const express = require('express')
const { validate: isUuid } = require('uuid')
const pool = require('../config/db')
const auth = require('../middleware/auth')
const {
  formatFixed,
  normalizeFulfillment,
  normalizeOrder,
  parseFixed
} = require('../utils/salesOrders')

const router = express.Router()
const ORDER_STATUSES = ['draft', 'confirmed', 'partially_fulfilled', 'fulfilled', 'cancelled']

function httpError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

async function withTransaction(work) {
  let client
  let transactionOpen = false
  let releaseError
  try {
    client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      transactionOpen = true
    } catch (error) {
      releaseError = error
      throw error
    }
    const result = await work(client)
    await client.query('COMMIT')
    transactionOpen = false
    return result
  } catch (error) {
    if (client && transactionOpen) {
      try {
        await client.query('ROLLBACK')
        transactionOpen = false
      } catch (rollbackError) {
        releaseError = rollbackError
        console.error('Failed to roll back sales order transaction', rollbackError)
      }
    }
    throw error
  } finally {
    if (client) client.release(releaseError)
  }
}

async function requireClient(client, tenantId, clientId) {
  const result = await client.query(
    `SELECT id FROM clients WHERE id = $1 AND tenant_id = $2 FOR SHARE`,
    [clientId, tenantId]
  )
  if (result.rowCount !== 1) throw httpError(404, 'Client not found')
}

async function lockActiveProducts(client, tenantId, items) {
  const productIds = items.map((item) => item.product_id).sort()
  const result = await client.query(
    `SELECT id, name, sku, selling_price
     FROM products
     WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND is_active = true
     ORDER BY id FOR SHARE`,
    [tenantId, productIds]
  )
  if (result.rowCount !== productIds.length) throw httpError(404, 'Product not found')
  return new Map(result.rows.map((product) => [product.id, product]))
}

async function insertOrderItems(client, tenantId, orderId, items, products) {
  for (const item of items) {
    const product = products.get(item.product_id)
    await client.query(
      `INSERT INTO sales_order_items
         (tenant_id, sales_order_id, product_id, product_name, product_sku,
          quantity_ordered, unit_price, discount_rate, discount_amount, line_subtotal)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [tenantId, orderId, item.product_id, product.name, product.sku, item.quantity,
        item.unit_price, item.discount_rate, item.discount_amount, item.line_subtotal]
    )
  }
}

async function orderDetails(client, tenantId, orderId) {
  const orderResult = await client.query(
    `SELECT so.*, c.name AS client_name, c.email AS client_email,
            c.phone AS client_phone, c.address AS client_address
     FROM sales_orders so
     JOIN clients c ON c.id = so.client_id AND c.tenant_id = so.tenant_id
     WHERE so.id = $1 AND so.tenant_id = $2`,
    [orderId, tenantId]
  )
  if (orderResult.rowCount !== 1) throw httpError(404, 'Sales order not found')
  const itemsResult = await client.query(
    `SELECT * FROM sales_order_items
     WHERE tenant_id = $1 AND sales_order_id = $2
     ORDER BY created_at, id`,
    [tenantId, orderId]
  )
  const fulfillmentsResult = await client.query(
    `SELECT * FROM sales_order_fulfillments
     WHERE tenant_id = $1 AND sales_order_id = $2
     ORDER BY fulfilled_at DESC, id DESC`,
    [tenantId, orderId]
  )
  const fulfillmentItemsResult = await client.query(
    `SELECT fi.*, soi.product_name, soi.product_sku
     FROM sales_order_fulfillment_items fi
     JOIN sales_order_items soi
       ON soi.tenant_id = fi.tenant_id
      AND soi.sales_order_id = fi.sales_order_id
      AND soi.id = fi.sales_order_item_id
      AND soi.product_id = fi.product_id
     WHERE fi.tenant_id = $1 AND fi.sales_order_id = $2
     ORDER BY fi.id`,
    [tenantId, orderId]
  )
  const itemsByFulfillment = new Map()
  for (const item of fulfillmentItemsResult.rows) {
    const rows = itemsByFulfillment.get(item.fulfillment_id) || []
    rows.push(item)
    itemsByFulfillment.set(item.fulfillment_id, rows)
  }
  const fulfillments = fulfillmentsResult.rows.map((fulfillment) => ({
    ...fulfillment,
    items: itemsByFulfillment.get(fulfillment.id) || []
  }))
  const invoiceResult = await client.query(
    `SELECT id, invoice_number, status, created_at
     FROM invoices WHERE tenant_id = $1 AND sales_order_id = $2`,
    [tenantId, orderId]
  )
  return {
    ...orderResult.rows[0],
    items: itemsResult.rows,
    fulfillments,
    invoice: invoiceResult.rows[0] || null
  }
}

function validateOrderId(id, res) {
  if (isUuid(id)) return true
  res.status(404).json({ error: 'Sales order not found' })
  return false
}

function sendError(res, error, fallback) {
  if (error.statusCode) return res.status(error.statusCode).json({ error: error.message })
  console.error(error)
  return res.status(500).json({ error: fallback })
}

router.get('/', auth, async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : ''
  const status = typeof req.query.status === 'string' && ORDER_STATUSES.includes(req.query.status)
    ? req.query.status
    : null
  if (req.query.status && !status) return res.status(400).json({ error: 'Invalid sales order status' })
  try {
    const result = await pool.query(
      `SELECT so.*, c.name AS client_name, inv.invoice_number,
              (SELECT COUNT(*)::integer FROM sales_order_items soi
               WHERE soi.tenant_id = so.tenant_id AND soi.sales_order_id = so.id) AS item_count
       FROM sales_orders so
       JOIN clients c ON c.id = so.client_id AND c.tenant_id = so.tenant_id
       LEFT JOIN invoices inv ON inv.tenant_id = so.tenant_id AND inv.sales_order_id = so.id
       WHERE so.tenant_id = $1
         AND ($2 = '' OR so.order_number ILIKE '%' || $2 || '%'
              OR c.name ILIKE '%' || $2 || '%')
         AND ($3::text IS NULL OR so.status = $3)
       ORDER BY so.created_at DESC, so.id DESC
       LIMIT 500`,
      [req.user.tenantId, search, status]
    )
    res.json(result.rows)
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: 'Failed to fetch sales orders' })
  }
})

router.post('/', auth, async (req, res) => {
  let order
  try {
    order = normalizeOrder(req.body)
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message })
  }
  try {
    const created = await withTransaction(async (client) => {
      const tenantResult = await client.query(
        `SELECT id FROM tenants WHERE id = $1 FOR UPDATE`,
        [req.user.tenantId]
      )
      if (tenantResult.rowCount !== 1) throw httpError(404, 'Sales order context not found')
      await requireClient(client, req.user.tenantId, order.client_id)
      const products = await lockActiveProducts(client, req.user.tenantId, order.items)
      const numberResult = await client.query(
        `SELECT COALESCE(MAX(SUBSTRING(order_number FROM '^SO-([0-9]+)$')::numeric), 0) + 1 AS next_number
         FROM sales_orders WHERE tenant_id = $1 AND order_number ~ '^SO-[0-9]+$'`,
        [req.user.tenantId]
      )
      const orderNumber = `SO-${BigInt(String(numberResult.rows[0].next_number)).toString().padStart(4, '0')}`
      const inserted = await client.query(
        `INSERT INTO sales_orders
           (tenant_id, client_id, order_number, order_date, expected_delivery_date,
            status, subtotal, discount_total, tax_rate, tax_amount, total, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [req.user.tenantId, order.client_id, orderNumber, order.order_date,
          order.expected_delivery_date, order.subtotal, order.discount_total,
          order.tax_rate, order.tax_amount, order.total, order.notes, req.user.userId]
      )
      const orderId = inserted.rows[0].id
      await insertOrderItems(client, req.user.tenantId, orderId, order.items, products)
      return orderDetails(client, req.user.tenantId, orderId)
    })
    res.status(201).json(created)
  } catch (error) {
    sendError(res, error, 'Failed to create sales order')
  }
})

router.get('/:id', auth, async (req, res) => {
  if (!validateOrderId(req.params.id, res)) return
  try {
    res.json(await orderDetails(pool, req.user.tenantId, req.params.id))
  } catch (error) {
    sendError(res, error, 'Failed to fetch sales order')
  }
})

router.put('/:id', auth, async (req, res) => {
  if (!validateOrderId(req.params.id, res)) return
  let order
  try {
    order = normalizeOrder(req.body)
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message })
  }
  try {
    const updated = await withTransaction(async (client) => {
      const currentResult = await client.query(
        `SELECT id, status FROM sales_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [req.params.id, req.user.tenantId]
      )
      if (currentResult.rowCount !== 1) throw httpError(404, 'Sales order not found')
      if (currentResult.rows[0].status !== 'draft') throw httpError(409, 'Only draft sales orders can be edited')
      await requireClient(client, req.user.tenantId, order.client_id)
      const products = await lockActiveProducts(client, req.user.tenantId, order.items)
      await client.query(
        `UPDATE sales_orders
         SET client_id = $1, order_date = $2, expected_delivery_date = $3,
             subtotal = $4, discount_total = $5, tax_rate = $6, tax_amount = $7,
             total = $8, notes = $9, updated_at = CURRENT_TIMESTAMP
         WHERE id = $10 AND tenant_id = $11`,
        [order.client_id, order.order_date, order.expected_delivery_date, order.subtotal,
          order.discount_total, order.tax_rate, order.tax_amount, order.total,
          order.notes, req.params.id, req.user.tenantId]
      )
      await client.query(
        `DELETE FROM sales_order_items WHERE tenant_id = $1 AND sales_order_id = $2`,
        [req.user.tenantId, req.params.id]
      )
      await insertOrderItems(client, req.user.tenantId, req.params.id, order.items, products)
      return orderDetails(client, req.user.tenantId, req.params.id)
    })
    res.json(updated)
  } catch (error) {
    sendError(res, error, 'Failed to update sales order')
  }
})

router.patch('/:id/status', auth, async (req, res) => {
  if (!validateOrderId(req.params.id, res)) return
  const targetStatus = req.body && req.body.status
  if (!['confirmed', 'cancelled'].includes(targetStatus)) {
    return res.status(400).json({ error: 'Status can only be changed to confirmed or cancelled' })
  }
  try {
    const updated = await withTransaction(async (client) => {
      const currentResult = await client.query(
        `SELECT id, status FROM sales_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [req.params.id, req.user.tenantId]
      )
      if (currentResult.rowCount !== 1) throw httpError(404, 'Sales order not found')
      const currentStatus = currentResult.rows[0].status
      const canConfirm = targetStatus === 'confirmed' && currentStatus === 'draft'
      const canCancel = targetStatus === 'cancelled' && ['draft', 'confirmed'].includes(currentStatus)
      if (!canConfirm && !canCancel) throw httpError(409, 'This sales order status transition is not allowed')
      await client.query(
        `UPDATE sales_orders SET status = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND tenant_id = $3`,
        [targetStatus, req.params.id, req.user.tenantId]
      )
      return orderDetails(client, req.user.tenantId, req.params.id)
    })
    res.json(updated)
  } catch (error) {
    sendError(res, error, 'Failed to update sales order status')
  }
})

router.post('/:id/fulfillments', auth, async (req, res) => {
  if (!validateOrderId(req.params.id, res)) return
  const idempotencyKey = typeof req.get('Idempotency-Key') === 'string'
    ? req.get('Idempotency-Key').trim()
    : ''
  if (idempotencyKey.length < 8 || idempotencyKey.length > 100 || /[\r\n]/.test(idempotencyKey)) {
    return res.status(400).json({ error: 'A valid Idempotency-Key header is required' })
  }
  let input
  try {
    input = normalizeFulfillment(req.body)
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message })
  }
  try {
    const result = await withTransaction(async (client) => {
      const orderResult = await client.query(
        `SELECT * FROM sales_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [req.params.id, req.user.tenantId]
      )
      if (orderResult.rowCount !== 1) throw httpError(404, 'Sales order not found')
      const order = orderResult.rows[0]
      const prior = await client.query(
        `SELECT * FROM sales_order_fulfillments
         WHERE tenant_id = $1 AND sales_order_id = $2 AND idempotency_key = $3`,
        [req.user.tenantId, order.id, idempotencyKey]
      )
      if (prior.rowCount === 1) {
        const details = await orderDetails(client, req.user.tenantId, order.id)
        const fulfillment = details.fulfillments.find((row) => row.id === prior.rows[0].id)
        return { statusCode: 200, body: { sales_order: details, fulfillment, duplicate: true } }
      }
      if (!['confirmed', 'partially_fulfilled'].includes(order.status)) {
        throw httpError(409, 'Only confirmed sales orders can be fulfilled')
      }

      const linesResult = await client.query(
        `SELECT * FROM sales_order_items
         WHERE tenant_id = $1 AND sales_order_id = $2
         ORDER BY id FOR UPDATE`,
        [req.user.tenantId, order.id]
      )
      const lines = new Map(linesResult.rows.map((line) => [line.id, line]))
      const requested = input.items.map((entry) => {
        const line = lines.get(entry.sales_order_item_id)
        if (!line) throw httpError(404, 'Sales order item not found')
        const ordered = parseFixed(line.quantity_ordered, 2, 8, 'Ordered quantity')
        const fulfilled = parseFixed(line.quantity_fulfilled, 2, 8, 'Fulfilled quantity')
        if (entry.quantityUnits > ordered - fulfilled) {
          throw httpError(409, 'Fulfillment quantity exceeds the outstanding quantity')
        }
        return { ...entry, line }
      })
      const productIds = [...new Set(requested.map((entry) => entry.line.product_id))].sort()
      const productsResult = await client.query(
        `SELECT id, current_stock FROM products
         WHERE tenant_id = $1 AND id = ANY($2::uuid[])
         ORDER BY id FOR UPDATE`,
        [req.user.tenantId, productIds]
      )
      if (productsResult.rowCount !== productIds.length) throw httpError(404, 'Product not found')
      const products = new Map(productsResult.rows.map((product) => [product.id, product]))
      for (const entry of requested) {
        const stockMilli = parseFixed(products.get(entry.line.product_id).current_stock, 3, 9, 'Available stock')
        if (stockMilli < entry.quantityUnits * 10n) {
          throw httpError(409, `Insufficient stock for ${entry.line.product_name}`)
        }
      }

      const fulfillmentResult = await client.query(
        `INSERT INTO sales_order_fulfillments
           (tenant_id, sales_order_id, idempotency_key, fulfilled_by, notes)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [req.user.tenantId, order.id, idempotencyKey, req.user.userId, input.notes]
      )
      const fulfillment = fulfillmentResult.rows[0]

      for (const entry of requested) {
        const line = entry.line
        const quantityMilli = entry.quantityUnits * 10n
        const fulfillmentItemResult = await client.query(
          `INSERT INTO sales_order_fulfillment_items
             (tenant_id, sales_order_id, fulfillment_id, sales_order_item_id,
              product_id, fulfilled_quantity)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [req.user.tenantId, order.id, fulfillment.id, line.id, line.product_id,
            formatFixed(entry.quantityUnits, 2)]
        )
        const fulfillmentItemId = fulfillmentItemResult.rows[0].id
        const lineUpdate = await client.query(
          `UPDATE sales_order_items
           SET quantity_fulfilled = quantity_fulfilled + $1::numeric,
               updated_at = CURRENT_TIMESTAMP
           WHERE tenant_id = $2 AND sales_order_id = $3 AND id = $4
             AND quantity_fulfilled + $1::numeric <= quantity_ordered
           RETURNING quantity_fulfilled`,
          [formatFixed(entry.quantityUnits, 2), req.user.tenantId, order.id, line.id]
        )
        if (lineUpdate.rowCount !== 1) {
          throw httpError(409, 'Fulfillment quantity exceeds the outstanding quantity')
        }

        const product = products.get(line.product_id)
        const stockUpdate = await client.query(
          `UPDATE products
           SET current_stock = current_stock - $1::numeric,
               updated_at = CURRENT_TIMESTAMP
           WHERE tenant_id = $2 AND id = $3 AND current_stock >= $1::numeric
           RETURNING current_stock`,
          [formatFixed(quantityMilli, 3), req.user.tenantId, line.product_id]
        )
        if (stockUpdate.rowCount !== 1) throw httpError(409, `Insufficient stock for ${line.product_name}`)
        const movementNotes = input.notes || `Sales order fulfillment ${fulfillment.id}`
        await client.query(
          `INSERT INTO stock_movements
             (tenant_id, product_id, movement_type, quantity_delta,
              quantity_before, quantity_after, reference, notes, created_by,
              sales_order_fulfillment_item_id)
           VALUES ($1, $2, 'adjustment', $3, $4, $5, $6, $7, $8, $9)`,
          [req.user.tenantId, line.product_id, formatFixed(-quantityMilli, 3),
            product.current_stock, stockUpdate.rows[0].current_stock,
            order.order_number, movementNotes, req.user.userId, fulfillmentItemId]
        )
      }

      const completeResult = await client.query(
        `SELECT COALESCE(bool_and(quantity_fulfilled = quantity_ordered), false) AS fully_fulfilled
         FROM sales_order_items WHERE tenant_id = $1 AND sales_order_id = $2`,
        [req.user.tenantId, order.id]
      )
      const nextStatus = completeResult.rows[0].fully_fulfilled ? 'fulfilled' : 'partially_fulfilled'
      await client.query(
        `UPDATE sales_orders SET status = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND tenant_id = $3`,
        [nextStatus, order.id, req.user.tenantId]
      )
      const details = await orderDetails(client, req.user.tenantId, order.id)
      const createdFulfillment = details.fulfillments.find((row) => row.id === fulfillment.id)
      return { statusCode: 201, body: { sales_order: details, fulfillment: createdFulfillment, duplicate: false } }
    })
    res.status(result.statusCode).json(result.body)
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'This fulfillment has already been recorded' })
    sendError(res, error, 'Failed to fulfill sales order')
  }
})

router.post('/:id/invoice', auth, async (req, res) => {
  if (!validateOrderId(req.params.id, res)) return
  try {
    const invoice = await withTransaction(async (client) => {
      const tenantResult = await client.query(
        `SELECT id FROM tenants WHERE id = $1 FOR UPDATE`,
        [req.user.tenantId]
      )
      if (tenantResult.rowCount !== 1) throw httpError(404, 'Sales order context not found')
      const orderResult = await client.query(
        `SELECT * FROM sales_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [req.params.id, req.user.tenantId]
      )
      if (orderResult.rowCount !== 1) throw httpError(404, 'Sales order not found')
      const order = orderResult.rows[0]
      const existingInvoice = await client.query(
        `SELECT id FROM invoices WHERE tenant_id = $1 AND sales_order_id = $2`,
        [req.user.tenantId, order.id]
      )
      if (existingInvoice.rowCount > 0) throw httpError(409, 'An invoice already exists for this sales order')
      if (order.status !== 'fulfilled') {
        throw httpError(409, 'Fulfill the entire sales order before creating its invoice')
      }
      await requireClient(client, req.user.tenantId, order.client_id)
      const lineResult = await client.query(
        `SELECT * FROM sales_order_items
         WHERE tenant_id = $1 AND sales_order_id = $2
         ORDER BY id FOR UPDATE`,
        [req.user.tenantId, order.id]
      )
      if (lineResult.rowCount === 0 || lineResult.rows.some((line) => line.quantity_fulfilled !== line.quantity_ordered)) {
        throw httpError(409, 'Only fully fulfilled sales orders can be invoiced')
      }

      const nextNumberResult = await client.query(
        `SELECT COALESCE(
           MAX(SUBSTRING(invoice_number FROM '^INV-([0-9]+)$')::numeric),
           0
         ) + 1 AS next_number
         FROM invoices
         WHERE tenant_id = $1 AND invoice_number ~ '^INV-[0-9]+$'`,
        [req.user.tenantId]
      )
      const invoiceNumber = `INV-${String(nextNumberResult.rows[0].next_number).padStart(4, '0')}`
      const invoiceNotes = [`Sales order ${order.order_number}`, order.notes].filter(Boolean).join('\n')
      const invoiceItems = lineResult.rows.map((line) => {
        const discountDescription = Number(line.discount_rate) > 0
          ? ` - discount ${Number(line.discount_rate).toFixed(2)}% (KES ${Number(line.discount_amount).toFixed(2)})`
          : ''
        return {
          description: `${line.product_name} (${line.product_sku})${discountDescription}`,
          quantity: line.quantity_ordered,
          unit_price: line.unit_price,
          amount: line.line_subtotal
        }
      })
      const insertedInvoice = await client.query(
        `INSERT INTO invoices
           (tenant_id, client_id, sales_order_id, invoice_number, due_date,
            subtotal, tax_rate, tax_amount, total, notes)
         VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9)
         RETURNING *`,
        [req.user.tenantId, order.client_id, order.id, invoiceNumber,
          order.subtotal, order.tax_rate, order.tax_amount, order.total, invoiceNotes]
      )
      const createdInvoice = insertedInvoice.rows[0]
      for (const item of invoiceItems) {
        await client.query(
          `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount)
           VALUES ($1, $2, $3, $4, $5)`,
          [createdInvoice.id, item.description, item.quantity, item.unit_price, item.amount]
        )
      }
      return { ...createdInvoice, items: invoiceItems }
    })
    res.status(201).json(invoice)
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'An invoice already exists for this sales order' })
    sendError(res, error, 'Failed to create invoice from sales order')
  }
})

module.exports = router

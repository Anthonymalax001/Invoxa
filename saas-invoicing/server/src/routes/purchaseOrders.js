const express = require('express')
const { validate: isUuid } = require('uuid')
const pool = require('../config/db')
const auth = require('../middleware/auth')
const {
  formatFixed,
  normalizeOrder,
  normalizeReceipt,
  parseFixed
} = require('../utils/purchasing')

const router = express.Router()
const ORDER_STATUSES = ['draft', 'ordered', 'partially_received', 'received', 'cancelled']

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
        console.error('Failed to roll back purchasing transaction', rollbackError)
      }
    }
    throw error
  } finally {
    if (client) client.release(releaseError)
  }
}

async function requireActiveSupplier(client, tenantId, supplierId) {
  const result = await client.query(
    `SELECT id FROM suppliers
     WHERE id = $1 AND tenant_id = $2 AND is_active = true
     FOR SHARE`,
    [supplierId, tenantId]
  )
  if (result.rowCount !== 1) throw httpError(404, 'Supplier not found')
}

async function lockActiveProducts(client, tenantId, items) {
  const productIds = items.map((item) => item.product_id).sort()
  const result = await client.query(
    `SELECT id, name, sku
     FROM products
     WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND is_active = true
     ORDER BY id
     FOR SHARE`,
    [tenantId, productIds]
  )
  if (result.rowCount !== productIds.length) throw httpError(404, 'Product not found')
  return new Map(result.rows.map((product) => [product.id, product]))
}

async function insertOrderItems(client, tenantId, orderId, items, products) {
  for (const item of items) {
    const product = products.get(item.product_id)
    await client.query(
      `INSERT INTO purchase_order_items
         (tenant_id, purchase_order_id, product_id, product_name, product_sku,
          quantity_ordered, unit_cost, line_subtotal)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [tenantId, orderId, item.product_id, product.name, product.sku,
        item.quantity, item.unit_cost, item.line_subtotal]
    )
  }
}

async function orderDetails(client, tenantId, orderId) {
  const orderResult = await client.query(
    `SELECT po.*, s.business_name AS supplier_name, s.contact_person AS supplier_contact,
            s.email AS supplier_email, s.phone AS supplier_phone
     FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id AND s.tenant_id = po.tenant_id
     WHERE po.id = $1 AND po.tenant_id = $2`,
    [orderId, tenantId]
  )
  if (orderResult.rowCount !== 1) throw httpError(404, 'Purchase order not found')
  const itemsResult = await client.query(
    `SELECT * FROM purchase_order_items
     WHERE tenant_id = $1 AND purchase_order_id = $2
     ORDER BY created_at, id`,
    [tenantId, orderId]
  )
  const receiptsResult = await client.query(
    `SELECT * FROM purchase_order_receipts
     WHERE tenant_id = $1 AND purchase_order_id = $2
     ORDER BY received_at DESC, id DESC`,
    [tenantId, orderId]
  )
  const receiptItemsResult = await client.query(
    `SELECT ri.*, poi.product_name, poi.product_sku
     FROM purchase_order_receipt_items ri
     JOIN purchase_order_items poi
       ON poi.tenant_id = ri.tenant_id
      AND poi.purchase_order_id = ri.purchase_order_id
      AND poi.id = ri.purchase_order_item_id
     WHERE ri.tenant_id = $1 AND ri.purchase_order_id = $2
     ORDER BY ri.id`,
    [tenantId, orderId]
  )
  const receiptItemsByReceipt = new Map()
  for (const item of receiptItemsResult.rows) {
    const rows = receiptItemsByReceipt.get(item.receipt_id) || []
    rows.push(item)
    receiptItemsByReceipt.set(item.receipt_id, rows)
  }
  const receipts = receiptsResult.rows.map((receipt) => ({
    ...receipt,
    items: receiptItemsByReceipt.get(receipt.id) || []
  }))
  return { ...orderResult.rows[0], items: itemsResult.rows, receipts }
}

function validateOrderId(id, res) {
  if (isUuid(id)) return true
  res.status(404).json({ error: 'Purchase order not found' })
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
  if (req.query.status && !status) return res.status(400).json({ error: 'Invalid purchase order status' })
  const supplierId = req.query.supplier_id || null
  if (supplierId && !isUuid(supplierId)) return res.status(400).json({ error: 'Invalid supplier filter' })
  try {
    const result = await pool.query(
      `SELECT po.*, s.business_name AS supplier_name,
              (SELECT COUNT(*)::integer FROM purchase_order_items poi
               WHERE poi.tenant_id = po.tenant_id AND poi.purchase_order_id = po.id) AS item_count
       FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id AND s.tenant_id = po.tenant_id
       WHERE po.tenant_id = $1
         AND ($2 = '' OR po.purchase_order_number ILIKE '%' || $2 || '%'
              OR s.business_name ILIKE '%' || $2 || '%')
         AND ($3::text IS NULL OR po.status = $3)
         AND ($4::uuid IS NULL OR po.supplier_id = $4)
       ORDER BY po.created_at DESC, po.id DESC
       LIMIT 500`,
      [req.user.tenantId, search, status, supplierId]
    )
    res.json(result.rows)
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: 'Failed to fetch purchase orders' })
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
      if (tenantResult.rowCount !== 1) throw httpError(404, 'Purchase order context not found')
      await requireActiveSupplier(client, req.user.tenantId, order.supplier_id)
      const products = await lockActiveProducts(client, req.user.tenantId, order.items)
      const numberResult = await client.query(
        `SELECT COALESCE(MAX(SUBSTRING(purchase_order_number FROM '^PO-([0-9]+)$')::numeric), 0) + 1 AS next_number
         FROM purchase_orders
         WHERE tenant_id = $1 AND purchase_order_number ~ '^PO-[0-9]+$'`,
        [req.user.tenantId]
      )
      const orderNumber = `PO-${BigInt(String(numberResult.rows[0].next_number)).toString().padStart(4, '0')}`
      const inserted = await client.query(
        `INSERT INTO purchase_orders
           (tenant_id, supplier_id, purchase_order_number, order_date,
            expected_delivery_date, status, subtotal, tax_rate, tax_amount, total, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8, $9, $10, $11)
         RETURNING id`,
        [req.user.tenantId, order.supplier_id, orderNumber, order.order_date,
          order.expected_delivery_date, order.subtotal, order.tax_rate, order.tax_amount,
          order.total, order.notes, req.user.userId]
      )
      const orderId = inserted.rows[0].id
      await insertOrderItems(client, req.user.tenantId, orderId, order.items, products)
      return orderDetails(client, req.user.tenantId, orderId)
    })
    res.status(201).json(created)
  } catch (error) {
    sendError(res, error, 'Failed to create purchase order')
  }
})

router.get('/:id', auth, async (req, res) => {
  if (!validateOrderId(req.params.id, res)) return
  try {
    const result = await orderDetails(pool, req.user.tenantId, req.params.id)
    res.json(result)
  } catch (error) {
    sendError(res, error, 'Failed to fetch purchase order')
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
        `SELECT id, status FROM purchase_orders
         WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [req.params.id, req.user.tenantId]
      )
      if (currentResult.rowCount !== 1) throw httpError(404, 'Purchase order not found')
      if (currentResult.rows[0].status !== 'draft') {
        throw httpError(409, 'Only draft purchase orders can be edited')
      }
      await requireActiveSupplier(client, req.user.tenantId, order.supplier_id)
      const products = await lockActiveProducts(client, req.user.tenantId, order.items)
      await client.query(
        `UPDATE purchase_orders
         SET supplier_id = $1, order_date = $2, expected_delivery_date = $3,
             subtotal = $4, tax_rate = $5, tax_amount = $6, total = $7,
             notes = $8, updated_at = CURRENT_TIMESTAMP
         WHERE id = $9 AND tenant_id = $10`,
        [order.supplier_id, order.order_date, order.expected_delivery_date,
          order.subtotal, order.tax_rate, order.tax_amount, order.total,
          order.notes, req.params.id, req.user.tenantId]
      )
      await client.query(
        `DELETE FROM purchase_order_items WHERE tenant_id = $1 AND purchase_order_id = $2`,
        [req.user.tenantId, req.params.id]
      )
      await insertOrderItems(client, req.user.tenantId, req.params.id, order.items, products)
      return orderDetails(client, req.user.tenantId, req.params.id)
    })
    res.json(updated)
  } catch (error) {
    sendError(res, error, 'Failed to update purchase order')
  }
})

router.patch('/:id/status', auth, async (req, res) => {
  if (!validateOrderId(req.params.id, res)) return
  const targetStatus = req.body && req.body.status
  if (!['ordered', 'cancelled'].includes(targetStatus)) {
    return res.status(400).json({ error: 'Status can only be changed to ordered or cancelled' })
  }
  try {
    const updated = await withTransaction(async (client) => {
      const currentResult = await client.query(
        `SELECT id, status FROM purchase_orders
         WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [req.params.id, req.user.tenantId]
      )
      if (currentResult.rowCount !== 1) throw httpError(404, 'Purchase order not found')
      const currentStatus = currentResult.rows[0].status
      const canOrder = targetStatus === 'ordered' && currentStatus === 'draft'
      const canCancel = targetStatus === 'cancelled' && ['draft', 'ordered'].includes(currentStatus)
      if (!canOrder && !canCancel) throw httpError(409, 'This purchase order status transition is not allowed')
      await client.query(
        `UPDATE purchase_orders SET status = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND tenant_id = $3`,
        [targetStatus, req.params.id, req.user.tenantId]
      )
      return orderDetails(client, req.user.tenantId, req.params.id)
    })
    res.json(updated)
  } catch (error) {
    sendError(res, error, 'Failed to update purchase order status')
  }
})

router.post('/:id/receipts', auth, async (req, res) => {
  if (!validateOrderId(req.params.id, res)) return
  const idempotencyKey = typeof req.get('Idempotency-Key') === 'string'
    ? req.get('Idempotency-Key').trim()
    : ''
  if (idempotencyKey.length < 8 || idempotencyKey.length > 100 || /[\r\n]/.test(idempotencyKey)) {
    return res.status(400).json({ error: 'A valid Idempotency-Key header is required' })
  }
  let receiptInput
  try {
    receiptInput = normalizeReceipt(req.body)
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message })
  }

  try {
    const result = await withTransaction(async (client) => {
      const orderResult = await client.query(
        `SELECT * FROM purchase_orders
         WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [req.params.id, req.user.tenantId]
      )
      if (orderResult.rowCount !== 1) throw httpError(404, 'Purchase order not found')
      const order = orderResult.rows[0]

      const existingReceipt = await client.query(
        `SELECT * FROM purchase_order_receipts
         WHERE tenant_id = $1 AND purchase_order_id = $2 AND idempotency_key = $3`,
        [req.user.tenantId, order.id, idempotencyKey]
      )
      if (existingReceipt.rowCount === 1) {
        const details = await orderDetails(client, req.user.tenantId, order.id)
        const receipt = details.receipts.find((row) => row.id === existingReceipt.rows[0].id)
        return { statusCode: 200, body: { purchase_order: details, receipt, duplicate: true } }
      }
      if (!['ordered', 'partially_received'].includes(order.status)) {
        throw httpError(409, 'Only ordered purchase orders can receive goods')
      }

      const orderItemsResult = await client.query(
        `SELECT * FROM purchase_order_items
         WHERE tenant_id = $1 AND purchase_order_id = $2
         ORDER BY id FOR UPDATE`,
        [req.user.tenantId, order.id]
      )
      const orderItems = new Map(orderItemsResult.rows.map((item) => [item.id, item]))
      const requested = receiptInput.items.map((item) => {
        const orderItem = orderItems.get(item.purchase_order_item_id)
        if (!orderItem) throw httpError(404, 'Purchase order item not found')
        const orderedMilli = parseFixed(orderItem.quantity_ordered, 3, 9, 'Ordered quantity')
        const receivedMilli = parseFixed(orderItem.quantity_received, 3, 9, 'Received quantity')
        if (item.quantityMilli > orderedMilli - receivedMilli) {
          throw httpError(409, 'Receipt quantity exceeds the outstanding quantity')
        }
        return { ...item, orderItem }
      })
      const productIds = [...new Set(requested.map((item) => item.orderItem.product_id))].sort()
      const productsResult = await client.query(
        `SELECT id, current_stock FROM products
         WHERE tenant_id = $1 AND id = ANY($2::uuid[])
         ORDER BY id FOR UPDATE`,
        [req.user.tenantId, productIds]
      )
      if (productsResult.rowCount !== productIds.length) throw httpError(404, 'Product not found')
      const products = new Map(productsResult.rows.map((product) => [product.id, product]))

      const receiptResult = await client.query(
        `INSERT INTO purchase_order_receipts
           (tenant_id, purchase_order_id, idempotency_key, received_by, notes)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [req.user.tenantId, order.id, idempotencyKey, req.user.userId, receiptInput.notes]
      )
      const receipt = receiptResult.rows[0]

      for (const input of requested) {
        const orderItem = input.orderItem
        const unitCostCents = parseFixed(orderItem.unit_cost, 2, 10, 'Unit cost')
        const lineTotalCents = (input.quantityMilli * unitCostCents + 500n) / 1000n
        const receiptItemResult = await client.query(
          `INSERT INTO purchase_order_receipt_items
             (tenant_id, purchase_order_id, receipt_id, purchase_order_item_id,
              product_id, received_quantity, unit_cost, line_total)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [req.user.tenantId, order.id, receipt.id, orderItem.id, orderItem.product_id,
            formatFixed(input.quantityMilli, 3), orderItem.unit_cost, formatFixed(lineTotalCents, 2)]
        )
        const receiptItemId = receiptItemResult.rows[0].id
        const receivedUpdate = await client.query(
          `UPDATE purchase_order_items
           SET quantity_received = quantity_received + $1::numeric,
               updated_at = CURRENT_TIMESTAMP
           WHERE tenant_id = $2 AND purchase_order_id = $3 AND id = $4
             AND quantity_received + $1::numeric <= quantity_ordered
           RETURNING quantity_received`,
          [formatFixed(input.quantityMilli, 3), req.user.tenantId, order.id, orderItem.id]
        )
        if (receivedUpdate.rowCount !== 1) {
          throw httpError(409, 'Receipt quantity exceeds the outstanding quantity')
        }

        const product = products.get(orderItem.product_id)
        const stockUpdate = await client.query(
          `UPDATE products
           SET current_stock = current_stock + $1::numeric,
               updated_at = CURRENT_TIMESTAMP
           WHERE tenant_id = $2 AND id = $3
           RETURNING current_stock`,
          [formatFixed(input.quantityMilli, 3), req.user.tenantId, orderItem.product_id]
        )
        if (stockUpdate.rowCount !== 1) throw httpError(404, 'Product not found')
        const movementNotes = receiptInput.notes || `Purchase receipt ${receipt.id}`
        await client.query(
          `INSERT INTO stock_movements
             (tenant_id, product_id, movement_type, quantity_delta,
              quantity_before, quantity_after, reference, notes, created_by,
              purchase_order_receipt_item_id)
           VALUES ($1, $2, 'receipt', $3, $4, $5, $6, $7, $8, $9)`,
          [req.user.tenantId, orderItem.product_id, formatFixed(input.quantityMilli, 3),
            product.current_stock, stockUpdate.rows[0].current_stock,
            order.purchase_order_number, movementNotes, req.user.userId, receiptItemId]
        )
      }

      const completionResult = await client.query(
        `SELECT COALESCE(bool_and(quantity_received = quantity_ordered), false) AS fully_received
         FROM purchase_order_items
         WHERE tenant_id = $1 AND purchase_order_id = $2`,
        [req.user.tenantId, order.id]
      )
      const nextStatus = completionResult.rows[0].fully_received ? 'received' : 'partially_received'
      await client.query(
        `UPDATE purchase_orders SET status = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND tenant_id = $3`,
        [nextStatus, order.id, req.user.tenantId]
      )
      const details = await orderDetails(client, req.user.tenantId, order.id)
      const newReceipt = details.receipts.find((row) => row.id === receipt.id)
      return { statusCode: 201, body: { purchase_order: details, receipt: newReceipt, duplicate: false } }
    })
    res.status(result.statusCode).json(result.body)
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'This receipt has already been recorded' })
    }
    sendError(res, error, 'Failed to record goods receipt')
  }
})

module.exports = router

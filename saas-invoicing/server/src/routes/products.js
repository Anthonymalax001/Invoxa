const express = require('express')
const { validate: isUuid } = require('uuid')
const pool = require('../config/db')
const auth = require('../middleware/auth')
const { logSafeError } = require('../utils/errorLogging')
const { valueAdjustment, valueReceipt, valueReturn } = require('../services/inventoryAccounting')

const router = express.Router()
const MAX_NUMERIC_UNITS = 999999999999n

function parseFixed(value, scale, allowNegative = false) {
  if (typeof value !== 'number' && typeof value !== 'string') return null

  const text = typeof value === 'string' ? value.trim() : String(value)
  const signPattern = allowNegative ? '(-?)' : ''
  const match = text.match(new RegExp(`^${signPattern}(0|[1-9]\\d*)(?:\\.(\\d{1,${scale}}))?$`))
  if (!match) return null

  const offset = allowNegative ? 1 : 0
  const sign = allowNegative && match[1] === '-' ? -1n : 1n
  const whole = match[1 + offset]
  const fraction = match[2 + offset] || ''
  if (whole.length > 12 - scale) return null
  const factor = 10n ** BigInt(scale)
  const units = BigInt(whole) * factor + BigInt(fraction.padEnd(scale, '0') || '0')
  if (units > MAX_NUMERIC_UNITS) return null
  return sign * units
}

function formatFixed(units, scale) {
  const sign = units < 0n ? '-' : ''
  const absolute = units < 0n ? -units : units
  const factor = 10n ** BigInt(scale)
  const whole = absolute / factor
  const fraction = (absolute % factor).toString().padStart(scale, '0')
  return `${sign}${whole}.${fraction}`
}

function parseProduct(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const sku = typeof body.sku === 'string' ? body.sku.trim().toUpperCase() : ''
  const unit = typeof body.unit_of_measure === 'string'
    ? body.unit_of_measure.trim()
    : 'each'
  const description = body.description == null ? null : body.description
  const costPrice = parseFixed(body.cost_price, 2)
  const sellingPrice = parseFixed(body.selling_price, 2)
  const lowStockThreshold = body.low_stock_threshold == null
    ? 0n
    : parseFixed(body.low_stock_threshold, 3)

  if (!name || name.length > 255 || !sku || sku.length > 100 ||
      !unit || unit.length > 50 ||
      (description !== null && (typeof description !== 'string' || description.length > 10000)) ||
      costPrice === null || sellingPrice === null || lowStockThreshold === null) {
    return null
  }

  return {
    name,
    sku,
    description: description === null ? null : description.trim() || null,
    unit_of_measure: unit,
    cost_price: formatFixed(costPrice, 2),
    selling_price: formatFixed(sellingPrice, 2),
    low_stock_threshold: formatFixed(lowStockThreshold, 3)
  }
}

function parseMovementMetadata(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const reference = body.reference == null || body.reference === '' ? null : body.reference
  const notes = body.notes == null || body.notes === '' ? null : body.notes
  if ((reference !== null && (typeof reference !== 'string' || reference.trim().length > 100)) ||
      (notes !== null && (typeof notes !== 'string' || notes.length > 10000))) {
    return null
  }
  return {
    reference: reference === null ? null : reference.trim() || null,
    notes: notes === null ? null : notes.trim() || null
  }
}

function logAndRespond(err, res, fallback) {
  if (err.statusCode) {
    return res.status(err.statusCode).json({ error: err.publicMessage || fallback })
  }
  if (err.code === '23505') {
    return res.status(409).json({ error: 'A product with this SKU already exists' })
  }
  logSafeError(fallback, err)
  return res.status(500).json({ error: fallback })
}

router.get('/', auth, async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : ''
  if (search.length > 100) {
    return res.status(400).json({ error: 'Search text must be 100 characters or fewer' })
  }

  let activeFilter = null
  if (req.query.active === 'true') activeFilter = true
  else if (req.query.active === 'false') activeFilter = false
  else if (req.query.active != null && req.query.active !== 'all') {
    return res.status(400).json({ error: 'Invalid active filter' })
  }

  try {
    const result = await pool.query(
      `SELECT *
       FROM products
       WHERE tenant_id = $1
         AND ($2::text = '' OR name ILIKE '%' || $2 || '%'
              OR sku ILIKE '%' || $2 || '%'
              OR COALESCE(description, '') ILIKE '%' || $2 || '%')
         AND ($3::boolean IS NULL OR is_active = $3)
       ORDER BY lower(name), id
       LIMIT 500`,
      [req.user.tenantId, search, activeFilter]
    )
    res.json(result.rows)
  } catch (err) {
    logAndRespond(err, res, 'Failed to fetch products')
  }
})

router.post('/', auth, async (req, res) => {
  const product = parseProduct(req.body)
  if (!product) {
    return res.status(400).json({ error: 'Enter a valid name, SKU, unit, prices and low-stock threshold' })
  }

  try {
    const result = await pool.query(
      `INSERT INTO products
         (tenant_id, name, sku, description, unit_of_measure, cost_price,
          selling_price, low_stock_threshold)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        req.user.tenantId,
        product.name,
        product.sku,
        product.description,
        product.unit_of_measure,
        product.cost_price,
        product.selling_price,
        product.low_stock_threshold
      ]
    )
    res.status(201).json(result.rows[0])
  } catch (err) {
    logAndRespond(err, res, 'Failed to create product')
  }
})

router.get('/:id/movements', auth, async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Product not found' })
  const requestedLimit = req.query.limit == null ? 100 : Number(req.query.limit)
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 200) {
    return res.status(400).json({ error: 'History limit must be between 1 and 200' })
  }

  try {
    const product = await pool.query(
      `SELECT id FROM products WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.user.tenantId]
    )
    if (product.rowCount === 0) return res.status(404).json({ error: 'Product not found' })

    const movements = await pool.query(
      `SELECT sm.*
       FROM stock_movements sm
       JOIN products p ON p.id = sm.product_id AND p.tenant_id = sm.tenant_id
       WHERE p.id = $1 AND p.tenant_id = $2
       ORDER BY sm.created_at DESC, sm.id DESC
       LIMIT $3`,
      [req.params.id, req.user.tenantId, requestedLimit]
    )
    res.json(movements.rows)
  } catch (err) {
    logAndRespond(err, res, 'Failed to fetch stock history')
  }
})

async function changeStock(req, res, movementType, delta, metadata) {
  let client
  let transactionOpen = false
  let releaseError

  try {
    client = await pool.connect()
    try {
      await client.query('BEGIN')
      transactionOpen = true
    } catch (err) {
      releaseError = err
      throw err
    }

    const currentResult = await client.query(
      `SELECT id, current_stock
       FROM products
       WHERE id = $1 AND tenant_id = $2
       FOR UPDATE`,
      [req.params.id, req.user.tenantId]
    )
    if (currentResult.rowCount !== 1) {
      const err = new Error('Product not found')
      err.statusCode = 404
      err.publicMessage = 'Product not found'
      throw err
    }

    const before = parseFixed(currentResult.rows[0].current_stock, 3)
    if (before === null) throw new Error('Stored stock quantity is invalid')
    const after = before + delta
    if (after < 0n || after > MAX_NUMERIC_UNITS) {
      const err = new Error('Stock quantity would be outside its allowed range')
      err.statusCode = 400
      err.publicMessage = 'The adjustment would result in invalid stock quantity'
      throw err
    }

    const updated = await client.query(
      `UPDATE products
       SET current_stock = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND tenant_id = $3
       RETURNING *`,
      [formatFixed(after, 3), req.params.id, req.user.tenantId]
    )
    const movement = await client.query(
      `INSERT INTO stock_movements
         (tenant_id, product_id, movement_type, quantity_delta,
          quantity_before, quantity_after, reference, notes, created_by,
          source_type, source_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        req.user.tenantId,
        req.params.id,
        movementType,
        formatFixed(delta, 3),
        formatFixed(before, 3),
        formatFixed(after, 3),
        metadata.reference,
        metadata.notes,
        isUuid(req.user.userId) ? req.user.userId : null,
        movementType === 'receipt' ? 'manual_receipt' : 'inventory_adjustment',
        null
      ]
    )
    const movementId = movement.rows[0].id
    if (movementType === 'receipt') {
      await valueReceipt(client, {
        tenantId: req.user.tenantId, userId: req.user.userId,
        productId: req.params.id, quantity: formatFixed(delta, 3),
        unitCost: req.body?.unit_cost, entryDate: req.body?.entry_date || new Date().toISOString().slice(0, 10),
        sourceType: 'manual_receipt', sourceId: movementId,
        sourceReference: metadata.reference, movementId
      })
    } else if (movementType === 'return') {
      await valueReturn(client, {
        tenantId: req.user.tenantId, userId: req.user.userId,
        productId: req.params.id, quantity: formatFixed(delta, 3),
        entryDate: req.body?.entry_date || new Date().toISOString().slice(0, 10),
        sourceType: 'inventory_return', sourceId: movementId,
        sourceReference: metadata.reference, movementId
      })
    } else {
      await valueAdjustment(client, {
        tenantId: req.user.tenantId, userId: req.user.userId,
        productId: req.params.id, quantityDelta: formatFixed(delta, 3),
        unitCost: req.body?.unit_cost, entryDate: req.body?.entry_date || new Date().toISOString().slice(0, 10),
        sourceType: 'inventory_adjustment', sourceId: movementId,
        sourceReference: metadata.reference, movementId
      })
    }

    await client.query('COMMIT')
    transactionOpen = false
    res.status(201).json({ product: updated.rows[0], movement: movement.rows[0] })
  } catch (err) {
    if (client && transactionOpen) {
      try {
        await client.query('ROLLBACK')
        transactionOpen = false
      } catch (rollbackError) {
        releaseError = rollbackError
        logSafeError('Failed to roll back stock transaction', rollbackError)
      }
    }
    logAndRespond(err, res, 'Failed to update stock')
  } finally {
    if (client) client.release(releaseError)
  }
}

router.post('/:id/receive', auth, async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Product not found' })
  const quantity = parseFixed(req.body?.quantity, 3)
  const metadata = parseMovementMetadata(req.body)
  if (quantity === null || quantity <= 0n || !metadata) {
    return res.status(400).json({ error: 'Enter a positive quantity and valid reference or notes' })
  }
  return changeStock(req, res, 'receipt', quantity, metadata)
})

router.post('/:id/adjust', auth, async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Product not found' })
  const delta = parseFixed(req.body?.quantity_delta, 3, true)
  const metadata = parseMovementMetadata(req.body)
  if (delta === null || delta === 0n || !metadata) {
    return res.status(400).json({ error: 'Enter a non-zero adjustment and valid reference or notes' })
  }
  return changeStock(req, res, 'adjustment', delta, metadata)
})

router.post('/:id/return', auth, async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Product not found' })
  const quantity = parseFixed(req.body?.quantity, 3)
  const metadata = parseMovementMetadata(req.body)
  if (quantity === null || quantity <= 0n || !metadata) {
    return res.status(400).json({ error: 'Enter a positive quantity and valid reference or notes' })
  }
  return changeStock(req, res, 'return', quantity, metadata)
})

router.patch('/:id/status', auth, async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Product not found' })
  const isActive = req.body?.is_active
  if (typeof isActive !== 'boolean') {
    return res.status(400).json({ error: 'is_active must be true or false' })
  }

  try {
    const result = await pool.query(
      `UPDATE products
       SET is_active = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND tenant_id = $3
       RETURNING *`,
      [isActive, req.params.id, req.user.tenantId]
    )
    if (result.rowCount === 0) return res.status(404).json({ error: 'Product not found' })
    res.json(result.rows[0])
  } catch (err) {
    logAndRespond(err, res, 'Failed to update product status')
  }
})

router.get('/:id', auth, async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Product not found' })
  try {
    const result = await pool.query(
      `SELECT * FROM products WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.user.tenantId]
    )
    if (result.rowCount === 0) return res.status(404).json({ error: 'Product not found' })
    res.json(result.rows[0])
  } catch (err) {
    logAndRespond(err, res, 'Failed to fetch product')
  }
})

router.put('/:id', auth, async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Product not found' })
  const product = parseProduct(req.body)
  if (!product) {
    return res.status(400).json({ error: 'Enter a valid name, SKU, unit, prices and low-stock threshold' })
  }

  try {
    const result = await pool.query(
      `UPDATE products
       SET name = $1, sku = $2, description = $3, unit_of_measure = $4,
           cost_price = $5, selling_price = $6, low_stock_threshold = $7,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $8 AND tenant_id = $9
       RETURNING *`,
      [
        product.name,
        product.sku,
        product.description,
        product.unit_of_measure,
        product.cost_price,
        product.selling_price,
        product.low_stock_threshold,
        req.params.id,
        req.user.tenantId
      ]
    )
    if (result.rowCount === 0) return res.status(404).json({ error: 'Product not found' })
    res.json(result.rows[0])
  } catch (err) {
    logAndRespond(err, res, 'Failed to update product')
  }
})

module.exports = router

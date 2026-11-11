const express = require('express')
const { validate: isUuid } = require('uuid')
const pool = require('../config/db')
const auth = require('../middleware/auth')
const { logSafeError } = require('../utils/errorLogging')
const { normalizeSupplier } = require('../utils/purchasing')

const router = express.Router()

function validIdOr404(id, res, message = 'Supplier not found') {
  if (!isUuid(id)) {
    res.status(404).json({ error: message })
    return false
  }
  return true
}

router.get('/', auth, async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : ''
  const active = ['true', 'false'].includes(req.query.active) ? req.query.active === 'true' : null
  try {
    const result = await pool.query(
      `SELECT s.*,
              (SELECT COUNT(*)::integer FROM purchase_orders po
               WHERE po.tenant_id = s.tenant_id AND po.supplier_id = s.id) AS purchase_order_count
       FROM suppliers s
       WHERE s.tenant_id = $1
         AND ($2 = '' OR s.business_name ILIKE '%' || $2 || '%'
              OR COALESCE(s.contact_person, '') ILIKE '%' || $2 || '%'
              OR COALESCE(s.email, '') ILIKE '%' || $2 || '%')
         AND ($3::boolean IS NULL OR s.is_active = $3)
       ORDER BY s.is_active DESC, lower(s.business_name), s.id`,
      [req.user.tenantId, search, active]
    )
    res.json(result.rows)
  } catch (err) {
    logSafeError('Failed to fetch suppliers', err)
    res.status(500).json({ error: 'Failed to fetch suppliers' })
  }
})

router.post('/', auth, async (req, res) => {
  let supplier
  try {
    supplier = normalizeSupplier(req.body)
  } catch (err) {
    return res.status(err.statusCode || 400).json({ error: err.message })
  }
  try {
    const result = await pool.query(
      `INSERT INTO suppliers
         (tenant_id, business_name, contact_person, email, phone, address, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.user.tenantId, supplier.business_name, supplier.contact_person,
        supplier.email, supplier.phone, supplier.address, supplier.notes]
    )
    res.status(201).json(result.rows[0])
  } catch (err) {
    logSafeError('Failed to create supplier', err)
    res.status(500).json({ error: 'Failed to create supplier' })
  }
})

router.get('/:id/purchase-orders', auth, async (req, res) => {
  if (!validIdOr404(req.params.id, res)) return
  try {
    const supplier = await pool.query(
      `SELECT id FROM suppliers WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.user.tenantId]
    )
    if (supplier.rowCount !== 1) return res.status(404).json({ error: 'Supplier not found' })
    const result = await pool.query(
      `SELECT po.*,
              (SELECT COUNT(*)::integer FROM purchase_order_items poi
               WHERE poi.tenant_id = po.tenant_id AND poi.purchase_order_id = po.id) AS item_count
       FROM purchase_orders po
       WHERE po.tenant_id = $1 AND po.supplier_id = $2
       ORDER BY po.order_date DESC, po.created_at DESC, po.id DESC`,
      [req.user.tenantId, req.params.id]
    )
    res.json(result.rows)
  } catch (err) {
    logSafeError('Failed to fetch supplier purchase history', err)
    res.status(500).json({ error: 'Failed to fetch supplier purchase history' })
  }
})

router.get('/:id', auth, async (req, res) => {
  if (!validIdOr404(req.params.id, res)) return
  try {
    const result = await pool.query(
      `SELECT s.*,
              (SELECT COUNT(*)::integer FROM purchase_orders po
               WHERE po.tenant_id = s.tenant_id AND po.supplier_id = s.id) AS purchase_order_count
       FROM suppliers s WHERE s.id = $1 AND s.tenant_id = $2`,
      [req.params.id, req.user.tenantId]
    )
    if (result.rowCount !== 1) return res.status(404).json({ error: 'Supplier not found' })
    res.json(result.rows[0])
  } catch (err) {
    logSafeError('Failed to fetch supplier', err)
    res.status(500).json({ error: 'Failed to fetch supplier' })
  }
})

router.put('/:id', auth, async (req, res) => {
  if (!validIdOr404(req.params.id, res)) return
  let supplier
  try {
    supplier = normalizeSupplier(req.body)
  } catch (err) {
    return res.status(err.statusCode || 400).json({ error: err.message })
  }
  try {
    const result = await pool.query(
      `UPDATE suppliers
       SET business_name = $1, contact_person = $2, email = $3, phone = $4,
           address = $5, notes = $6, updated_at = CURRENT_TIMESTAMP
       WHERE id = $7 AND tenant_id = $8
       RETURNING *`,
      [supplier.business_name, supplier.contact_person, supplier.email, supplier.phone,
        supplier.address, supplier.notes, req.params.id, req.user.tenantId]
    )
    if (result.rowCount !== 1) return res.status(404).json({ error: 'Supplier not found' })
    res.json(result.rows[0])
  } catch (err) {
    logSafeError('Failed to update supplier', err)
    res.status(500).json({ error: 'Failed to update supplier' })
  }
})

router.patch('/:id/status', auth, async (req, res) => {
  if (!validIdOr404(req.params.id, res)) return
  const isActive = req.body && req.body.is_active
  if (typeof isActive !== 'boolean') {
    return res.status(400).json({ error: 'is_active must be a boolean' })
  }
  try {
    const result = await pool.query(
      `UPDATE suppliers
       SET is_active = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND tenant_id = $3
       RETURNING *`,
      [isActive, req.params.id, req.user.tenantId]
    )
    if (result.rowCount !== 1) return res.status(404).json({ error: 'Supplier not found' })
    res.json(result.rows[0])
  } catch (err) {
    logSafeError('Failed to update supplier status', err)
    res.status(500).json({ error: 'Failed to update supplier status' })
  }
})

module.exports = router

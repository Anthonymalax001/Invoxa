const express = require('express')
const pool = require('../config/db')
const auth = require('../middleware/auth')
const { generateInvoicePDF } = require('../config/pdf')

const router = express.Router()

router.get('/', auth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE invoices 
       SET status = 'overdue'
       WHERE tenant_id = $1
       AND status = 'sent'
       AND due_date < CURRENT_DATE`,
      [req.user.tenantId]
    )
    const result = await pool.query(
      `SELECT i.*, c.name AS client_name, c.email AS client_email
       FROM invoices i
       JOIN clients c ON i.client_id = c.id
       WHERE i.tenant_id = $1
       ORDER BY i.created_at DESC`,
      [req.user.tenantId]
    )
    res.json(result.rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch invoices' })
  }
})

router.get('/:id/pdf', auth, async (req, res) => {
  try {
    const invoiceResult = await pool.query(
      `SELECT i.*, c.name AS client_name, c.email AS client_email,
              c.phone AS client_phone, c.address AS client_address
       FROM invoices i
       JOIN clients c ON i.client_id = c.id
       WHERE i.id = $1 AND i.tenant_id = $2`,
      [req.params.id, req.user.tenantId]
    )
    if (invoiceResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' })
    }
    const invoice = invoiceResult.rows[0]
    const itemsResult = await pool.query(
      `SELECT * FROM invoice_items WHERE invoice_id = $1`,
      [req.params.id]
    )
    const tenantResult = await pool.query(
      `SELECT * FROM tenants WHERE id = $1`,
      [req.user.tenantId]
    )
    const tenant = tenantResult.rows[0]
    const pdfBuffer = await generateInvoicePDF(invoice, itemsResult.rows, tenant)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename=${invoice.invoice_number}.pdf`)
    res.send(pdfBuffer)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to generate PDF' })
  }
})

router.get('/:id', auth, async (req, res) => {
  try {
    const invoice = await pool.query(
      `SELECT i.*, c.name AS client_name, c.email AS client_email,
              c.phone AS client_phone, c.address AS client_address
       FROM invoices i
       JOIN clients c ON i.client_id = c.id
       WHERE i.id = $1 AND i.tenant_id = $2`,
      [req.params.id, req.user.tenantId]
    )
    if (invoice.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' })
    }
    const items = await pool.query(
      `SELECT * FROM invoice_items WHERE invoice_id = $1`,
      [req.params.id]
    )
    res.json({ ...invoice.rows[0], items: items.rows })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch invoice' })
  }
})

router.post('/', auth, async (req, res) => {
  const { client_id, due_date, tax_rate, notes, items } = req.body
  if (!client_id || !items || items.length === 0) {
    return res.status(400).json({ error: 'Client and at least one item are required' })
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const countResult = await client.query(
      `SELECT COUNT(*) FROM invoices WHERE tenant_id = $1`,
      [req.user.tenantId]
    )
    const count = parseInt(countResult.rows[0].count) + 1
    const invoiceNumber = `INV-${String(count).padStart(4, '0')}`
    const subtotal = items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0)
    const rate = tax_rate ?? 16
    const taxAmount = (subtotal * rate) / 100
    const total = subtotal + taxAmount
    const invoiceResult = await client.query(
      `INSERT INTO invoices (tenant_id, client_id, invoice_number, due_date, subtotal, tax_rate, tax_amount, total, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [req.user.tenantId, client_id, invoiceNumber, due_date || null, subtotal, rate, taxAmount, total, notes || null]
    )
    const invoice = invoiceResult.rows[0]
    for (const item of items) {
      const amount = item.quantity * item.unit_price
      await client.query(
        `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount)
         VALUES ($1, $2, $3, $4, $5)`,
        [invoice.id, item.description, item.quantity, item.unit_price, amount]
      )
    }
    await client.query('COMMIT')
    res.status(201).json({ ...invoice, items })
  } catch (err) {
    await client.query('ROLLBACK')
    console.error(err)
    res.status(500).json({ error: 'Failed to create invoice' })
  } finally {
    client.release()
  }
})

router.patch('/:id/status', auth, async (req, res) => {
  const { status } = req.body
  const validStatuses = ['draft', 'sent', 'paid', 'overdue']
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' })
  }
  try {
    const result = await pool.query(
      `UPDATE invoices SET status=$1 WHERE id=$2 AND tenant_id=$3 RETURNING *`,
      [status, req.params.id, req.user.tenantId]
    )
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' })
    }
    res.json(result.rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to update status' })
  }
})

router.delete('/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM invoices WHERE id=$1 AND tenant_id=$2 RETURNING id`,
      [req.params.id, req.user.tenantId]
    )
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' })
    }
    res.json({ message: 'Invoice deleted successfully' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to delete invoice' })
  }
})

module.exports = router
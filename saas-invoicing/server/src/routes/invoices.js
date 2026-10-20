const express = require('express')
const { validate: isUuid } = require('uuid')
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
       JOIN clients c ON i.client_id = c.id AND c.tenant_id = i.tenant_id
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
       JOIN clients c ON i.client_id = c.id AND c.tenant_id = i.tenant_id
       WHERE i.id = $1 AND i.tenant_id = $2`,
      [req.params.id, req.user.tenantId]
    )
    if (invoiceResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' })
    }
    const invoice = invoiceResult.rows[0]
    const itemsResult = await pool.query(
      `SELECT ii.*
       FROM invoice_items ii
       JOIN invoices i ON i.id = ii.invoice_id
       WHERE i.id = $1 AND i.tenant_id = $2`,
      [req.params.id, req.user.tenantId]
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
       JOIN clients c ON i.client_id = c.id AND c.tenant_id = i.tenant_id
       WHERE i.id = $1 AND i.tenant_id = $2`,
      [req.params.id, req.user.tenantId]
    )
    if (invoice.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' })
    }
    const items = await pool.query(
      `SELECT ii.*
       FROM invoice_items ii
       JOIN invoices i ON i.id = ii.invoice_id
       WHERE i.id = $1 AND i.tenant_id = $2`,
      [req.params.id, req.user.tenantId]
    )
    res.json({ ...invoice.rows[0], items: items.rows })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch invoice' })
  }
})

router.post('/', auth, async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {}
  const { client_id, due_date, tax_rate, notes, items } = body
  const hasNumericValue = (value) =>
    (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) &&
    Number.isFinite(Number(value))
  const validItems = Array.isArray(items) && items.length > 0 && items.every((item) =>
    item &&
    typeof item.description === 'string' &&
    item.description.trim() !== '' &&
    hasNumericValue(item.quantity) &&
    Number(item.quantity) > 0 &&
    hasNumericValue(item.unit_price) &&
    Number(item.unit_price) >= 0
  )

  if (!isUuid(client_id) || !validItems) {
    return res.status(400).json({ error: 'Client and valid invoice items are required' })
  }
  let client
  let transactionOpen = false
  let releaseError
  try {
    client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      transactionOpen = true
    } catch (err) {
      // A failed BEGIN can leave the connection state uncertain. Discard it.
      releaseError = err
      throw err
    }

    const tenantResult = await client.query(
      `SELECT id FROM tenants WHERE id = $1 FOR UPDATE`,
      [req.user.tenantId]
    )
    if (tenantResult.rowCount !== 1) {
      const err = new Error('Invoice context not found')
      err.statusCode = 404
      throw err
    }

    const clientResult = await client.query(
      `SELECT id FROM clients WHERE id = $1 AND tenant_id = $2 FOR SHARE`,
      [client_id, req.user.tenantId]
    )
    if (clientResult.rowCount !== 1) {
      const err = new Error('Invoice context not found')
      err.statusCode = 404
      throw err
    }

    const nextNumberResult = await client.query(
      `SELECT COALESCE(
         MAX(SUBSTRING(invoice_number FROM '^INV-([0-9]+)$')::numeric),
         0
       ) + 1 AS next_number
       FROM invoices
       WHERE tenant_id = $1
         AND invoice_number ~ '^INV-[0-9]+$'`,
      [req.user.tenantId]
    )
    const invoiceNumber = `INV-${String(nextNumberResult.rows[0].next_number).padStart(4, '0')}`
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
    transactionOpen = false
    res.status(201).json({ ...invoice, items })
  } catch (err) {
    if (client && transactionOpen) {
      try {
        await client.query('ROLLBACK')
        transactionOpen = false
      } catch (rollbackError) {
        // pg-pool destroys a client released with an error instead of reusing it.
        releaseError = rollbackError
        console.error('Failed to roll back invoice transaction', rollbackError)
      }
    }
    if (err.statusCode === 404) {
      return res.status(404).json({ error: 'Client not found' })
    }
    console.error(err)
    res.status(500).json({ error: 'Failed to create invoice' })
  } finally {
    if (client) {
      client.release(releaseError)
    }
  }
})

router.patch('/:id/status', auth, async (req, res) => {
  const { status } = req.body || {}
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

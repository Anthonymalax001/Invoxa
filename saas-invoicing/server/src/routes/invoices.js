const express = require('express')
const { validate: isUuid } = require('uuid')
const pool = require('../config/db')
const auth = require('../middleware/auth')
const { generateInvoicePDF } = require('../config/pdf')
const { requireAccountingPermission } = require('../middleware/accountingAuthorization')
const { finalizeInvoice } = require('../services/invoiceAccounting')
const { calculateTaxTotals, dateOnly, normalizeDirectInvoiceItems } = require('../utils/invoiceTax')
const { loadTaxProfile, saveTaxSnapshot } = require('../services/invoiceTax')
const { logSafeError } = require('../utils/errorLogging')

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
    logSafeError('Failed to fetch invoices', err)
    res.status(500).json({ error: 'Failed to fetch invoices' })
  }
})

router.get('/:id/pdf', auth, async (req, res) => {
  try {
    const invoiceResult = await pool.query(
      `SELECT i.*, c.name AS client_name, c.email AS client_email,
              c.phone AS client_phone, c.address AS client_address,
              tax.profile_name AS tax_profile_name,
              tax.calculation_method AS tax_calculation_method
       FROM invoices i
       JOIN clients c ON i.client_id = c.id AND c.tenant_id = i.tenant_id
       LEFT JOIN accounting_invoice_tax_snapshots tax
         ON tax.tenant_id = i.tenant_id AND tax.source_type = 'invoice' AND tax.source_id = i.id
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
    logSafeError('Failed to generate invoice PDF', err)
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
    logSafeError('Failed to fetch invoice', err)
    res.status(500).json({ error: 'Failed to fetch invoice' })
  }
})

router.post('/', auth, async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {}
  const { client_id, due_date, tax_profile_id, notes, items } = body
  let normalizedItems
  let normalizedDueDate = null
  let normalizedNotes = null
  try {
    if (!isUuid(client_id) || !isUuid(tax_profile_id)) throw new Error('Client and tax profile are required')
    if (body.currency != null && body.currency !== 'KES') {
      const error = new Error('New invoices are KES-only; currency conversion is not supported')
      error.statusCode = 400
      throw error
    }
    if (due_date) normalizedDueDate = dateOnly(due_date, 'Due date')
    if (notes != null) {
      if (typeof notes !== 'string' || notes.length > 10000) {
        const error = new Error('Notes must be text of 10000 characters or fewer')
        error.statusCode = 400
        throw error
      }
      normalizedNotes = notes.trim() || null
    }
    normalizedItems = normalizeDirectInvoiceItems(items)
  } catch (err) {
    return res.status(err.statusCode || 400).json({ error: err.message || 'Client, tax profile and valid invoice items are required' })
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

    const currentDate = await client.query('SELECT CURRENT_DATE::text AS issue_date')
    const profile = await loadTaxProfile(client, req.user.tenantId, tax_profile_id,
      String(currentDate.rows[0].issue_date).slice(0, 10))
    const totals = calculateTaxTotals(normalizedItems.map((item) => item.amountUnits), profile)

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
    const invoiceResult = await client.query(
      `INSERT INTO invoices
         (tenant_id, client_id, invoice_number, due_date, subtotal, tax_rate, tax_amount, total, notes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft') RETURNING *`,
      [req.user.tenantId, client_id, invoiceNumber, normalizedDueDate,
        totals.subtotal, profile.tax_rate, totals.tax_amount, totals.total,
        normalizedNotes]
    )
    const invoice = invoiceResult.rows[0]
    for (const item of normalizedItems) {
      await client.query(
        `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount)
         VALUES ($1, $2, $3, $4, $5)`,
        [invoice.id, item.description, item.quantity, item.unit_price, item.amount]
      )
    }
    await saveTaxSnapshot(client, {
      tenantId: req.user.tenantId,
      sourceType: 'invoice',
      sourceId: invoice.id,
      profile,
      totals,
      userId: req.user.userId
    })
    await client.query('COMMIT')
    transactionOpen = false
    res.status(201).json({ ...invoice, items: normalizedItems.map(({ amountUnits, ...item }) => item) })
  } catch (err) {
    if (client && transactionOpen) {
      try {
        await client.query('ROLLBACK')
        transactionOpen = false
      } catch (rollbackError) {
        // pg-pool destroys a client released with an error instead of reusing it.
        releaseError = rollbackError
        logSafeError('Failed to roll back invoice transaction', rollbackError)
      }
    }
    if (err.statusCode === 404) {
      return res.status(404).json({ error: err.message === 'Tax profile not found' ? 'Tax profile not found' : 'Client not found' })
    }
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message })
    logSafeError('Failed to create invoice', err)
    res.status(500).json({ error: 'Failed to create invoice' })
  } finally {
    if (client) {
      client.release(releaseError)
    }
  }
})

router.post('/:id/finalize', auth, requireAccountingPermission('accounting:issue-invoices'), async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Invoice not found' })
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
  if (Object.keys(body).some((key) => key !== 'issue_date')) {
    return res.status(400).json({ error: 'Only the optional issue_date may be supplied' })
  }
  try {
    const result = await finalizeInvoice(pool, {
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      invoiceId: req.params.id,
      issueDate: body.issue_date
    })
    res.status(result.replayed ? 200 : 201).json(result)
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message })
    if (['23503', '23514', '23P01', '23505'].includes(error.code)) {
      return res.status(409).json({ error: 'Invoice issuance violates an accounting integrity rule' })
    }
    logSafeError('Invoice finalization failed', error)
    res.status(500).json({ error: 'Failed to finalize invoice' })
  }
})

router.patch('/:id/status', auth, async (req, res) => {
  const { status } = req.body || {}
  if (status === 'sent' || status === 'paid') {
    try {
      const owned = await pool.query(
        'SELECT id FROM invoices WHERE id = $1 AND tenant_id = $2',
        [req.params.id, req.user.tenantId]
      )
      if (owned.rowCount !== 1) return res.status(404).json({ error: 'Invoice not found' })
    } catch (err) {
      logSafeError('Failed to verify invoice status request', err)
      return res.status(500).json({ error: 'Failed to update status' })
    }
    return res.status(409).json({ error: 'Use the authorized invoice issuance or verified payment workflow for this status' })
  }
  if (status !== 'overdue') {
    return res.status(400).json({ error: 'Only overdue status may be set through this endpoint' })
  }
  try {
    const result = await pool.query(
      `UPDATE invoices SET status='overdue' WHERE id=$1 AND tenant_id=$2
         AND status IN ('sent', 'overdue') RETURNING *`,
      [req.params.id, req.user.tenantId]
    )
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found or not eligible for overdue status' })
    }
    res.json(result.rows[0])
  } catch (err) {
    logSafeError('Failed to update invoice status', err)
    res.status(500).json({ error: 'Failed to update status' })
  }
})

router.delete('/:id', auth, async (req, res) => {
  let client
  let transactionOpen = false
  let releaseError
  try {
    client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      transactionOpen = true
    } catch (beginError) {
      releaseError = beginError
      throw beginError
    }
    const current = await client.query(
      `SELECT id, status FROM invoices WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [req.params.id, req.user.tenantId]
    )
    if (current.rowCount !== 1) {
      await client.query('ROLLBACK')
      transactionOpen = false
      return res.status(404).json({ error: 'Invoice not found' })
    }
    if (current.rows[0].status !== 'draft') {
      await client.query('ROLLBACK')
      transactionOpen = false
      return res.status(409).json({ error: 'Only draft invoices can be deleted' })
    }
    await client.query(
      `DELETE FROM accounting_invoice_tax_snapshots
       WHERE tenant_id = $1 AND source_type = 'invoice' AND source_id = $2 AND issued_at IS NULL`,
      [req.user.tenantId, req.params.id]
    )
    const result = await client.query(
      `DELETE FROM invoices WHERE id = $1 AND tenant_id = $2 AND status = 'draft' RETURNING id`,
      [req.params.id, req.user.tenantId]
    )
    if (result.rowCount !== 1) throw new Error('Invoice could not be deleted')
    await client.query('COMMIT')
    transactionOpen = false
    res.json({ message: 'Invoice deleted successfully' })
  } catch (err) {
    if (client && transactionOpen) {
      try { await client.query('ROLLBACK'); transactionOpen = false } catch (rollbackError) {
        releaseError = rollbackError
        logSafeError('Failed to roll back invoice deletion', rollbackError)
      }
    }
    logSafeError('Failed to delete invoice', err)
    res.status(500).json({ error: 'Failed to delete invoice' })
  } finally {
    if (client) client.release(releaseError)
  }
})

module.exports = router

const { validate: isUuid } = require('uuid')
const { postJournal, withTransaction } = require('./accounting')
const { httpError } = require('../utils/accounting')
const {
  calculateTaxTotals,
  formatUnits,
  lineAmountUnits,
  MAX_MONEY_UNITS,
  parseUnits,
  dateOnly
} = require('../utils/invoiceTax')
const { loadTaxProfileBySnapshot } = require('./invoiceTax')

function sameMoney(left, right, label) {
  const a = parseUnits(String(left), 2, 10, label)
  const b = parseUnits(String(right), 2, 10, label)
  return a === b
}

function sumInvoiceLines(rows, { salesOrder = false } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) throw httpError(409, 'Invoice must contain at least one valid line')
  let grossUnits = 0n
  let quantityUnits = 0n
  for (const row of rows) {
    const quantity = parseUnits(String(row.quantity), 2, 8, 'Invoice line quantity', { allowZero: false })
    const amount = parseUnits(String(row.amount), 2, 10, 'Invoice line amount')
    if (!salesOrder) {
      const expected = lineAmountUnits(String(row.quantity), String(row.unit_price), 'Invoice line')
      if (expected !== amount) throw httpError(409, 'Invoice line amount does not match its quantity and unit price')
    }
    grossUnits += amount
    quantityUnits += quantity
    if (grossUnits > MAX_MONEY_UNITS || quantityUnits > 9999999999n * BigInt(rows.length)) {
      throw httpError(409, 'Invoice line totals exceed the supported range')
    }
  }
  return { grossUnits, quantityUnits }
}

async function loadInvoice(client, tenantId, invoiceId) {
  const result = await client.query(
    `SELECT i.*, c.id AS verified_client_id
     FROM invoices i
     JOIN clients c ON c.id = i.client_id AND c.tenant_id = i.tenant_id
     WHERE i.id = $1 AND i.tenant_id = $2
     FOR UPDATE OF i`,
    [invoiceId, tenantId]
  )
  if (result.rowCount !== 1) throw httpError(404, 'Invoice not found')
  return result.rows[0]
}

async function loadInvoiceSnapshot(client, tenantId, invoiceId) {
  const result = await client.query(
    `SELECT * FROM accounting_invoice_tax_snapshots
     WHERE tenant_id = $1 AND source_type = 'invoice' AND source_id = $2
     FOR UPDATE`,
    [tenantId, invoiceId]
  )
  if (result.rowCount !== 1) throw httpError(409, 'Invoice has no saved tax calculation; create a new draft before issuance')
  return result.rows[0]
}

async function verifySalesOrderInvoice(client, tenantId, invoice, invoiceLines, invoiceAmounts) {
  const orderResult = await client.query(
    `SELECT id, client_id, status, subtotal, tax_rate, tax_amount, total
     FROM sales_orders WHERE tenant_id = $1 AND id = $2 FOR SHARE`,
    [tenantId, invoice.sales_order_id]
  )
  if (orderResult.rowCount !== 1) throw httpError(409, 'Linked sales order is unavailable')
  const order = orderResult.rows[0]
  if (order.client_id !== invoice.client_id || order.status !== 'fulfilled') {
    throw httpError(409, 'Linked sales order is not fully fulfilled for this invoice client')
  }
  const lines = await client.query(
    `SELECT quantity_ordered, line_subtotal FROM sales_order_items
     WHERE tenant_id = $1 AND sales_order_id = $2
     ORDER BY created_at, id FOR SHARE`,
    [tenantId, order.id]
  )
  if (lines.rowCount !== invoiceLines.length || lines.rowCount === 0) {
    throw httpError(409, 'Invoice lines do not match the linked sales order')
  }
  let orderAmounts = 0n
  let orderQuantities = 0n
  for (const line of lines.rows) {
    orderAmounts += parseUnits(String(line.line_subtotal), 2, 10, 'Sales order line amount')
    orderQuantities += parseUnits(String(line.quantity_ordered), 2, 8, 'Sales order quantity', { allowZero: false })
  }
  if (orderAmounts !== invoiceAmounts.grossUnits || orderQuantities !== invoiceAmounts.quantityUnits ||
      !sameMoney(order.subtotal, invoice.subtotal, 'Sales order subtotal') ||
      !sameMoney(order.tax_rate, invoice.tax_rate, 'Sales order tax rate') ||
      !sameMoney(order.tax_amount, invoice.tax_amount, 'Sales order tax amount') ||
      !sameMoney(order.total, invoice.total, 'Sales order total')) {
    throw httpError(409, 'Invoice amounts do not match the linked sales order')
  }
}

async function getAccountMappings(client, tenantId, snapshot) {
  const mappingsResult = await client.query(
    `SELECT receivables_account_id, sales_revenue_account_id
     FROM accounting_invoice_mappings WHERE tenant_id = $1 FOR SHARE`,
    [tenantId]
  )
  if (mappingsResult.rowCount !== 1) throw httpError(409, 'Configure invoice receivables and revenue accounts before issuance')
  const mappings = mappingsResult.rows[0]
  const accountIds = [mappings.receivables_account_id, mappings.sales_revenue_account_id]
  if (snapshot.tax_payable_account_id) accountIds.push(snapshot.tax_payable_account_id)
  const accounts = await client.query(
    `SELECT id, account_type, is_active FROM accounting_accounts
     WHERE tenant_id = $1 AND id = ANY($2::uuid[]) FOR SHARE`,
    [tenantId, [...new Set(accountIds)]]
  )
  const byId = new Map(accounts.rows.map((row) => [row.id, row]))
  const expected = [
    [mappings.receivables_account_id, 'asset'],
    [mappings.sales_revenue_account_id, 'revenue']
  ]
  const taxUnits = parseUnits(String(snapshot.tax_amount), 2, 10, 'Invoice tax amount')
  if (snapshot.requires_tax_payable) {
    if (!snapshot.tax_payable_account_id) {
      throw httpError(409, 'Tax profile requires an explicit tax payable mapping')
    }
    expected.push([snapshot.tax_payable_account_id, 'liability'])
  } else if (taxUnits > 0n) {
    throw httpError(409, 'Tax profile requires an explicit tax payable mapping')
  }
  for (const [id, accountType] of expected) {
    const account = byId.get(id)
    if (!account || !account.is_active || account.account_type !== accountType) {
      throw httpError(409, `Invoice mapping requires an active ${accountType} account`)
    }
  }
  return mappings
}

async function findPeriod(client, tenantId, issueDate) {
  const result = await client.query(
    `SELECT id FROM accounting_periods
     WHERE tenant_id = $1 AND status = 'open' AND $2::date BETWEEN starts_on AND ends_on
     FOR SHARE`,
    [tenantId, issueDate]
  )
  if (result.rowCount !== 1) throw httpError(409, 'No single open accounting period covers the invoice issue date')
  return result.rows[0].id
}

async function readJournal(client, tenantId, journalId) {
  const result = await client.query(
    `SELECT * FROM accounting_journal_entries
     WHERE tenant_id = $1 AND id = $2 AND status = 'posted'`,
    [tenantId, journalId]
  )
  if (result.rowCount !== 1) throw httpError(409, 'Invoice posting journal is unavailable')
  const lines = await client.query(
    `SELECT line_number, account_id, description, debit, credit,
            transaction_currency, transaction_amount, exchange_rate,
            exchange_rate_source, exchange_rate_at
     FROM accounting_journal_lines
     WHERE tenant_id = $1 AND journal_entry_id = $2 ORDER BY line_number`,
    [tenantId, journalId]
  )
  return { journal: result.rows[0], lines: lines.rows, replayed: true }
}

async function finalizeInvoice(pool, { tenantId, userId, invoiceId, issueDate }) {
  if (!isUuid(tenantId) || !isUuid(userId) || !isUuid(invoiceId)) {
    throw httpError(401, 'Authenticated tenant and user identities are required')
  }
  const requestedIssueDate = issueDate == null ? null : dateOnly(issueDate, 'Invoice issue date')
  return withTransaction(pool, async (client) => {
    const invoice = await loadInvoice(client, tenantId, invoiceId)
    const snapshot = await loadInvoiceSnapshot(client, tenantId, invoiceId)

    if (snapshot.issued_at) {
      const storedDate = String(snapshot.issued_on).slice(0, 10)
      if (requestedIssueDate && requestedIssueDate !== storedDate) {
        throw httpError(409, 'Invoice was already issued with a different issue date')
      }
      if (!['sent', 'overdue', 'paid'].includes(invoice.status)) {
        throw httpError(409, 'Invoice issue state does not match its accounting snapshot')
      }
      return readJournal(client, tenantId, snapshot.journal_entry_id)
    }

    if (invoice.status !== 'draft') {
      throw httpError(409, 'A previously issued invoice without a matching posting snapshot requires an approved cutover review')
    }

    const issueDateResult = requestedIssueDate
      ? { rows: [{ issue_date: requestedIssueDate }] }
      : await client.query('SELECT CURRENT_DATE::text AS issue_date')
    const issueDateToUse = String(issueDateResult.rows[0].issue_date).slice(0, 10)
    const profile = await loadTaxProfileBySnapshot(client, tenantId, { ...snapshot, issued_on: issueDateToUse })
    const settings = await client.query(
      'SELECT base_currency FROM accounting_settings WHERE tenant_id = $1 FOR SHARE',
      [tenantId]
    )
    if (settings.rowCount !== 1 || settings.rows[0].base_currency !== 'KES') {
      throw httpError(409, 'Invoice ledger posting requires tenant accounting base currency KES')
    }
    const taxSnapshot = { ...snapshot, tax_rate: profile.tax_rate }
    const lineResult = await client.query(
      `SELECT invoice_id, description, quantity, unit_price, amount
     FROM invoice_items WHERE invoice_id = $1 FOR SHARE`,
      [invoiceId]
    )
    const invoiceAmounts = sumInvoiceLines(lineResult.rows, { salesOrder: Boolean(invoice.sales_order_id) })
    if (invoice.sales_order_id) {
      await verifySalesOrderInvoice(client, tenantId, invoice, lineResult.rows, invoiceAmounts)
    }
    const totals = calculateTaxTotals(lineResult.rows.map((line) => parseUnits(String(line.amount), 2, 10, 'Invoice line amount')), profile)
    if (!sameMoney(invoice.subtotal, totals.subtotal, 'Invoice subtotal') ||
        !sameMoney(invoice.tax_rate, profile.tax_rate, 'Invoice tax rate') ||
        !sameMoney(invoice.tax_amount, totals.tax_amount, 'Invoice tax amount') ||
        !sameMoney(invoice.total, totals.total, 'Invoice total') ||
        !sameMoney(snapshot.subtotal, totals.subtotal, 'Saved subtotal') ||
        !sameMoney(snapshot.tax_amount, totals.tax_amount, 'Saved tax amount') ||
        !sameMoney(snapshot.total, totals.total, 'Saved total')) {
      throw httpError(409, 'Invoice financial fields do not match its saved tax calculation')
    }
    const mappings = await getAccountMappings(client, tenantId, taxSnapshot)
    const periodId = await findPeriod(client, tenantId, issueDateToUse)
    const subtotalUnits = parseUnits(totals.subtotal, 2, 10, 'Invoice subtotal')
    const taxUnits = parseUnits(totals.tax_amount, 2, 10, 'Invoice tax amount')
    const totalUnits = parseUnits(totals.total, 2, 10, 'Invoice total')
    if (totalUnits <= 0n) throw httpError(409, 'Zero-value invoices cannot be posted to the ledger')
    const lines = [
      { account_id: mappings.receivables_account_id, description: `Receivable for ${invoice.invoice_number}`, debit: formatUnits(totalUnits, 2), credit: '0.00' },
      { account_id: mappings.sales_revenue_account_id, description: `Sales revenue for ${invoice.invoice_number}`, debit: '0.00', credit: formatUnits(subtotalUnits, 2) }
    ]
    if (taxUnits > 0n) {
      lines.push({
        account_id: snapshot.tax_payable_account_id,
        description: `Tax payable for ${invoice.invoice_number}`,
        debit: '0.00', credit: formatUnits(taxUnits, 2)
      })
    }
    const posted = await postJournal(pool, {
      tenantId,
      userId,
      idempotencyKey: `invoice:${invoice.id}:issue:v1`,
      body: {
        accounting_period_id: periodId,
        entry_date: issueDateToUse,
        description: `Issue invoice ${invoice.invoice_number}`,
        source_type: 'invoice',
        source_id: invoice.id,
        source_reference: invoice.invoice_number,
        event_type: 'issue',
        lines
      }
    }, { client })
    const invoiceUpdate = await client.query(
      `UPDATE invoices SET status = 'sent' WHERE id = $1 AND tenant_id = $2 AND status = 'draft'`,
      [invoiceId, tenantId]
    )
    if (invoiceUpdate.rowCount !== 1) throw httpError(409, 'Invoice could not be finalized from its current status')
    const snapshotUpdate = await client.query(
      `UPDATE accounting_invoice_tax_snapshots
       SET issued_on = $1, issued_by = $2, issued_at = CURRENT_TIMESTAMP, journal_entry_id = $3
       WHERE tenant_id = $4 AND source_type = 'invoice' AND source_id = $5 AND issued_at IS NULL`,
      [issueDateToUse, userId, posted.journal.id, tenantId, invoiceId]
    )
    if (snapshotUpdate.rowCount !== 1) throw httpError(409, 'Invoice tax snapshot could not be finalized')
    const updatedInvoice = await client.query(
      'SELECT * FROM invoices WHERE id = $1 AND tenant_id = $2', [invoiceId, tenantId]
    )
    return { invoice: updatedInvoice.rows[0], journal: posted.journal, lines: posted.lines, replayed: posted.replayed }
  })
}

module.exports = { finalizeInvoice }

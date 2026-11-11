const crypto = require('node:crypto')
const { validate: isUuid } = require('uuid')
const { assertDateNotInClosedPeriod, postJournal, reverseJournal, withTransaction } = require('./accounting')
const {
  decimal,
  decimalUnits,
  httpError,
  normalizeCurrency,
  normalizeIdempotencyKey,
  text,
  validationError
} = require('../utils/accounting')

const PAYMENT_METHODS = new Set(['cash', 'bank_transfer', 'card', 'cheque', 'mpesa', 'other'])
const BILL_STATES = new Set(['draft', 'submitted', 'approved', 'partially_paid', 'paid', 'overdue', 'cancelled', 'reversed'])
const PAYMENT_STATES = new Set(['pending', 'verified', 'failed', 'reversed'])

function requireIdentity(tenantId, userId) {
  if (!isUuid(tenantId) || !isUuid(userId)) {
    throw httpError(401, 'Authenticated tenant and user identities are required')
  }
}

function normalizeDate(value, label, { required = true } = {}) {
  if ((value == null || value === '') && !required) return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw validationError(`${label} must use YYYY-MM-DD`)
  }
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw validationError(`${label} is invalid`)
  }
  return value
}

function hashPayload(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function formatUnits(units, scale) {
  const factor = 10n ** BigInt(scale)
  return `${units / factor}.${(units % factor).toString().padStart(scale, '0')}`
}

function normalizeBillLine(source, index) {
  const label = `Bill line ${index + 1}`
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw validationError(`${label} is invalid`)
  }
  if (!isUuid(source.account_id)) throw validationError(`${label} requires an expense or asset account`)
  const quantity = decimal(source.quantity == null ? '1' : source.quantity, 3, `${label} quantity`)
  const unitPrice = decimal(source.unit_price, 2, `${label} unit price`, { allowZero: true })
  const quantityUnits = decimalUnits(quantity, 3, `${label} quantity`)
  const priceCents = decimalUnits(unitPrice, 2, `${label} unit price`, { allowZero: true })
  if (quantityUnits > 999999999999n || priceCents > 999999999999n) {
    throw validationError(`${label} quantity or unit price exceeds the supported range`)
  }
  const subtotalCents = (quantityUnits * priceCents + 500n) / 1000n
  const taxRate = decimal(source.tax_rate == null || source.tax_rate === '' ? '0' : source.tax_rate,
    2, `${label} tax rate`, { allowZero: true })
  const taxRateUnits = decimalUnits(taxRate, 2, `${label} tax rate`, { allowZero: true })
  if (taxRateUnits > 10000n) throw validationError(`${label} tax rate must not exceed 100 percent`)
  const taxCents = (subtotalCents * taxRateUnits + 5000n) / 10000n
  if (subtotalCents > 999999999999n || taxCents > 999999999999n) {
    throw validationError(`${label} total is too large`)
  }
  const purchaseOrderItemId = source.purchase_order_item_id || null
  const receiptId = source.receipt_id || null
  const receiptItemId = source.purchase_order_receipt_item_id || null
  if (purchaseOrderItemId != null && !isUuid(purchaseOrderItemId)) {
    throw validationError(`${label} has an invalid purchase order line`)
  }
  if ((receiptId == null) !== (receiptItemId == null) || (receiptId != null && !isUuid(receiptId)) ||
      (receiptItemId != null && !isUuid(receiptItemId))) {
    throw validationError(`${label} must identify both the goods receipt and its line`)
  }
  if ((receiptId != null || receiptItemId != null) && purchaseOrderItemId == null) {
    throw validationError(`${label} must identify its purchase order line when linking received goods`)
  }
  return {
    description: text(source.description, `${label} description`, 1000, { required: true }),
    quantity,
    unit_price: unitPrice,
    tax_rate: taxRate,
    line_subtotal: formatUnits(subtotalCents, 2),
    tax_amount: formatUnits(taxCents, 2),
    total: formatUnits(subtotalCents + taxCents, 2),
    account_id: source.account_id,
    purchase_order_item_id: purchaseOrderItemId,
    receipt_id: receiptId,
    purchase_order_receipt_item_id: receiptItemId
  }
}

function normalizeBillInput(body, idempotencyKey) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  if (!isUuid(source.supplier_id)) throw validationError('A valid supplier is required')
  const billDate = normalizeDate(source.bill_date, 'Bill date')
  const dueDate = normalizeDate(source.due_date, 'Due date')
  if (dueDate < billDate) throw validationError('Due date must not be before the bill date')
  const purchaseOrderId = source.purchase_order_id || null
  if (purchaseOrderId != null && !isUuid(purchaseOrderId)) {
    throw validationError('Purchase order must be a valid ID')
  }
  const linesInput = source.lines
  if (!Array.isArray(linesInput) || linesInput.length < 1 || linesInput.length > 100) {
    throw validationError('Provide between 1 and 100 bill lines')
  }
  const lines = linesInput.map(normalizeBillLine)
  if (lines.some((line) => line.purchase_order_item_id) && !purchaseOrderId) {
    throw validationError('Select the purchase order before linking a bill line')
  }
  const subtotalCents = lines.reduce((sum, line) => sum + decimalUnits(line.line_subtotal, 2, 'Line subtotal', { allowZero: true }), 0n)
  const taxCents = lines.reduce((sum, line) => sum + decimalUnits(line.tax_amount, 2, 'Line tax', { allowZero: true }), 0n)
  const totalCents = subtotalCents + taxCents
  if (subtotalCents > 999999999999n || taxCents > 999999999999n || totalCents > 999999999999n || totalCents === 0n) {
    throw validationError('Bill total must be positive and within the supported amount range')
  }
  const normalized = {
    supplier_id: source.supplier_id,
    supplier_invoice_number: text(source.supplier_invoice_number, 'Supplier invoice number', 150, { required: true }),
    bill_date: billDate,
    due_date: dueDate,
    currency: normalizeCurrency(source.currency),
    purchase_order_id: purchaseOrderId,
    notes: text(source.notes, 'Notes', 2000),
    subtotal: formatUnits(subtotalCents, 2),
    tax_amount: formatUnits(taxCents, 2),
    total: formatUnits(totalCents, 2),
    lines,
    idempotency_key: normalizeIdempotencyKey(idempotencyKey)
  }
  normalized.payload_hash = hashPayload({ ...normalized, idempotency_key: undefined })
  return normalized
}

function normalizePaymentInput(body, idempotencyKey) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  if (!isUuid(source.supplier_id)) throw validationError('A valid supplier is required')
  const paymentDate = normalizeDate(source.payment_date, 'Payment date')
  const amount = decimal(source.amount, 2, 'Payment amount')
  const currency = normalizeCurrency(source.currency)
  if (!PAYMENT_METHODS.has(source.payment_method)) throw validationError('Invalid payment method')
  const reference = text(source.payment_reference, 'Payment reference', 255, { required: true })
  if (!Array.isArray(source.allocations) || source.allocations.length < 1 || source.allocations.length > 100) {
    throw validationError('Provide between 1 and 100 bill allocations')
  }
  const allocations = source.allocations.map((allocation, index) => {
    if (!allocation || typeof allocation !== 'object' || Array.isArray(allocation) || !isUuid(allocation.bill_id)) {
      throw validationError(`Allocation ${index + 1} has an invalid bill`)
    }
    return { bill_id: allocation.bill_id, amount: decimal(allocation.amount, 2, `Allocation ${index + 1} amount`) }
  }).sort((left, right) => left.bill_id.localeCompare(right.bill_id))
  if (new Set(allocations.map((allocation) => allocation.bill_id)).size !== allocations.length) {
    throw validationError('Use one allocation amount per bill')
  }
  const allocationTotal = allocations.reduce((sum, item) => sum + decimalUnits(item.amount, 2, 'Allocation amount'), 0n)
  if (allocationTotal !== decimalUnits(amount, 2, 'Payment amount')) {
    throw validationError('Payment allocations must equal the full payment amount')
  }
  const normalized = {
    supplier_id: source.supplier_id,
    amount,
    currency,
    payment_date: paymentDate,
    payment_method: source.payment_method,
    payment_reference: reference,
    notes: text(source.notes, 'Notes', 2000),
    allocations,
    idempotency_key: normalizeIdempotencyKey(idempotencyKey)
  }
  normalized.payload_hash = hashPayload({ ...normalized, idempotency_key: undefined })
  return normalized
}

function paymentVerification(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  if (!isUuid(source.accounting_period_id)) throw validationError('A valid accounting period is required')
  if (!isUuid(source.cash_account_id)) throw validationError('A valid cash or bank account is required')
  return { accounting_period_id: source.accounting_period_id, cash_account_id: source.cash_account_id }
}

function reversalInput(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  if (!isUuid(source.accounting_period_id)) throw validationError('A valid accounting period is required')
  return {
    accounting_period_id: source.accounting_period_id,
    reversal_date: normalizeDate(source.reversal_date, 'Reversal date'),
    reason: text(source.reason, 'Reversal reason', 1800, { required: true })
  }
}

function assertApprovalAllowed(bill, userId, baseCurrency) {
  if (bill.status !== 'submitted') throw httpError(409, 'Only submitted supplier bills may be approved')
  if (bill.created_by === userId) throw httpError(403, 'The bill creator cannot approve their own bill')
  if (decimalUnits(String(bill.tax_amount), 2, 'Bill tax', { allowZero: true }) !== 0n) {
    throw httpError(409, 'Taxable supplier bills cannot be posted until an approved input-tax account mapping is configured')
  }
  if (baseCurrency !== bill.currency) {
    throw httpError(409, 'Supplier bill currency must match the configured accounting base currency; foreign-currency posting is not configured')
  }
}

function assertAllocationWithinBalance(amount, total, paid = '0.00') {
  if (decimalUnits(amount, 2, 'Allocation amount') + decimalUnits(String(paid), 2, 'Paid amount', { allowZero: true }) >
      decimalUnits(String(total), 2, 'Bill total')) {
    throw httpError(409, 'Payment allocation exceeds the supplier bill outstanding balance')
  }
}

function assertSameCurrency(left, right) {
  if (left !== right) throw httpError(409, 'Payment and supplier bill currencies must match')
}

function assertPaymentCanFail(status) {
  if (status !== 'pending') throw httpError(409, 'Only a pending supplier payment may be marked failed')
}

function assertPaymentCanVerify(payment, userId) {
  if (payment.status !== 'pending') throw httpError(409, 'Only a pending supplier payment may be verified')
  if (payment.created_by === userId) throw httpError(403, 'The payment creator cannot verify their own payment')
}

function assertPaymentCanReverse(status) {
  if (status !== 'verified') throw httpError(409, 'Only a verified supplier payment may be reversed')
}

function assertBillCanReverse(status, activePaymentStatuses = []) {
  if (status !== 'approved') throw httpError(409, 'Only an unpaid approved supplier bill may be reversed')
  if (activePaymentStatuses.includes('verified')) throw httpError(409, 'Reverse verified supplier payments before reversing this bill')
  if (activePaymentStatuses.includes('pending')) throw httpError(409, 'Fail pending supplier payments before reversing this bill')
}

function buildBillJournalLines(lines, payableAccountId, billNumber, total) {
  const journalLines = lines
    .filter((line) => decimalUnits(String(line.line_subtotal), 2, 'Bill line amount', { allowZero: true }) > 0n)
    .map((line) => ({
      account_id: line.account_id,
      description: line.description,
      debit: String(line.line_subtotal),
      credit: '0'
    }))
  journalLines.push({ account_id: payableAccountId, description: `Accounts payable for ${billNumber}`, debit: '0', credit: String(total) })
  return journalLines
}

function buildPaymentJournalLines(allocations, bills, cashAccountId, paymentNumber) {
  const grouped = new Map()
  for (const allocation of allocations) {
    const bill = bills.get(allocation.bill_id)
    if (!bill?.payable_account_id) throw httpError(409, 'Approved bill is missing its accounts payable account')
    const current = grouped.get(bill.payable_account_id) || 0n
    grouped.set(bill.payable_account_id, current + decimalUnits(allocation.amount, 2, 'Allocation amount'))
  }
  return [
    ...[...grouped.entries()].map(([accountId, amount]) => ({
      account_id: accountId, description: `Supplier payment ${paymentNumber}`,
      debit: formatUnits(amount, 2), credit: '0'
    })),
    { account_id: cashAccountId, description: `Supplier payment ${paymentNumber}`, debit: '0', credit: formatUnits(allocations.reduce((sum, item) => sum + decimalUnits(item.amount, 2, 'Allocation amount'), 0n), 2) }
  ]
}

function assertJournalBalanced(lines) {
  const debit = lines.reduce((sum, line) => sum + decimalUnits(String(line.debit || '0'), 2, 'Debit', { allowZero: true }), 0n)
  const credit = lines.reduce((sum, line) => sum + decimalUnits(String(line.credit || '0'), 2, 'Credit', { allowZero: true }), 0n)
  if (lines.length < 2 || debit === 0n || debit !== credit) throw validationError('Supplier payable journal lines must balance')
  return { debit: formatUnits(debit, 2), credit: formatUnits(credit, 2) }
}

function approvalInput(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  if (!isUuid(source.accounting_period_id)) throw validationError('A valid accounting period is required')
  if (!isUuid(source.payable_account_id)) throw validationError('A valid accounts payable account is required')
  return {
    accounting_period_id: source.accounting_period_id,
    entry_date: normalizeDate(source.entry_date, 'Accounting date', { required: false }),
    payable_account_id: source.payable_account_id
  }
}

async function addEvent(client, table, tenantId, sourceId, actorId, eventType, details) {
  const billEvent = table === 'supplier_bill_events'
  const sourceColumn = billEvent ? 'supplier_bill_id' : 'supplier_payment_id'
  await client.query(
    `INSERT INTO ${table} (tenant_id, ${sourceColumn}, actor_id, event_type, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [tenantId, sourceId, actorId, eventType, JSON.stringify(details || {})]
  )
}

function publicBill(row) {
  if (!row) return row
  const result = { ...row }
  for (const field of ['idempotency_key', 'payload_hash', 'approval_payload_hash', 'reversal_payload_hash']) delete result[field]
  return result
}

function publicPayment(row) {
  if (!row) return row
  const result = { ...row }
  for (const field of ['idempotency_key', 'payload_hash', 'verification_payload_hash', 'reversal_payload_hash']) delete result[field]
  return result
}

function billAuditSnapshot(value) {
  return {
    supplier_id: value.supplier_id,
    purchase_order_id: value.purchase_order_id || null,
    supplier_invoice_number: value.supplier_invoice_number,
    bill_date: String(value.bill_date).slice(0, 10),
    due_date: String(value.due_date).slice(0, 10),
    currency: String(value.currency).trim(),
    subtotal: String(value.subtotal),
    tax_amount: String(value.tax_amount),
    total: String(value.total),
    notes: value.notes || null,
    lines: (value.lines || []).map((line) => ({
      description: line.description,
      quantity: String(line.quantity),
      unit_price: String(line.unit_price),
      line_subtotal: String(line.line_subtotal),
      tax_rate: String(line.tax_rate),
      tax_amount: String(line.tax_amount),
      account_id: line.account_id,
      purchase_order_id: line.purchase_order_id || null,
      purchase_order_item_id: line.purchase_order_item_id || null,
      product_id: line.product_id || null,
      receipt_id: line.receipt_id || null,
      purchase_order_receipt_item_id: line.purchase_order_receipt_item_id || null
    }))
  }
}

function billInputSnapshot(input) {
  return billAuditSnapshot(input)
}

async function billDetails(queryable, tenantId, billId) {
  const billResult = await queryable.query(
    `SELECT bill.*, supplier.business_name AS supplier_name,
            COALESCE(paid.amount, 0)::numeric(12,2)::text AS paid_amount,
            CASE WHEN bill.status = 'approved' THEN
              GREATEST(bill.total - COALESCE(paid.amount, 0), 0)::numeric(12,2)::text
              ELSE '0.00' END AS balance_due,
            CASE WHEN bill.status <> 'approved' THEN bill.status
              WHEN COALESCE(paid.amount, 0) >= bill.total THEN 'paid'
              WHEN COALESCE(paid.amount, 0) > 0 THEN 'partially_paid'
              WHEN bill.due_date < CURRENT_DATE THEN 'overdue'
              ELSE 'approved' END AS display_status
     FROM supplier_bills bill
     JOIN suppliers supplier ON supplier.tenant_id = bill.tenant_id AND supplier.id = bill.supplier_id
     LEFT JOIN LATERAL (
       SELECT SUM(allocation.amount) AS amount
       FROM supplier_payment_allocations allocation
       JOIN supplier_payments payment
         ON payment.tenant_id = allocation.tenant_id AND payment.id = allocation.supplier_payment_id
        AND payment.status = 'verified'
       WHERE allocation.tenant_id = bill.tenant_id AND allocation.supplier_bill_id = bill.id
     ) paid ON true
     WHERE bill.tenant_id = $1 AND bill.id = $2`,
    [tenantId, billId]
  )
  if (billResult.rowCount !== 1) throw httpError(404, 'Supplier bill not found')
  const lineResult = await queryable.query(
    `SELECT line.*, account.account_code, account.name AS account_name,
            purchase_line.product_name, purchase_line.product_sku
     FROM supplier_bill_lines line
     JOIN accounting_accounts account ON account.tenant_id = line.tenant_id AND account.id = line.account_id
     LEFT JOIN purchase_order_items purchase_line
       ON purchase_line.tenant_id = line.tenant_id
      AND purchase_line.purchase_order_id = line.purchase_order_id
      AND purchase_line.id = line.purchase_order_item_id
     WHERE line.tenant_id = $1 AND line.supplier_bill_id = $2
     ORDER BY line.line_number`,
    [tenantId, billId]
  )
  const eventResult = await queryable.query(
    `SELECT id, actor_id, event_type, details, created_at
     FROM supplier_bill_events WHERE tenant_id = $1 AND supplier_bill_id = $2
     ORDER BY created_at, id`,
    [tenantId, billId]
  )
  const paymentResult = await queryable.query(
    `SELECT payment.id, payment.payment_number, payment.amount::text AS amount,
            payment.currency, payment.payment_date, payment.payment_method,
            payment.payment_reference, payment.status,
            allocation.amount::text AS allocated_amount,
            payment.journal_entry_id, payment.reversal_journal_entry_id
     FROM supplier_payment_allocations allocation
     JOIN supplier_payments payment
       ON payment.tenant_id = allocation.tenant_id AND payment.id = allocation.supplier_payment_id
     WHERE allocation.tenant_id = $1 AND allocation.supplier_bill_id = $2
     ORDER BY payment.payment_date DESC, payment.created_at DESC, payment.id`,
    [tenantId, billId]
  )
  const bill = publicBill(billResult.rows[0])
  bill.status = bill.display_status
  delete bill.display_status
  bill.lines = lineResult.rows
  bill.events = eventResult.rows
  bill.payments = paymentResult.rows
  return bill
}

async function requireActiveSupplier(client, tenantId, supplierId) {
  const result = await client.query(
    `SELECT id FROM suppliers WHERE tenant_id = $1 AND id = $2 AND is_active = true FOR SHARE`,
    [tenantId, supplierId]
  )
  if (result.rowCount !== 1) throw httpError(404, 'Supplier not found')
}

async function validateBillReferences(client, tenantId, input) {
  if (input.purchase_order_id) {
    const order = await client.query(
      `SELECT id, supplier_id, status FROM purchase_orders
       WHERE tenant_id = $1 AND id = $2 FOR SHARE`,
      [tenantId, input.purchase_order_id]
    )
    if (order.rowCount !== 1 || order.rows[0].supplier_id !== input.supplier_id) {
      throw httpError(404, 'Purchase order not found for this supplier')
    }
    if (!['ordered', 'partially_received', 'received'].includes(order.rows[0].status)) {
      throw httpError(409, 'Bills can only reference an ordered purchase order')
    }
  }
  const preparedLines = []
  for (const line of input.lines) {
    let purchaseOrderId = input.purchase_order_id
    let productId = null
    if (line.purchase_order_item_id) {
      const orderLine = await client.query(
        `SELECT id, product_id FROM purchase_order_items
         WHERE tenant_id = $1 AND purchase_order_id = $2 AND id = $3 FOR SHARE`,
        [tenantId, input.purchase_order_id, line.purchase_order_item_id]
      )
      if (orderLine.rowCount !== 1) throw httpError(404, 'Purchase order line not found')
      productId = orderLine.rows[0].product_id
    } else {
      purchaseOrderId = null
    }
    if (line.purchase_order_receipt_item_id) {
      const receiptLine = await client.query(
        `SELECT receipt_item.id, receipt_item.product_id, receipt_item.purchase_order_id,
                receipt_item.purchase_order_item_id, receipt_item.receipt_id
         FROM purchase_order_receipt_items receipt_item
         JOIN purchase_order_receipts receipt
           ON receipt.tenant_id = receipt_item.tenant_id
          AND receipt.purchase_order_id = receipt_item.purchase_order_id
          AND receipt.id = receipt_item.receipt_id
         WHERE receipt_item.tenant_id = $1 AND receipt_item.id = $2 FOR SHARE OF receipt_item, receipt`,
        [tenantId, line.purchase_order_receipt_item_id]
      )
      const row = receiptLine.rows[0]
      if (receiptLine.rowCount !== 1 || row.purchase_order_id !== input.purchase_order_id ||
          row.purchase_order_item_id !== line.purchase_order_item_id || row.receipt_id !== line.receipt_id ||
          row.product_id !== productId) {
        throw httpError(404, 'Received goods line does not match the selected purchase order line')
      }
    }
    preparedLines.push({ ...line, purchase_order_id: purchaseOrderId, product_id: productId })
  }
  return preparedLines
}

async function validateDebitAccounts(client, tenantId, lines, { inventoryClearingAccountId = null } = {}) {
  const ids = [...new Set(lines.map((line) => line.account_id))]
  const result = await client.query(
    `SELECT id, account_type, normal_balance, is_active FROM accounting_accounts
     WHERE tenant_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR SHARE`,
    [tenantId, ids]
  )
  const invalid = result.rows.some((account) => {
    if (inventoryClearingAccountId && account.id === inventoryClearingAccountId) {
      return !account.is_active || account.account_type !== 'liability' || account.normal_balance !== 'credit'
    }
    return !account.is_active || !['asset', 'expense'].includes(account.account_type) || account.normal_balance !== 'debit'
  })
  if (result.rowCount !== ids.length || invalid) {
    throw httpError(400, 'Each bill line must use an active tenant expense or asset debit account')
  }
}

async function nextNumber(client, tenantId, table, column, prefix) {
  const result = await client.query(
    `SELECT COALESCE(MAX(SUBSTRING(${column} FROM '^${prefix}-([0-9]+)$')::numeric), 0) + 1 AS next_number
     FROM ${table} WHERE tenant_id = $1 AND ${column} ~ '^${prefix}-[0-9]+$'`,
    [tenantId]
  )
  return `${prefix}-${BigInt(String(result.rows[0].next_number)).toString().padStart(6, '0')}`
}

async function insertBillLines(client, tenantId, supplierId, billId, lines) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    await client.query(
      `INSERT INTO supplier_bill_lines
         (tenant_id, supplier_id, supplier_bill_id, line_number, description, quantity, unit_price,
          line_subtotal, tax_rate, tax_amount, account_id, purchase_order_id,
          purchase_order_item_id, product_id, receipt_id, purchase_order_receipt_item_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [tenantId, supplierId, billId, index + 1, line.description, line.quantity, line.unit_price,
        line.line_subtotal, line.tax_rate, line.tax_amount, line.account_id,
        line.purchase_order_id, line.purchase_order_item_id, line.product_id,
        line.receipt_id, line.purchase_order_receipt_item_id]
    )
  }
}

async function createSupplierBill(pool, { tenantId, userId, idempotencyKey, body }) {
  requireIdentity(tenantId, userId)
  const input = normalizeBillInput(body, idempotencyKey)
  return withTransaction(pool, async (client) => {
    await client.query('SELECT id FROM tenants WHERE id = $1 FOR UPDATE', [tenantId])
    const replay = await client.query(
      `SELECT id, payload_hash FROM supplier_bills WHERE tenant_id = $1 AND idempotency_key = $2 FOR UPDATE`,
      [tenantId, input.idempotency_key]
    )
    if (replay.rowCount === 1) {
      if (replay.rows[0].payload_hash !== input.payload_hash) {
        throw httpError(409, 'Idempotency-Key was already used for a different supplier bill')
      }
      return { bill: await billDetails(client, tenantId, replay.rows[0].id), replayed: true }
    }
    await assertDateNotInClosedPeriod(client, tenantId, input.bill_date, 'Supplier bill date')
    await requireActiveSupplier(client, tenantId, input.supplier_id)
    await validateDebitAccounts(client, tenantId, input.lines)
    const lines = await validateBillReferences(client, tenantId, input)
    const billNumber = await nextNumber(client, tenantId, 'supplier_bills', 'bill_number', 'BILL')
    const inserted = await client.query(
      `INSERT INTO supplier_bills
         (tenant_id, supplier_id, purchase_order_id, bill_number, supplier_invoice_number,
          bill_date, due_date, currency, subtotal, tax_amount, total, notes,
          idempotency_key, payload_hash, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id`,
      [tenantId, input.supplier_id, input.purchase_order_id, billNumber,
        input.supplier_invoice_number, input.bill_date, input.due_date, input.currency,
        input.subtotal, input.tax_amount, input.total, input.notes,
        input.idempotency_key, input.payload_hash, userId]
    )
    const billId = inserted.rows[0].id
    await insertBillLines(client, tenantId, input.supplier_id, billId, lines)
    await addEvent(client, 'supplier_bill_events', tenantId, billId, userId, 'created', {
      bill_number: billNumber, after: billInputSnapshot({ ...input, lines })
    })
    return { bill: await billDetails(client, tenantId, billId), replayed: false }
  })
}

async function updateSupplierBill(pool, { tenantId, userId, billId, idempotencyKey, body }) {
  requireIdentity(tenantId, userId)
  if (!isUuid(billId)) throw httpError(404, 'Supplier bill not found')
  const input = normalizeBillInput(body, idempotencyKey)
  return withTransaction(pool, async (client) => {
    const current = await client.query(
      `SELECT id, status FROM supplier_bills WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, billId]
    )
    if (current.rowCount !== 1) throw httpError(404, 'Supplier bill not found')
    if (current.rows[0].status !== 'draft') throw httpError(409, 'Only draft supplier bills may be edited')
    await assertDateNotInClosedPeriod(client, tenantId, input.bill_date, 'Supplier bill date')
    const before = billAuditSnapshot(await billDetails(client, tenantId, billId))
    await requireActiveSupplier(client, tenantId, input.supplier_id)
    await validateDebitAccounts(client, tenantId, input.lines)
    const lines = await validateBillReferences(client, tenantId, input)
    await client.query(
      `UPDATE supplier_bills SET supplier_id = $1, purchase_order_id = $2,
         supplier_invoice_number = $3, bill_date = $4, due_date = $5, currency = $6,
         subtotal = $7, tax_amount = $8, total = $9, notes = $10, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $11 AND id = $12 AND status = 'draft'`,
      [input.supplier_id, input.purchase_order_id, input.supplier_invoice_number,
        input.bill_date, input.due_date, input.currency, input.subtotal,
        input.tax_amount, input.total, input.notes, tenantId, billId]
    )
    await client.query('DELETE FROM supplier_bill_lines WHERE tenant_id = $1 AND supplier_bill_id = $2', [tenantId, billId])
    await insertBillLines(client, tenantId, input.supplier_id, billId, lines)
    await addEvent(client, 'supplier_bill_events', tenantId, billId, userId, 'updated', {
      before, after: billInputSnapshot({ ...input, lines })
    })
    return { bill: await billDetails(client, tenantId, billId), replayed: false }
  })
}

async function submitSupplierBill(pool, { tenantId, userId, billId }) {
  requireIdentity(tenantId, userId)
  if (!isUuid(billId)) throw httpError(404, 'Supplier bill not found')
  return withTransaction(pool, async (client) => {
    const bill = await client.query(
      `SELECT id, status, bill_date FROM supplier_bills WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, billId]
    )
    if (bill.rowCount !== 1) throw httpError(404, 'Supplier bill not found')
    if (bill.rows[0].status === 'submitted') return { bill: await billDetails(client, tenantId, billId), replayed: true }
    if (bill.rows[0].status !== 'draft') throw httpError(409, 'Only draft supplier bills may be submitted')
    await assertDateNotInClosedPeriod(client, tenantId, bill.rows[0].bill_date, 'Supplier bill date')
    await client.query(
      `UPDATE supplier_bills SET status = 'submitted', submitted_by = $1,
         submitted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $2 AND id = $3 AND status = 'draft'`,
      [userId, tenantId, billId]
    )
    await addEvent(client, 'supplier_bill_events', tenantId, billId, userId, 'submitted', {})
    return { bill: await billDetails(client, tenantId, billId), replayed: false }
  })
}

async function validatePayableAccount(client, tenantId, accountId) {
  const result = await client.query(
    `SELECT id, account_type, normal_balance, is_active FROM accounting_accounts
     WHERE tenant_id = $1 AND id = $2 FOR SHARE`,
    [tenantId, accountId]
  )
  if (result.rowCount !== 1 || !result.rows[0].is_active || result.rows[0].account_type !== 'liability' ||
      result.rows[0].normal_balance !== 'credit') {
    throw httpError(400, 'Accounts payable must use an active tenant liability credit account')
  }
}

async function approveSupplierBill(pool, { tenantId, userId, billId, body }) {
  requireIdentity(tenantId, userId)
  if (!isUuid(billId)) throw httpError(404, 'Supplier bill not found')
  const input = approvalInput(body)
  const hash = hashPayload(input)
  return withTransaction(pool, async (client) => {
    const result = await client.query(
      `SELECT * FROM supplier_bills WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, billId]
    )
    if (result.rowCount !== 1) throw httpError(404, 'Supplier bill not found')
    const bill = result.rows[0]
    if (bill.status === 'approved') {
      if (bill.approval_payload_hash !== hash) throw httpError(409, 'Supplier bill was approved using a different posting request')
      return { bill: await billDetails(client, tenantId, billId), replayed: true }
    }
    const settings = await client.query('SELECT base_currency FROM accounting_settings WHERE tenant_id = $1 FOR SHARE', [tenantId])
    if (settings.rowCount !== 1) throw httpError(409, 'Configure the tenant accounting currency before approving supplier bills')
    assertApprovalAllowed(bill, userId, settings.rows[0].base_currency)
    await validatePayableAccount(client, tenantId, input.payable_account_id)
    const inventorySettings = await client.query(
      'SELECT inventory_clearing_account_id FROM accounting_settings WHERE tenant_id = $1 FOR SHARE',
      [tenantId]
    )
    const clearingAccountId = inventorySettings.rows[0]?.inventory_clearing_account_id || null
    const linesResult = await client.query(
      `SELECT line_number, description, line_subtotal, tax_amount, account_id,
              purchase_order_receipt_item_id
       FROM supplier_bill_lines WHERE tenant_id = $1 AND supplier_bill_id = $2 ORDER BY line_number FOR SHARE`,
      [tenantId, billId]
    )
    const linkedLines = linesResult.rows.filter((line) => line.purchase_order_receipt_item_id)
    if (linkedLines.length > 0) {
      if (!clearingAccountId || linkedLines.some((line) => line.account_id !== clearingAccountId)) {
        throw httpError(409, 'Received inventory supplier bill lines must use the configured inventory clearing account')
      }
    }
    await validateDebitAccounts(client, tenantId, linesResult.rows.map((line) => ({ account_id: line.account_id })),
      { inventoryClearingAccountId: clearingAccountId })
    const journalLines = buildBillJournalLines(linesResult.rows, input.payable_account_id, bill.bill_number, bill.total)
    assertJournalBalanced(journalLines)
    const posting = await postJournal(pool, {
      tenantId, userId, idempotencyKey: `supplier-bill:${bill.id}:approve:v1`,
      body: {
        accounting_period_id: input.accounting_period_id,
        entry_date: input.entry_date || String(bill.bill_date).slice(0, 10),
        description: `Supplier bill ${bill.bill_number}`,
        source_type: 'supplier_bill', source_id: bill.id,
        source_reference: bill.supplier_invoice_number, event_type: 'approve', lines: journalLines
      }
    }, { client })
    await client.query(
      `UPDATE supplier_bills SET status = 'approved', payable_account_id = $1,
         journal_entry_id = $2, approval_payload_hash = $3, approved_by = $4,
         approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $5 AND id = $6 AND status = 'submitted'`,
      [input.payable_account_id, posting.journal.id, hash, userId, tenantId, billId]
    )
    await addEvent(client, 'supplier_bill_events', tenantId, billId, userId, 'approved', {
      journal_entry_id: posting.journal.id, payable_account_id: input.payable_account_id,
      accounting_period_id: input.accounting_period_id
    })
    return { bill: await billDetails(client, tenantId, billId), journal: posting.journal, replayed: posting.replayed }
  })
}

async function cancelSupplierBill(pool, { tenantId, userId, billId, body }) {
  requireIdentity(tenantId, userId)
  if (!isUuid(billId)) throw httpError(404, 'Supplier bill not found')
  const reason = text(body?.reason, 'Cancellation reason', 1800, { required: true })
  return withTransaction(pool, async (client) => {
    const current = await client.query(
      `SELECT id, status FROM supplier_bills WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, billId]
    )
    if (current.rowCount !== 1) throw httpError(404, 'Supplier bill not found')
    if (current.rows[0].status === 'cancelled') return { bill: await billDetails(client, tenantId, billId), replayed: true }
    if (!['draft', 'submitted'].includes(current.rows[0].status)) {
      throw httpError(409, 'Only unposted draft or submitted supplier bills may be cancelled')
    }
    await client.query(
      `UPDATE supplier_bills SET status = 'cancelled', cancellation_reason = $1,
         cancelled_by = $2, cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $3 AND id = $4`,
      [reason, userId, tenantId, billId]
    )
    await addEvent(client, 'supplier_bill_events', tenantId, billId, userId, 'cancelled', { reason })
    return { bill: await billDetails(client, tenantId, billId), replayed: false }
  })
}

async function reverseSupplierBill(pool, { tenantId, userId, billId, idempotencyKey, body }) {
  requireIdentity(tenantId, userId)
  if (!isUuid(billId)) throw httpError(404, 'Supplier bill not found')
  const input = reversalInput(body)
  const key = normalizeIdempotencyKey(idempotencyKey)
  const hash = hashPayload({ bill_id: billId, ...input })
  return withTransaction(pool, async (client) => {
    const result = await client.query(`SELECT * FROM supplier_bills WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId, billId])
    if (result.rowCount !== 1) throw httpError(404, 'Supplier bill not found')
    const bill = result.rows[0]
    if (bill.status === 'reversed') {
      if (bill.reversal_idempotency_key !== key || bill.reversal_payload_hash !== hash) {
        throw httpError(409, 'Supplier bill has already been reversed with a different request')
      }
      return { bill: await billDetails(client, tenantId, billId), replayed: true }
    }
    const activePayment = await client.query(
      `SELECT payment.status FROM supplier_payment_allocations allocation
       JOIN supplier_payments payment ON payment.tenant_id = allocation.tenant_id
        AND payment.id = allocation.supplier_payment_id AND payment.status IN ('pending', 'verified')
       WHERE allocation.tenant_id = $1 AND allocation.supplier_bill_id = $2`,
      [tenantId, billId]
    )
    assertBillCanReverse(bill.status, activePayment.rows.map((row) => row.status))
    const posting = await reverseJournal(pool, {
      tenantId, userId, journalId: bill.journal_entry_id,
      idempotencyKey: `supplier-bill:${bill.id}:reverse:v1`, reversalDate: input.reversal_date,
      periodId: input.accounting_period_id, reason: input.reason
    }, { client, allowedSourceTypes: ['supplier_bill'] })
    await client.query(
      `UPDATE supplier_bills SET status = 'reversed', reversal_journal_entry_id = $1,
         reversal_idempotency_key = $2, reversal_payload_hash = $3,
         reversal_reason = $4, reversed_by = $5, reversed_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP WHERE tenant_id = $6 AND id = $7 AND status = 'approved'`,
      [posting.journal.id, key, hash, input.reason, userId, tenantId, billId]
    )
    await addEvent(client, 'supplier_bill_events', tenantId, billId, userId, 'reversed', {
      reversal_journal_entry_id: posting.journal.id, reason: input.reason
    })
    return { bill: await billDetails(client, tenantId, billId), journal: posting.journal, replayed: false }
  })
}

async function listSupplierBills(pool, tenantId, { supplierId = null, status = null, search = '' } = {}) {
  if (!isUuid(tenantId)) throw httpError(401, 'Authenticated tenant identity is required')
  if (supplierId != null && !isUuid(supplierId)) throw validationError('A valid supplier is required')
  if (status != null && !BILL_STATES.has(status)) throw validationError('Invalid supplier bill status')
  const result = await pool.query(
    `SELECT bill.id, bill.tenant_id, bill.supplier_id, supplier.business_name AS supplier_name,
            bill.purchase_order_id, bill.bill_number, bill.supplier_invoice_number,
            bill.bill_date, bill.due_date, bill.currency, bill.subtotal::text,
            bill.tax_amount::text, bill.total::text, bill.notes, bill.journal_entry_id,
            bill.created_by, bill.created_at, bill.updated_at,
            COALESCE(paid.amount, 0)::numeric(12,2)::text AS paid_amount,
            CASE WHEN bill.status = 'approved' THEN
              GREATEST(bill.total - COALESCE(paid.amount, 0), 0)::numeric(12,2)::text ELSE '0.00' END AS balance_due,
            CASE WHEN bill.status <> 'approved' THEN bill.status
              WHEN COALESCE(paid.amount, 0) >= bill.total THEN 'paid'
              WHEN COALESCE(paid.amount, 0) > 0 THEN 'partially_paid'
              WHEN bill.due_date < CURRENT_DATE THEN 'overdue' ELSE 'approved' END AS status
     FROM supplier_bills bill
     JOIN suppliers supplier ON supplier.tenant_id = bill.tenant_id AND supplier.id = bill.supplier_id
     LEFT JOIN LATERAL (
       SELECT SUM(allocation.amount) AS amount FROM supplier_payment_allocations allocation
       JOIN supplier_payments payment ON payment.tenant_id = allocation.tenant_id
        AND payment.id = allocation.supplier_payment_id AND payment.status = 'verified'
       WHERE allocation.tenant_id = bill.tenant_id AND allocation.supplier_bill_id = bill.id
     ) paid ON true
     WHERE bill.tenant_id = $1 AND ($2::uuid IS NULL OR bill.supplier_id = $2)
       AND ($3 = '' OR bill.bill_number ILIKE '%' || $3 || '%'
            OR bill.supplier_invoice_number ILIKE '%' || $3 || '%'
            OR supplier.business_name ILIKE '%' || $3 || '%')
     ORDER BY bill.created_at DESC, bill.id DESC LIMIT 500`,
    [tenantId, supplierId, search]
  )
  return result.rows.filter((bill) => status == null || bill.status === status).map(publicBill)
}

async function getSupplierBill(pool, tenantId, billId) {
  if (!isUuid(tenantId)) throw httpError(401, 'Authenticated tenant identity is required')
  if (!isUuid(billId)) throw httpError(404, 'Supplier bill not found')
  return billDetails(pool, tenantId, billId)
}

async function lockBillsForPayment(client, tenantId, supplierId, allocations, currency) {
  const ids = allocations.map((allocation) => allocation.bill_id).sort()
  const result = await client.query(
    `SELECT id, supplier_id, status, currency, total::text, payable_account_id
     FROM supplier_bills WHERE tenant_id = $1 AND id = ANY($2::uuid[])
     ORDER BY id FOR UPDATE`,
    [tenantId, ids]
  )
  if (result.rowCount !== ids.length) throw httpError(404, 'One or more supplier bills are unavailable')
  const bills = new Map(result.rows.map((bill) => [bill.id, bill]))
  const paidResult = await client.query(
    `SELECT allocation.supplier_bill_id, COALESCE(SUM(allocation.amount), 0)::text AS amount
     FROM supplier_payment_allocations allocation
     JOIN supplier_payments payment ON payment.tenant_id = allocation.tenant_id
      AND payment.id = allocation.supplier_payment_id AND payment.status = 'verified'
     WHERE allocation.tenant_id = $1 AND allocation.supplier_bill_id = ANY($2::uuid[])
     GROUP BY allocation.supplier_bill_id`,
    [tenantId, ids]
  )
  const paid = new Map(paidResult.rows.map((row) => [row.supplier_bill_id,
    decimalUnits(String(row.amount), 2, 'Paid amount', { allowZero: true })]))
  for (const allocation of allocations) {
    const bill = bills.get(allocation.bill_id)
    if (bill.supplier_id !== supplierId || bill.status !== 'approved') {
      throw httpError(409, 'Payments can only be allocated to approved bills for the same supplier')
    }
    assertSameCurrency(bill.currency, currency)
    const total = decimalUnits(String(bill.total), 2, 'Bill total')
    const alreadyPaid = paid.get(bill.id) || 0n
    assertAllocationWithinBalance(allocation.amount, formatUnits(total, 2), formatUnits(alreadyPaid, 2))
  }
  return bills
}

async function createSupplierPayment(pool, { tenantId, userId, idempotencyKey, body }) {
  requireIdentity(tenantId, userId)
  const input = normalizePaymentInput(body, idempotencyKey)
  return withTransaction(pool, async (client) => {
    await client.query('SELECT id FROM tenants WHERE id = $1 FOR UPDATE', [tenantId])
    const replay = await client.query(
      `SELECT id, payload_hash FROM supplier_payments WHERE tenant_id = $1 AND idempotency_key = $2 FOR UPDATE`,
      [tenantId, input.idempotency_key]
    )
    if (replay.rowCount === 1) {
      if (replay.rows[0].payload_hash !== input.payload_hash) {
        throw httpError(409, 'Idempotency-Key was already used for a different supplier payment')
      }
      return { payment: await paymentDetails(client, tenantId, replay.rows[0].id), replayed: true }
    }
    await assertDateNotInClosedPeriod(client, tenantId, input.payment_date, 'Supplier payment date')
    const supplier = await client.query(
      'SELECT id FROM suppliers WHERE tenant_id = $1 AND id = $2 AND is_active = true FOR SHARE',
      [tenantId, input.supplier_id]
    )
    if (supplier.rowCount !== 1) throw httpError(404, 'Supplier not found')
    const settings = await client.query('SELECT base_currency FROM accounting_settings WHERE tenant_id = $1 FOR SHARE', [tenantId])
    if (settings.rowCount !== 1 || settings.rows[0].base_currency !== input.currency) {
      throw httpError(409, 'Supplier payment currency must match the configured accounting base currency; foreign-currency posting is not configured')
    }
    await lockBillsForPayment(client, tenantId, input.supplier_id, input.allocations, input.currency)
    const paymentNumber = await nextNumber(client, tenantId, 'supplier_payments', 'payment_number', 'SPAY')
    const inserted = await client.query(
      `INSERT INTO supplier_payments
         (tenant_id, supplier_id, payment_number, amount, currency, payment_date,
          payment_method, payment_reference, notes, idempotency_key, payload_hash, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [tenantId, input.supplier_id, paymentNumber, input.amount, input.currency,
        input.payment_date, input.payment_method, input.payment_reference, input.notes,
        input.idempotency_key, input.payload_hash, userId]
    )
    const paymentId = inserted.rows[0].id
    for (const allocation of input.allocations) {
      await client.query(
        `INSERT INTO supplier_payment_allocations
           (tenant_id, supplier_payment_id, supplier_bill_id, supplier_id, amount, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenantId, paymentId, allocation.bill_id, input.supplier_id, allocation.amount, userId]
      )
    }
    await addEvent(client, 'supplier_payment_events', tenantId, paymentId, userId, 'created', {
      payment_number: paymentNumber, amount: input.amount, currency: input.currency,
      allocation_count: input.allocations.length
    })
    return { payment: await paymentDetails(client, tenantId, paymentId), replayed: false }
  })
}

async function paymentDetails(queryable, tenantId, paymentId) {
  const result = await queryable.query(
    `SELECT payment.*, supplier.business_name AS supplier_name,
            COALESCE(allocation.allocated_amount, 0)::numeric(12,2)::text AS allocated_amount
     FROM supplier_payments payment
     JOIN suppliers supplier ON supplier.tenant_id = payment.tenant_id AND supplier.id = payment.supplier_id
     LEFT JOIN LATERAL (
       SELECT SUM(amount) AS allocated_amount FROM supplier_payment_allocations
       WHERE tenant_id = payment.tenant_id AND supplier_payment_id = payment.id
     ) allocation ON true
     WHERE payment.tenant_id = $1 AND payment.id = $2`,
    [tenantId, paymentId]
  )
  if (result.rowCount !== 1) throw httpError(404, 'Supplier payment not found')
  const allocations = await queryable.query(
    `SELECT allocation.id, allocation.supplier_bill_id, bill.bill_number,
            bill.supplier_invoice_number, allocation.amount::text AS amount
     FROM supplier_payment_allocations allocation
     JOIN supplier_bills bill ON bill.tenant_id = allocation.tenant_id AND bill.id = allocation.supplier_bill_id
     WHERE allocation.tenant_id = $1 AND allocation.supplier_payment_id = $2
     ORDER BY bill.bill_number`,
    [tenantId, paymentId]
  )
  const events = await queryable.query(
    `SELECT id, actor_id, event_type, details, created_at
     FROM supplier_payment_events WHERE tenant_id = $1 AND supplier_payment_id = $2
     ORDER BY created_at, id`,
    [tenantId, paymentId]
  )
  const payment = publicPayment(result.rows[0])
  payment.allocations = allocations.rows
  payment.events = events.rows
  return payment
}

async function verifySupplierPayment(pool, { tenantId, userId, paymentId, body }) {
  requireIdentity(tenantId, userId)
  if (!isUuid(paymentId)) throw httpError(404, 'Supplier payment not found')
  const input = paymentVerification(body)
  const hash = hashPayload(input)
  return withTransaction(pool, async (client) => {
    const result = await client.query(
      `SELECT * FROM supplier_payments WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, paymentId]
    )
    if (result.rowCount !== 1) throw httpError(404, 'Supplier payment not found')
    const payment = result.rows[0]
    if (payment.status === 'verified') {
      if (payment.verification_payload_hash !== hash) throw httpError(409, 'Payment was verified using a different posting request')
      return { payment: await paymentDetails(client, tenantId, paymentId), replayed: true }
    }
    assertPaymentCanVerify(payment, userId)
    const allocationsResult = await client.query(
      `SELECT supplier_bill_id, amount::text AS amount FROM supplier_payment_allocations
       WHERE tenant_id = $1 AND supplier_payment_id = $2 ORDER BY supplier_bill_id`,
      [tenantId, paymentId]
    )
    if (!allocationsResult.rowCount) throw httpError(409, 'Supplier payment has no bill allocations')
    const allocations = allocationsResult.rows.map((row) => ({ bill_id: row.supplier_bill_id, amount: row.amount }))
    const allocationTotal = allocations.reduce((sum, item) => sum + decimalUnits(item.amount, 2, 'Allocation amount'), 0n)
    if (allocationTotal !== decimalUnits(String(payment.amount), 2, 'Payment amount')) {
      throw httpError(409, 'Payment allocations must equal the full payment amount')
    }
    const bills = await lockBillsForPayment(client, tenantId, payment.supplier_id, allocations, payment.currency)
    const settings = await client.query('SELECT base_currency FROM accounting_settings WHERE tenant_id = $1 FOR SHARE', [tenantId])
    if (settings.rowCount !== 1 || settings.rows[0].base_currency !== payment.currency) {
      throw httpError(409, 'Supplier payment currency must match the configured accounting base currency')
    }
    const cashAccount = await client.query(
      `SELECT id, account_type, normal_balance, is_active FROM accounting_accounts
       WHERE tenant_id = $1 AND id = $2 FOR SHARE`,
      [tenantId, input.cash_account_id]
    )
    if (cashAccount.rowCount !== 1 || !cashAccount.rows[0].is_active ||
        cashAccount.rows[0].account_type !== 'asset' || cashAccount.rows[0].normal_balance !== 'debit') {
      throw httpError(400, 'Supplier payments must use an active tenant cash or bank debit asset account')
    }
    const lines = buildPaymentJournalLines(allocations, bills, input.cash_account_id, payment.payment_number)
    assertJournalBalanced(lines)
    const posting = await postJournal(pool, {
      tenantId, userId, idempotencyKey: `supplier-payment:${payment.id}:verify:v1`,
      body: {
        accounting_period_id: input.accounting_period_id,
        entry_date: String(payment.payment_date).slice(0, 10),
        description: `Supplier payment ${payment.payment_number}`,
        source_type: 'supplier_payment', source_id: payment.id,
        source_reference: payment.payment_reference, event_type: 'verify', lines
      }
    }, { client })
    await client.query(
      `UPDATE supplier_payments SET status = 'verified', cash_account_id = $1,
         journal_entry_id = $2, verification_payload_hash = $3, verified_by = $4,
         verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $5 AND id = $6 AND status = 'pending'`,
      [input.cash_account_id, posting.journal.id, hash, userId, tenantId, paymentId]
    )
    await addEvent(client, 'supplier_payment_events', tenantId, paymentId, userId, 'verified', {
      journal_entry_id: posting.journal.id, cash_account_id: input.cash_account_id,
      accounting_period_id: input.accounting_period_id
    })
    return { payment: await paymentDetails(client, tenantId, paymentId), journal: posting.journal, replayed: posting.replayed }
  })
}

async function failSupplierPayment(pool, { tenantId, userId, paymentId, body }) {
  requireIdentity(tenantId, userId)
  if (!isUuid(paymentId)) throw httpError(404, 'Supplier payment not found')
  const reason = text(body?.reason, 'Failure reason', 1800, { required: true })
  return withTransaction(pool, async (client) => {
    const result = await client.query(`SELECT id, status FROM supplier_payments WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId, paymentId])
    if (result.rowCount !== 1) throw httpError(404, 'Supplier payment not found')
    if (result.rows[0].status === 'failed') return { payment: await paymentDetails(client, tenantId, paymentId), replayed: true }
    assertPaymentCanFail(result.rows[0].status)
    await client.query(
      `UPDATE supplier_payments SET status = 'failed', failure_reason = $1,
         failed_by = $2, failed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $3 AND id = $4 AND status = 'pending'`,
      [reason, userId, tenantId, paymentId]
    )
    await addEvent(client, 'supplier_payment_events', tenantId, paymentId, userId, 'failed', { reason })
    return { payment: await paymentDetails(client, tenantId, paymentId), replayed: false }
  })
}

async function reverseSupplierPayment(pool, { tenantId, userId, paymentId, idempotencyKey, body }) {
  requireIdentity(tenantId, userId)
  if (!isUuid(paymentId)) throw httpError(404, 'Supplier payment not found')
  const input = reversalInput(body)
  const key = normalizeIdempotencyKey(idempotencyKey)
  const hash = hashPayload({ payment_id: paymentId, ...input })
  return withTransaction(pool, async (client) => {
    const result = await client.query(`SELECT * FROM supplier_payments WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId, paymentId])
    if (result.rowCount !== 1) throw httpError(404, 'Supplier payment not found')
    const payment = result.rows[0]
    if (payment.status === 'reversed') {
      if (payment.reversal_idempotency_key !== key || payment.reversal_payload_hash !== hash) {
        throw httpError(409, 'Supplier payment has already been reversed with a different request')
      }
      return { payment: await paymentDetails(client, tenantId, paymentId), replayed: true }
    }
    assertPaymentCanReverse(payment.status)
    const posting = await reverseJournal(pool, {
      tenantId, userId, journalId: payment.journal_entry_id,
      idempotencyKey: `supplier-payment:${payment.id}:reverse:v1`,
      reversalDate: input.reversal_date, periodId: input.accounting_period_id, reason: input.reason
    }, { client, allowedSourceTypes: ['supplier_payment'] })
    await client.query(
      `UPDATE supplier_payments SET status = 'reversed', reversal_journal_entry_id = $1,
         reversal_idempotency_key = $2, reversal_payload_hash = $3,
         reversal_reason = $4, reversed_by = $5, reversed_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP WHERE tenant_id = $6 AND id = $7 AND status = 'verified'`,
      [posting.journal.id, key, hash, input.reason, userId, tenantId, paymentId]
    )
    await addEvent(client, 'supplier_payment_events', tenantId, paymentId, userId, 'reversed', {
      reversal_journal_entry_id: posting.journal.id, reason: input.reason
    })
    return { payment: await paymentDetails(client, tenantId, paymentId), journal: posting.journal, replayed: false }
  })
}

async function listSupplierPayments(pool, tenantId, { supplierId = null, status = null } = {}) {
  if (!isUuid(tenantId)) throw httpError(401, 'Authenticated tenant identity is required')
  if (supplierId != null && !isUuid(supplierId)) throw validationError('A valid supplier is required')
  if (status != null && !PAYMENT_STATES.has(status)) throw validationError('Invalid supplier payment status')
  const result = await pool.query(
    `SELECT payment.id, payment.supplier_id, supplier.business_name AS supplier_name,
            payment.payment_number, payment.amount::text, payment.currency,
            payment.payment_date, payment.payment_method, payment.payment_reference,
            payment.status, payment.journal_entry_id, payment.reversal_journal_entry_id,
            payment.created_at,
            COALESCE(allocation.amount, 0)::numeric(12,2)::text AS allocated_amount
     FROM supplier_payments payment
     JOIN suppliers supplier ON supplier.tenant_id = payment.tenant_id AND supplier.id = payment.supplier_id
     LEFT JOIN LATERAL (
       SELECT SUM(amount) AS amount FROM supplier_payment_allocations
       WHERE tenant_id = payment.tenant_id AND supplier_payment_id = payment.id
     ) allocation ON true
     WHERE payment.tenant_id = $1 AND ($2::uuid IS NULL OR payment.supplier_id = $2)
       AND ($3::text IS NULL OR payment.status = $3)
     ORDER BY payment.payment_date DESC, payment.created_at DESC LIMIT 500`,
    [tenantId, supplierId, status]
  )
  return result.rows.map(publicPayment)
}

async function getSupplierPayment(pool, tenantId, paymentId) {
  if (!isUuid(tenantId)) throw httpError(401, 'Authenticated tenant identity is required')
  if (!isUuid(paymentId)) throw httpError(404, 'Supplier payment not found')
  return paymentDetails(pool, tenantId, paymentId)
}

module.exports = {
  approveSupplierBill,
  assertAllocationWithinBalance,
  assertApprovalAllowed,
  assertBillCanReverse,
  assertJournalBalanced,
  assertPaymentCanFail,
  assertPaymentCanVerify,
  assertPaymentCanReverse,
  assertSameCurrency,
  buildBillJournalLines,
  buildPaymentJournalLines,
  cancelSupplierBill,
  createSupplierBill,
  createSupplierPayment,
  failSupplierPayment,
  getSupplierBill,
  getSupplierPayment,
  listSupplierBills,
  listSupplierPayments,
  normalizeBillInput,
  normalizePaymentInput,
  reverseSupplierBill,
  reverseSupplierPayment,
  submitSupplierBill,
  updateSupplierBill,
  verifySupplierPayment
}

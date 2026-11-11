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

function requireIdentity(tenantId, userId) {
  if (!isUuid(tenantId) || !isUuid(userId)) {
    throw httpError(401, 'Authenticated tenant and user identities are required')
  }
}

function normalizeDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw validationError(`${label} must use YYYY-MM-DD`)
  }
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw validationError(`${label} is invalid`)
  }
  return value
}

function payloadHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function publicReceipt(receipt) {
  if (!receipt) return receipt
  const safe = { ...receipt }
  for (const field of [
    'idempotency_key',
    'payload_hash',
    'verification_idempotency_key',
    'verification_payload_hash',
    'reversal_idempotency_key',
    'reversal_payload_hash'
  ]) delete safe[field]
  return safe
}

function normalizeReceipt(body, idempotencyKey) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  if (!isUuid(source.customer_id)) throw validationError('A valid customer is required')
  const amount = decimal(source.amount, 2, 'Receipt amount')
  const currency = normalizeCurrency(source.currency)
  const paymentMethod = source.payment_method
  if (!PAYMENT_METHODS.has(paymentMethod)) throw validationError('Invalid receipt payment method')
  const normalized = {
    customer_id: source.customer_id,
    amount,
    currency,
    payment_method: paymentMethod,
    receipt_reference: text(source.receipt_reference, 'Receipt reference', 150),
    payment_date: normalizeDate(source.payment_date, 'Payment date'),
    idempotency_key: normalizeIdempotencyKey(idempotencyKey)
  }
  normalized.payload_hash = payloadHash({
    customer_id: normalized.customer_id,
    amount: normalized.amount,
    currency: normalized.currency,
    payment_method: normalized.payment_method,
    receipt_reference: normalized.receipt_reference,
    payment_date: normalized.payment_date
  })
  return normalized
}

function normalizeProviderEvidence(value) {
  if (value == null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.source !== 'daraja_stk_query' || typeof value.checkout_request_id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,150}$/.test(value.checkout_request_id)) {
    throw validationError('Invalid provider verification evidence')
  }
  return {
    verification_source: 'daraja_stk_query',
    checkout_request_id: value.checkout_request_id
  }
}

function normalizeAllocations(body, idempotencyKey) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  if (!Array.isArray(source.allocations) || source.allocations.length < 1 || source.allocations.length > 100) {
    throw validationError('Provide between 1 and 100 invoice allocations')
  }
  const allocations = source.allocations.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !isUuid(item.invoice_id)) {
      throw validationError(`Allocation ${index + 1} has an invalid invoice`)
    }
    return { invoice_id: item.invoice_id, amount: decimal(item.amount, 2, `Allocation ${index + 1} amount`) }
  }).sort((left, right) => left.invoice_id.localeCompare(right.invoice_id))
  if (new Set(allocations.map((item) => item.invoice_id)).size !== allocations.length) {
    throw validationError('Use one allocation amount per invoice')
  }
  return {
    allocations,
    idempotency_key: normalizeIdempotencyKey(idempotencyKey)
  }
}

async function addReceiptEvent(client, { tenantId, receiptId, actorId, eventType, details }) {
  await client.query(
    `INSERT INTO customer_receipt_events (tenant_id, receipt_id, event_type, actor_id, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [tenantId, receiptId, eventType, actorId, JSON.stringify(details || {})]
  )
}

async function lockCustomer(client, tenantId, customerId) {
  const result = await client.query(
    'SELECT id FROM clients WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
    [tenantId, customerId]
  )
  if (result.rowCount !== 1) throw httpError(404, 'Customer not found')
}

async function hasStkReservationSchema(client) {
  const result = await client.query(
    `SELECT to_regclass('public.mpesa_stk_initiation_requests') IS NOT NULL AS available`
  )
  return result.rows[0]?.available === true
}

async function activeStkReservationsForCustomer(client, tenantId, customerId) {
  if (!await hasStkReservationSchema(client)) return []
  const result = await client.query(
    `SELECT request.id, request.invoice_id, request.request_status,
            request.provider_checkout_request_id, request.payment_id
     FROM mpesa_stk_initiation_requests request
     JOIN invoices invoice
       ON invoice.tenant_id = request.tenant_id AND invoice.id::text = request.invoice_id
     WHERE request.tenant_id = $1 AND invoice.client_id = $2
       AND request.request_status IN
         ('reserved', 'outcome_unknown', 'provider_accepted', 'reference_recovered', 'payment_recorded', 'provider_succeeded')
     ORDER BY request.invoice_id, request.id
     FOR UPDATE OF request`,
    [tenantId, customerId]
  )
  return result.rows
}

async function assertNoCompetingStkReservation(client, tenantId, customerId) {
  const active = await activeStkReservationsForCustomer(client, tenantId, customerId)
  if (active.length > 0) {
    throw httpError(409, 'An M-Pesa request for this customer is still outstanding; reconcile or resolve it before recording another receipt')
  }
}

async function assertProviderReceiptMatchesReservation(client, tenantId, receipt, checkoutId) {
  if (!await hasStkReservationSchema(client)) {
    throw httpError(503, 'M-Pesa request reservation schema is unavailable')
  }
  const result = await client.query(
    `SELECT request.id
     FROM mpesa_stk_initiation_requests request
     JOIN invoices invoice
       ON invoice.tenant_id = request.tenant_id AND invoice.id::text = request.invoice_id
     WHERE request.tenant_id = $1 AND request.provider_checkout_request_id = $2
       AND request.request_status = 'provider_succeeded'
       AND request.amount = $3::numeric AND invoice.client_id = $4
     FOR UPDATE OF request`,
    [tenantId, checkoutId, receipt.amount, receipt.customer_id]
  )
  if (result.rowCount !== 1) {
    throw httpError(409, 'Provider-confirmed receipt does not match a successful M-Pesa invoice reservation')
  }
}

async function receiptOwnsSuccessfulStkReservation(client, tenantId, receiptId, request) {
  if (!request || request.request_status !== 'provider_succeeded' || !request.payment_id ||
      !await hasStkReservationSchema(client)) return false
  const auditTable = await client.query(
    `SELECT to_regclass('public.mpesa_payment_reconciliation_audit') IS NOT NULL AS available`
  )
  if (auditTable.rows[0]?.available !== true) return false
  const result = await client.query(
    `SELECT 1
     FROM mpesa_payment_reconciliation_audit audit
     WHERE audit.tenant_id = $1 AND audit.payment_id = $2
       AND audit.receipt_id = $3 AND audit.outcome = 'provider_success'
     LIMIT 1`,
    [tenantId, request.payment_id, receiptId]
  )
  return result.rowCount === 1
}

async function assertNoCustomerReservationExceptReceipt(client, tenantId, customerId, receiptId) {
  if (!await hasStkReservationSchema(client)) return
  const active = await activeStkReservationsForCustomer(client, tenantId, customerId)
  const permitted = []
  for (const request of active) {
    if (await receiptOwnsSuccessfulStkReservation(client, tenantId, receiptId, request)) permitted.push(request.id)
  }
  if (active.some((request) => !permitted.includes(request.id))) {
    throw httpError(409, 'An M-Pesa request for this customer is still outstanding; complete or resolve it before verifying this receipt')
  }
}

async function lockInvoices(client, tenantId, invoiceIds) {
  if (invoiceIds.length === 0) return []
  const result = await client.query(
    `SELECT id::text AS id, client_id::text AS customer_id
     FROM invoices
     WHERE tenant_id = $1 AND id::text = ANY($2::text[])
     ORDER BY id FOR UPDATE`,
    [tenantId, invoiceIds]
  )
  if (result.rowCount !== invoiceIds.length) throw httpError(404, 'One or more invoices are unavailable')
  return result.rows
}

async function assertInvoiceReservationAllowsReceipt(client, tenantId, invoiceId, receiptId) {
  if (!await hasStkReservationSchema(client)) return
  const active = await client.query(
    `SELECT id, request_status, provider_checkout_request_id, payment_id
     FROM mpesa_stk_initiation_requests
     WHERE tenant_id = $1 AND invoice_id = $2
       AND request_status IN
         ('reserved', 'outcome_unknown', 'provider_accepted', 'reference_recovered', 'payment_recorded', 'provider_succeeded')
     FOR UPDATE`,
    [tenantId, invoiceId]
  )
  if (active.rowCount === 0) return
  const request = active.rows[0]
  if (active.rowCount === 1 && request.request_status === 'provider_succeeded' &&
      await receiptOwnsSuccessfulStkReservation(client, tenantId, receiptId, request)) return
  throw httpError(409, 'This invoice has an outstanding M-Pesa prompt; only its provider-confirmed receipt may be allocated')
}

async function createCustomerReceipt(pool, { tenantId, userId, idempotencyKey, body, client: transactionClient, providerEvidence }) {
  requireIdentity(tenantId, userId)
  const receipt = normalizeReceipt(body, idempotencyKey)
  const evidence = normalizeProviderEvidence(providerEvidence)
  const create = async (client) => {
    const replay = await client.query(
      `SELECT * FROM customer_receipts WHERE tenant_id = $1 AND idempotency_key = $2 FOR UPDATE`,
      [tenantId, receipt.idempotency_key]
    )
    if (replay.rowCount === 1) {
      if (replay.rows[0].payload_hash !== receipt.payload_hash) {
        throw httpError(409, 'Idempotency-Key was already used for a different receipt')
      }
      return { receipt: publicReceipt(replay.rows[0]), replayed: true }
    }
    await assertDateNotInClosedPeriod(client, tenantId, receipt.payment_date, 'Receipt date')
    const customer = await client.query(
      'SELECT id FROM clients WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
      [tenantId, receipt.customer_id]
    )
    if (customer.rowCount !== 1) throw httpError(404, 'Customer not found')
    if (evidence) {
      await assertProviderReceiptMatchesReservation(client, tenantId, receipt, evidence.checkout_request_id)
    } else {
      await assertNoCompetingStkReservation(client, tenantId, receipt.customer_id)
    }

    const inserted = await client.query(
      `INSERT INTO customer_receipts
         (tenant_id, customer_id, amount, currency, payment_method, receipt_reference,
          payment_date, idempotency_key, payload_hash, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [tenantId, receipt.customer_id, receipt.amount, receipt.currency, receipt.payment_method,
        receipt.receipt_reference, receipt.payment_date, receipt.idempotency_key,
        receipt.payload_hash, userId]
    )
    if (inserted.rowCount === 0) {
      const existing = await client.query(
        `SELECT * FROM customer_receipts
         WHERE tenant_id = $1 AND idempotency_key = $2 FOR UPDATE`,
        [tenantId, receipt.idempotency_key]
      )
      if (existing.rowCount !== 1) throw httpError(409, 'Receipt request could not be resolved')
      if (existing.rows[0].payload_hash !== receipt.payload_hash) {
        throw httpError(409, 'Idempotency-Key was already used for a different receipt')
      }
      return { receipt: publicReceipt(existing.rows[0]), replayed: true }
    }

    const created = inserted.rows[0]
    const eventDetails = {
      amount: receipt.amount,
      currency: receipt.currency,
      payment_method: receipt.payment_method
    }
    if (evidence) Object.assign(eventDetails, evidence)
    await addReceiptEvent(client, {
      tenantId, receiptId: created.id, actorId: userId, eventType: 'recorded',
      details: eventDetails
    })
    return { receipt: publicReceipt(created), replayed: false }
  }
  return transactionClient ? create(transactionClient) : withTransaction(pool, create)
}

async function loadReceipt(client, tenantId, receiptId, { lock = false } = {}) {
  const result = await client.query(
    `SELECT * FROM customer_receipts WHERE tenant_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`,
    [tenantId, receiptId]
  )
  if (result.rowCount !== 1) throw httpError(404, 'Receipt not found')
  return result.rows[0]
}

async function readJournal(client, tenantId, journalId) {
  const journal = await client.query(
    `SELECT * FROM accounting_journal_entries
     WHERE tenant_id = $1 AND id = $2 AND status = 'posted'`,
    [tenantId, journalId]
  )
  if (journal.rowCount !== 1) throw httpError(409, 'Receipt accounting journal is unavailable')
  const lines = await client.query(
    `SELECT line_number, account_id, description, debit, credit,
            transaction_currency, transaction_amount, exchange_rate,
            exchange_rate_source, exchange_rate_at
     FROM accounting_journal_lines
     WHERE tenant_id = $1 AND journal_entry_id = $2 ORDER BY line_number`,
    [tenantId, journalId]
  )
  return { journal: journal.rows[0], lines: lines.rows, replayed: true }
}

async function verifyCustomerReceipt(pool, { tenantId, userId, receiptId, idempotencyKey, body }) {
  requireIdentity(tenantId, userId)
  if (!isUuid(receiptId)) throw httpError(404, 'Receipt not found')
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  if (!isUuid(source.cash_account_id)) throw validationError('A valid cash or bank account is required')
  if (!isUuid(source.accounting_period_id)) throw validationError('A valid accounting period is required')
  const key = normalizeIdempotencyKey(idempotencyKey)

  return withTransaction(pool, async (client) => {
    const owner = await client.query(
      'SELECT customer_id FROM customer_receipts WHERE tenant_id = $1 AND id = $2',
      [tenantId, receiptId]
    )
    if (owner.rowCount !== 1) throw httpError(404, 'Receipt not found')
    await lockCustomer(client, tenantId, owner.rows[0].customer_id)
    const current = await client.query(
      'SELECT status FROM customer_receipts WHERE tenant_id = $1 AND id = $2',
      [tenantId, receiptId]
    )
    if (current.rowCount !== 1) throw httpError(404, 'Receipt not found')
    // Terminal verification replay is read-only. Do not let a later STK
    // reservation turn an already completed idempotent retry into a conflict.
    if (current.rows[0].status !== 'verified' && current.rows[0].status !== 'reversed') {
      await assertNoCustomerReservationExceptReceipt(client, tenantId, owner.rows[0].customer_id, receiptId)
    }
    const receipt = await loadReceipt(client, tenantId, receiptId, { lock: true })
    const verifyHash = payloadHash({
      receipt_id: receipt.id,
      cash_account_id: source.cash_account_id,
      accounting_period_id: source.accounting_period_id,
      payment_date: String(receipt.payment_date).slice(0, 10)
    })
    if (receipt.status === 'verified' || receipt.status === 'reversed') {
      if (receipt.verification_idempotency_key !== key || receipt.verification_payload_hash !== verifyHash) {
        throw httpError(409, 'Receipt has already been verified with a different request')
      }
      const posting = await readJournal(client, tenantId, receipt.journal_entry_id)
      return { receipt: publicReceipt(receipt), ...posting, replayed: true }
    }
    if (receipt.status !== 'pending') throw httpError(409, 'Only a pending receipt may be verified')

    const settings = await client.query(
      'SELECT base_currency FROM accounting_settings WHERE tenant_id = $1 FOR SHARE',
      [tenantId]
    )
    if (settings.rowCount !== 1) throw httpError(409, 'Configure tenant accounting settings before verifying receipts')
    const baseCurrency = normalizeCurrency(settings.rows[0].base_currency, 'Configured base currency')
    if (baseCurrency !== 'KES' || receipt.currency !== baseCurrency) {
      throw httpError(409, 'Receipt currency must match the configured KES accounting currency')
    }

    const mappings = await client.query(
      `SELECT mapping.receivables_account_id, cash.account_type AS cash_type,
              cash.normal_balance AS cash_normal_balance, cash.is_active AS cash_active,
              receivable.account_type AS receivable_type,
              receivable.normal_balance AS receivable_normal_balance,
              receivable.is_active AS receivable_active
       FROM accounting_invoice_mappings mapping
       JOIN accounting_accounts cash
         ON cash.tenant_id = mapping.tenant_id AND cash.id = $2
       JOIN accounting_accounts receivable
         ON receivable.tenant_id = mapping.tenant_id AND receivable.id = mapping.receivables_account_id
       WHERE mapping.tenant_id = $1
       FOR SHARE OF mapping, cash, receivable`,
      [tenantId, source.cash_account_id]
    )
    if (mappings.rowCount !== 1) throw httpError(409, 'Configure invoice receivables and select a tenant cash or bank account')
    const mapping = mappings.rows[0]
    if (source.cash_account_id === mapping.receivables_account_id || !mapping.cash_active ||
        mapping.cash_type !== 'asset' || mapping.cash_normal_balance !== 'debit' ||
        !mapping.receivable_active || mapping.receivable_type !== 'asset' ||
        mapping.receivable_normal_balance !== 'debit') {
      throw httpError(409, 'Receipt posting requires distinct active asset cash and receivables accounts')
    }

    const amount = decimal(receipt.amount, 2, 'Receipt amount')
    const posted = await postJournal(pool, {
      tenantId,
      userId,
      idempotencyKey: `customer-receipt:${receipt.id}:verify:v1`,
      body: {
        accounting_period_id: source.accounting_period_id,
        entry_date: String(receipt.payment_date).slice(0, 10),
        description: `Verify customer receipt ${receipt.receipt_reference || receipt.id}`,
        source_type: 'customer_receipt',
        source_id: receipt.id,
        source_reference: receipt.receipt_reference || receipt.id,
        event_type: 'verify',
        lines: [
          { account_id: source.cash_account_id, description: 'Customer receipt received', debit: amount, credit: '0.00' },
          { account_id: mapping.receivables_account_id, description: 'Customer receivable settled', debit: '0.00', credit: amount }
        ]
      }
    }, { client })

    const updated = await client.query(
      `UPDATE customer_receipts
       SET status = 'verified', verification_idempotency_key = $1,
           verification_payload_hash = $2, cash_account_id = $3,
           accounting_period_id = $4, journal_entry_id = $5,
           verified_by = $6, verified_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $7 AND id = $8 AND status = 'pending'
       RETURNING *`,
      [key, verifyHash, source.cash_account_id, source.accounting_period_id,
        posted.journal.id, userId, tenantId, receipt.id]
    )
    if (updated.rowCount !== 1) throw httpError(409, 'Receipt could not be verified from its current state')
    await addReceiptEvent(client, {
      tenantId, receiptId: receipt.id, actorId: userId, eventType: 'verified',
      details: { journal_entry_id: posted.journal.id, cash_account_id: source.cash_account_id }
    })
    return { receipt: publicReceipt(updated.rows[0]), ...posted }
  })
}

async function failCustomerReceipt(pool, { tenantId, userId, receiptId, body }) {
  requireIdentity(tenantId, userId)
  if (!isUuid(receiptId)) throw httpError(404, 'Receipt not found')
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  const reason = text(source.reason, 'Failure reason', 1800, { required: true })
  return withTransaction(pool, async (client) => {
    const owner = await client.query(
      'SELECT customer_id FROM customer_receipts WHERE tenant_id = $1 AND id = $2',
      [tenantId, receiptId]
    )
    if (owner.rowCount !== 1) throw httpError(404, 'Receipt not found')
    await lockCustomer(client, tenantId, owner.rows[0].customer_id)
    const receipt = await loadReceipt(client, tenantId, receiptId, { lock: true })
    if (receipt.status === 'failed') {
      if (receipt.failure_reason === reason) return { receipt: publicReceipt(receipt), replayed: true }
      throw httpError(409, 'Receipt has already been marked failed with a different reason')
    }
    if (receipt.status !== 'pending') throw httpError(409, 'Only a pending receipt may be marked failed')
    const updated = await client.query(
      `UPDATE customer_receipts SET status = 'failed', failure_reason = $1,
              failed_by = $2, failed_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $3 AND id = $4 AND status = 'pending' RETURNING *`,
      [reason, userId, tenantId, receipt.id]
    )
    if (updated.rowCount !== 1) throw httpError(409, 'Receipt could not be marked failed')
    await addReceiptEvent(client, {
      tenantId, receiptId: receipt.id, actorId: userId, eventType: 'failed', details: { reason }
    })
    return { receipt: publicReceipt(updated.rows[0]), replayed: false }
  })
}

async function allocateCustomerReceipt(pool, { tenantId, userId, receiptId, idempotencyKey, body }) {
  requireIdentity(tenantId, userId)
  if (!isUuid(receiptId)) throw httpError(404, 'Receipt not found')
  const request = normalizeAllocations(body, idempotencyKey)
  const hash = payloadHash({ receipt_id: receiptId, allocations: request.allocations })

  return withTransaction(pool, async (client) => {
    const owner = await client.query(
      'SELECT customer_id FROM customer_receipts WHERE tenant_id = $1 AND id = $2',
      [tenantId, receiptId]
    )
    if (owner.rowCount !== 1) throw httpError(404, 'Receipt not found')
    await lockCustomer(client, tenantId, owner.rows[0].customer_id)
    const ids = request.allocations.map((item) => item.invoice_id)
    await lockInvoices(client, tenantId, ids)
    const existingBatch = await client.query(
      `SELECT id, receipt_id, payload_hash FROM customer_receipt_allocation_batches
       WHERE tenant_id = $1 AND idempotency_key = $2 FOR UPDATE`,
      [tenantId, request.idempotency_key]
    )
    if (existingBatch.rowCount === 1) {
      const batch = existingBatch.rows[0]
      const receipt = await loadReceipt(client, tenantId, receiptId, { lock: true })
      if (batch.receipt_id !== receipt.id || batch.payload_hash !== hash) {
        throw httpError(409, 'Idempotency-Key was already used for a different allocation')
      }
      const replay = await client.query(
        `SELECT allocation.id, allocation.invoice_id, allocation.amount::text AS amount,
                invoice.invoice_number
         FROM customer_receipt_allocations allocation
         JOIN invoices invoice ON invoice.tenant_id = allocation.tenant_id AND invoice.id = allocation.invoice_id
         WHERE allocation.tenant_id = $1 AND allocation.batch_id = $2
         ORDER BY allocation.invoice_id`,
        [tenantId, batch.id]
      )
      return { receipt: publicReceipt(receipt), allocations: replay.rows, replayed: true }
    }
    const invoices = await client.query(
      `SELECT i.id, i.invoice_number, i.client_id, i.total::text AS total, i.status,
              snapshot.total::text AS snapshot_total,
              journal.functional_currency AS invoice_currency
       FROM invoices i
       JOIN accounting_invoice_tax_snapshots snapshot
         ON snapshot.tenant_id = i.tenant_id AND snapshot.source_type = 'invoice'
        AND snapshot.source_id = i.id AND snapshot.issued_at IS NOT NULL
       JOIN accounting_journal_entries journal
         ON journal.tenant_id = snapshot.tenant_id AND journal.id = snapshot.journal_entry_id
        AND journal.status = 'posted'
       WHERE i.tenant_id = $1 AND i.id = ANY($2::uuid[])
       ORDER BY i.id FOR UPDATE OF i`,
      [tenantId, ids]
    )
    if (invoices.rowCount !== ids.length) throw httpError(404, 'One or more invoices are unavailable')
    const invoiceById = new Map(invoices.rows.map((invoice) => [invoice.id, invoice]))
    for (const item of request.allocations) {
      await assertInvoiceReservationAllowsReceipt(client, tenantId, item.invoice_id, receiptId)
    }
    const receipt = await loadReceipt(client, tenantId, receiptId, { lock: true })
    if (receipt.status !== 'verified') throw httpError(409, 'Only a verified receipt may be allocated')
    const allocationTotal = request.allocations.reduce(
      (sum, item) => sum + decimalUnits(item.amount, 2, 'Allocation amount'), 0n
    )
    const currentReceiptAllocations = await client.query(
      `SELECT COALESCE(sum(allocation.amount), 0)::text AS total
       FROM customer_receipt_allocations allocation
       JOIN customer_receipts active_receipt
         ON active_receipt.tenant_id = allocation.tenant_id AND active_receipt.id = allocation.receipt_id
        AND active_receipt.status = 'verified'
       WHERE allocation.tenant_id = $1 AND allocation.receipt_id = $2`,
      [tenantId, receipt.id]
    )
    const allocatedUnits = decimalUnits(String(currentReceiptAllocations.rows[0].total), 2, 'Allocated amount', { allowZero: true })
    const receiptUnits = decimalUnits(String(receipt.amount), 2, 'Receipt amount')
    if (allocatedUnits + allocationTotal > receiptUnits) {
      throw httpError(409, 'Allocation exceeds the available receipt balance')
    }

    const invoiceBalances = await client.query(
      `SELECT allocation.invoice_id, COALESCE(sum(allocation.amount), 0)::text AS allocated
       FROM customer_receipt_allocations allocation
       JOIN customer_receipts active_receipt
         ON active_receipt.tenant_id = allocation.tenant_id AND active_receipt.id = allocation.receipt_id
        AND active_receipt.status = 'verified'
       WHERE allocation.tenant_id = $1 AND allocation.invoice_id = ANY($2::uuid[])
       GROUP BY allocation.invoice_id`,
      [tenantId, ids]
    )
    const invoiceAllocated = new Map(invoiceBalances.rows.map((row) => [row.invoice_id,
      decimalUnits(String(row.allocated), 2, 'Invoice allocated amount', { allowZero: true })]))
    for (const item of request.allocations) {
      const invoice = invoiceById.get(item.invoice_id)
      if (invoice.client_id !== receipt.customer_id) {
        throw httpError(409, 'Receipt can only be allocated to an issued invoice for the same customer')
      }
      if (invoice.total !== invoice.snapshot_total || invoice.invoice_currency !== receipt.currency) {
        throw httpError(409, 'Invoice total or currency does not match its posted accounting record')
      }
      const totalUnits = decimalUnits(String(invoice.total), 2, 'Invoice total', { allowZero: true })
      const priorUnits = invoiceAllocated.get(item.invoice_id) || 0n
      if (priorUnits + decimalUnits(item.amount, 2, 'Allocation amount') > totalUnits) {
        throw httpError(409, 'Allocation exceeds the invoice outstanding balance')
      }
      if (!['sent', 'overdue'].includes(invoice.status)) {
        throw httpError(409, 'Receipt can only be allocated to an outstanding issued invoice')
      }
    }

    const batchResult = await client.query(
      `INSERT INTO customer_receipt_allocation_batches
         (tenant_id, receipt_id, idempotency_key, payload_hash, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [tenantId, receipt.id, request.idempotency_key, hash, userId]
    )
    if (batchResult.rowCount !== 1) {
      const concurrent = await client.query(
        `SELECT id, receipt_id, payload_hash FROM customer_receipt_allocation_batches
         WHERE tenant_id = $1 AND idempotency_key = $2 FOR UPDATE`,
        [tenantId, request.idempotency_key]
      )
      if (concurrent.rowCount !== 1 || concurrent.rows[0].receipt_id !== receipt.id || concurrent.rows[0].payload_hash !== hash) {
        throw httpError(409, 'Idempotency-Key was already used for a different allocation')
      }
      const replay = await client.query(
        `SELECT allocation.id, allocation.invoice_id, allocation.amount::text AS amount,
                invoice.invoice_number
         FROM customer_receipt_allocations allocation
         JOIN invoices invoice ON invoice.tenant_id = allocation.tenant_id AND invoice.id = allocation.invoice_id
         WHERE allocation.tenant_id = $1 AND allocation.batch_id = $2
         ORDER BY allocation.invoice_id`,
        [tenantId, concurrent.rows[0].id]
      )
      return { receipt: publicReceipt(receipt), allocations: replay.rows, replayed: true }
    }
    const batchId = batchResult.rows[0].id
    const inserted = []
    for (const item of request.allocations) {
      const result = await client.query(
        `INSERT INTO customer_receipt_allocations
           (tenant_id, receipt_id, batch_id, invoice_id, customer_id, amount, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, invoice_id, amount::text AS amount`,
        [tenantId, receipt.id, batchId, item.invoice_id, receipt.customer_id, item.amount, userId]
      )
      inserted.push({ ...result.rows[0], invoice_number: invoiceById.get(item.invoice_id).invoice_number })
      const invoice = invoiceById.get(item.invoice_id)
      const alreadyAllocated = invoiceAllocated.get(item.invoice_id) || 0n
      const nowAllocated = alreadyAllocated + decimalUnits(item.amount, 2, 'Allocation amount')
      const invoiceTotal = decimalUnits(String(invoice.total), 2, 'Invoice total', { allowZero: true })
      if (nowAllocated === invoiceTotal) {
        await client.query(
          `UPDATE invoices SET status = 'paid'
           WHERE tenant_id = $1 AND id = $2 AND status IN ('sent', 'overdue')`,
          [tenantId, item.invoice_id]
        )
      }
    }
    await addReceiptEvent(client, {
      tenantId, receiptId: receipt.id, actorId: userId, eventType: 'allocated',
      details: { allocation_batch_id: batchId, allocations: request.allocations }
    })
    return { receipt: publicReceipt(receipt), allocations: inserted, replayed: false }
  })
}

async function reverseCustomerReceipt(pool, { tenantId, userId, receiptId, idempotencyKey, body }) {
  requireIdentity(tenantId, userId)
  if (!isUuid(receiptId)) throw httpError(404, 'Receipt not found')
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  if (!isUuid(source.accounting_period_id)) throw validationError('A valid accounting period is required')
  const reversalDate = normalizeDate(source.reversal_date, 'Reversal date')
  const reason = text(source.reason, 'Reversal reason', 1800, { required: true })
  const key = normalizeIdempotencyKey(idempotencyKey)

  return withTransaction(pool, async (client) => {
    const owner = await client.query(
      'SELECT customer_id FROM customer_receipts WHERE tenant_id = $1 AND id = $2',
      [tenantId, receiptId]
    )
    if (owner.rowCount !== 1) throw httpError(404, 'Receipt not found')
    await lockCustomer(client, tenantId, owner.rows[0].customer_id)
    const current = await client.query(
      'SELECT status FROM customer_receipts WHERE tenant_id = $1 AND id = $2',
      [tenantId, receiptId]
    )
    if (current.rowCount !== 1) throw httpError(404, 'Receipt not found')
    if (current.rows[0].status === 'reversed') {
      const receipt = await loadReceipt(client, tenantId, receiptId, { lock: true })
      const hash = payloadHash({ receipt_id: receipt.id, accounting_period_id: source.accounting_period_id, reversal_date: reversalDate, reason })
      if (receipt.reversal_idempotency_key !== key || receipt.reversal_payload_hash !== hash) {
        throw httpError(409, 'Receipt has already been reversed with a different request')
      }
      const posting = await readJournal(client, tenantId, receipt.reversal_journal_entry_id)
      return { receipt: publicReceipt(receipt), ...posting, replayed: true }
    }
    const allocatedInvoices = await client.query(
      `SELECT invoice.id::text AS id
       FROM invoices invoice
       WHERE invoice.tenant_id = $1 AND EXISTS (
         SELECT 1 FROM customer_receipt_allocations allocation
         WHERE allocation.tenant_id = invoice.tenant_id
           AND allocation.invoice_id = invoice.id AND allocation.receipt_id = $2
       )
       ORDER BY invoice.id`,
      [tenantId, receiptId]
    )
    const allocatedInvoiceIds = allocatedInvoices.rows.map((row) => row.id)
    await lockInvoices(client, tenantId, allocatedInvoiceIds)
    for (const invoiceId of allocatedInvoiceIds) {
      await assertInvoiceReservationAllowsReceipt(client, tenantId, invoiceId, receiptId)
    }
    const receipt = await loadReceipt(client, tenantId, receiptId, { lock: true })
    const hash = payloadHash({ receipt_id: receipt.id, accounting_period_id: source.accounting_period_id, reversal_date: reversalDate, reason })
    if (receipt.status === 'reversed') {
      if (receipt.reversal_idempotency_key !== key || receipt.reversal_payload_hash !== hash) {
        throw httpError(409, 'Receipt has already been reversed with a different request')
      }
      const posting = await readJournal(client, tenantId, receipt.reversal_journal_entry_id)
      return { receipt: publicReceipt(receipt), ...posting, replayed: true }
    }
    if (receipt.status !== 'verified') throw httpError(409, 'Only a verified receipt may be reversed')

    const posted = await reverseJournal(pool, {
      tenantId,
      userId,
      journalId: receipt.journal_entry_id,
      idempotencyKey: `customer-receipt:${receipt.id}:reverse:v1`,
      reversalDate,
      periodId: source.accounting_period_id,
      reason
    }, { client, allowedSourceTypes: ['customer_receipt'] })
    const updated = await client.query(
      `UPDATE customer_receipts
       SET status = 'reversed', reversal_idempotency_key = $1,
           reversal_payload_hash = $2, reversal_journal_entry_id = $3,
           reversal_reason = $4, reversed_by = $5, reversed_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $6 AND id = $7 AND status = 'verified'
       RETURNING *`,
      [key, hash, posted.journal.id, reason, userId, tenantId, receipt.id]
    )
    if (updated.rowCount !== 1) throw httpError(409, 'Receipt could not be reversed from its current state')
    if (allocatedInvoiceIds.length > 0) {
      await client.query(
        `UPDATE invoices invoice
         SET status = CASE WHEN invoice.due_date IS NOT NULL AND invoice.due_date < CURRENT_DATE
                      THEN 'overdue' ELSE 'sent' END
         WHERE invoice.tenant_id = $1 AND invoice.id = ANY($2::uuid[])
           AND invoice.status = 'paid'
           AND invoice.total > (
             SELECT COALESCE(sum(allocation.amount), 0)
             FROM customer_receipt_allocations allocation
             JOIN customer_receipts active_receipt
               ON active_receipt.tenant_id = allocation.tenant_id
              AND active_receipt.id = allocation.receipt_id AND active_receipt.status = 'verified'
             WHERE allocation.tenant_id = invoice.tenant_id AND allocation.invoice_id = invoice.id
           )`,
        [tenantId, allocatedInvoiceIds]
      )
    }
    await addReceiptEvent(client, {
      tenantId, receiptId: receipt.id, actorId: userId, eventType: 'reversed',
      details: { reversal_journal_entry_id: posted.journal.id, reason }
    })
    return { receipt: publicReceipt(updated.rows[0]), ...posted }
  })
}

async function listCustomerReceipts(pool, tenantId, customerId = null) {
  if (!isUuid(tenantId)) throw httpError(401, 'Authenticated tenant identity is required')
  if (customerId != null && !isUuid(customerId)) throw validationError('A valid customer is required')
  const result = await pool.query(
    `SELECT receipt.*,
            COALESCE(balance.allocated_amount, '0.00') AS allocated_amount,
            CASE WHEN receipt.status = 'verified'
              THEN (receipt.amount - COALESCE(balance.allocated_amount::numeric, 0))::text
              ELSE '0.00' END AS unallocated_amount
     FROM customer_receipts receipt
     LEFT JOIN LATERAL (
       SELECT COALESCE(sum(allocation.amount) FILTER (WHERE active_receipt.status = 'verified'), 0)::text AS allocated_amount
       FROM customer_receipt_allocations allocation
       JOIN customer_receipts active_receipt
         ON active_receipt.tenant_id = allocation.tenant_id AND active_receipt.id = allocation.receipt_id
       WHERE allocation.tenant_id = receipt.tenant_id AND allocation.receipt_id = receipt.id
     ) balance ON true
     WHERE receipt.tenant_id = $1 AND ($2::uuid IS NULL OR receipt.customer_id = $2)
     ORDER BY receipt.created_at DESC, receipt.id DESC`,
    [tenantId, customerId]
  )
  return result.rows.map((receipt) => publicReceipt(receipt))
}

async function getCustomerReceipt(pool, tenantId, receiptId) {
  if (!isUuid(tenantId)) throw httpError(401, 'Authenticated tenant identity is required')
  if (!isUuid(receiptId)) throw httpError(404, 'Receipt not found')
  const receipt = await pool.query(
    `SELECT receipt.*,
            COALESCE(balance.allocated_amount, '0.00') AS allocated_amount,
            CASE WHEN receipt.status = 'verified'
              THEN (receipt.amount - COALESCE(balance.allocated_amount::numeric, 0))::text
              ELSE '0.00' END AS unallocated_amount
     FROM customer_receipts receipt
     LEFT JOIN LATERAL (
       SELECT COALESCE(sum(allocation.amount) FILTER (WHERE active_receipt.status = 'verified'), 0)::text AS allocated_amount
       FROM customer_receipt_allocations allocation
       JOIN customer_receipts active_receipt
         ON active_receipt.tenant_id = allocation.tenant_id AND active_receipt.id = allocation.receipt_id
       WHERE allocation.tenant_id = receipt.tenant_id AND allocation.receipt_id = receipt.id
     ) balance ON true
     WHERE receipt.tenant_id = $1 AND receipt.id = $2`,
    [tenantId, receiptId]
  )
  if (receipt.rowCount !== 1) throw httpError(404, 'Receipt not found')
  const allocations = await pool.query(
    `SELECT allocation.id, allocation.invoice_id, invoice.invoice_number,
            allocation.amount::text AS amount, allocation.created_at,
            (receipt.status = 'verified') AS effective
     FROM customer_receipt_allocations allocation
     JOIN customer_receipts receipt
       ON receipt.tenant_id = allocation.tenant_id AND receipt.id = allocation.receipt_id
     JOIN invoices invoice
       ON invoice.tenant_id = allocation.tenant_id AND invoice.id = allocation.invoice_id
     WHERE allocation.tenant_id = $1 AND allocation.receipt_id = $2
     ORDER BY allocation.created_at, allocation.id`,
    [tenantId, receiptId]
  )
  const events = await pool.query(
    `SELECT id, event_type, actor_id, details, created_at
     FROM customer_receipt_events WHERE tenant_id = $1 AND receipt_id = $2
     ORDER BY created_at, id`,
    [tenantId, receiptId]
  )
  return { ...publicReceipt(receipt.rows[0]), allocations: allocations.rows, events: events.rows }
}

async function listOutstandingInvoices(pool, tenantId, customerId) {
  if (!isUuid(tenantId)) throw httpError(401, 'Authenticated tenant identity is required')
  if (!isUuid(customerId)) throw validationError('A valid customer is required')
  const result = await pool.query(
    `SELECT invoice.id, invoice.invoice_number, invoice.client_id AS customer_id,
            invoice.total::text AS total, invoice.status, settings.base_currency AS currency,
            COALESCE(sum(CASE WHEN receipt.status = 'verified' THEN allocation.amount ELSE 0 END), 0)::text AS allocated_amount,
            (invoice.total - COALESCE(sum(CASE WHEN receipt.status = 'verified' THEN allocation.amount ELSE 0 END), 0))::text AS outstanding_amount
     FROM invoices invoice
     JOIN accounting_settings settings ON settings.tenant_id = invoice.tenant_id
     JOIN accounting_invoice_tax_snapshots snapshot
       ON snapshot.tenant_id = invoice.tenant_id AND snapshot.source_type = 'invoice'
      AND snapshot.source_id = invoice.id AND snapshot.issued_at IS NOT NULL
     JOIN accounting_journal_entries journal
       ON journal.tenant_id = snapshot.tenant_id AND journal.id = snapshot.journal_entry_id
      AND journal.status = 'posted' AND journal.functional_currency = settings.base_currency
     LEFT JOIN customer_receipt_allocations allocation
       ON allocation.tenant_id = invoice.tenant_id AND allocation.invoice_id = invoice.id
     LEFT JOIN customer_receipts receipt
       ON receipt.tenant_id = allocation.tenant_id AND receipt.id = allocation.receipt_id
     WHERE invoice.tenant_id = $1 AND invoice.client_id = $2
       AND invoice.status IN ('sent', 'overdue') AND invoice.total = snapshot.total
       AND settings.base_currency = 'KES'
     GROUP BY invoice.id, invoice.invoice_number, invoice.client_id,
              invoice.total, invoice.status, settings.base_currency
     HAVING invoice.total - COALESCE(sum(CASE WHEN receipt.status = 'verified' THEN allocation.amount ELSE 0 END), 0) > 0
     ORDER BY invoice.invoice_number, invoice.id`,
    [tenantId, customerId]
  )
  return result.rows
}

async function getCustomerPaymentHistory(pool, tenantId, customerId) {
  const receipts = await listCustomerReceipts(pool, tenantId, customerId)
  const allocations = await pool.query(
    `SELECT allocation.id, allocation.receipt_id, allocation.invoice_id,
            invoice.invoice_number, allocation.amount::text AS amount,
            receipt.status AS receipt_status, allocation.created_at,
            (receipt.status = 'verified') AS effective
     FROM customer_receipt_allocations allocation
     JOIN customer_receipts receipt
       ON receipt.tenant_id = allocation.tenant_id AND receipt.id = allocation.receipt_id
     JOIN invoices invoice
       ON invoice.tenant_id = allocation.tenant_id AND invoice.id = allocation.invoice_id
     WHERE allocation.tenant_id = $1 AND allocation.customer_id = $2
     ORDER BY allocation.created_at, allocation.id`,
    [tenantId, customerId]
  )
  return { receipts, allocations: allocations.rows }
}

module.exports = {
  allocateCustomerReceipt,
  createCustomerReceipt,
  failCustomerReceipt,
  getCustomerPaymentHistory,
  getCustomerReceipt,
  listCustomerReceipts,
  listOutstandingInvoices,
  reverseCustomerReceipt,
  verifyCustomerReceipt
}

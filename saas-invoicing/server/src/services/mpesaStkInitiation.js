const crypto = require('node:crypto')
const { validate: isUuid } = require('uuid')
const { decimalUnits, httpError, normalizeIdempotencyKey, validationError } = require('../utils/accounting')
const { withTransaction } = require('./accounting')

const MAX_STK_AMOUNT_KES = 250000n
const MPESA_ID = /^[A-Za-z0-9_-]{1,150}$/
const ACTIVE_REQUEST_STATUSES = ['reserved', 'outcome_unknown', 'provider_accepted', 'reference_recovered', 'payment_recorded', 'provider_succeeded']
const RESOLUTION_OUTCOMES = new Set(['not_accepted', 'failed', 'cancelled'])

function normalizeKenyanPhone(value) {
  if (typeof value !== 'string') throw validationError('Phone number must be text')
  let phone = value.trim().replace(/\s+/g, '')
  if (phone.startsWith('+')) phone = phone.slice(1)
  if (phone.startsWith('0')) phone = `254${phone.slice(1)}`
  if (!/^254(?:1|7)\d{8}$/.test(phone)) {
    throw validationError('Phone number must be a Kenyan mobile number beginning with 01, 07, +2541 or +2547')
  }
  return phone
}

function safePayment(payment) {
  return {
    id: payment.id,
    invoice_id: payment.invoice_id,
    amount: payment.amount,
    mpesa_checkout_id: payment.mpesa_checkout_id,
    status: payment.status
  }
}

function requestPayload({ tenantId, invoiceId, amount, phoneNumber, invoiceNumber }) {
  if (!isUuid(tenantId) || typeof invoiceId !== 'string' || !invoiceId.trim() || invoiceId.length > 150) {
    throw httpError(400, 'A valid tenant and invoice are required')
  }
  if (typeof amount !== 'string') throw validationError('Invoice total must be an exact decimal string')
  const amountUnits = decimalUnits(amount, 2, 'Invoice total')
  if (amountUnits % 100n !== 0n) {
    throw httpError(409, 'M-Pesa STK Push supports whole KES amounts; this invoice has a fractional amount')
  }
  const wholeAmount = amountUnits / 100n
  if (wholeAmount > MAX_STK_AMOUNT_KES || wholeAmount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw httpError(409, 'M-Pesa STK Push amount exceeds the supported KES transaction limit')
  }
  if (typeof invoiceNumber !== 'string' || !invoiceNumber.trim() || invoiceNumber.length > 150) {
    throw httpError(400, 'A valid invoice number is required')
  }
  const normalizedPhone = normalizeKenyanPhone(phoneNumber)
  const normalizedAmount = `${amountUnits / 100n}.${(amountUnits % 100n).toString().padStart(2, '0')}`
  const payloadHash = crypto.createHash('sha256')
    .update(JSON.stringify({ tenantId, invoiceId, amount: normalizedAmount, currency: 'KES', phone: normalizedPhone, invoiceNumber }))
    .digest('hex')
  return { amountUnits, normalizedAmount, wholeAmount, normalizedPhone, payloadHash }
}

function stateConflict(message, status) {
  const error = httpError(409, message)
  error.requestStatus = status
  return error
}

async function withInvoiceAdvisoryLock(pool, tenantId, invoiceId, work) {
  const client = await pool.connect()
  const lockName = `${tenantId}:${invoiceId}`
  let locked = false
  let releaseError
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1::text, 0))', [lockName])
    locked = true
    return await work()
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1::text, 0))', [lockName])
      } catch (error) { releaseError = error }
    }
    client.release(releaseError)
  }
}

async function lockInvoiceCustomer(client, tenantId, invoiceId) {
  const owner = await client.query(
    `SELECT client_id::text AS customer_id
     FROM invoices WHERE tenant_id = $1 AND id::text = $2`,
    [tenantId, invoiceId]
  )
  if (owner.rowCount !== 1) throw httpError(404, 'Invoice not found')
  const customer = await client.query(
    'SELECT id FROM clients WHERE tenant_id = $1 AND id::text = $2 FOR UPDATE',
    [tenantId, owner.rows[0].customer_id]
  )
  if (customer.rowCount !== 1) throw httpError(404, 'Invoice customer not found')
  const invoice = await client.query(
    `SELECT invoice.id::text AS id, invoice.client_id::text AS customer_id,
            invoice.invoice_number, invoice.total::text AS total, invoice.status,
            snapshot.total::text AS snapshot_total, snapshot.issued_at,
            journal.status AS journal_status,
            journal.functional_currency AS invoice_currency
     FROM invoices invoice
     LEFT JOIN accounting_invoice_tax_snapshots snapshot
       ON snapshot.tenant_id = invoice.tenant_id AND snapshot.source_type = 'invoice'
      AND snapshot.source_id = invoice.id
     LEFT JOIN accounting_journal_entries journal
       ON journal.tenant_id = snapshot.tenant_id AND journal.id = snapshot.journal_entry_id
     WHERE invoice.tenant_id = $1 AND invoice.id::text = $2
     FOR UPDATE OF invoice`,
    [tenantId, invoiceId]
  )
  if (invoice.rowCount !== 1) throw httpError(404, 'Invoice not found')
  return invoice.rows[0]
}

async function hasUnallocatedCustomerReceipt(client, tenantId, customerId) {
  const result = await client.query(
    `SELECT receipt.id
     FROM customer_receipts receipt
     WHERE receipt.tenant_id = $1 AND receipt.customer_id = $2
       AND (receipt.status = 'pending' OR (
         receipt.status = 'verified' AND receipt.amount > COALESCE((
           SELECT sum(allocation.amount)
           FROM customer_receipt_allocations allocation
           JOIN customer_receipts active_receipt
             ON active_receipt.tenant_id = allocation.tenant_id
            AND active_receipt.id = allocation.receipt_id
            AND active_receipt.status = 'verified'
           WHERE allocation.tenant_id = receipt.tenant_id
             AND allocation.receipt_id = receipt.id
         ), 0
       )))
     LIMIT 1`,
    [tenantId, customerId]
  )
  return result.rowCount > 0
}

async function reserveRequest(pool, { tenantId, userId, key, invoiceId, phoneNumber }) {
  return withTransaction(pool, async (client) => {
    const existing = await client.query(
      `SELECT id, request_status, payload_hash, invoice_id, invoice_number,
              amount::text AS amount, currency, phone_number,
              provider_checkout_request_id, merchant_request_id, payment_id,
              created_at, updated_at
       FROM mpesa_stk_initiation_requests
       WHERE tenant_id = $1 AND idempotency_key = $2
       FOR UPDATE`,
      [tenantId, key]
    )
    if (existing.rowCount === 1) {
      const row = existing.rows[0]
      const replayPayload = requestPayload({
        tenantId,
        invoiceId,
        invoiceNumber: row.invoice_number,
        amount: row.amount,
        phoneNumber
      })
      if (row.payload_hash !== replayPayload.payloadHash) {
        throw httpError(409, 'Idempotency-Key was already used for a different M-Pesa request payload')
      }
      if (row.request_status === 'payment_recorded' || row.request_status === 'provider_succeeded') {
        return { row, newlyReserved: false, alreadyRecorded: true }
      }
      if (row.request_status === 'provider_accepted') return { row, newlyReserved: false }
      throw stateConflict(
        row.request_status === 'resolved_no_collection' || row.request_status === 'provider_rejected'
          ? 'This M-Pesa request was closed without a collection. Use a new idempotency key only after reviewing its audit history.'
          : 'This M-Pesa request has an unresolved provider outcome. Do not submit it again; review the request status and provider records.',
        row.request_status
      )
    }

    const reservationConstraint = await client.query(
      `SELECT to_regclass('public.mpesa_stk_one_active_request_per_invoice_uq') IS NOT NULL AS available`
    )
    if (reservationConstraint.rows[0]?.available !== true) {
      throw httpError(503, 'M-Pesa invoice reservation migration is unavailable; do not submit a payment prompt')
    }

    // All receipt paths lock the customer first, then invoice rows. That makes
    // the receipt checks and the invoice reservation one serial transaction.
    const invoice = await lockInvoiceCustomer(client, tenantId, invoiceId)
    if (!['sent', 'overdue'].includes(invoice.status)) {
      throw httpError(409, 'Only an issued invoice can accept a payment request')
    }
    if (invoice.issued_at == null || invoice.journal_status !== 'posted' ||
        invoice.invoice_currency !== 'KES' || invoice.total !== invoice.snapshot_total) {
      throw httpError(409, 'M-Pesa requests require a matching posted KES invoice record')
    }
    const payload = requestPayload({
      tenantId,
      invoiceId,
      invoiceNumber: invoice.invoice_number,
      amount: invoice.total,
      phoneNumber
    })
    const balance = await client.query(
      `SELECT COALESCE(sum(allocation.amount), 0)::text AS allocated
       FROM customer_receipt_allocations allocation
       JOIN customer_receipts active_receipt
         ON active_receipt.tenant_id = allocation.tenant_id
        AND active_receipt.id = allocation.receipt_id AND active_receipt.status = 'verified'
       WHERE allocation.tenant_id = $1 AND allocation.invoice_id::text = $2`,
      [tenantId, invoiceId]
    )
    const allocatedUnits = decimalUnits(String(balance.rows[0].allocated), 2, 'Invoice allocated amount', { allowZero: true })
    if (decimalUnits(invoice.total, 2, 'Invoice total') - allocatedUnits !== payload.amountUnits) {
      throw httpError(409, 'M-Pesa STK prompts require the full invoice balance to be outstanding; use the customer receipt workflow for a partial balance')
    }
    if (await hasUnallocatedCustomerReceipt(client, tenantId, invoice.customer_id)) {
      throw httpError(409, 'A pending or unallocated customer receipt exists; review and allocate it before starting another payment prompt')
    }

    const active = await client.query(
      `SELECT id, request_status
       FROM mpesa_stk_initiation_requests
       WHERE tenant_id = $1 AND invoice_id = $2
         AND request_status = ANY($3::text[])
       FOR UPDATE`,
      [tenantId, invoiceId, ACTIVE_REQUEST_STATUSES]
    )
    if (active.rowCount > 0) {
      throw stateConflict('This invoice already has an outstanding M-Pesa request; resolve or reconcile it before trying another payment channel', active.rows[0].request_status)
    }

    const inserted = await client.query(
      `INSERT INTO mpesa_stk_initiation_requests
         (tenant_id, idempotency_key, payload_hash, invoice_id, invoice_number,
          amount, currency, phone_number, request_status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'KES', $7, 'reserved', $8)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING id, request_status, payload_hash, invoice_id, amount::text AS amount,
                 currency, phone_number, provider_checkout_request_id,
                 merchant_request_id, payment_id, created_at, updated_at`,
      [tenantId, key, payload.payloadHash, invoiceId, invoice.invoice_number,
        payload.normalizedAmount, payload.normalizedPhone, userId]
    )
    if (inserted.rowCount === 1) {
      const row = inserted.rows[0]
      await client.query(
        `INSERT INTO mpesa_stk_initiation_events
           (tenant_id, request_id, event_type, from_status, to_status, actor_id)
         VALUES ($1, $2, 'reserved', NULL, 'reserved', $3)`,
        [tenantId, row.id, userId]
      )
      return { row, newlyReserved: true }
    }

    const concurrent = await client.query(
      `SELECT id, request_status, payload_hash, invoice_id, amount::text AS amount,
              invoice_number, currency, phone_number, provider_checkout_request_id,
              merchant_request_id, payment_id, created_at, updated_at
       FROM mpesa_stk_initiation_requests
       WHERE tenant_id = $1 AND idempotency_key = $2
       FOR UPDATE`,
      [tenantId, key]
    )
    if (concurrent.rowCount !== 1) throw stateConflict('M-Pesa request reservation could not be resolved; inspect its status before retrying', 'unknown')
    const row = concurrent.rows[0]
    if (row.payload_hash !== payload.payloadHash) {
      throw httpError(409, 'Idempotency-Key was already used for a different M-Pesa request payload')
    }
    if (row.request_status === 'payment_recorded' || row.request_status === 'provider_succeeded') return { row, newlyReserved: false, alreadyRecorded: true }
    if (row.request_status === 'provider_accepted') return { row, newlyReserved: false }
    throw stateConflict(
      'This M-Pesa request has an unresolved provider outcome. Do not submit it again; review the request status and provider records.',
      row.request_status
    )
  })
}

async function markProviderRejected(pool, { tenantId, userId, key, providerResponseCode }) {
  return withTransaction(pool, async (client) => {
    const updated = await client.query(
      `UPDATE mpesa_stk_initiation_requests
       SET request_status = 'provider_rejected', phone_number = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $1 AND idempotency_key = $2 AND request_status = 'reserved'
       RETURNING id`,
      [tenantId, key]
    )
    if (updated.rowCount === 1) {
      await client.query(
        `INSERT INTO mpesa_stk_initiation_events
           (tenant_id, request_id, event_type, from_status, to_status, actor_id, details)
         VALUES ($1, $2, 'provider_rejected', 'reserved', 'provider_rejected', $3, $4::jsonb)`,
        [tenantId, updated.rows[0].id, userId, JSON.stringify({ provider_response_code: providerResponseCode })]
      )
    }
  })
}

function definiteProviderRejectionCode(response) {
  const checkoutId = response?.CheckoutRequestID
  const code = response?.ResponseCode
  if (typeof checkoutId === 'string' && MPESA_ID.test(checkoutId)) return null
  const normalized = typeof code === 'number' && Number.isSafeInteger(code)
    ? String(code)
    : typeof code === 'string' && /^\d{1,10}$/.test(code) ? code : null
  return normalized && normalized !== '0' ? normalized : null
}

async function markOutcomeUnknown(pool, { tenantId, userId, key, checkoutRequestId = null, merchantRequestId = null }) {
  return withTransaction(pool, async (client) => {
    const updated = await client.query(
      `UPDATE mpesa_stk_initiation_requests
       SET request_status = 'outcome_unknown',
           provider_checkout_request_id = COALESCE($3, provider_checkout_request_id),
           merchant_request_id = COALESCE($4, merchant_request_id),
           phone_number = CASE WHEN $3 IS NULL THEN NULL ELSE phone_number END,
           updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $1 AND idempotency_key = $2 AND request_status = 'reserved'
       RETURNING id`,
      [tenantId, key, checkoutRequestId, merchantRequestId]
    )
    if (updated.rowCount === 1) {
      await client.query(
        `INSERT INTO mpesa_stk_initiation_events
           (tenant_id, request_id, event_type, from_status, to_status,
            checkout_request_id, merchant_request_id, actor_id)
         VALUES ($1, $2, 'outcome_unknown', 'reserved', 'outcome_unknown', $3, $4, $5)`,
        [tenantId, updated.rows[0].id, checkoutRequestId, merchantRequestId, userId]
      )
    }
  })
}

async function persistProviderAcceptance(pool, { tenantId, userId, key, fromStatus, checkoutRequestId, merchantRequestId }) {
  return withTransaction(pool, async (client) => {
    const updated = await client.query(
      `UPDATE mpesa_stk_initiation_requests
       SET request_status = 'provider_accepted', provider_checkout_request_id = $3,
           merchant_request_id = $4, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $1 AND idempotency_key = $2
         AND request_status IN ('reserved', 'outcome_unknown')
         AND (provider_checkout_request_id IS NULL OR provider_checkout_request_id = $3)
       RETURNING id`,
      [tenantId, key, checkoutRequestId, merchantRequestId]
    )
    if (updated.rowCount !== 1) throw stateConflict('Provider accepted the prompt but its request state could not be advanced; review the saved request before retrying', 'reserved')
    await client.query(
      `INSERT INTO mpesa_stk_initiation_events
         (tenant_id, request_id, event_type, from_status, to_status,
          checkout_request_id, merchant_request_id, actor_id)
       VALUES ($1, $2, 'provider_accepted', $3, 'provider_accepted', $4, $5, $6)`,
      [tenantId, updated.rows[0].id, fromStatus, checkoutRequestId, merchantRequestId, userId]
    )
  })
}

async function recordPayment(pool, { tenantId, userId, key }) {
  return withTransaction(pool, async (client) => {
    const selected = await client.query(
      `SELECT id, invoice_id, invoice_number, amount::text AS amount, currency,
              phone_number, request_status, provider_checkout_request_id,
              merchant_request_id, payment_id
       FROM mpesa_stk_initiation_requests
       WHERE tenant_id = $1 AND idempotency_key = $2
       FOR UPDATE`,
      [tenantId, key]
    )
    if (selected.rowCount !== 1) throw httpError(404, 'M-Pesa initiation request not found')
    const request = selected.rows[0]
    if (request.request_status === 'payment_recorded') {
      return {
        request: { id: request.id, status: request.request_status, checkoutRequestId: request.provider_checkout_request_id },
        payment: { id: request.payment_id, invoice_id: request.invoice_id, amount: request.amount,
          mpesa_checkout_id: request.provider_checkout_request_id, status: 'pending' },
        replayed: true
      }
    }
    if (!['provider_accepted', 'reference_recovered'].includes(request.request_status) ||
        !request.provider_checkout_request_id || !request.phone_number) {
      throw stateConflict('M-Pesa request has no safely persisted checkout reference and phone to record', request.request_status)
    }
    const fromStatus = request.request_status

    const payment = await client.query(
      `INSERT INTO payments
         (tenant_id, invoice_id, amount, phone_number, mpesa_checkout_id, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING id::text AS id, invoice_id::text AS invoice_id, amount::text AS amount,
                 mpesa_checkout_id, status`,
      [tenantId, request.invoice_id, request.amount, request.phone_number, request.provider_checkout_request_id]
    )
    if (payment.rowCount !== 1) throw httpError(503, 'The checkout reference was saved but its pending payment row was not recorded; use the same request or recovery evidence to resume')
    const updated = await client.query(
      `UPDATE mpesa_stk_initiation_requests
       SET request_status = 'payment_recorded', payment_id = $3, phone_number = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $1 AND idempotency_key = $2
         AND request_status IN ('provider_accepted', 'reference_recovered')
       RETURNING id, provider_checkout_request_id`,
      [tenantId, key, payment.rows[0].id]
    )
    if (updated.rowCount !== 1) throw stateConflict('Pending payment was not linked to its M-Pesa initiation request', 'provider_accepted')
    await client.query(
      `INSERT INTO mpesa_stk_initiation_events
         (tenant_id, request_id, event_type, from_status, to_status,
          checkout_request_id, merchant_request_id, payment_id, actor_id)
       VALUES ($1, $2, 'payment_recorded', $3, 'payment_recorded', $4, $5, $6, $7)`,
      [tenantId, updated.rows[0].id, fromStatus, updated.rows[0].provider_checkout_request_id,
        request.merchant_request_id, payment.rows[0].id, userId]
    )
    return {
      request: { id: updated.rows[0].id, status: 'payment_recorded', checkoutRequestId: updated.rows[0].provider_checkout_request_id },
      payment: safePayment(payment.rows[0]),
      replayed: false
    }
  })
}

async function initiateMpesaStkRequest(pool, {
  tenantId, userId, idempotencyKey, invoiceId, phoneNumber, provider
}) {
  if (!isUuid(tenantId) || !isUuid(userId)) throw httpError(401, 'Authenticated tenant and user identities are required')
  if (typeof provider !== 'function') throw httpError(503, 'M-Pesa provider is unavailable')
  if (typeof invoiceId !== 'string' || !invoiceId.trim() || invoiceId.length > 150) {
    throw httpError(400, 'A valid invoice is required')
  }
  const key = normalizeIdempotencyKey(idempotencyKey)
  normalizeKenyanPhone(phoneNumber)
  return withInvoiceAdvisoryLock(pool, tenantId, invoiceId, async () => {
    let reserved
    try {
      reserved = await reserveRequest(pool, { tenantId, userId, key, invoiceId, phoneNumber })
    } catch (error) {
      if (error.code === '23505' && error.constraint === 'mpesa_stk_one_active_request_per_invoice_uq') {
        throw stateConflict('This invoice already has an outstanding M-Pesa request; resolve or reconcile it before trying another payment channel', 'reserved')
      }
      throw error
    }

    if (reserved.alreadyRecorded) {
      const row = reserved.row
      return {
        request: { id: row.id, status: row.request_status, checkoutRequestId: row.provider_checkout_request_id },
        payment: { id: row.payment_id, invoice_id: row.invoice_id, amount: row.amount,
          mpesa_checkout_id: row.provider_checkout_request_id, status: 'pending' },
        replayed: true
      }
    }

    if (reserved.newlyReserved) {
      let providerResponse
      try {
        providerResponse = await provider({
          phone: reserved.row.phone_number,
          amount: Number(decimalUnits(String(reserved.row.amount), 2, 'Invoice total') / 100n),
          invoiceNumber: reserved.row.invoice_number
        })
      } catch (error) {
        const responseBody = error?.response?.data
        const checkoutRequestId = typeof responseBody?.CheckoutRequestID === 'string' && MPESA_ID.test(responseBody.CheckoutRequestID)
          ? responseBody.CheckoutRequestID : null
        const merchantRequestId = typeof responseBody?.MerchantRequestID === 'string' && MPESA_ID.test(responseBody.MerchantRequestID)
          ? responseBody.MerchantRequestID : null
        try {
          await markOutcomeUnknown(pool, { tenantId, userId, key, checkoutRequestId, merchantRequestId })
        } catch (_stateError) { /* Keep the durable reservation; retry remains blocked. */ }
        throw httpError(502, 'M-Pesa request outcome is unknown. Do not submit another prompt; investigate the saved request and provider records.')
      }
      const checkoutRequestId = providerResponse?.CheckoutRequestID
      const merchantRequestId = providerResponse?.MerchantRequestID
      const checkoutIdIsValid = typeof checkoutRequestId === 'string' && MPESA_ID.test(checkoutRequestId)
      const merchantIdIsValid = merchantRequestId == null ||
        (typeof merchantRequestId === 'string' && MPESA_ID.test(merchantRequestId))
      if (providerResponse?.ResponseCode !== '0' && providerResponse?.ResponseCode !== 0) {
        const rejectionCode = definiteProviderRejectionCode(providerResponse)
        if (rejectionCode) {
          await markProviderRejected(pool, { tenantId, userId, key, providerResponseCode: rejectionCode })
          throw httpError(502, 'Daraja rejected the M-Pesa request. No retry was issued; review the saved request before using a new key.')
        }
      }
      if (providerResponse?.ResponseCode !== '0' && providerResponse?.ResponseCode !== 0 ||
          !checkoutIdIsValid || !merchantIdIsValid) {
        try {
          await markOutcomeUnknown(pool, {
            tenantId, userId, key,
            checkoutRequestId: checkoutIdIsValid ? checkoutRequestId : null,
            merchantRequestId: typeof merchantRequestId === 'string' && MPESA_ID.test(merchantRequestId) ? merchantRequestId : null
          })
        } catch (_stateError) { /* Keep the durable reservation; retry remains blocked. */ }
        throw httpError(502, 'M-Pesa response could not be safely identified. Do not submit another prompt; investigate the saved request.')
      }
      try {
        await persistProviderAcceptance(pool, { tenantId, userId, key, fromStatus: 'reserved', checkoutRequestId, merchantRequestId: merchantRequestId || null })
      } catch (_error) {
        try {
          await markOutcomeUnknown(pool, { tenantId, userId, key, checkoutRequestId, merchantRequestId: merchantRequestId || null })
        } catch (_stateError) { /* The original reservation remains the fail-closed state. */ }
        throw httpError(503, 'M-Pesa prompt may have been accepted but its response could not be durably recorded. Do not submit another prompt; investigate the request.')
      }
    }

    return recordPayment(pool, { tenantId, userId, key })
  })
}

async function recoverMpesaStkRequest(pool, {
  tenantId, userId, idempotencyKey, checkoutRequestId, phoneNumber,
  evidenceReference, reason, confirmExternalReference
}) {
  if (!isUuid(tenantId) || !isUuid(userId)) throw httpError(401, 'Authenticated tenant and user identities are required')
  const key = normalizeIdempotencyKey(idempotencyKey)
  const initial = await pool.query(
    `SELECT invoice_id FROM mpesa_stk_initiation_requests
     WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenantId, key]
  )
  if (initial.rowCount !== 1) throw httpError(404, 'M-Pesa initiation request not found')

  return withInvoiceAdvisoryLock(pool, tenantId, initial.rows[0].invoice_id, async () => {
    const selected = await withTransaction(pool, async (client) => {
      const owner = await client.query(
        `SELECT client_id::text AS customer_id FROM invoices
         WHERE tenant_id = $1 AND id::text = $2`,
        [tenantId, initial.rows[0].invoice_id]
      )
      if (owner.rowCount !== 1) throw httpError(409, 'The reserved invoice is unavailable; investigate the request with the database administrator')
      await client.query('SELECT id FROM clients WHERE tenant_id = $1 AND id::text = $2 FOR UPDATE', [tenantId, owner.rows[0].customer_id])
      await client.query('SELECT id FROM invoices WHERE tenant_id = $1 AND id::text = $2 FOR UPDATE', [tenantId, initial.rows[0].invoice_id])
      const result = await client.query(
        `SELECT id, request_status, provider_checkout_request_id, merchant_request_id,
                phone_number, payment_id, invoice_id, invoice_number, amount::text AS amount
         FROM mpesa_stk_initiation_requests
         WHERE tenant_id = $1 AND idempotency_key = $2 FOR UPDATE`,
        [tenantId, key]
      )
      if (result.rowCount !== 1) throw httpError(404, 'M-Pesa initiation request not found')
      const row = result.rows[0]
      if (['payment_recorded', 'provider_succeeded'].includes(row.request_status)) return { row, done: true }
      if (row.request_status === 'provider_accepted') return { row, done: false }

      if (!['outcome_unknown', 'reference_recovered'].includes(row.request_status)) {
        throw stateConflict('The M-Pesa request is not eligible for recovery. Do not send another prompt; investigate its saved state.', row.request_status)
      }
      if (confirmExternalReference !== true) {
        throw validationError('Confirm that the checkout identifier was obtained from an external Daraja record')
      }
      const recoveredCheckoutId = typeof checkoutRequestId === 'string' && MPESA_ID.test(checkoutRequestId)
        ? checkoutRequestId : null
      if (!recoveredCheckoutId || (row.provider_checkout_request_id && row.provider_checkout_request_id !== recoveredCheckoutId)) {
        throw validationError('A valid provider checkout identifier matching the saved record is required')
      }
      const normalizedPhone = normalizeKenyanPhone(phoneNumber)
      const payload = requestPayload({
        tenantId, invoiceId: row.invoice_id, amount: row.amount,
        phoneNumber: normalizedPhone, invoiceNumber: row.invoice_number
      })
      if (row.payload_hash !== payload.payloadHash) {
        throw validationError('The recovered phone number does not match the original M-Pesa request')
      }
      if (typeof evidenceReference !== 'string' || evidenceReference.trim().length < 3 || evidenceReference.trim().length > 200 ||
          /[\u0000-\u001f\u007f]/.test(evidenceReference) || typeof reason !== 'string' || reason.trim().length < 5 ||
          reason.trim().length > 1800 || /[\u0000-\u001f\u007f]/.test(reason)) {
        throw validationError('A provider record reference and recovery reason are required')
      }
      const normalizedEvidence = evidenceReference.trim()
      const normalizedReason = reason.trim()
      if (row.request_status === 'reference_recovered') {
        const prior = await client.query(
          `SELECT details FROM mpesa_stk_initiation_events
           WHERE tenant_id = $1 AND request_id = $2 AND event_type = 'reference_recovered'
           ORDER BY created_at DESC, id DESC LIMIT 1`,
          [tenantId, row.id]
        )
        const details = prior.rows[0]?.details
        if (details?.checkout_request_id !== recoveredCheckoutId || details?.evidence_reference !== normalizedEvidence ||
            details?.reason !== normalizedReason) {
          throw httpError(409, 'This ambiguous M-Pesa request was recovered using different provider evidence')
        }
        return { row, done: false }
      }

      const updated = await client.query(
        `UPDATE mpesa_stk_initiation_requests
         SET request_status = 'reference_recovered',
             provider_checkout_request_id = $3, phone_number = $4,
             updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = $1 AND id = $2 AND request_status = 'outcome_unknown'
         RETURNING id`,
        [tenantId, row.id, recoveredCheckoutId, normalizedPhone]
      )
      if (updated.rowCount !== 1) throw stateConflict('M-Pesa request changed while provider evidence was being recorded', row.request_status)
      await client.query(
        `INSERT INTO mpesa_stk_initiation_events
           (tenant_id, request_id, event_type, from_status, to_status,
            checkout_request_id, merchant_request_id, actor_id, details)
         VALUES ($1, $2, 'reference_recovered', 'outcome_unknown', 'reference_recovered', $3, $4, $5, $6::jsonb)`,
        [tenantId, row.id, recoveredCheckoutId, row.merchant_request_id, userId,
          JSON.stringify({ checkout_request_id: recoveredCheckoutId, evidence_reference: normalizedEvidence, reason: normalizedReason,
            source: 'administrator_external_provider_record' })]
      )
      return { row: { ...row, request_status: 'reference_recovered', provider_checkout_request_id: recoveredCheckoutId }, done: false }
    })

    if (selected.done) {
      return {
        request: { id: selected.row.id, status: selected.row.request_status, checkoutRequestId: selected.row.provider_checkout_request_id },
        payment: { id: selected.row.payment_id, invoice_id: selected.row.invoice_id, amount: selected.row.amount,
          mpesa_checkout_id: selected.row.provider_checkout_request_id, status: 'pending' },
        replayed: true
      }
    }
    return recordPayment(pool, { tenantId, userId, key })
  })
}

async function resolveMpesaStkRequest(pool, {
  tenantId, userId, idempotencyKey, resolution, evidenceReference, reason,
  confirmNoCollection, confirmNoOutstandingPrompt
}) {
  if (!isUuid(tenantId) || !isUuid(userId)) throw httpError(401, 'Authenticated tenant and user identities are required')
  const key = normalizeIdempotencyKey(idempotencyKey)
  if (confirmNoCollection !== true || confirmNoOutstandingPrompt !== true || !RESOLUTION_OUTCOMES.has(resolution)) {
    throw validationError('Confirm no collection, confirm no active prompt and choose not_accepted, failed or cancelled after reviewing provider records')
  }
  if (typeof evidenceReference !== 'string' || evidenceReference.trim().length < 3 || evidenceReference.trim().length > 200 ||
      /[\u0000-\u001f\u007f]/.test(evidenceReference)) {
    throw validationError('A provider portal or support evidence reference is required')
  }
  if (typeof reason !== 'string' || reason.trim().length < 5 || reason.trim().length > 1800 ||
      /[\u0000-\u001f\u007f]/.test(reason)) {
    throw validationError('A resolution reason is required')
  }
  const normalizedEvidenceReference = evidenceReference.trim()
  const normalizedReason = reason.trim()
  const initial = await pool.query(
    `SELECT invoice_id FROM mpesa_stk_initiation_requests
     WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenantId, key]
  )
  if (initial.rowCount !== 1) throw httpError(404, 'M-Pesa initiation request not found')
  const reservationConstraint = await pool.query(
    `SELECT to_regclass('public.mpesa_stk_one_active_request_per_invoice_uq') IS NOT NULL AS available`
  )
  if (reservationConstraint.rows[0]?.available !== true) {
    throw httpError(503, 'M-Pesa invoice reservation migration is unavailable; do not release the request')
  }

  return withInvoiceAdvisoryLock(pool, tenantId, initial.rows[0].invoice_id, async () => withTransaction(pool, async (client) => {
    const owner = await client.query(
      `SELECT client_id::text AS customer_id
       FROM invoices WHERE tenant_id = $1 AND id::text = $2`,
      [tenantId, initial.rows[0].invoice_id]
    )
    if (owner.rowCount !== 1) throw httpError(409, 'The reserved invoice is unavailable; investigate the request with the database administrator')
    await client.query('SELECT id FROM clients WHERE tenant_id = $1 AND id::text = $2 FOR UPDATE', [tenantId, owner.rows[0].customer_id])
    await client.query('SELECT id FROM invoices WHERE tenant_id = $1 AND id::text = $2 FOR UPDATE', [tenantId, initial.rows[0].invoice_id])

    const selected = await client.query(
      `SELECT id, invoice_id, request_status, provider_checkout_request_id,
              merchant_request_id, payment_id
       FROM mpesa_stk_initiation_requests
       WHERE tenant_id = $1 AND idempotency_key = $2 FOR UPDATE`,
      [tenantId, key]
    )
    if (selected.rowCount !== 1) throw httpError(404, 'M-Pesa initiation request not found')
    const row = selected.rows[0]
    const eventType = `admin_resolved_${resolution}`
    if (row.request_status === 'resolved_no_collection') {
      const prior = await client.query(
        `SELECT details FROM mpesa_stk_initiation_events
         WHERE tenant_id = $1 AND request_id = $2 AND event_type = $3
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [tenantId, row.id, eventType]
      )
      const details = prior.rows[0]?.details
      if (details?.evidence_reference === normalizedEvidenceReference && details?.reason === normalizedReason) {
        return { id: row.id, status: row.request_status, checkout_request_id: row.provider_checkout_request_id, replayed: true }
      }
      throw httpError(409, 'This M-Pesa request has already been resolved')
    }
    if (!ACTIVE_REQUEST_STATUSES.includes(row.request_status) || row.request_status === 'provider_succeeded') {
      throw stateConflict('This M-Pesa request cannot be released because its state is not safely resolvable', row.request_status)
    }

    const updated = await client.query(
      `UPDATE mpesa_stk_initiation_requests
       SET request_status = 'resolved_no_collection', phone_number = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $1 AND id = $2
         AND request_status = ANY($3::text[])
       RETURNING id, provider_checkout_request_id`,
      [tenantId, row.id, ACTIVE_REQUEST_STATUSES.filter((status) => status !== 'provider_succeeded')]
    )
    if (updated.rowCount !== 1) throw stateConflict('M-Pesa request state changed while it was being resolved', row.request_status)
    const details = {
      resolution,
      evidence_reference: normalizedEvidenceReference,
      reason: normalizedReason,
      assertion: 'administrator_confirmed_no_collection_and_no_outstanding_prompt',
      confirmed_no_collection: true,
      confirmed_no_outstanding_prompt: true
    }
    await client.query(
      `INSERT INTO mpesa_stk_initiation_events
         (tenant_id, request_id, event_type, from_status, to_status,
          checkout_request_id, merchant_request_id, actor_id, details)
       VALUES ($1, $2, $3, $4, 'resolved_no_collection', $5, $6, $7, $8::jsonb)`,
      [tenantId, row.id, eventType, row.request_status, row.provider_checkout_request_id,
        row.merchant_request_id, userId, JSON.stringify(details)]
    )
    return { id: row.id, status: 'resolved_no_collection', checkout_request_id: row.provider_checkout_request_id, replayed: false }
  }))
}

async function getMpesaStkInitiationStatus(pool, tenantId, idempotencyKey) {
  if (!isUuid(tenantId)) throw httpError(401, 'Authenticated tenant identity is required')
  const key = normalizeIdempotencyKey(idempotencyKey)
  const result = await pool.query(
    `SELECT id, invoice_id, amount::text AS amount, currency, request_status,
            provider_checkout_request_id, merchant_request_id, payment_id,
            created_at, updated_at
     FROM mpesa_stk_initiation_requests
     WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenantId, key]
  )
  if (result.rowCount !== 1) throw httpError(404, 'M-Pesa initiation request not found')
  const row = result.rows[0]
  const events = await pool.query(
    `SELECT event_type, from_status, to_status, checkout_request_id,
            merchant_request_id, payment_id, actor_id, details, created_at
     FROM mpesa_stk_initiation_events
     WHERE tenant_id = $1 AND request_id = $2
     ORDER BY created_at, id`,
    [tenantId, row.id]
  )
  return {
    id: row.id,
    invoice_id: row.invoice_id,
    amount: row.amount,
    currency: row.currency,
    status: row.request_status,
    checkout_request_id: row.provider_checkout_request_id,
    merchant_request_id: row.merchant_request_id,
    payment_id: row.payment_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    events: events.rows
  }
}

module.exports = {
  getMpesaStkInitiationStatus,
  initiateMpesaStkRequest,
  normalizeKenyanPhone,
  recoverMpesaStkRequest,
  resolveMpesaStkRequest
}

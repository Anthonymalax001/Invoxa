const crypto = require('node:crypto')
const { validate: isUuid } = require('uuid')
const { withTransaction } = require('./accounting')
const { createCustomerReceipt } = require('./customerReceipts')
const {
  decimalUnits,
  httpError,
  normalizeIdempotencyKey,
  validationError
} = require('../utils/accounting')

const CHECKOUT_ID = /^[A-Za-z0-9_-]{1,150}$/

function normalizePaymentDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw validationError('Payment date must use YYYY-MM-DD')
  }
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw validationError('Payment date is invalid')
  }
  return value
}

function requireIdentity(tenantId, userId) {
  if (!isUuid(tenantId) || !isUuid(userId)) {
    throw httpError(401, 'Authenticated tenant and user identities are required')
  }
}

function payloadHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function normalizeResultCode(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  if (typeof value === 'string' && /^-?\d{1,20}$/.test(value)) return value
  return null
}

function queryOutcome(response, expectedCheckoutId, expectedAmount) {
  if (!response || typeof response !== 'object' || Array.isArray(response) ||
      String(response.ResponseCode) !== '0') {
    return { outcome: 'query_failed', providerResultCode: null }
  }
  const resultCode = normalizeResultCode(response.ResultCode)
  if (response.CheckoutRequestID !== expectedCheckoutId || resultCode == null) {
    return { outcome: 'inconclusive', providerResultCode: resultCode }
  }
  if (resultCode === '0' && response.Amount != null) {
    try {
      if (decimalUnits(String(response.Amount), 2, 'Provider amount') !==
          decimalUnits(expectedAmount, 2, 'M-Pesa request amount')) {
        return { outcome: 'inconclusive', providerResultCode: resultCode }
      }
    } catch {
      return { outcome: 'inconclusive', providerResultCode: resultCode }
    }
  }
  return {
    outcome: resultCode === '0' ? 'provider_success' : 'provider_non_success',
    providerResultCode: resultCode
  }
}

async function loadPayment(client, tenantId, paymentId, { lock = false } = {}) {
  const result = await client.query(
    `SELECT payment.id::text AS payment_id, payment.tenant_id, payment.invoice_id::text AS invoice_id,
            payment.amount::text AS payment_amount, payment.mpesa_checkout_id, payment.status AS payment_status,
            invoice.client_id::text AS customer_id, invoice.total::text AS invoice_total,
            invoice.status AS invoice_status, snapshot.total::text AS snapshot_total,
            snapshot.issued_at, journal.status AS journal_status,
            journal.functional_currency AS invoice_currency
     FROM payments payment
     JOIN invoices invoice
       ON invoice.tenant_id = payment.tenant_id AND invoice.id = payment.invoice_id
     LEFT JOIN accounting_invoice_tax_snapshots snapshot
       ON snapshot.tenant_id = invoice.tenant_id AND snapshot.source_type = 'invoice'
      AND snapshot.source_id = invoice.id
     LEFT JOIN accounting_journal_entries journal
       ON journal.tenant_id = snapshot.tenant_id AND journal.id = snapshot.journal_entry_id
     WHERE payment.tenant_id = $1 AND payment.id::text = $2
     ${lock ? 'FOR UPDATE OF payment' : ''}`,
    [tenantId, paymentId]
  )
  if (result.rowCount !== 1) throw httpError(404, 'M-Pesa payment request not found')
  return result.rows[0]
}

function validatePayment(payment, { allowPaidInvoice = false } = {}) {
  if (payment.payment_status !== 'pending') {
    throw httpError(409, 'Only a pending M-Pesa request can be reconciled')
  }
  const allowedInvoiceStates = allowPaidInvoice ? ['sent', 'overdue', 'paid'] : ['sent', 'overdue']
  if (!allowedInvoiceStates.includes(payment.invoice_status)) {
    throw httpError(409, 'The invoice is not in a payable state')
  }
  if (payment.issued_at == null || payment.journal_status !== 'posted' || payment.invoice_currency !== 'KES') {
    throw httpError(409, 'The invoice has no verifiable posted KES accounting record')
  }
  if (typeof payment.mpesa_checkout_id !== 'string' || !CHECKOUT_ID.test(payment.mpesa_checkout_id)) {
    throw httpError(409, 'The payment request has no valid Daraja checkout identifier')
  }

  const requestedUnits = decimalUnits(payment.payment_amount, 2, 'M-Pesa request amount')
  const invoiceUnits = decimalUnits(payment.invoice_total, 2, 'Invoice amount')
  const snapshotUnits = decimalUnits(payment.snapshot_total, 2, 'Posted invoice amount')
  if (requestedUnits !== invoiceUnits || invoiceUnits !== snapshotUnits) {
    throw httpError(409, 'M-Pesa request amount does not match the posted invoice amount')
  }
  if (requestedUnits % 100n !== 0n) {
    throw httpError(409, 'M-Pesa STK Push supports whole KES amounts only')
  }
  return payment
}

async function selectAudit(client, tenantId, idempotencyKey) {
  const result = await client.query(
    `SELECT id, tenant_id, payment_id, checkout_request_id, payment_date, outcome,
            provider_result_code, receipt_id, idempotency_key, payload_hash, actor_id, created_at
     FROM mpesa_payment_reconciliation_audit
     WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenantId, idempotencyKey]
  )
  return result.rowCount === 1 ? result.rows[0] : null
}

async function successForCheckout(client, tenantId, checkoutId) {
  const result = await client.query(
    `SELECT id, tenant_id, payment_id, checkout_request_id, payment_date, outcome,
            provider_result_code, receipt_id, idempotency_key, payload_hash, actor_id, created_at
     FROM mpesa_payment_reconciliation_audit
     WHERE tenant_id = $1 AND checkout_request_id = $2 AND outcome = 'provider_success'`,
    [tenantId, checkoutId]
  )
  return result.rowCount === 1 ? result.rows[0] : null
}

async function blockedSuccessForCheckout(client, tenantId, checkoutId) {
  const result = await client.query(
    `SELECT id, tenant_id, payment_id, checkout_request_id, payment_date, outcome,
            provider_result_code, receipt_id, idempotency_key, payload_hash, actor_id, created_at
     FROM mpesa_payment_reconciliation_audit
     WHERE tenant_id = $1 AND checkout_request_id = $2
       AND outcome IN ('provider_success_blocked_period', 'provider_success_blocked_invoice')
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [tenantId, checkoutId]
  )
  return result.rowCount === 1 ? result.rows[0] : null
}

async function hasClosedAccountingPeriod(client, tenantId, paymentDate, { lock = false } = {}) {
  const result = await client.query(
    `SELECT id, status FROM accounting_periods
     WHERE tenant_id = $1 AND $2::date BETWEEN starts_on AND ends_on
     ${lock ? 'FOR SHARE' : ''}`,
    [tenantId, paymentDate]
  )
  return result.rows.some((period) => period.status !== 'open')
}

async function publicResult(client, event, { replayed = false, receipt = null } = {}) {
  if (!receipt && event.receipt_id) {
    const result = await client.query(
      `SELECT id, customer_id, amount::text AS amount, currency, payment_method,
              receipt_reference, payment_date, status
       FROM customer_receipts WHERE tenant_id = $1 AND id = $2`,
      [event.tenant_id, event.receipt_id]
    )
    if (result.rowCount === 1) receipt = result.rows[0]
  }
  return {
    reconciliation: {
      id: event.id,
      payment_id: event.payment_id,
      checkout_request_id: event.checkout_request_id,
      payment_date: String(event.payment_date).slice(0, 10),
      outcome: event.outcome,
      provider_result_code: event.provider_result_code,
      receipt_id: event.receipt_id,
      actor_id: event.actor_id,
      created_at: event.created_at
    },
    receipt,
    replayed,
    message: event.outcome === 'provider_success'
      ? 'Daraja reported success. The linked receipt remains subject to evidence review and accounting verification.'
      : event.outcome === 'provider_non_success'
        ? 'Daraja reported a non-success result. No receipt was created.'
        : event.outcome === 'provider_success_blocked_period'
          ? 'Daraja reported success, but the selected transaction date is in a closed accounting period. No receipt was created; use the approved period correction process.'
          : event.outcome === 'provider_success_blocked_invoice'
            ? 'Daraja reported success, but the invoice is no longer outstanding. No receipt was created; investigate the competing invoice settlement.'
        : event.outcome === 'conflicting_result'
          ? 'Daraja returned a result that conflicts with a previously verified success. The prior receipt is unchanged; investigate this payment.'
          : event.outcome === 'query_failed'
            ? 'Daraja status query failed. No receipt was created.'
            : 'Daraja did not return a matching final result. No receipt was created.'
  }
}

async function reconcileMpesaPayment(pool, {
  tenantId, userId, paymentId, idempotencyKey, paymentDate, queryProvider
}) {
  requireIdentity(tenantId, userId)
  if (typeof paymentId !== 'string' || paymentId.trim() === '' || paymentId.length > 200) {
    throw httpError(404, 'M-Pesa payment request not found')
  }
  if (typeof queryProvider !== 'function') throw new TypeError('Daraja status query is required')
  const key = normalizeIdempotencyKey(idempotencyKey)
  const normalizedDate = normalizePaymentDate(paymentDate)
  const reservationConstraint = await pool.query(
    `SELECT to_regclass('public.mpesa_stk_one_active_request_per_invoice_uq') IS NOT NULL AS available`
  )
  if (reservationConstraint.rows[0]?.available !== true) {
    throw httpError(503, 'M-Pesa invoice reservation migration is unavailable; provider reconciliation is disabled')
  }
  const initialPayment = validatePayment(await loadPayment(pool, tenantId, paymentId), { allowPaidInvoice: true })
  const initialRequest = await pool.query(
    `SELECT id, invoice_id, request_status, provider_checkout_request_id
     FROM mpesa_stk_initiation_requests
     WHERE tenant_id = $1 AND payment_id = $2`,
    [tenantId, initialPayment.payment_id]
  )
  if (initialRequest.rowCount !== 1 || !['payment_recorded', 'provider_succeeded'].includes(initialRequest.rows[0].request_status) ||
      initialRequest.rows[0].invoice_id !== initialPayment.invoice_id ||
      initialRequest.rows[0].provider_checkout_request_id !== initialPayment.mpesa_checkout_id) {
    throw httpError(409, 'This legacy M-Pesa payment has no matching durable invoice reservation; investigate it before reconciliation')
  }
  const hash = payloadHash({
    payment_id: initialPayment.payment_id,
    invoice_id: initialPayment.invoice_id,
    checkout_request_id: initialPayment.mpesa_checkout_id,
    amount: initialPayment.payment_amount,
    invoice_total: initialPayment.invoice_total,
    snapshot_total: initialPayment.snapshot_total,
    customer_id: initialPayment.customer_id,
    currency: initialPayment.invoice_currency,
    payment_date: normalizedDate
  })

  const previous = await selectAudit(pool, tenantId, key)
  if (previous) {
    if (previous.payment_id !== initialPayment.payment_id || previous.payload_hash !== hash) {
      throw httpError(409, 'Idempotency-Key was already used for a different M-Pesa reconciliation')
    }
    return publicResult(pool, previous, { replayed: true })
  }

  const priorBlockedSuccess = await blockedSuccessForCheckout(pool, tenantId, initialPayment.mpesa_checkout_id)
  if (priorBlockedSuccess) {
    if (String(priorBlockedSuccess.payment_date).slice(0, 10) !== normalizedDate) {
      throw httpError(409, 'The provider-confirmed transaction date cannot be changed during reconciliation')
    }
    const stillBlocked = !['sent', 'overdue'].includes(initialPayment.invoice_status) ||
      await hasClosedAccountingPeriod(pool, tenantId, normalizedDate)
    if (stillBlocked) return publicResult(pool, priorBlockedSuccess, { replayed: true })
  }

  let outcome
  try {
    const response = await queryProvider({ checkoutRequestId: initialPayment.mpesa_checkout_id })
    outcome = queryOutcome(response, initialPayment.mpesa_checkout_id, initialPayment.payment_amount)
  } catch (error) {
    outcome = { outcome: 'query_failed', providerResultCode: null, providerError: error }
  }

  try {
    const result = await withTransaction(pool, async (client) => {
      const owner = await client.query(
        `SELECT invoice.client_id::text AS customer_id
         FROM invoices invoice
         WHERE invoice.tenant_id = $1 AND invoice.id::text = $2`,
        [tenantId, initialPayment.invoice_id]
      )
      if (owner.rowCount !== 1) throw httpError(409, 'Invoice is unavailable while reconciling this M-Pesa request')
      await client.query('SELECT id FROM clients WHERE tenant_id = $1 AND id::text = $2 FOR UPDATE', [tenantId, owner.rows[0].customer_id])
      await client.query('SELECT id FROM invoices WHERE tenant_id = $1 AND id::text = $2 FOR UPDATE', [tenantId, initialPayment.invoice_id])
      const currentRequestResult = await client.query(
        `SELECT id, request_status, invoice_id, provider_checkout_request_id
         FROM mpesa_stk_initiation_requests
         WHERE tenant_id = $1 AND payment_id = $2 FOR UPDATE`,
        [tenantId, initialPayment.payment_id]
      )
      if (currentRequestResult.rowCount !== 1 ||
          !['payment_recorded', 'provider_succeeded'].includes(currentRequestResult.rows[0].request_status) ||
          currentRequestResult.rows[0].invoice_id !== initialPayment.invoice_id ||
          currentRequestResult.rows[0].provider_checkout_request_id !== initialPayment.mpesa_checkout_id) {
        throw httpError(409, 'M-Pesa invoice reservation changed while provider status was checked')
      }
      const currentPayment = validatePayment(await loadPayment(client, tenantId, paymentId, { lock: true }), { allowPaidInvoice: true })
      if (currentPayment.mpesa_checkout_id !== initialPayment.mpesa_checkout_id ||
          currentPayment.payment_amount !== initialPayment.payment_amount ||
          currentPayment.invoice_total !== initialPayment.invoice_total ||
          currentPayment.snapshot_total !== initialPayment.snapshot_total ||
          currentPayment.invoice_id !== initialPayment.invoice_id ||
          currentPayment.customer_id !== initialPayment.customer_id ||
          currentPayment.invoice_currency !== initialPayment.invoice_currency) {
        throw httpError(409, 'M-Pesa request changed while provider status was being checked')
      }

      const replay = await selectAudit(client, tenantId, key)
      if (replay) {
        if (replay.payment_id !== currentPayment.payment_id || replay.payload_hash !== hash) {
          throw httpError(409, 'Idempotency-Key was already used for a different M-Pesa reconciliation')
        }
        return publicResult(client, replay, { replayed: true })
      }

      const existingSuccess = await successForCheckout(client, tenantId, currentPayment.mpesa_checkout_id)
      if (existingSuccess) {
        if (existingSuccess.payment_id !== currentPayment.payment_id) {
          throw httpError(409, 'This Daraja checkout is already linked to another payment request')
        }
        if (outcome.outcome === 'provider_success') {
          return publicResult(client, existingSuccess, { replayed: true })
        }
        if (outcome.outcome === 'provider_non_success') {
          const conflict = await client.query(
            `INSERT INTO mpesa_payment_reconciliation_audit
               (tenant_id, payment_id, checkout_request_id, payment_date, outcome,
                provider_result_code, receipt_id, idempotency_key, payload_hash, actor_id)
             VALUES ($1, $2, $3, $4, 'conflicting_result', $5, NULL, $6, $7, $8)
             RETURNING id, tenant_id, payment_id, checkout_request_id, payment_date, outcome,
                       provider_result_code, receipt_id, actor_id, created_at`,
            [tenantId, currentPayment.payment_id, currentPayment.mpesa_checkout_id, normalizedDate,
              outcome.providerResultCode, key, hash, userId]
          )
          return publicResult(client, conflict.rows[0])
        }
      }

      let recordedOutcome = outcome.outcome
      if (recordedOutcome === 'provider_success') {
        if (!['sent', 'overdue'].includes(currentPayment.invoice_status)) {
          recordedOutcome = 'provider_success_blocked_invoice'
        } else if (await hasClosedAccountingPeriod(client, tenantId, normalizedDate, { lock: true })) {
          recordedOutcome = 'provider_success_blocked_period'
        }
      }

      let receipt = null
      let receiptReplayed = false
      let receiptId = null
      if (outcome.outcome === 'provider_success' && currentRequestResult.rows[0].request_status === 'payment_recorded') {
        const promoted = await client.query(
          `UPDATE mpesa_stk_initiation_requests
           SET request_status = 'provider_succeeded', updated_at = CURRENT_TIMESTAMP
           WHERE tenant_id = $1 AND id = $2 AND request_status = 'payment_recorded'
           RETURNING id`,
          [tenantId, currentRequestResult.rows[0].id]
        )
        if (promoted.rowCount !== 1) throw httpError(409, 'Provider success could not be linked to its invoice reservation')
        await client.query(
          `INSERT INTO mpesa_stk_initiation_events
             (tenant_id, request_id, event_type, from_status, to_status,
              checkout_request_id, actor_id, details)
           VALUES ($1, $2, 'provider_succeeded', 'payment_recorded', 'provider_succeeded', $3, $4, $5::jsonb)`,
          [tenantId, currentRequestResult.rows[0].id, currentPayment.mpesa_checkout_id, userId,
            JSON.stringify({ source: 'server_to_server_stk_query', result_code: outcome.providerResultCode })]
        )
      }
      if (recordedOutcome === 'provider_success') {
        const receiptResult = await createCustomerReceipt(pool, {
          tenantId,
          userId,
          idempotencyKey: `mpesa-checkout-${crypto.createHash('sha256').update(currentPayment.mpesa_checkout_id).digest('hex')}`,
          body: {
            customer_id: currentPayment.customer_id,
            amount: currentPayment.payment_amount,
            currency: 'KES',
            payment_method: 'mpesa',
            receipt_reference: currentPayment.mpesa_checkout_id,
            payment_date: normalizedDate
          },
          client,
          providerEvidence: {
            source: 'daraja_stk_query',
            checkout_request_id: currentPayment.mpesa_checkout_id
          }
        })
        receipt = receiptResult.receipt
        receiptReplayed = receiptResult.replayed
        receiptId = receipt.id
      }

      const inserted = await client.query(
        `INSERT INTO mpesa_payment_reconciliation_audit
           (tenant_id, payment_id, checkout_request_id, payment_date, outcome,
            provider_result_code, receipt_id, idempotency_key, payload_hash, actor_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, tenant_id, payment_id, checkout_request_id, payment_date, outcome,
                   provider_result_code, receipt_id, actor_id, created_at`,
        [tenantId, currentPayment.payment_id, currentPayment.mpesa_checkout_id, normalizedDate,
          recordedOutcome, outcome.providerResultCode, receiptId, key, hash, userId]
      )
      const result = await publicResult(client, inserted.rows[0], { receipt })
      if (recordedOutcome === 'provider_success' && receiptReplayed) {
        result.message = 'A pending receipt already exists for this Daraja checkout.'
      } else if (recordedOutcome === 'provider_success') {
        result.message = 'Daraja reported success. A pending receipt was recorded for evidence review.'
      }
      return result
    })
    if (outcome.providerError) {
      const error = new Error('Daraja status query failed')
      error.statusCode = 502
      throw error
    }
    return result
  } catch (error) {
    if (error.code === '23505') {
      const saved = await selectAudit(pool, tenantId, key)
      if (saved && saved.payment_id === initialPayment.payment_id && saved.payload_hash === hash) {
        return publicResult(pool, saved, { replayed: true })
      }
      const savedSuccess = await successForCheckout(pool, tenantId, initialPayment.mpesa_checkout_id)
      if (savedSuccess && savedSuccess.payment_id === initialPayment.payment_id) {
        return publicResult(pool, savedSuccess, { replayed: true })
      }
      throw httpError(409, 'This Daraja checkout has already been reconciled')
    }
    throw error
  }
}

async function listMpesaReconciliationHistory(pool, tenantId, paymentId) {
  const result = await pool.query(
    `SELECT id, payment_id, checkout_request_id, payment_date, outcome,
            provider_result_code, receipt_id, actor_id, created_at
     FROM mpesa_payment_reconciliation_audit
     WHERE tenant_id = $1 AND payment_id = $2
     ORDER BY created_at DESC, id DESC LIMIT 100`,
    [tenantId, paymentId]
  )
  return result.rows.map((row) => ({ ...row, payment_date: String(row.payment_date).slice(0, 10) }))
}

module.exports = {
  listMpesaReconciliationHistory,
  queryOutcome,
  reconcileMpesaPayment,
  validatePayment
}

const express = require('express')
const pool = require('../config/db')
const auth = require('../middleware/auth')
const { stkPush, stkPushQuery } = require('../config/mpesa')
const { requireAccountingPermission } = require('../middleware/accountingAuthorization')
const {
  allocateCustomerReceipt,
  createCustomerReceipt,
  failCustomerReceipt,
  getCustomerPaymentHistory,
  getCustomerReceipt,
  listCustomerReceipts,
  listOutstandingInvoices,
  reverseCustomerReceipt,
  verifyCustomerReceipt
} = require('../services/customerReceipts')
const { logSafeError } = require('../utils/errorLogging')
const { normalizeIdempotencyKey } = require('../utils/accounting')
const {
  listMpesaReconciliationHistory,
  reconcileMpesaPayment
} = require('../services/mpesaReconciliation')
const {
  getMpesaStkInitiationStatus,
  initiateMpesaStkRequest,
  recoverMpesaStkRequest,
  resolveMpesaStkRequest
} = require('../services/mpesaStkInitiation')

const router = express.Router()
const MPESA_ID = /^[A-Za-z0-9_-]{1,150}$/
const MPESA_INITIATION_SCHEMA_CODES = new Set(['42P01', '42703', '42883'])

function callbackIsWellFormed(body) {
  const callback = body && typeof body === 'object' && !Array.isArray(body)
    ? body.Body?.stkCallback
    : null
  if (!callback || typeof callback !== 'object' || Array.isArray(callback) ||
      typeof callback.MerchantRequestID !== 'string' || callback.MerchantRequestID.length > 150 ||
      callback.MerchantRequestID.trim() === '' || !MPESA_ID.test(callback.CheckoutRequestID || '') ||
      !Number.isSafeInteger(callback.ResultCode) || typeof callback.ResultDesc !== 'string' ||
      callback.ResultDesc.length > 1024) return false
  if (callback.ResultCode !== 0 || callback.CallbackMetadata == null) return true

  const items = callback.CallbackMetadata?.Item
  if (!callback.CallbackMetadata || typeof callback.CallbackMetadata !== 'object' ||
      Array.isArray(callback.CallbackMetadata) || !Array.isArray(items)) return false
  const values = new Map()
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        typeof item.Name !== 'string' || values.has(item.Name)) return false
    values.set(item.Name, item.Value)
  }
  const amount = values.get('Amount')
  const amountText = typeof amount === 'number' && Number.isFinite(amount) ? String(amount) : amount
  const receipt = values.get('MpesaReceiptNumber')
  const transactionDate = values.get('TransactionDate')
  const amountValid = amount == null || (typeof amountText === 'string' &&
    /^(?:0|[1-9]\d{0,19})(?:\.\d{1,2})?$/.test(amountText) && Number.isFinite(Number(amountText)) && Number(amountText) > 0)
  const receiptValid = receipt == null || (typeof receipt === 'string' && /^[A-Za-z0-9]{1,32}$/.test(receipt))
  const dateValid = transactionDate == null || (typeof transactionDate === 'number' && Number.isSafeInteger(transactionDate)
    ? /^\d{14}$/.test(String(transactionDate))
    : typeof transactionDate === 'string' && /^\d{14}$/.test(transactionDate))
  return amountValid && receiptValid && dateValid
}

function sendServiceError(res, message, error) {
  logSafeError(message, error)
  return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Customer receipt request failed' })
}

function sendMpesaInitiationError(res, message, error) {
  logSafeError(message, error)
  if (MPESA_INITIATION_SCHEMA_CODES.has(error.code)) {
    return res.status(503).json({ error: 'M-Pesa STK idempotency schema is unavailable; review and apply the additive request-state migration before accepting prompts' })
  }
  return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'M-Pesa request failed' })
}

// GET /api/payments/receipts/outstanding-invoices?customer_id=...
router.get('/receipts/outstanding-invoices', auth, requireAccountingPermission('accounting:read'), async (req, res) => {
  try {
    const rows = await listOutstandingInvoices(pool, req.user.tenantId, req.query.customer_id)
    res.json(rows)
  } catch (error) {
    return sendServiceError(res, 'Outstanding invoice request failed', error)
  }
})

// GET /api/payments/receipts
router.get('/receipts', auth, requireAccountingPermission('accounting:read'), async (req, res) => {
  try {
    const customerId = req.query.customer_id || null
    const rows = await listCustomerReceipts(pool, req.user.tenantId, customerId)
    res.json(rows)
  } catch (error) {
    return sendServiceError(res, 'Customer receipt history request failed', error)
  }
})

// GET /api/payments/receipts/:id
router.get('/receipts/:id', auth, requireAccountingPermission('accounting:read'), async (req, res) => {
  try {
    const receipt = await getCustomerReceipt(pool, req.user.tenantId, req.params.id)
    res.json(receipt)
  } catch (error) {
    return sendServiceError(res, 'Customer receipt detail request failed', error)
  }
})

// GET /api/payments/customers/:customerId/payment-history
router.get('/customers/:customerId/payment-history', auth, requireAccountingPermission('accounting:read'), async (req, res) => {
  try {
    const history = await getCustomerPaymentHistory(pool, req.user.tenantId, req.params.customerId)
    res.json(history)
  } catch (error) {
    return sendServiceError(res, 'Customer payment history request failed', error)
  }
})

// POST /api/payments/receipts
router.post('/receipts', auth, requireAccountingPermission('accounting:manage-receipts'), async (req, res) => {
  try {
    const result = await createCustomerReceipt(pool, {
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      idempotencyKey: req.get('Idempotency-Key'),
      body: req.body
    })
    return res.status(result.replayed ? 200 : 201).json(result)
  } catch (error) {
    return sendServiceError(res, 'Customer receipt creation failed', error)
  }
})

// POST /api/payments/receipts/:id/verify
router.post('/receipts/:id/verify', auth, requireAccountingPermission('accounting:manage-receipts'), async (req, res) => {
  try {
    const result = await verifyCustomerReceipt(pool, {
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      receiptId: req.params.id,
      idempotencyKey: req.get('Idempotency-Key'),
      body: req.body
    })
    return res.status(200).json(result)
  } catch (error) {
    return sendServiceError(res, 'Customer receipt verification failed', error)
  }
})

// POST /api/payments/receipts/:id/fail
router.post('/receipts/:id/fail', auth, requireAccountingPermission('accounting:manage-receipts'), async (req, res) => {
  try {
    const result = await failCustomerReceipt(pool, {
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      receiptId: req.params.id,
      body: req.body
    })
    return res.status(200).json(result)
  } catch (error) {
    return sendServiceError(res, 'Customer receipt failure update failed', error)
  }
})

// POST /api/payments/receipts/:id/allocate
router.post('/receipts/:id/allocate', auth, requireAccountingPermission('accounting:manage-receipts'), async (req, res) => {
  try {
    const result = await allocateCustomerReceipt(pool, {
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      receiptId: req.params.id,
      idempotencyKey: req.get('Idempotency-Key'),
      body: req.body
    })
    return res.status(result.replayed ? 200 : 201).json(result)
  } catch (error) {
    return sendServiceError(res, 'Customer receipt allocation failed', error)
  }
})

// POST /api/payments/receipts/:id/reverse
router.post('/receipts/:id/reverse', auth, requireAccountingPermission('accounting:manage-receipts'), async (req, res) => {
  try {
    const result = await reverseCustomerReceipt(pool, {
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      receiptId: req.params.id,
      idempotencyKey: req.get('Idempotency-Key'),
      body: req.body
    })
    return res.status(200).json(result)
  } catch (error) {
    return sendServiceError(res, 'Customer receipt reversal failed', error)
  }
})

// GET /api/payments
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.id, p.tenant_id, p.invoice_id, p.amount::text AS amount,
              p.mpesa_checkout_id, p.status, p.created_at, i.invoice_number
       FROM payments p
       JOIN invoices i ON p.invoice_id = i.id AND i.tenant_id = p.tenant_id
       WHERE p.tenant_id = $1
       ORDER BY p.created_at DESC`,
      [req.user.tenantId]
    )
    res.json(result.rows)
  } catch (err) {
    logSafeError('Payment list request failed', err)
    res.status(500).json({ error: 'Failed to fetch payments' })
  }
})

// POST /api/payments/request — STK Push
router.post('/request', auth, async (req, res) => {
  const { invoice_id, phone_number } = req.body

  if (!invoice_id || !phone_number) {
    return res.status(400).json({ error: 'invoice_id and phone_number are required' })
  }
  let idempotencyKey
  try {
    idempotencyKey = normalizeIdempotencyKey(req.get('Idempotency-Key'))
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message })
  }

  try {
    const result = await initiateMpesaStkRequest(pool, {
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      idempotencyKey,
      invoiceId: invoice_id,
      phoneNumber: phone_number,
      provider: stkPush
    })

    return res.status(result.replayed ? 200 : 201).json({
      message: 'Payment prompt submitted. This acknowledgement is not proof of payment; use provider status reconciliation after the transaction completes.',
      request: result.request,
      checkoutRequestId: result.request.checkoutRequestId,
      payment: result.payment
    })

  } catch (err) {
    if (MPESA_INITIATION_SCHEMA_CODES.has(err.code)) {
      logSafeError('M-Pesa request failed', err)
      return res.status(503).json({ error: 'M-Pesa STK idempotency schema is unavailable; review and apply the additive request-state migration before accepting prompts' })
    }
    logSafeError('M-Pesa request failed', err)
    const response = { error: err.statusCode ? err.message : 'M-Pesa request failed' }
    if (err.requestStatus) response.request_status = err.requestStatus
    return res.status(err.statusCode || 500).json(response)
  }
})

// A retry with the original key cannot start another prompt. This read endpoint
// lets an accounting-authorized tenant user inspect the durable request state.
router.get('/stk-request-status', auth, requireAccountingPermission('accounting:read'), async (req, res) => {
  try {
    return res.json(await getMpesaStkInitiationStatus(pool, req.user.tenantId, req.get('Idempotency-Key')))
  } catch (error) {
    return sendMpesaInitiationError(res, 'M-Pesa initiation status request failed', error)
  }
})

router.post('/stk-request/recover', auth, requireAccountingPermission('accounting:manage-receipts'), async (req, res) => {
  if (req.body?.confirm !== true) {
    return res.status(400).json({ error: 'Explicit confirmation is required to recover the saved M-Pesa request' })
  }
  try {
    const result = await recoverMpesaStkRequest(pool, {
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      idempotencyKey: req.get('Idempotency-Key'),
      checkoutRequestId: req.body?.checkout_request_id,
      phoneNumber: req.body?.phone_number,
      evidenceReference: req.body?.evidence_reference,
      reason: req.body?.reason,
      confirmExternalReference: req.body?.confirm_external_reference === true
    })
    return res.status(200).json({
      message: 'A pending payment record was recovered from the saved or externally referenced checkout identifier. This is not proof of payment; reconcile it with Daraja before recording a receipt.',
      ...result
    })
  } catch (error) {
    return sendMpesaInitiationError(res, 'M-Pesa initiation recovery failed', error)
  }
})

// Administrative resolution is an auditable assertion based on external provider records.
router.post('/stk-request/resolve', auth, requireAccountingPermission('accounting:manage-receipts'), async (req, res) => {
  try {
    const result = await resolveMpesaStkRequest(pool, {
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      idempotencyKey: req.get('Idempotency-Key'),
      resolution: req.body?.resolution,
      evidenceReference: req.body?.evidence_reference,
      reason: req.body?.reason,
      confirmNoCollection: req.body?.confirm_no_collection,
      confirmNoOutstandingPrompt: req.body?.confirm_no_outstanding_prompt
    })
    return res.status(result.replayed ? 200 : 201).json({
      message: 'The request was released based on the administrator’s recorded confirmation. No provider response was inferred or synthesized.',
      ...result
    })
  } catch (error) {
    return sendMpesaInitiationError(res, 'M-Pesa initiation resolution failed', error)
  }
})

// POST /api/payments/callback — Safaricom calls this
router.post('/callback', async (req, res) => {
  if (!callbackIsWellFormed(req.body)) {
    return res.status(400).json({ ResultCode: 1, ResultDesc: 'Invalid callback payload' })
  }
  // Daraja callback requests are not authenticated by this repository. Keep
  // them non-mutating; an administrator must query the provider before a
  // pending receipt can be created.
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' })
})

// GET /api/payments/:paymentId/mpesa/reconciliation
router.get('/:paymentId/mpesa/reconciliation', auth, requireAccountingPermission('accounting:read'), async (req, res) => {
  try {
    return res.json(await listMpesaReconciliationHistory(pool, req.user.tenantId, req.params.paymentId))
  } catch (error) {
    return sendServiceError(res, 'M-Pesa reconciliation history request failed', error)
  }
})

// POST /api/payments/:paymentId/mpesa/reconcile
router.post('/:paymentId/mpesa/reconcile', auth, requireAccountingPermission('accounting:manage-receipts'), async (req, res) => {
  try {
    const result = await reconcileMpesaPayment(pool, {
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      paymentId: req.params.paymentId,
      idempotencyKey: req.get('Idempotency-Key'),
      paymentDate: req.body?.payment_date,
      queryProvider: stkPushQuery
    })
    return res.status(result.replayed ? 200 : 201).json(result)
  } catch (error) {
    return sendServiceError(res, 'M-Pesa reconciliation failed', error)
  }
})

module.exports = router

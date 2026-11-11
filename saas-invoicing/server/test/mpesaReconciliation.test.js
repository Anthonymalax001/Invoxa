const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_A = '11111111-1111-4111-8111-111111111111'
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222'
const PAYMENT_ID = 'payment-legacy-id'
const CHECKOUT_ID = 'ws_CO_202610301200001234'

const fixturePayment = (overrides = {}) => ({
  payment_id: PAYMENT_ID,
  tenant_id: TENANT_A,
  invoice_id: 'invoice-legacy-id',
  payment_amount: '250.00',
  mpesa_checkout_id: CHECKOUT_ID,
  payment_status: 'pending',
  customer_id: CUSTOMER_ID,
  invoice_total: '250.00',
  invoice_status: 'sent',
  snapshot_total: '250.00',
  issued_at: '2026-10-01T12:00:00.000Z',
  journal_status: 'posted',
  invoice_currency: 'KES',
  ...overrides
})

const makeHarness = (payment = fixturePayment()) => {
  const state = {
    payment, audits: [], receipts: [], receiptCalls: 0, accountingPeriodStatus: null,
    initiationRequest: {
      id: 'stk-request-1', tenant_id: payment.tenant_id, invoice_id: payment.invoice_id,
      request_status: 'payment_recorded', provider_checkout_request_id: payment.mpesa_checkout_id,
      payment_id: payment.payment_id
    }, initiationEvents: []
  }
  let transactionTail = Promise.resolve()

  const execute = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
    if (normalized.includes('to_regclass(')) return { rows: [{ available: true }], rowCount: 1 }
    if (normalized === 'begin isolation level read committed' || normalized === 'commit' || normalized === 'rollback') {
      return { rows: [], rowCount: 0 }
    }
    if (normalized.startsWith('select payment.id::text as payment_id')) {
      const matches = state.payment.tenant_id === params[0] && state.payment.payment_id === params[1]
      return { rows: matches ? [{ ...state.payment }] : [], rowCount: matches ? 1 : 0 }
    }
    if (normalized.startsWith('select id, invoice_id, request_status, provider_checkout_request_id from mpesa_stk_initiation_requests')) {
      const request = state.initiationRequest
      const matches = request.tenant_id === params[0] && request.payment_id === params[1]
      return { rows: matches ? [{ ...request }] : [], rowCount: matches ? 1 : 0 }
    }
    if (normalized.startsWith('select invoice.client_id::text as customer_id from invoices invoice')) {
      return { rows: [{ customer_id: state.payment.customer_id }], rowCount: 1 }
    }
    if (normalized.startsWith('select id from clients where tenant_id = $1 and id::text = $2 for update')) {
      return { rows: [{ id: params[1] }], rowCount: 1 }
    }
    if (normalized.startsWith('select id from invoices where tenant_id = $1 and id::text = $2 for update')) {
      return { rows: [{ id: params[1] }], rowCount: 1 }
    }
    if (normalized.startsWith('select id, request_status, invoice_id, provider_checkout_request_id from mpesa_stk_initiation_requests')) {
      const request = state.initiationRequest
      const matches = request.tenant_id === params[0] && request.payment_id === params[1]
      return { rows: matches ? [{ ...request }] : [], rowCount: matches ? 1 : 0 }
    }
    if (normalized.startsWith("update mpesa_stk_initiation_requests set request_status = 'provider_succeeded'")) {
      const request = state.initiationRequest
      if (request.tenant_id !== params[0] || request.id !== params[1] || request.request_status !== 'payment_recorded') {
        return { rows: [], rowCount: 0 }
      }
      request.request_status = 'provider_succeeded'
      return { rows: [{ id: request.id }], rowCount: 1 }
    }
    if (normalized.startsWith('insert into mpesa_stk_initiation_events')) {
      const event = { event_type: 'provider_succeeded', request_id: params[1], details: JSON.parse(params.at(-1)) }
      state.initiationEvents.push(event)
      return { rows: [event], rowCount: 1 }
    }
    if (normalized.startsWith('select id, status from accounting_periods')) {
      const rows = state.accountingPeriodStatus == null ? [] : [{ id: 'period-1', status: state.accountingPeriodStatus }]
      return { rows, rowCount: rows.length }
    }
    if (normalized.includes('from mpesa_payment_reconciliation_audit') &&
        normalized.includes("'provider_success_blocked_period'") && normalized.includes('order by created_at desc')) {
      const row = [...state.audits].reverse().find((item) => item.tenant_id === params[0] &&
        item.checkout_request_id === params[1] &&
        ['provider_success_blocked_period', 'provider_success_blocked_invoice'].includes(item.outcome))
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 }
    }
    if (normalized.includes('from mpesa_payment_reconciliation_audit') && normalized.includes('idempotency_key = $2')) {
      const row = state.audits.find((item) => item.tenant_id === params[0] && item.idempotency_key === params[1])
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 }
    }
    if (normalized.includes('from mpesa_payment_reconciliation_audit') && normalized.includes("outcome = 'provider_success'")) {
      const row = state.audits.find((item) => item.tenant_id === params[0] &&
        item.checkout_request_id === params[1] && item.outcome === 'provider_success')
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 }
    }
    if (normalized.startsWith('insert into mpesa_payment_reconciliation_audit')) {
      const isConflict = normalized.includes("'conflicting_result'")
      const [tenantId, paymentId, checkoutId, paymentDate] = params
      const outcome = isConflict ? 'conflicting_result' : params[4]
      const providerCode = isConflict ? params[4] : params[5]
      const receiptId = isConflict ? null : params[6]
      const key = isConflict ? params[5] : params[7]
      const hash = isConflict ? params[6] : params[8]
      const actorId = isConflict ? params[7] : params[9]
      if (state.audits.some((item) => item.tenant_id === tenantId && item.idempotency_key === key) ||
          (outcome === 'provider_success' && state.audits.some((item) => item.tenant_id === tenantId &&
            item.checkout_request_id === checkoutId && item.outcome === 'provider_success'))) {
        throw Object.assign(new Error('unique constraint violation'), { code: '23505' })
      }
      const row = {
        id: `audit-${state.audits.length + 1}`, tenant_id: tenantId, payment_id: paymentId,
        checkout_request_id: checkoutId, payment_date: paymentDate, outcome,
        provider_result_code: providerCode, receipt_id: receiptId, idempotency_key: key,
        payload_hash: hash, actor_id: actorId, created_at: new Date('2026-10-30T12:00:00.000Z').toISOString()
      }
      state.audits.push(row)
      return { rows: [{ ...row }], rowCount: 1 }
    }
    if (normalized.startsWith('select id, customer_id, amount::text as amount')) {
      const receipt = state.receipts.find((item) => item.tenant_id === params[0] && item.id === params[1])
      return { rows: receipt ? [{ ...receipt }] : [], rowCount: receipt ? 1 : 0 }
    }
    if (normalized.startsWith('select id, payment_id, checkout_request_id, payment_date')) {
      const rows = state.audits.filter((item) => item.tenant_id === params[0] && item.payment_id === params[1])
      return { rows, rowCount: rows.length }
    }
    throw new Error(`Unexpected mocked query: ${normalized}`)
  }

  const pool = {
    query: execute,
    async connect() {
      const turn = transactionTail
      let unlock
      transactionTail = new Promise((resolve) => { unlock = resolve })
      await turn
      return {
        query: execute,
        release() { unlock() }
      }
    }
  }

  return {
    pool,
    state,
    makeReceiptService: () => async (_pool, input) => {
      state.receiptCalls += 1
      const body = input.body
      const existing = state.receipts.find((receipt) => receipt.tenant_id === input.tenantId &&
        receipt.idempotency_key === input.idempotencyKey)
      if (existing) return { receipt: existing, replayed: true }
      const receipt = {
        id: `receipt-${state.receipts.length + 1}`,
        tenant_id: input.tenantId,
        idempotency_key: input.idempotencyKey,
        customer_id: body.customer_id,
        amount: body.amount,
        currency: body.currency,
        payment_method: body.payment_method,
        receipt_reference: body.receipt_reference,
        payment_date: body.payment_date,
        status: 'pending'
      }
      state.receipts.push(receipt)
      return { receipt, replayed: false }
    }
  }
}

const customerReceiptsPath = require.resolve('../src/services/customerReceipts')
const reconciliationPath = require.resolve('../src/services/mpesaReconciliation')
const originalCustomerReceipts = require.cache[customerReceiptsPath]
const receiptHarness = makeHarness()
let activeReceiptCreator = receiptHarness.makeReceiptService()
const customerReceiptsMock = new Module(customerReceiptsPath)
customerReceiptsMock.filename = customerReceiptsPath
customerReceiptsMock.loaded = true
customerReceiptsMock.exports = {
  createCustomerReceipt(...args) { return activeReceiptCreator(...args) }
}
require.cache[customerReceiptsPath] = customerReceiptsMock
const { listMpesaReconciliationHistory, queryOutcome, reconcileMpesaPayment, validatePayment } = require(reconciliationPath)

test.after(() => {
  delete require.cache[reconciliationPath]
  if (originalCustomerReceipts) require.cache[customerReceiptsPath] = originalCustomerReceipts
  else delete require.cache[customerReceiptsPath]
})

test('provider query result requires an accepted response and the exact checkout identifier', () => {
  assert.deepEqual(queryOutcome({ ResponseCode: '0', CheckoutRequestID: CHECKOUT_ID, ResultCode: '0' }, CHECKOUT_ID), {
    outcome: 'provider_success', providerResultCode: '0'
  })
  assert.deepEqual(queryOutcome({ ResponseCode: 0, CheckoutRequestID: CHECKOUT_ID, ResultCode: 1032 }, CHECKOUT_ID), {
    outcome: 'provider_non_success', providerResultCode: '1032'
  })
  assert.deepEqual(queryOutcome({ ResponseCode: '0', CheckoutRequestID: 'other', ResultCode: '0' }, CHECKOUT_ID), {
    outcome: 'inconclusive', providerResultCode: '0'
  })
  assert.deepEqual(queryOutcome({ ResponseCode: '0', CheckoutRequestID: CHECKOUT_ID }, CHECKOUT_ID), {
    outcome: 'inconclusive', providerResultCode: null
  })
  assert.deepEqual(queryOutcome({ ResponseCode: '0', CheckoutRequestID: CHECKOUT_ID, ResultCode: '0', Amount: '251.00' }, CHECKOUT_ID, '250.00'), {
    outcome: 'inconclusive', providerResultCode: '0'
  })
})

test('reconciliation validates posted invoice amount, currency, request state and exact whole-KES amount', () => {
  assert.equal(validatePayment(fixturePayment()).payment_amount, '250.00')
  assert.throws(() => validatePayment(fixturePayment({ payment_amount: '249.99' })), /does not match/)
  assert.throws(() => validatePayment(fixturePayment({ invoice_currency: 'USD' })), /posted KES/)
  assert.throws(() => validatePayment(fixturePayment({ snapshot_total: '251.00' })), /does not match/)
  assert.throws(() => validatePayment(fixturePayment({ payment_amount: '250.50', invoice_total: '250.50', snapshot_total: '250.50' })), /whole KES/)
  assert.throws(() => validatePayment(fixturePayment({ payment_status: 'success' })), /Only a pending/)
})

test('successful provider result creates one pending receipt and append-only reconciliation record', async () => {
  const harness = makeHarness()
  activeReceiptCreator = harness.makeReceiptService()
  const result = await reconcileMpesaPayment(harness.pool, {
    tenantId: TENANT_A, userId: USER_A, paymentId: PAYMENT_ID,
    idempotencyKey: 'mpesa-reconcile-success-1', paymentDate: '2026-10-30',
    queryProvider: async ({ checkoutRequestId }) => ({ ResponseCode: '0', CheckoutRequestID: checkoutRequestId, ResultCode: '0' })
  })
  assert.equal(result.reconciliation.outcome, 'provider_success')
  assert.equal(result.receipt.status, 'pending')
  assert.equal(result.receipt.receipt_reference, CHECKOUT_ID)
  assert.equal(harness.state.receipts.length, 1)
  assert.equal(harness.state.receiptCalls, 1)
  assert.equal(harness.state.audits.length, 1)
  assert.equal(harness.state.payment.payment_status, 'pending')
  assert.equal(harness.state.initiationRequest.request_status, 'provider_succeeded')
  assert.deepEqual(harness.state.initiationEvents.map((event) => event.event_type), ['provider_succeeded'])
})

test('provider success in a closed accounting period is audited without creating or redating a receipt', async () => {
  const harness = makeHarness()
  activeReceiptCreator = harness.makeReceiptService()
  harness.state.accountingPeriodStatus = 'closed'
  let providerQueries = 0
  const request = (key, paymentDate) => reconcileMpesaPayment(harness.pool, {
    tenantId: TENANT_A, userId: USER_A, paymentId: PAYMENT_ID,
    idempotencyKey: key, paymentDate,
    queryProvider: async ({ checkoutRequestId }) => {
      providerQueries += 1
      return { ResponseCode: '0', CheckoutRequestID: checkoutRequestId, ResultCode: '0' }
    }
  })

  const blocked = await request('mpesa-closed-period-a', '2026-10-30')
  assert.equal(blocked.reconciliation.outcome, 'provider_success_blocked_period')
  assert.match(blocked.message, /closed accounting period/)
  assert.equal(blocked.receipt, null)
  assert.equal(harness.state.receipts.length, 0)
  assert.equal(harness.state.receiptCalls, 0)

  const replay = await request('mpesa-closed-period-b', '2026-10-30')
  assert.equal(replay.reconciliation.id, blocked.reconciliation.id)
  assert.equal(replay.replayed, true)
  assert.equal(providerQueries, 1)
  await assert.rejects(request('mpesa-closed-period-c', '2026-11-01'), {
    statusCode: 409,
    message: 'The provider-confirmed transaction date cannot be changed during reconciliation'
  })
  assert.equal(providerQueries, 1)
})

test('a blocked provider success can be retried on the same date after the period is reopened', async () => {
  const harness = makeHarness()
  activeReceiptCreator = harness.makeReceiptService()
  harness.state.accountingPeriodStatus = 'closed'
  const request = (key) => reconcileMpesaPayment(harness.pool, {
    tenantId: TENANT_A, userId: USER_A, paymentId: PAYMENT_ID,
    idempotencyKey: key, paymentDate: '2026-10-30',
    queryProvider: async ({ checkoutRequestId }) => ({ ResponseCode: '0', CheckoutRequestID: checkoutRequestId, ResultCode: '0' })
  })
  const blocked = await request('mpesa-reopen-period-a')
  harness.state.accountingPeriodStatus = 'open'
  const reconciled = await request('mpesa-reopen-period-b')
  assert.equal(blocked.reconciliation.outcome, 'provider_success_blocked_period')
  assert.equal(reconciled.reconciliation.outcome, 'provider_success')
  assert.equal(reconciled.receipt.status, 'pending')
  assert.deepEqual(harness.state.audits.map((audit) => audit.outcome), [
    'provider_success_blocked_period', 'provider_success'
  ])
  assert.equal(harness.state.receipts.length, 1)
})

test('provider success after competing invoice settlement is audited without a receipt', async () => {
  const harness = makeHarness(fixturePayment({ invoice_status: 'paid' }))
  activeReceiptCreator = harness.makeReceiptService()
  const result = await reconcileMpesaPayment(harness.pool, {
    tenantId: TENANT_A, userId: USER_A, paymentId: PAYMENT_ID,
    idempotencyKey: 'mpesa-paid-invoice-a', paymentDate: '2026-10-30',
    queryProvider: async ({ checkoutRequestId }) => ({ ResponseCode: '0', CheckoutRequestID: checkoutRequestId, ResultCode: '0' })
  })
  assert.equal(result.reconciliation.outcome, 'provider_success_blocked_invoice')
  assert.equal(result.receipt, null)
  assert.equal(harness.state.receipts.length, 0)
})

test('tenant-scoped lookup rejects another tenant and never queries Daraja', async () => {
  const harness = makeHarness()
  let providerCalls = 0
  await assert.rejects(reconcileMpesaPayment(harness.pool, {
    tenantId: TENANT_B, userId: USER_A, paymentId: PAYMENT_ID,
    idempotencyKey: 'mpesa-reconcile-tenant-b', paymentDate: '2026-10-30',
    queryProvider: async () => { providerCalls += 1; return {} }
  }), { statusCode: 404 })
  assert.equal(providerCalls, 0)
  assert.deepEqual(harness.state.audits, [])
})

test('non-success and inconclusive provider results never create receipts', async () => {
  for (const [resultCode, expected] of [['1032', 'provider_non_success'], [null, 'inconclusive']]) {
    const harness = makeHarness()
    activeReceiptCreator = harness.makeReceiptService()
    const result = await reconcileMpesaPayment(harness.pool, {
      tenantId: TENANT_A, userId: USER_A, paymentId: PAYMENT_ID,
      idempotencyKey: `mpesa-reconcile-result-${expected}`, paymentDate: '2026-10-30',
      queryProvider: async ({ checkoutRequestId }) => ({
        ResponseCode: '0', CheckoutRequestID: checkoutRequestId,
        ...(resultCode == null ? {} : { ResultCode: resultCode })
      })
    })
    assert.equal(result.reconciliation.outcome, expected)
    assert.equal(result.receipt, null)
    assert.equal(harness.state.receipts.length, 0)
    assert.equal(harness.state.initiationRequest.request_status, 'payment_recorded')
  }
})

test('a non-success query followed by a success query is resolved in order without duplicate receipt creation', async () => {
  const harness = makeHarness()
  activeReceiptCreator = harness.makeReceiptService()
  const request = (key, resultCode) => reconcileMpesaPayment(harness.pool, {
    tenantId: TENANT_A, userId: USER_A, paymentId: PAYMENT_ID,
    idempotencyKey: key, paymentDate: '2026-10-30',
    queryProvider: async ({ checkoutRequestId }) => ({ ResponseCode: '0', CheckoutRequestID: checkoutRequestId, ResultCode: resultCode })
  })
  const earlier = await request('mpesa-out-of-order-a', '1032')
  const later = await request('mpesa-out-of-order-b', '0')
  assert.equal(earlier.reconciliation.outcome, 'provider_non_success')
  assert.equal(later.reconciliation.outcome, 'provider_success')
  assert.equal(harness.state.receipts.length, 1)
  assert.equal(harness.state.audits.length, 2)
})

test('conflicting later provider result is audited without changing an existing successful receipt', async () => {
  const harness = makeHarness()
  activeReceiptCreator = harness.makeReceiptService()
  const request = (key, resultCode) => reconcileMpesaPayment(harness.pool, {
    tenantId: TENANT_A, userId: USER_A, paymentId: PAYMENT_ID,
    idempotencyKey: key, paymentDate: '2026-10-30',
    queryProvider: async ({ checkoutRequestId }) => ({ ResponseCode: '0', CheckoutRequestID: checkoutRequestId, ResultCode: resultCode })
  })
  const success = await request('mpesa-reconcile-conflict-a', '0')
  const conflict = await request('mpesa-reconcile-conflict-b', '1032')
  assert.equal(success.reconciliation.outcome, 'provider_success')
  assert.equal(conflict.reconciliation.outcome, 'conflicting_result')
  assert.equal(harness.state.receipts.length, 1)
  assert.equal(harness.state.receipts[0].status, 'pending')
})

test('concurrent reconciliation requests produce a single receipt and audit result', async () => {
  const harness = makeHarness()
  activeReceiptCreator = harness.makeReceiptService()
  let calls = 0
  let releaseProvider
  const barrier = new Promise((resolve) => { releaseProvider = resolve })
  const queryProvider = async ({ checkoutRequestId }) => {
    calls += 1
    if (calls === 2) releaseProvider()
    await barrier
    return { ResponseCode: '0', CheckoutRequestID: checkoutRequestId, ResultCode: '0' }
  }
  const reconcile = () => reconcileMpesaPayment(harness.pool, {
    tenantId: TENANT_A, userId: USER_A, paymentId: PAYMENT_ID,
    idempotencyKey: 'mpesa-concurrent-reconcile-1', paymentDate: '2026-10-30', queryProvider
  })
  const results = await Promise.all([reconcile(), reconcile()])
  assert.equal(results.filter((item) => item.reconciliation.outcome === 'provider_success').length, 2)
  assert.equal(harness.state.receipts.length, 1)
  assert.equal(harness.state.receiptCalls, 1)
  assert.equal(harness.state.audits.length, 1)
})

test('idempotency replay avoids another provider query and history is tenant scoped', async () => {
  const harness = makeHarness()
  activeReceiptCreator = harness.makeReceiptService()
  let queries = 0
  const input = {
    tenantId: TENANT_A, userId: USER_A, paymentId: PAYMENT_ID,
    idempotencyKey: 'mpesa-idempotency-replay-1', paymentDate: '2026-10-30',
    queryProvider: async ({ checkoutRequestId }) => {
      queries += 1
      return { ResponseCode: '0', CheckoutRequestID: checkoutRequestId, ResultCode: '0' }
    }
  }
  const first = await reconcileMpesaPayment(harness.pool, input)
  harness.state.payment.invoice_status = 'paid'
  const replay = await reconcileMpesaPayment(harness.pool, input)
  assert.equal(first.reconciliation.id, replay.reconciliation.id)
  assert.equal(replay.replayed, true)
  assert.equal(queries, 1)
  const history = await listMpesaReconciliationHistory(harness.pool, TENANT_A, PAYMENT_ID)
  assert.equal(history.length, 1)
  assert.equal((await listMpesaReconciliationHistory(harness.pool, TENANT_B, PAYMENT_ID)).length, 0)
})

test('query errors are recorded without exposing provider error details', async () => {
  const harness = makeHarness()
  require.cache[customerReceiptsPath].exports.createCustomerReceipt = harness.makeReceiptService()
  await assert.rejects(reconcileMpesaPayment(harness.pool, {
    tenantId: TENANT_A, userId: USER_A, paymentId: PAYMENT_ID,
    idempotencyKey: 'mpesa-query-error-test-1', paymentDate: '2026-10-30',
    queryProvider: async () => { throw new Error('secret provider payload must not be persisted') }
  }), { statusCode: 502 })
  assert.equal(harness.state.audits[0].outcome, 'query_failed')
  assert.equal(harness.state.receipts.length, 0)
  assert.equal(JSON.stringify(harness.state.audits).includes('secret provider payload'), false)
})

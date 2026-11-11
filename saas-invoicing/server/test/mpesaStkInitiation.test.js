const test = require('node:test')
const assert = require('node:assert/strict')
const {
  getMpesaStkInitiationStatus,
  initiateMpesaStkRequest,
  normalizeKenyanPhone,
  recoverMpesaStkRequest,
  resolveMpesaStkRequest
} = require('../src/services/mpesaStkInitiation')

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_A = '11111111-1111-4111-8111-111111111111'
const USER_B = '22222222-2222-4222-8222-222222222222'
let nextId = 0
const newId = () => `33333333-3333-4333-8333-${String(++nextId).padStart(12, '0')}`

function makePool() {
  const state = {
    requests: new Map(),
    events: [],
    payments: [],
    invoices: new Map(),
    allocations: [],
    receipts: [],
    queries: [],
    failPaymentInsert: false,
    failProviderAcceptanceUpdate: false
  }
  let queue = Promise.resolve()
  let advisoryQueue = Promise.resolve()
  let releaseAdvisoryLock = null

  const getInvoice = (tenantId, invoiceId) => {
    const mapKey = `${tenantId}:${invoiceId}`
    if (!state.invoices.has(mapKey)) {
      state.invoices.set(mapKey, {
        id: invoiceId, tenant_id: tenantId, customer_id: `customer:${tenantId}`,
        invoice_number: 'INV-1001', total: '123.00', status: 'sent',
        snapshot_total: '123.00', issued_at: '2026-10-31T08:00:00.000Z',
        journal_status: 'posted', invoice_currency: 'KES'
      })
    }
    return state.invoices.get(mapKey)
  }

  const cloneState = () => ({
    requests: structuredClone(state.requests),
    events: structuredClone(state.events),
    payments: structuredClone(state.payments),
    invoices: structuredClone(state.invoices),
    allocations: structuredClone(state.allocations),
    receipts: structuredClone(state.receipts),
    queries: structuredClone(state.queries),
    failPaymentInsert: state.failPaymentInsert,
    failProviderAcceptanceUpdate: state.failProviderAcceptanceUpdate
  })
  const restoreState = (snapshot) => {
    state.requests = snapshot.requests
    state.events = snapshot.events
    state.payments = snapshot.payments
    state.invoices = snapshot.invoices
    state.allocations = snapshot.allocations
    state.receipts = snapshot.receipts
    state.queries = snapshot.queries
    state.failPaymentInsert = snapshot.failPaymentInsert
    state.failProviderAcceptanceUpdate = snapshot.failProviderAcceptanceUpdate
  }

  const query = async (sql, params = []) => {
    const q = sql.replace(/\s+/g, ' ').trim()
    const lower = q.toLowerCase()
    state.queries.push({ sql: q, params })

    if (lower.includes('to_regclass(')) return { rows: [{ available: true }], rowCount: 1 }

    if (lower.includes('pg_advisory_lock(')) {
      const previous = advisoryQueue
      let release
      const gate = new Promise((resolve) => { release = resolve })
      advisoryQueue = previous.then(() => gate)
      await previous
      releaseAdvisoryLock = release
      return { rows: [{ pg_advisory_lock: null }], rowCount: 1 }
    }

    if (lower.includes('pg_advisory_unlock(')) {
      releaseAdvisoryLock?.()
      releaseAdvisoryLock = null
      return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 }
    }

    if (lower.startsWith('select id, request_status, payload_hash, invoice_id, invoice_number')) {
      const row = state.requests.get(`${params[0]}:${params[1]}`)
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 }
    }

    if (lower.startsWith('select client_id::text as customer_id from invoices')) {
      const invoice = getInvoice(params[0], params[1])
      return { rows: [{ customer_id: invoice.customer_id }], rowCount: 1 }
    }

    if (lower.startsWith('select id from clients where tenant_id = $1 and id::text = $2')) {
      return { rows: [{ id: params[1] }], rowCount: 1 }
    }

    if (lower.startsWith('select invoice.id::text as id, invoice.client_id::text as customer_id')) {
      const invoice = getInvoice(params[0], params[1])
      return { rows: [{ ...invoice, client_id: invoice.customer_id, total: invoice.total, snapshot_total: invoice.snapshot_total }], rowCount: 1 }
    }

    if (lower.startsWith('select coalesce(sum(allocation.amount), 0)::text as allocated')) {
      const allocated = state.allocations.filter((item) => item.tenant_id === params[0] && item.invoice_id === params[1])
        .filter((item) => state.receipts.find((receipt) => receipt.id === item.receipt_id)?.status === 'verified')
        .reduce((sum, item) => sum + BigInt(item.amount.replace('.', '')), 0n)
      return { rows: [{ allocated: `${allocated / 100n}.${String(allocated % 100n).padStart(2, '0')}` }], rowCount: 1 }
    }

    if (lower.startsWith('select receipt.id from customer_receipts receipt')) {
      const hasBalance = state.receipts.some((receipt) => receipt.tenant_id === params[0] && receipt.customer_id === params[1] &&
        (receipt.status === 'pending' || (receipt.status === 'verified' &&
          BigInt(receipt.amount.replace('.', '')) > state.allocations
            .filter((item) => item.tenant_id === params[0] && item.receipt_id === receipt.id)
            .reduce((sum, item) => sum + BigInt(item.amount.replace('.', '')), 0n))))
      return { rows: hasBalance ? [{ id: 'receipt-unallocated' }] : [], rowCount: hasBalance ? 1 : 0 }
    }

    if (lower.startsWith('select id, request_status from mpesa_stk_initiation_requests')) {
      const rows = [...state.requests.values()].filter((row) => row.tenant_id === params[0] && row.invoice_id === params[1] && params[2].includes(row.request_status))
      return { rows, rowCount: rows.length }
    }

    if (lower.startsWith('insert into mpesa_stk_initiation_requests')) {
      const [tenantId, key, hash, invoiceId, invoiceNumber, amount, phone, userId] = params
      const mapKey = `${tenantId}:${key}`
      if (state.requests.has(mapKey)) return { rows: [], rowCount: 0 }
      if ([...state.requests.values()].some((row) => row.tenant_id === tenantId && row.invoice_id === invoiceId &&
          ['reserved', 'outcome_unknown', 'provider_accepted', 'reference_recovered', 'payment_recorded', 'provider_succeeded'].includes(row.request_status))) {
        throw Object.assign(new Error('active invoice reservation conflict'), { code: '23505', constraint: 'mpesa_stk_one_active_request_per_invoice_uq' })
      }
      const invoice = getInvoice(tenantId, invoiceId)
      const row = {
        id: newId(), tenant_id: tenantId, idempotency_key: key, payload_hash: hash,
        invoice_id: invoiceId, invoice_number: invoiceNumber || invoice.invoice_number, amount, currency: 'KES',
        phone_number: phone, request_status: 'reserved', provider_checkout_request_id: null,
        merchant_request_id: null, payment_id: null, created_by: userId,
        created_at: '2026-10-31T09:00:00.000Z', updated_at: '2026-10-31T09:00:00.000Z'
      }
      state.requests.set(mapKey, row)
      return { rows: [{ ...row }], rowCount: 1 }
    }

    if (lower.startsWith('select id, invoice_id, invoice_number')) {
      const row = state.requests.get(`${params[0]}:${params[1]}`)
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 }
    }

    if (lower.startsWith('select id, request_status, provider_checkout_request_id')) {
      const row = state.requests.get(`${params[0]}:${params[1]}`)
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 }
    }

    if (lower.startsWith('select id, invoice_id, amount::text as amount, currency, request_status')) {
      const row = [...state.requests.values()].find((item) => item.tenant_id === params[0] && item.idempotency_key === params[1])
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 }
    }

    if (lower.startsWith('select event_type, from_status, to_status, checkout_request_id')) {
      const rows = state.events.filter((event) => event.tenant_id === params[0] && event.request_id === params[1])
      return { rows, rowCount: rows.length }
    }

    if (lower.startsWith('update mpesa_stk_initiation_requests') && lower.includes("set request_status = 'provider_rejected'")) {
      const row = state.requests.get(`${params[0]}:${params[1]}`)
      if (!row || row.request_status !== 'reserved') return { rows: [], rowCount: 0 }
      row.request_status = 'provider_rejected'
      row.phone_number = null
      return { rows: [{ id: row.id }], rowCount: 1 }
    }

    if (lower.startsWith('update mpesa_stk_initiation_requests') && lower.includes("set request_status = 'outcome_unknown'")) {
      const row = state.requests.get(`${params[0]}:${params[1]}`)
      if (!row || row.request_status !== 'reserved') return { rows: [], rowCount: 0 }
      row.request_status = 'outcome_unknown'
      row.provider_checkout_request_id = params[2] || row.provider_checkout_request_id
      row.merchant_request_id = params[3] || row.merchant_request_id
      if (params[2] == null) row.phone_number = null
      return { rows: [{ id: row.id }], rowCount: 1 }
    }

    if (lower.startsWith('update mpesa_stk_initiation_requests') && lower.includes("set request_status = 'provider_accepted'") && lower.includes("request_status = 'outcome_unknown'")) {
      const row = state.requests.get(`${params[0]}:${params[1]}`)
      if (!row || row.request_status !== 'outcome_unknown') return { rows: [], rowCount: 0 }
      row.request_status = 'provider_accepted'
      return { rows: [{ id: row.id }], rowCount: 1 }
    }

    if (lower.startsWith('update mpesa_stk_initiation_requests') && lower.includes("set request_status = 'reference_recovered'")) {
      const row = [...state.requests.values()].find((item) => item.tenant_id === params[0] && item.id === params[1])
      if (!row || row.request_status !== 'outcome_unknown') return { rows: [], rowCount: 0 }
      row.request_status = 'reference_recovered'
      row.provider_checkout_request_id = params[2]
      row.phone_number = params[3]
      return { rows: [{ id: row.id }], rowCount: 1 }
    }

    if (lower.startsWith('update mpesa_stk_initiation_requests') && lower.includes("set request_status = 'provider_accepted'")) {
      if (state.failProviderAcceptanceUpdate) throw Object.assign(new Error('simulated write interruption'), { code: '08006' })
      const row = state.requests.get(`${params[0]}:${params[1]}`)
      if (!row || row.request_status !== 'reserved') return { rows: [], rowCount: 0 }
      row.request_status = 'provider_accepted'
      row.provider_checkout_request_id = params[2]
      row.merchant_request_id = params[3]
      return { rows: [{ id: row.id }], rowCount: 1 }
    }

    if (lower.startsWith('insert into mpesa_stk_initiation_events')) {
      const literalType = /values\s*\(\$1,\s*\$2,\s*'([^']+)'/i.exec(q)?.[1]
      const eventType = literalType || (lower.includes('values ($1, $2, $3') ? params[2] : undefined)
      const event = { id: newId(), tenant_id: params[0], request_id: params[1],
        event_type: eventType, details: params.at(-1) && lower.includes('details') ? JSON.parse(params.at(-1)) : {} }
      state.events.push(event)
      return { rows: [{ ...event }], rowCount: 1 }
    }

    if (lower.startsWith('insert into payments')) {
      if (state.failPaymentInsert) throw Object.assign(new Error('simulated payment table outage'), { code: '08006' })
      const [tenantId, invoiceId, amount, phone, checkout] = params
      const payment = { id: newId(), tenant_id: tenantId, invoice_id: invoiceId,
        amount, phone_number: phone, mpesa_checkout_id: checkout, status: 'pending' }
      state.payments.push(payment)
      return { rows: [{ id: payment.id, invoice_id: invoiceId, amount, mpesa_checkout_id: checkout, status: 'pending' }], rowCount: 1 }
    }

    if (lower.startsWith('update mpesa_stk_initiation_requests') && lower.includes("request_status = 'payment_recorded'")) {
      const row = state.requests.get(`${params[0]}:${params[1]}`)
      if (!row || !['provider_accepted', 'reference_recovered'].includes(row.request_status)) return { rows: [], rowCount: 0 }
      row.request_status = 'payment_recorded'
      row.payment_id = params[2]
      row.phone_number = null
      return { rows: [{ id: row.id, provider_checkout_request_id: row.provider_checkout_request_id }], rowCount: 1 }
    }

    if (lower.startsWith('select invoice_id from mpesa_stk_initiation_requests')) {
      const row = state.requests.get(`${params[0]}:${params[1]}`)
      return { rows: row ? [{ invoice_id: row.invoice_id }] : [], rowCount: row ? 1 : 0 }
    }

    if (lower.startsWith('select client_id::text as customer_id from invoices')) {
      const invoice = getInvoice(params[0], params[1])
      return { rows: [{ customer_id: invoice.customer_id }], rowCount: 1 }
    }

    if (lower.startsWith('select id from invoices where tenant_id = $1 and id::text = $2')) {
      return { rows: [{ id: params[1] }], rowCount: 1 }
    }

    if (lower.startsWith('select id, invoice_id, request_status, provider_checkout_request_id')) {
      const row = [...state.requests.values()].find((item) => item.tenant_id === params[0] && item.idempotency_key === params[1])
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 }
    }

    if (lower.startsWith('select details from mpesa_stk_initiation_events')) {
      const eventType = /event_type = '([^']+)'/.exec(lower)?.[1] || params[2]
      const event = [...state.events].reverse().find((item) => item.tenant_id === params[0] && item.request_id === params[1] && item.event_type === eventType)
      return { rows: event ? [{ details: event.details }] : [], rowCount: event ? 1 : 0 }
    }

    if (lower.startsWith('update mpesa_stk_initiation_requests') && lower.includes("set request_status = 'resolved_no_collection'")) {
      const row = [...state.requests.values()].find((item) => item.tenant_id === params[0] && item.id === params[1])
      if (!row || !params[2].includes(row.request_status)) return { rows: [], rowCount: 0 }
      row.request_status = 'resolved_no_collection'
      row.phone_number = null
      return { rows: [{ id: row.id, provider_checkout_request_id: row.provider_checkout_request_id }], rowCount: 1 }
    }

    throw new Error(`Unexpected M-Pesa initiation query: ${q}`)
  }

  return {
    state,
    query,
    async connect() {
      let releaseLock
      let locked = false
      let snapshot
      return {
        async query(sql, params = []) {
          if (sql.startsWith('BEGIN')) {
            const previous = queue
            queue = new Promise((resolve) => { releaseLock = resolve })
            await previous
            locked = true
            snapshot = cloneState()
            return { rows: [], rowCount: 0 }
          }
          if (sql === 'COMMIT') {
            if (locked) { locked = false; releaseLock() }
            return { rows: [], rowCount: 0 }
          }
          if (sql === 'ROLLBACK') {
            if (locked) { restoreState(snapshot); locked = false; releaseLock() }
            return { rows: [], rowCount: 0 }
          }
          return query(sql, params)
        },
        release() { if (locked) { locked = false; releaseLock() } }
      }
    }
  }
}

function request(pool, overrides = {}) {
  return initiateMpesaStkRequest(pool, {
    tenantId: TENANT_A,
    userId: USER_A,
    idempotencyKey: 'mpesa-request-idem-001',
    invoiceId: 'legacy-invoice-id',
    invoiceNumber: 'INV-1001',
    amount: '123.00',
    phoneNumber: '0712 345 678',
    provider: async () => ({ ResponseCode: '0', CheckoutRequestID: 'ws_CO_stk_unit_001', MerchantRequestID: 'merchant_unit_001' }),
    ...overrides
  })
}

test('repeated same-key request returns one pending payment without another provider prompt', async () => {
  const pool = makePool()
  let providerCalls = 0
  const first = await request(pool, { provider: async () => {
    providerCalls += 1
    return { ResponseCode: '0', CheckoutRequestID: 'ws_CO_stk_unit_001', MerchantRequestID: 'merchant_unit_001' }
  } })
  const retry = await request(pool, { provider: async () => {
    providerCalls += 1
    return { ResponseCode: '0', CheckoutRequestID: 'ws_CO_should_not_be_called' }
  } })

  assert.equal(providerCalls, 1)
  assert.equal(first.replayed, false)
  assert.equal(retry.replayed, true)
  assert.equal(first.payment.status, 'pending')
  assert.equal(pool.state.payments.length, 1)
  assert.equal(pool.state.requests.get(`${TENANT_A}:mpesa-request-idem-001`).phone_number, null)
  assert.deepEqual(pool.state.events.map((event) => event.event_type), ['reserved', 'provider_accepted', 'payment_recorded'])
})

test('same idempotency key with a different payload is rejected without a second provider request', async () => {
  const pool = makePool()
  let providerCalls = 0
  await request(pool, { provider: async () => {
    providerCalls += 1
    return { ResponseCode: '0', CheckoutRequestID: 'ws_CO_stk_unit_002' }
  } })
  await assert.rejects(request(pool, { phoneNumber: '0712345679', provider: async () => {
    providerCalls += 1
    return { ResponseCode: '0', CheckoutRequestID: 'ws_CO_duplicate' }
  } }), (error) => error.statusCode === 409 && /different M-Pesa request payload/.test(error.message))
  assert.equal(providerCalls, 1)
  assert.equal(pool.state.payments.length, 1)
})

test('concurrent same-key submissions reserve once and make exactly one provider call', async () => {
  const pool = makePool()
  let providerCalls = 0
  let markEntered
  let releaseProvider
  const entered = new Promise((resolve) => { markEntered = resolve })
  const providerGate = new Promise((resolve) => { releaseProvider = resolve })
  const first = request(pool, { provider: async () => {
    providerCalls += 1
    markEntered()
    return providerGate
  } })
  await entered
  const second = request(pool, { provider: async () => {
    providerCalls += 1
    return { ResponseCode: '0', CheckoutRequestID: 'ws_CO_duplicate' }
  } })
  releaseProvider({ ResponseCode: '0', CheckoutRequestID: 'ws_CO_stk_concurrent_001' })
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(firstResult.payment.status, 'pending')
  assert.equal(secondResult.replayed, true)
  assert.equal(providerCalls, 1)
  assert.equal(pool.state.payments.length, 1)
})

test('different idempotency keys cannot start concurrent prompts for one invoice', async () => {
  const pool = makePool()
  let providerCalls = 0
  let markEntered
  let releaseProvider
  const entered = new Promise((resolve) => { markEntered = resolve })
  const providerGate = new Promise((resolve) => { releaseProvider = resolve })
  const first = request(pool, { provider: async () => {
    providerCalls += 1
    markEntered()
    return providerGate
  } })
  await entered
  const second = request(pool, { idempotencyKey: 'mpesa-request-idem-002', provider: async () => {
    providerCalls += 1
    return { ResponseCode: '0', CheckoutRequestID: 'ws_CO_second_prompt' }
  } })
  releaseProvider({ ResponseCode: '0', CheckoutRequestID: 'ws_CO_first_prompt' })
  const [firstResult, secondResult] = await Promise.allSettled([first, second])
  assert.equal(firstResult.status, 'fulfilled')
  assert.equal(secondResult.status, 'rejected')
  assert.equal(secondResult.reason.statusCode, 409)
  assert.equal(providerCalls, 1)
  assert.equal([...pool.state.requests.values()].filter((row) => ['reserved', 'outcome_unknown', 'provider_accepted', 'reference_recovered', 'payment_recorded', 'provider_succeeded'].includes(row.request_status)).length, 1)
})

test('a manual receipt recorded first blocks STK initiation until it is resolved or allocated', async () => {
  const pool = makePool()
  const customerId = `customer:${TENANT_A}`
  pool.state.receipts.push({
    id: 'manual-receipt-001', tenant_id: TENANT_A, customer_id: customerId,
    amount: '123.00', status: 'pending'
  })
  let providerCalls = 0
  await assert.rejects(request(pool, { provider: async () => {
    providerCalls += 1
    return { ResponseCode: '0', CheckoutRequestID: 'ws_CO_must_not_be_called' }
  } }), (error) => error.statusCode === 409 && /customer receipt/.test(error.message))
  assert.equal(providerCalls, 0)
  assert.equal(pool.state.requests.size, 0)
})

test('a payment allocation that commits first makes the full-balance STK check fail', async () => {
  const pool = makePool()
  pool.state.receipts.push({ id: 'manual-receipt-allocated', tenant_id: TENANT_A,
    customer_id: `customer:${TENANT_A}`, amount: '25.00', status: 'verified' })
  pool.state.allocations.push({ tenant_id: TENANT_A, invoice_id: 'legacy-invoice-id',
    receipt_id: 'manual-receipt-allocated', amount: '25.00' })
  let providerCalls = 0
  await assert.rejects(request(pool, { provider: async () => {
    providerCalls += 1
    return { ResponseCode: '0', CheckoutRequestID: 'ws_CO_must_not_be_called' }
  } }), (error) => error.statusCode === 409 && /full invoice balance/.test(error.message))
  assert.equal(providerCalls, 0)
})

test('provider timeout records an ambiguous outcome, clears phone data and blocks retries', async () => {
  const pool = makePool()
  let providerCalls = 0
  await assert.rejects(request(pool, { provider: async () => {
    providerCalls += 1
    throw new Error('provider timeout containing sensitive details')
  } }), (error) => error.statusCode === 502 && !/sensitive details/.test(error.message))
  const row = pool.state.requests.get(`${TENANT_A}:mpesa-request-idem-001`)
  assert.equal(row.request_status, 'outcome_unknown')
  assert.equal(row.phone_number, null)
  assert.equal(pool.state.payments.length, 0)
  await assert.rejects(request(pool, { provider: async () => {
    providerCalls += 1
    return { ResponseCode: '0', CheckoutRequestID: 'ws_CO_retry_must_not_happen' }
  } }), (error) => error.statusCode === 409 && error.requestStatus === 'outcome_unknown')
  assert.equal(providerCalls, 1)
})

test('an ambiguous request without a checkout ID can be recovered from external evidence and retried idempotently', async () => {
  const pool = makePool()
  await assert.rejects(request(pool, { provider: async () => { throw new Error('provider timeout') } }),
    (error) => error.statusCode === 502)
  const recovery = {
    tenantId: TENANT_A,
    userId: USER_A,
    idempotencyKey: 'mpesa-request-idem-001',
    checkoutRequestId: 'ws_CO_found_in_portal_001',
    phoneNumber: '0712 345 678',
    evidenceReference: 'Daraja support case 44823',
    reason: 'The provider record matched the invoice request and original phone.',
    confirmExternalReference: true
  }
  await assert.rejects(recoverMpesaStkRequest(pool, { ...recovery, confirmExternalReference: false }),
    (error) => error.statusCode === 400)
  await assert.rejects(recoverMpesaStkRequest(pool, { ...recovery, tenantId: TENANT_B }),
    (error) => error.statusCode === 404)
  await assert.rejects(recoverMpesaStkRequest(pool, { ...recovery, phoneNumber: '0711 111 111' }),
    (error) => error.statusCode === 400)
  assert.equal(pool.state.requests.get(`${TENANT_A}:mpesa-request-idem-001`).request_status, 'outcome_unknown')
  pool.state.failPaymentInsert = true
  await assert.rejects(recoverMpesaStkRequest(pool, recovery), /simulated payment table outage/)
  assert.equal(pool.state.requests.get(`${TENANT_A}:mpesa-request-idem-001`).request_status, 'reference_recovered')
  assert.equal(pool.state.payments.length, 0)
  pool.state.failPaymentInsert = false
  const replay = await recoverMpesaStkRequest(pool, recovery)
  assert.equal(replay.payment.status, 'pending')
  assert.equal(pool.state.payments.length, 1)
  assert.equal(pool.state.events.filter((event) => event.event_type === 'reference_recovered').length, 1)
})

test('ambiguous requests can be released only through an audited administrator resolution', async () => {
  const pool = makePool()
  await assert.rejects(request(pool, { provider: async () => { throw new Error('network timeout') } }),
    (error) => error.statusCode === 502)

  const input = {
    tenantId: TENANT_A,
    userId: USER_A,
    idempotencyKey: 'mpesa-request-idem-001',
    resolution: 'cancelled',
    evidenceReference: 'Daraja portal case 44821',
    reason: 'Provider records showed no collection or active checkout.',
    confirmNoCollection: true,
    confirmNoOutstandingPrompt: true
  }
  const resolved = await resolveMpesaStkRequest(pool, input)
  assert.equal(resolved.status, 'resolved_no_collection')
  assert.equal(pool.state.events.at(-1).event_type, 'admin_resolved_cancelled')
  assert.equal(pool.state.events.at(-1).details.evidence_reference, input.evidenceReference)

  const replay = await resolveMpesaStkRequest(pool, input)
  assert.equal(replay.replayed, true)
  await assert.rejects(request(pool, { provider: async () => ({
    ResponseCode: '0', CheckoutRequestID: 'ws_CO_must_not_retry_same_key'
  }) }), (error) => error.statusCode === 409 && error.requestStatus === 'resolved_no_collection')
})

test('documented nonzero provider response is recorded as a definite rejection and releases the invoice', async () => {
  const pool = makePool()
  await assert.rejects(request(pool, { provider: async () => ({ ResponseCode: '1', ResponseDescription: 'Rejected' }) }),
    (error) => error.statusCode === 502 && /rejected/.test(error.message))
  const row = pool.state.requests.get(`${TENANT_A}:mpesa-request-idem-001`)
  assert.equal(row.request_status, 'provider_rejected')
  assert.equal(row.phone_number, null)
  assert.equal(pool.state.events.at(-1).details.provider_response_code, '1')

  const second = await request(pool, { idempotencyKey: 'mpesa-request-idem-002', provider: async () => ({
    ResponseCode: '0', CheckoutRequestID: 'ws_CO_after_rejection'
  }) })
  assert.equal(second.payment.status, 'pending')
  assert.equal(pool.state.payments.length, 1)
})

test('provider-accepted request resumes local persistence after a rolled-back payment insert', async () => {
  const pool = makePool()
  let providerCalls = 0
  pool.state.failPaymentInsert = true
  await assert.rejects(request(pool, { provider: async () => {
    providerCalls += 1
    return { ResponseCode: '0', CheckoutRequestID: 'ws_CO_recovery_001' }
  } }), /simulated payment table outage/)
  assert.equal(pool.state.requests.get(`${TENANT_A}:mpesa-request-idem-001`).request_status, 'provider_accepted')
  assert.equal(pool.state.payments.length, 0)

  pool.state.failPaymentInsert = false
  const resumed = await request(pool, { provider: async () => {
    providerCalls += 1
    throw new Error('provider must not be called on recovery')
  } })
  assert.equal(providerCalls, 1)
  assert.equal(resumed.payment.status, 'pending')
  assert.equal(pool.state.payments.length, 1)
})

test('valid checkout identifier is retained when another provider response field is malformed', async () => {
  const pool = makePool()
  await assert.rejects(request(pool, { provider: async () => ({
    ResponseCode: '0',
    CheckoutRequestID: 'ws_CO_valid_checkout_001',
    MerchantRequestID: { unexpected: 'object' }
  }) }), (error) => error.statusCode === 502)
  const row = pool.state.requests.get(`${TENANT_A}:mpesa-request-idem-001`)
  assert.equal(row.request_status, 'outcome_unknown')
  assert.equal(row.provider_checkout_request_id, 'ws_CO_valid_checkout_001')
  assert.equal(row.phone_number, '254712345678')
  assert.equal(pool.state.payments.length, 0)
})

test('a checkout identifier in a provider error remains ambiguous until audited external-reference recovery', async () => {
  const pool = makePool()
  let providerCalls = 0
  const providerError = Object.assign(new Error('HTTP error with provider response'), {
    response: { data: { ResponseCode: '0', CheckoutRequestID: 'ws_CO_error_body_001', MerchantRequestID: 'merchant_error_001' } }
  })
  await assert.rejects(request(pool, { provider: async () => {
    providerCalls += 1
    throw providerError
  } }), (error) => error.statusCode === 502)
  const row = pool.state.requests.get(`${TENANT_A}:mpesa-request-idem-001`)
  assert.equal(row.request_status, 'outcome_unknown')
  assert.equal(row.provider_checkout_request_id, 'ws_CO_error_body_001')
  assert.equal(row.phone_number, '254712345678')

  await assert.rejects(request(pool, { provider: async () => {
    providerCalls += 1
    throw new Error('provider must not be called during local recovery')
  } }), (error) => error.statusCode === 409 && error.requestStatus === 'outcome_unknown')
  const resumed = await recoverMpesaStkRequest(pool, {
    tenantId: TENANT_A,
    userId: USER_A,
    idempotencyKey: 'mpesa-request-idem-001',
    checkoutRequestId: 'ws_CO_error_body_001',
    phoneNumber: '0712 345 678',
    evidenceReference: 'Daraja portal case 44821',
    reason: 'Matched the checkout request in the provider portal before linking it for status reconciliation.',
    confirmExternalReference: true
  })
  assert.equal(resumed.payment.status, 'pending')
  assert.equal(providerCalls, 1)
  assert.equal(pool.state.requests.get(`${TENANT_A}:mpesa-request-idem-001`).request_status, 'payment_recorded')
  const recoveryEvent = pool.state.events.find((event) => event.event_type === 'reference_recovered')
  assert.ok(recoveryEvent)
  assert.equal(recoveryEvent.details.source, 'administrator_external_provider_record')
})

test('failed persistence of the provider response records a queryable ambiguous request', async () => {
  const pool = makePool()
  pool.state.failProviderAcceptanceUpdate = true
  await assert.rejects(request(pool), (error) => error.statusCode === 503)
  const row = pool.state.requests.get(`${TENANT_A}:mpesa-request-idem-001`)
  assert.equal(row.request_status, 'outcome_unknown')
  assert.equal(row.provider_checkout_request_id, 'ws_CO_stk_unit_001')
  assert.equal(row.phone_number, '254712345678')
  assert.equal(pool.state.payments.length, 0)
})

test('an externally verified checkout identifier repairs an interrupted response without another prompt', async () => {
  const pool = makePool()
  pool.state.failProviderAcceptanceUpdate = true
  let promptCalls = 0
  await assert.rejects(request(pool, { provider: async () => {
    promptCalls += 1
    return { ResponseCode: '0', CheckoutRequestID: 'ws_CO_recover_by_query_001' }
  } }), (error) => error.statusCode === 503)

  pool.state.failProviderAcceptanceUpdate = false
  const result = await recoverMpesaStkRequest(pool, {
    tenantId: TENANT_A,
    userId: USER_A,
    idempotencyKey: 'mpesa-request-idem-001',
    checkoutRequestId: 'ws_CO_recover_by_query_001',
    phoneNumber: '0712 345 678',
    evidenceReference: 'Daraja portal case 44822',
    reason: 'Matched the saved request against the provider portal and retained it for exact status reconciliation.',
    confirmExternalReference: true
  })
  assert.equal(promptCalls, 1)
  assert.equal(result.payment.status, 'pending')
  assert.equal(pool.state.requests.get(`${TENANT_A}:mpesa-request-idem-001`).request_status, 'payment_recorded')
  assert.equal(pool.state.payments.length, 1)
})

test('tenant-scoped status lookup hides another tenant request and exposes no phone or payload hash', async () => {
  const pool = makePool()
  await request(pool)
  await assert.rejects(getMpesaStkInitiationStatus(pool, TENANT_B, 'mpesa-request-idem-001'), (error) => error.statusCode === 404)
  const status = await getMpesaStkInitiationStatus(pool, TENANT_A, 'mpesa-request-idem-001')
  assert.equal(status.status, 'payment_recorded')
  assert.equal(status.checkout_request_id, 'ws_CO_stk_unit_001')
  assert.equal(Object.hasOwn(status, 'phone_number'), false)
  assert.equal(Object.hasOwn(status, 'payload_hash'), false)
})

test('whole-KES limits and Kenyan phone normalization are exact', async () => {
  assert.equal(normalizeKenyanPhone(' +254 712 345 678 '), '254712345678')
  assert.equal(normalizeKenyanPhone('0112345678'), '254112345678')
  assert.throws(() => normalizeKenyanPhone('12345'), /Kenyan mobile number/)
  const pool = makePool()
  const invoice = pool.state.invoices.get(`${TENANT_A}:legacy-invoice-id`) || {
    id: 'legacy-invoice-id', tenant_id: TENANT_A, customer_id: `customer:${TENANT_A}`,
    invoice_number: 'INV-1001', status: 'sent', issued_at: '2026-10-31T08:00:00.000Z',
    journal_status: 'posted', invoice_currency: 'KES'
  }
  pool.state.invoices.set(`${TENANT_A}:legacy-invoice-id`, { ...invoice, total: '123.01', snapshot_total: '123.01' })
  await assert.rejects(request(pool), (error) => error.statusCode === 409)
  pool.state.invoices.set(`${TENANT_A}:legacy-invoice-id`, { ...invoice, total: '250001.00', snapshot_total: '250001.00' })
  await assert.rejects(request(pool), (error) => error.statusCode === 409)
  assert.equal(pool.state.requests.size, 0)
})

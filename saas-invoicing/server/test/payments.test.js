const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const Module = require('node:module')
const express = require('express')
const jwt = require('jsonwebtoken')

const JWT_TEST_SECRET = 'payment-route-tenant-isolation-test-secret'
const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_A = '11111111-1111-4111-8111-111111111111'
process.env.JWT_SECRET = JWT_TEST_SECRET

const state = { queries: [], paymentListFixture: null, invoiceFixture: null, postedInvoiceFixture: null, outstandingAmountFixture: null, stkCalls: [], stkInitiationCalls: [], recoveryCalls: [], resolutionCalls: [], userRoles: new Map() }
const fakePool = {
  async query(sql, params) {
    state.queries.push({ sql, params })
    if (sql.includes('SELECT role FROM users WHERE id = $1 AND tenant_id = $2')) {
      const role = state.userRoles.get(`${params[0]}:${params[1]}`)
      return { rows: role ? [{ role }] : [], rowCount: role ? 1 : 0 }
    }
    if (sql.includes('FROM invoices WHERE id=$1 AND tenant_id=$2')) {
      const invoice = state.invoiceFixture
      return { rows: invoice && invoice.tenant_id === params[1] ? [invoice] : [], rowCount: invoice ? 1 : 0 }
    }
    if (sql.includes('FROM accounting_invoice_tax_snapshots snapshot')) {
      const snapshot = state.postedInvoiceFixture
      const matches = snapshot && snapshot.tenant_id === params[0] && snapshot.source_id === params[1]
      return { rows: matches ? [snapshot] : [], rowCount: matches ? 1 : 0 }
    }
    if (sql.includes('invoice.total::text AS total') && sql.includes('outstanding_amount')) {
      const invoice = state.invoiceFixture
      if (!invoice || invoice.tenant_id !== params[0] || invoice.client_id !== params[1]) {
        return { rows: [], rowCount: 0 }
      }
      const outstanding = state.outstandingAmountFixture || invoice.total
      return {
        rows: [{ id: invoice.id, invoice_number: invoice.invoice_number, customer_id: invoice.client_id,
          total: invoice.total, status: invoice.status, currency: 'KES', allocated_amount: '0.00',
          outstanding_amount: outstanding }],
        rowCount: 1
      }
    }
    if (sql.includes('INSERT INTO payments')) {
      return { rows: [{ id: 'payment-test', status: 'pending', amount: params[2], mpesa_checkout_id: params[4] }], rowCount: 1 }
    }
    if (sql.includes('FROM payments p')) {
      const payment = state.paymentListFixture
      if (!payment) return { rows: [], rowCount: 0 }

      const paymentMatchesTenant = payment.tenant_id === params[0]
      const joinMatchesTenant = !/i\.tenant_id\s*=\s*p\.tenant_id/i.test(sql) ||
        payment.invoice_tenant_id === payment.tenant_id
      const rows = paymentMatchesTenant && joinMatchesTenant
        ? [{
            id: payment.id,
            tenant_id: payment.tenant_id,
            invoice_id: payment.invoice_id,
            amount: payment.amount,
            status: payment.status,
            invoice_number: payment.invoice_number
          }]
        : []
      return { rows, rowCount: rows.length }
    }
    return { rows: [], rowCount: 0 }
  }
}

const installMockModule = (modulePath, exports) => {
  const mock = new Module(modulePath)
  mock.filename = modulePath
  mock.loaded = true
  mock.exports = exports
  require.cache[modulePath] = mock
}

installMockModule(require.resolve('../src/config/db'), fakePool)
installMockModule(require.resolve('../src/config/mpesa'), {
  async stkPush(input) {
    state.stkCalls.push(input)
    return { ResponseCode: '0', CheckoutRequestID: 'ws_CO_payment_route_test' }
  },
  async stkPushQuery() { throw new Error('Unexpected provider query in this route test') }
})
installMockModule(require.resolve('../src/services/mpesaStkInitiation'), {
  async initiateMpesaStkRequest(_pool, input) {
    state.stkInitiationCalls.push({ ...input, provider: undefined })
    const invoice = state.invoiceFixture
    if (!invoice || invoice.tenant_id !== input.tenantId || invoice.id !== input.invoiceId) {
      const error = new Error('Invoice not found')
      error.statusCode = 404
      throw error
    }
    if (!['sent', 'overdue'].includes(invoice.status)) {
      const error = new Error('Only an issued invoice can accept a payment request')
      error.statusCode = 409
      throw error
    }
    const amountUnits = BigInt(String(invoice.total).replace('.', ''))
    if (amountUnits % 100n !== 0n) {
      const error = new Error('M-Pesa STK Push supports whole KES amounts; this invoice has a fractional amount')
      error.statusCode = 409
      throw error
    }
    if (amountUnits / 100n > 250000n) {
      const error = new Error('M-Pesa STK Push amount exceeds the supported KES transaction limit')
      error.statusCode = 409
      throw error
    }
    const posted = state.postedInvoiceFixture
    if (!posted || posted.tenant_id !== input.tenantId || posted.source_id !== invoice.id ||
        posted.journal_status !== 'posted' || posted.functional_currency !== 'KES' ||
        posted.snapshot_total !== invoice.total) {
      const error = new Error('M-Pesa requests require a matching posted KES invoice record')
      error.statusCode = 409
      throw error
    }
    if (state.outstandingAmountFixture && state.outstandingAmountFixture !== invoice.total) {
      const error = new Error('M-Pesa STK prompts require the full invoice balance to be outstanding; use the customer receipt workflow for a partial balance')
      error.statusCode = 409
      throw error
    }
    const response = await input.provider({
      phone: input.phoneNumber,
      amount: Number(String(invoice.total).replace(/\.00$/, '')),
      invoiceNumber: invoice.invoice_number
    })
    return {
      replayed: false,
      request: { id: 'request-route-test', status: 'payment_recorded', checkoutRequestId: response.CheckoutRequestID },
      payment: { id: 'payment-test', invoice_id: input.invoiceId, amount: invoice.total,
        mpesa_checkout_id: response.CheckoutRequestID, status: 'pending' }
    }
  },
  async getMpesaStkInitiationStatus(_pool, tenantId, idempotencyKey) {
    return { tenant_id: tenantId, idempotency_key: idempotencyKey, status: 'outcome_unknown' }
  },
  async recoverMpesaStkRequest(_pool, input) {
    state.recoveryCalls.push(input)
    return {
      request: { id: 'request-recovered', status: 'payment_recorded', checkoutRequestId: 'ws_CO_recovered' },
      payment: { id: 'payment-recovered', status: 'pending' },
      replayed: false
    }
  },
  async resolveMpesaStkRequest(_pool, input) {
    state.resolutionCalls.push(input)
    return { id: 'request-resolved', status: 'resolved_no_collection', replayed: false }
  }
})
const paymentRouter = require('../src/routes/payments')

test('payment list does not expose an invoice number from another tenant', async (t) => {
  state.queries.length = 0
  state.paymentListFixture = {
    id: 'payment-a',
    tenant_id: TENANT_A,
    invoice_id: 'invoice-b',
    invoice_tenant_id: TENANT_B,
    invoice_number: 'FOREIGN-INVOICE-SENTINEL',
    amount: '45.00',
    status: 'pending'
  }

  const app = express()
  app.use(express.json())
  app.use('/api/payments', paymentRouter)
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => {
    state.paymentListFixture = null
    return new Promise((resolve) => server.close(resolve))
  })

  const token = jwt.sign({ userId: USER_A, tenantId: TENANT_A, role: 'admin' }, JWT_TEST_SECRET)
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/payments`, {
    headers: { Authorization: `Bearer ${token}` }
  })

  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(body, [])
  assert.doesNotMatch(JSON.stringify(body), /FOREIGN-INVOICE-SENTINEL/)
  assert.equal(state.queries.length, 1)
  assert.deepEqual(state.queries[0].params, [TENANT_A])
  assert.match(state.queries[0].sql, /i\.tenant_id\s*=\s*p\.tenant_id/i)
})

test('malformed M-Pesa callbacks are rejected without changing payment state', async (t) => {
  state.queries.length = 0
  const app = express()
  app.use(express.json())
  app.use('/api/payments', paymentRouter)
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/payments/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      Body: {
        stkCallback: {
          MerchantRequestID: 'forged-merchant-id',
          CheckoutRequestID: '',
          ResultCode: 0,
          ResultDesc: 'Processed',
          CallbackMetadata: { Item: [{ Name: 'MpesaReceiptNumber', Value: 'FORGED123' }] }
        }
      }
    })
  })

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { ResultCode: 1, ResultDesc: 'Invalid callback payload' })
  assert.equal(state.queries.length, 0)
})

test('well-formed repeated M-Pesa callbacks are acknowledged but never change payment state', async (t) => {
  state.queries.length = 0
  const app = express()
  app.use(express.json())
  app.use('/api/payments', paymentRouter)
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))

  const callback = {
    Body: {
      stkCallback: {
        MerchantRequestID: 'merchant-request-123',
        CheckoutRequestID: 'ws_CO_123456789',
        ResultCode: 0,
        ResultDesc: 'The service request is processed successfully.',
        CallbackMetadata: { Item: [
          { Name: 'Amount', Value: 45 },
          { Name: 'MpesaReceiptNumber', Value: 'ABC123XYZ' },
          { Name: 'TransactionDate', Value: 20261030120000 },
          { Name: 'PhoneNumber', Value: 254712345678 }
        ] }
      }
    }
  }
  const send = () => fetch(`http://127.0.0.1:${server.address().port}/api/payments/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(callback)
  })
  const responses = await Promise.all([send(), send(), send()])

  for (const response of responses) {
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ResultCode: 0, ResultDesc: 'Accepted' })
  }
  assert.equal(state.queries.length, 0)
})

test('STK request rejects fractional KES and sends a whole KES amount without rounding', async (t) => {
  state.queries.length = 0
  state.stkCalls.length = 0
  state.stkInitiationCalls.length = 0
  state.invoiceFixture = {
    id: 'invoice-a', tenant_id: TENANT_A, client_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', status: 'sent', total: '123.45', invoice_number: 'INV-A'
  }
  state.postedInvoiceFixture = {
    tenant_id: TENANT_A, source_id: 'invoice-a', snapshot_total: '123.45',
    issued_at: '2026-10-30T00:00:00Z', journal_status: 'posted', functional_currency: 'KES'
  }
  const app = express()
  app.use(express.json())
  app.use('/api/payments', paymentRouter)
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => {
    state.invoiceFixture = null
    state.postedInvoiceFixture = null
    return new Promise((resolve) => server.close(resolve))
  })

  const token = jwt.sign({ userId: USER_A, tenantId: TENANT_A, role: 'admin' }, JWT_TEST_SECRET)
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/payments/request`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'mpesa-route-stk-001' },
    body: JSON.stringify({ invoice_id: 'invoice-a', phone_number: '0712345678' })
  })
  assert.equal(response.status, 409)
  assert.match((await response.json()).error, /whole KES/)
  assert.equal(state.stkCalls.length, 0)
  assert.equal(state.queries.some((entry) => entry.sql.includes('INSERT INTO payments')), false)

  state.invoiceFixture = { ...state.invoiceFixture, total: '123.00' }
  state.postedInvoiceFixture = { ...state.postedInvoiceFixture, snapshot_total: '123.00' }
  const wholeAmountResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/payments/request`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'mpesa-route-stk-001' },
    body: JSON.stringify({ invoice_id: 'invoice-a', phone_number: '0712345678' })
  })
  assert.equal(wholeAmountResponse.status, 201)
  assert.equal(state.stkCalls.length, 1)
  assert.equal(state.stkCalls[0].amount, 123)
  assert.equal(state.stkInitiationCalls.at(-1).tenantId, TENANT_A)
  assert.equal(state.stkInitiationCalls.at(-1).userId, USER_A)
  assert.equal(state.stkInitiationCalls.at(-1).idempotencyKey, 'mpesa-route-stk-001')

  state.invoiceFixture = { ...state.invoiceFixture, total: '250001.00' }
  state.postedInvoiceFixture = { ...state.postedInvoiceFixture, snapshot_total: '250001.00' }
  const overLimitResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/payments/request`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'mpesa-route-stk-001' },
    body: JSON.stringify({ invoice_id: 'invoice-a', phone_number: '0712345678' })
  })
  assert.equal(overLimitResponse.status, 409)
  assert.equal(state.stkCalls.length, 1)

  state.invoiceFixture = { ...state.invoiceFixture, total: '123.00' }
  state.postedInvoiceFixture = { ...state.postedInvoiceFixture, snapshot_total: '124.00' }
  const unpostedMismatchResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/payments/request`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'mpesa-route-stk-001' },
    body: JSON.stringify({ invoice_id: 'invoice-a', phone_number: '0712345678' })
  })
  assert.equal(unpostedMismatchResponse.status, 409)
  assert.equal(state.stkCalls.length, 1)
})

test('STK request refuses a partially allocated invoice instead of prompting for its full original total', async (t) => {
  state.queries.length = 0
  state.stkCalls.length = 0
  state.stkInitiationCalls.length = 0
  state.invoiceFixture = {
    id: 'invoice-partial', tenant_id: TENANT_A, client_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    status: 'sent', total: '123.00', invoice_number: 'INV-PARTIAL'
  }
  state.postedInvoiceFixture = {
    tenant_id: TENANT_A, source_id: 'invoice-partial', snapshot_total: '123.00',
    issued_at: '2026-10-30T00:00:00Z', journal_status: 'posted', functional_currency: 'KES'
  }
  state.outstandingAmountFixture = '23.00'
  const app = express()
  app.use(express.json())
  app.use('/api/payments', paymentRouter)
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => {
    state.invoiceFixture = null
    state.postedInvoiceFixture = null
    state.outstandingAmountFixture = null
    return new Promise((resolve) => server.close(resolve))
  })

  const token = jwt.sign({ userId: USER_A, tenantId: TENANT_A, role: 'admin' }, JWT_TEST_SECRET)
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/payments/request`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'mpesa-partial-invoice-001' },
    body: JSON.stringify({ invoice_id: 'invoice-partial', phone_number: '0712345678' })
  })
  assert.equal(response.status, 409)
  assert.match((await response.json()).error, /full invoice balance to be outstanding/)
  assert.equal(state.stkCalls.length, 0)
  assert.equal(state.stkInitiationCalls.length, 1)
})

test('STK request requires an idempotency key before invoice or provider work', async (t) => {
  state.queries.length = 0
  state.stkCalls.length = 0
  const app = express()
  app.use(express.json())
  app.use('/api/payments', paymentRouter)
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))

  const token = jwt.sign({ userId: USER_A, tenantId: TENANT_A, role: 'admin' }, JWT_TEST_SECRET)
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/payments/request`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ invoice_id: 'invoice-a', phone_number: '0712345678' })
  })
  assert.equal(response.status, 400)
  assert.match((await response.json()).error, /Idempotency-Key/)
  assert.equal(state.queries.length, 0)
  assert.equal(state.stkCalls.length, 0)
})

test('M-Pesa initiation recovery requires accounting authorization and explicit confirmation', async (t) => {
  state.queries.length = 0
  state.recoveryCalls.length = 0
  state.userRoles.clear()
  state.userRoles.set(`${USER_A}:${TENANT_A}`, 'admin')
  state.userRoles.set(`${USER_A}:${TENANT_B}`, 'staff')
  const app = express()
  app.use(express.json())
  app.use('/api/payments', paymentRouter)
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => {
    state.userRoles.clear()
    return new Promise((resolve) => server.close(resolve))
  })

  const base = `http://127.0.0.1:${server.address().port}/api/payments/stk-request/recover`
  const adminToken = jwt.sign({ userId: USER_A, tenantId: TENANT_A, role: 'admin' }, JWT_TEST_SECRET)
  const staffToken = jwt.sign({ userId: USER_A, tenantId: TENANT_B, role: 'staff' }, JWT_TEST_SECRET)
  const denied = await fetch(base, {
    method: 'POST',
    headers: { Authorization: `Bearer ${staffToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'mpesa-recover-route-1' },
    body: JSON.stringify({ confirm: true })
  })
  assert.equal(denied.status, 403)

  const missingConfirmation = await fetch(base, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'mpesa-recover-route-1' },
    body: JSON.stringify({})
  })
  assert.equal(missingConfirmation.status, 400)
  assert.equal(state.recoveryCalls.length, 0)

  const recovered = await fetch(base, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'mpesa-recover-route-1' },
    body: JSON.stringify({
      confirm: true,
      confirm_external_reference: true,
      checkout_request_id: 'ws_CO_external_recovery_001',
      phone_number: '0712 345 678',
      evidence_reference: 'Daraja portal case 44821',
      reason: 'Matched the externally held checkout to the saved request.'
    })
  })
  assert.equal(recovered.status, 200)
  assert.equal((await recovered.json()).payment.status, 'pending')
  assert.equal(state.recoveryCalls[0].tenantId, TENANT_A)
  assert.equal(state.recoveryCalls[0].userId, USER_A)
  assert.equal(state.recoveryCalls[0].idempotencyKey, 'mpesa-recover-route-1')
  assert.equal(state.recoveryCalls[0].checkoutRequestId, 'ws_CO_external_recovery_001')
  assert.equal(state.recoveryCalls[0].evidenceReference, 'Daraja portal case 44821')
  assert.equal(state.recoveryCalls[0].confirmExternalReference, true)
})

test('audited M-Pesa resolution requires receipt management permission and an explicit no-collection record', async (t) => {
  state.queries.length = 0
  state.resolutionCalls.length = 0
  state.userRoles.clear()
  state.userRoles.set(`${USER_A}:${TENANT_A}`, 'admin')
  const app = express()
  app.use(express.json())
  app.use('/api/payments', paymentRouter)
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => {
    state.userRoles.clear()
    return new Promise((resolve) => server.close(resolve))
  })

  const token = jwt.sign({ userId: USER_A, tenantId: TENANT_A, role: 'admin' }, JWT_TEST_SECRET)
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/payments/stk-request/resolve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'mpesa-resolve-route-001' },
    body: JSON.stringify({
      confirm_no_collection: true,
      confirm_no_outstanding_prompt: true,
      resolution: 'failed',
      evidence_reference: 'Daraja portal case 99127',
      reason: 'Provider records showed no successful collection.'
    })
  })
  assert.equal(response.status, 201)
  assert.equal(state.resolutionCalls.length, 1)
  assert.equal(state.resolutionCalls[0].resolution, 'failed')
  assert.equal(state.resolutionCalls[0].confirmNoCollection, true)
  assert.equal(state.resolutionCalls[0].confirmNoOutstandingPrompt, true)
})

test('M-Pesa reconciliation routes require tenant-authenticated accounting permissions', async (t) => {
  state.queries.length = 0
  state.userRoles.clear()
  state.userRoles.set(`${USER_A}:${TENANT_A}`, 'admin')
  state.userRoles.set(`${USER_A}:${TENANT_B}`, 'staff')
  const app = express()
  app.use(express.json())
  app.use('/api/payments', paymentRouter)
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => {
    state.userRoles.clear()
    return new Promise((resolve) => server.close(resolve))
  })

  const base = `http://127.0.0.1:${server.address().port}/api/payments`
  const adminToken = jwt.sign({ userId: USER_A, tenantId: TENANT_A, role: 'admin' }, JWT_TEST_SECRET)
  const missingAuth = await fetch(`${base}/payment-a/mpesa/reconciliation`)
  assert.equal(missingAuth.status, 401)

  const read = await fetch(`${base}/payment-a/mpesa/reconciliation`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  })
  assert.equal(read.status, 200)
  assert.deepEqual(await read.json(), [])
  assert.equal(state.queries.at(-1).params[0], TENANT_A)

  const staffToken = jwt.sign({ userId: USER_A, tenantId: TENANT_B, role: 'staff' }, JWT_TEST_SECRET)
  const denied = await fetch(`${base}/payment-a/mpesa/reconcile`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${staffToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'staff-mpesa-reconcile-1' },
    body: JSON.stringify({ payment_date: '2026-10-30' })
  })
  assert.equal(denied.status, 403)
})

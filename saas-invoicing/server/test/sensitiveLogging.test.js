const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const Module = require('node:module')
const express = require('express')
const jwt = require('jsonwebtoken')

const JWT_TEST_SECRET = 'invoxa-logging-test-secret'
process.env.JWT_SECRET = JWT_TEST_SECRET

const paymentState = {
  providerError: Object.assign(new Error('provider failure phone=0712345678 amount=123.45'), {
    code: 'ECONNRESET',
    response: { data: { access_token: 'PROVIDER_TOKEN_SECRET', phone: '0712345678', amount: '123.45' } }
  }),
  failPaymentInsert: false
}

const fakePool = {
  async query(sql) {
    if (sql.includes('FROM users u')) {
      throw Object.assign(new Error('SELECT password_hash -- ACCOUNT_SQL_SECRET login=USER_SECRET'), {
        code: 'XX999'
      })
    }
    if (sql.includes('FROM invoices')) {
      if (sql.includes('FROM invoices invoice')) {
        return {
          rows: [{ id: 'invoice-test-id', outstanding_amount: '123.00' }],
          rowCount: 1
        }
      }
      return {
        rows: [{ id: 'invoice-test-id', client_id: '30000000-0000-4000-8000-000000000001',
          status: 'sent', total: '123.00', invoice_number: 'INV-TEST' }],
        rowCount: 1
      }
    }
    if (sql.includes('FROM accounting_invoice_tax_snapshots snapshot')) {
      return {
        rows: [{ snapshot_total: '123.00', issued_at: '2026-10-30T00:00:00Z', journal_status: 'posted', functional_currency: 'KES' }],
        rowCount: 1
      }
    }
    if (sql.includes('INSERT INTO payments')) {
      if (paymentState.failPaymentInsert) {
        throw Object.assign(new Error('INSERT INTO payments -- DATABASE_SQL_SECRET'), { code: 'XX001' })
      }
      return {
        rows: [{ id: 'payment-test-id', invoice_id: 'invoice-test-id', status: 'pending' }],
        rowCount: 1
      }
    }
    throw new Error('Unexpected mocked query')
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
  stkPush: async () => {
    if (paymentState.providerError) throw paymentState.providerError
    return { CheckoutRequestID: 'CHECKOUT-TEST' }
  }
})
installMockModule(require.resolve('../src/services/mpesaStkInitiation'), {
  async initiateMpesaStkRequest(pool, input) {
    const providerResponse = await input.provider({
      phone: input.phoneNumber,
      amount: Number(String(input.amount).replace(/\.00$/, '')),
      invoiceNumber: input.invoiceNumber
    })
    const inserted = await pool.query('INSERT INTO payments', [
      input.tenantId, input.invoiceId, input.amount, input.phoneNumber, providerResponse.CheckoutRequestID
    ])
    return {
      replayed: false,
      request: { id: 'request-sensitive-log-test', status: 'payment_recorded', checkoutRequestId: providerResponse.CheckoutRequestID },
      payment: { id: inserted.rows[0].id, invoice_id: input.invoiceId,
        amount: input.amount, mpesa_checkout_id: providerResponse.CheckoutRequestID, status: 'pending' }
    }
  },
  async getMpesaStkInitiationStatus() { return {} },
  async recoverMpesaStkRequest() { return {} }
})

const authRouter = require('../src/routes/auth')
const paymentRouter = require('../src/routes/payments')

async function withServer(run) {
  const app = express()
  app.use(express.json())
  app.use('/api/auth', authRouter)
  app.use('/api/payments', paymentRouter)

  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    await run(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
}

test('authentication and M-Pesa failures log structured diagnostics without secrets', async () => {
  const authLogs = []
  const providerLogs = []
  const persistenceLogs = []
  const originalConsoleError = console.error
  console.error = (...args) => {
    if (args[0] === 'Login failed') authLogs.push(args)
    else if (args[0] === 'M-Pesa request failed') {
      if (paymentState.failPaymentInsert) persistenceLogs.push(args)
      else providerLogs.push(args)
    }
  }
  try {
    await withServer(async (baseUrl) => {
      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Connection: 'close' },
        body: JSON.stringify({ email: 'person@example.test', password: 'USER_SECRET' })
      })
      assert.equal(loginResponse.status, 500)
      assert.deepEqual(await loginResponse.json(), { error: 'Login failed' })

      const token = jwt.sign({
        userId: '20000000-0000-4000-8000-000000000001',
        tenantId: '10000000-0000-4000-8000-000000000001',
        role: 'admin'
      }, JWT_TEST_SECRET)
      const paymentResponse = await fetch(`${baseUrl}/api/payments/request`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          Connection: 'close',
          'Idempotency-Key': 'mpesa-sensitive-log-1'
        },
        body: JSON.stringify({ invoice_id: 'invoice-test-id', phone_number: '0712345678' })
      })
      assert.equal(paymentResponse.status, 500)
      const providerBody = await paymentResponse.json()
      assert.deepEqual(providerBody, { error: 'M-Pesa request failed' })
      const providerBodyText = JSON.stringify(providerBody)
      for (const secret of ['PROVIDER_TOKEN_SECRET', '0712345678', '123.45', 'provider failure']) {
        assert.equal(providerBodyText.includes(secret), false)
      }

      paymentState.providerError = null
      paymentState.failPaymentInsert = true
      const persistenceResponse = await fetch(`${baseUrl}/api/payments/request`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          Connection: 'close',
          'Idempotency-Key': 'mpesa-sensitive-log-2'
        },
        body: JSON.stringify({ invoice_id: 'invoice-test-id', phone_number: '0712345678' })
      })
      assert.equal(persistenceResponse.status, 500)
      const persistenceBody = await persistenceResponse.json()
      assert.deepEqual(persistenceBody, { error: 'M-Pesa request failed' })
      assert.equal(JSON.stringify(persistenceBody).includes('DATABASE_SQL_SECRET'), false)

      paymentState.failPaymentInsert = false
      const successResponse = await fetch(`${baseUrl}/api/payments/request`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          Connection: 'close',
          'Idempotency-Key': 'mpesa-sensitive-log-3'
        },
        body: JSON.stringify({ invoice_id: 'invoice-test-id', phone_number: '0712345678' })
      })
      assert.equal(successResponse.status, 201)
      const successBody = await successResponse.json()
      assert.equal(successBody.checkoutRequestId, 'CHECKOUT-TEST')
      assert.equal(successBody.payment.status, 'pending')
    })
  } finally {
    console.error = originalConsoleError
    paymentState.providerError = Object.assign(new Error('provider failure phone=0712345678 amount=123.45'), {
      code: 'ECONNRESET',
      response: { data: { access_token: 'PROVIDER_TOKEN_SECRET', phone: '0712345678', amount: '123.45' } }
    })
    paymentState.failPaymentInsert = false
  }

  assert.equal(authLogs.length, 1)
  assert.equal(authLogs[0][0], 'Login failed')
  assert.equal(authLogs[0][1].error.code, 'XX999')
  const authSerialized = JSON.stringify(authLogs)
  for (const secret of ['ACCOUNT_SQL_SECRET', 'USER_SECRET', 'password_hash', 'person@example.test']) {
    assert.equal(authSerialized.includes(secret), false)
  }

  assert.equal(providerLogs.length, 1)
  assert.equal(providerLogs[0][0], 'M-Pesa request failed')
  assert.equal(providerLogs[0][1].error.code, 'ECONNRESET')
  const paymentSerialized = JSON.stringify(providerLogs)
  for (const secret of ['PROVIDER_TOKEN_SECRET', '0712345678', '123.45', 'provider failure']) {
    assert.equal(paymentSerialized.includes(secret), false)
  }

  assert.equal(persistenceLogs.length, 1)
  assert.equal(persistenceLogs[0][1].error.code, 'XX001')
  assert.equal(JSON.stringify(persistenceLogs).includes('DATABASE_SQL_SECRET'), false)
})

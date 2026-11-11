const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const Module = require('node:module')
const express = require('express')
const jwt = require('jsonwebtoken')

const JWT_TEST_SECRET = 'customer-receipt-route-tenant-test-secret'
const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_A = '11111111-1111-4111-8111-111111111111'
process.env.JWT_SECRET = JWT_TEST_SECRET

const calls = []
const permissions = []
const servicePath = require.resolve('../src/services/customerReceipts')
const authorizationPath = require.resolve('../src/middleware/accountingAuthorization')
const databasePath = require.resolve('../src/config/db')
const mpesaPath = require.resolve('../src/config/mpesa')
const loggingPath = require.resolve('../src/utils/errorLogging')
const originalModules = new Map([servicePath, authorizationPath, databasePath, mpesaPath, loggingPath]
  .map((path) => [path, require.cache[path]]))

const installMockModule = (modulePath, exports) => {
  const mock = new Module(modulePath)
  mock.filename = modulePath
  mock.loaded = true
  mock.exports = exports
  require.cache[modulePath] = mock
}

installMockModule(servicePath, {
  async createCustomerReceipt(pool, input) {
    calls.push({ type: 'create', pool, input })
    return { receipt: { id: 'receipt-new', status: 'pending' }, replayed: false }
  }
})
installMockModule(authorizationPath, {
  requireAccountingPermission(permission) {
    permissions.push(permission)
    return (_req, _res, next) => next()
  }
})
installMockModule(databasePath, { async query() { return { rows: [], rowCount: 0 } } })
installMockModule(mpesaPath, { async stkPush() { return { CheckoutRequestID: 'unused' } } })
installMockModule(loggingPath, { logSafeError() {} })
const paymentRouter = require('../src/routes/payments')

test('receipt creation passes only JWT tenant identity and requires receipt-management permission', async (t) => {
  calls.length = 0
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
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/payments/receipts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'receipt-route-test-001' },
    body: JSON.stringify({
      tenant_id: TENANT_B,
      customer_id: '22222222-2222-4222-8222-222222222222',
      amount: '100.00', currency: 'KES', payment_method: 'bank_transfer', payment_date: '2026-10-30'
    })
  })

  assert.equal(response.status, 201)
  assert.ok(permissions.includes('accounting:manage-receipts'))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].input.tenantId, TENANT_A)
  assert.equal(calls[0].input.userId, USER_A)
  assert.equal(Object.hasOwn(calls[0].input.body, 'tenant_id'), true)
  assert.equal(calls[0].input.body.tenant_id, TENANT_B)
})

test.after(() => {
  for (const [modulePath, original] of originalModules) {
    if (original) require.cache[modulePath] = original
    else delete require.cache[modulePath]
  }
})

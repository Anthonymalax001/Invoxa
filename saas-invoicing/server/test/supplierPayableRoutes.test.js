const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const Module = require('node:module')
const express = require('express')
const jwt = require('jsonwebtoken')

const JWT_TEST_SECRET = 'supplier-payables-route-test-secret'
const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_A = '11111111-1111-4111-8111-111111111111'
process.env.JWT_SECRET = JWT_TEST_SECRET

const calls = []
const permissions = []
const servicePath = require.resolve('../src/services/supplierPayables')
const authorizationPath = require.resolve('../src/middleware/accountingAuthorization')
const databasePath = require.resolve('../src/config/db')
const loggingPath = require.resolve('../src/utils/errorLogging')
const originalModules = new Map([servicePath, authorizationPath, databasePath, loggingPath]
  .map((path) => [path, require.cache[path]]))

const installMockModule = (modulePath, exports) => {
  const mock = new Module(modulePath)
  mock.filename = modulePath
  mock.loaded = true
  mock.exports = exports
  require.cache[modulePath] = mock
}

installMockModule(servicePath, {
  async createSupplierBill(pool, input) {
    calls.push({ pool, input })
    if (input.body.duplicate) {
      const error = new Error('duplicate')
      error.code = '23505'
      error.constraint = 'supplier_bills_supplier_invoice_ci_unique_idx'
      throw error
    }
    return { bill: { id: 'bill-created', status: 'draft' }, replayed: false }
  }
})
installMockModule(authorizationPath, {
  requireAccountingPermission(permission) {
    return (req, res, next) => {
      permissions.push(permission)
      if (permission === 'accounting:manage-payables' && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Accounting administrator access required' })
      }
      return next()
    }
  }
})
const mockPool = { async query() { return { rows: [], rowCount: 0 } } }
installMockModule(databasePath, mockPool)
installMockModule(loggingPath, { logSafeError() {} })
const router = require('../src/routes/supplierBills')

async function request(method, path, body, role = 'admin') {
  const app = express()
  app.use(express.json())
  app.use('/api/supplier-bills', router)
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const headers = {
      Authorization: `Bearer ${jwt.sign({ userId: USER_A, tenantId: TENANT_A, role }, JWT_TEST_SECRET)}`,
      'Idempotency-Key': 'supplier-bill-route-test-001',
      'Content-Type': 'application/json'
    }
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: response.status, body: await response.json() }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

test('supplier bill mutation uses JWT tenant/user identity and payables permission', async () => {
  calls.length = 0
  permissions.length = 0
  const response = await request('POST', '/api/supplier-bills', {
    tenant_id: TENANT_B, supplier_id: '22222222-2222-4222-8222-222222222222'
  })
  assert.equal(response.status, 201)
  assert.ok(permissions.includes('accounting:manage-payables'))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].input.tenantId, TENANT_A)
  assert.equal(calls[0].input.userId, USER_A)
  assert.equal(calls[0].input.body.tenant_id, TENANT_B)
})

test('supplier payable mutations are gated for non-admin roles', async () => {
  calls.length = 0
  const response = await request('POST', '/api/supplier-bills', {}, 'test-reader')
  assert.equal(response.status, 403)
  assert.equal(calls.length, 0)
})

test('duplicate supplier invoice database constraint returns a focused conflict', async () => {
  const response = await request('POST', '/api/supplier-bills', { duplicate: true })
  assert.equal(response.status, 409)
  assert.deepEqual(response.body, { error: 'This supplier invoice number is already recorded for this supplier' })
})

test.after(() => {
  for (const [modulePath, original] of originalModules) {
    if (original) require.cache[modulePath] = original
    else delete require.cache[modulePath]
  }
})

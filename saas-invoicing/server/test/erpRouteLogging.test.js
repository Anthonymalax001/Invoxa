const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const Module = require('node:module')
const express = require('express')
const jwt = require('jsonwebtoken')

const JWT_TEST_SECRET = 'invoxa-erp-route-logging-tests-only'
process.env.JWT_SECRET = JWT_TEST_SECRET

const fakePool = {
  async query() {
    throw Object.assign(new Error('SELECT SQL_SENTINEL CUSTOMER_PRIVATE TOKEN_PRIVATE'), {
      code: 'XX999'
    })
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

const routeCases = [
  ['/api/clients', require('../src/routes/clients'), 'Failed to fetch clients'],
  ['/api/invoices', require('../src/routes/invoices'), 'Failed to fetch invoices'],
  ['/api/expenses', require('../src/routes/expenses'), 'Failed to fetch expense categories', '/categories'],
  ['/api/products', require('../src/routes/products'), 'Failed to fetch products'],
  ['/api/suppliers', require('../src/routes/suppliers'), 'Failed to fetch suppliers'],
  ['/api/sales-orders', require('../src/routes/salesOrders'), 'Failed to fetch sales orders'],
  ['/api/purchase-orders', require('../src/routes/purchaseOrders'), 'Failed to fetch purchase orders']
]

test('ERP route database failures return existing generic bodies and log no internal details', async () => {
  const app = express()
  app.use(express.json())
  for (const [prefix, router] of routeCases) app.use(prefix, router)

  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const token = jwt.sign({
    userId: '20000000-0000-4000-8000-000000000001',
    tenantId: '10000000-0000-4000-8000-000000000001',
    role: 'admin'
  }, JWT_TEST_SECRET)
  const logs = []
  const originalConsoleError = console.error
  console.error = (...args) => logs.push(args)
  try {
    for (const [prefix, , expectedError, suffix = '/'] of routeCases) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${prefix}${suffix}`, {
        headers: { Authorization: `Bearer ${token}`, Connection: 'close' }
      })
      const body = await response.json()
      assert.equal(response.status, 500, `${prefix} preserves its existing status`)
      assert.deepEqual(body, { error: expectedError }, `${prefix} preserves its generic response`)
      assert.equal(JSON.stringify(body).includes('SQL_SENTINEL'), false)
    }
  } finally {
    console.error = originalConsoleError
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }

  assert.equal(logs.length, routeCases.length, 'each handled failure should be logged once')
  for (const log of logs) {
    assert.equal(typeof log[0], 'string')
    assert.equal(log[1].error.code, 'XX999')
  }
  const serializedLogs = JSON.stringify(logs)
  for (const secret of ['SQL_SENTINEL', 'CUSTOMER_PRIVATE', 'TOKEN_PRIVATE']) {
    assert.equal(serializedLogs.includes(secret), false)
  }
})

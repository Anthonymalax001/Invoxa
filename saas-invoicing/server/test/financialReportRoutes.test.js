const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const Module = require('node:module')
const express = require('express')
const jwt = require('jsonwebtoken')

const JWT_TEST_SECRET = 'financial-report-route-test-secret'
const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_A = '11111111-1111-4111-8111-111111111111'
const ACCOUNT_A = '22222222-2222-4222-8222-222222222222'
const previousJwtSecret = process.env.JWT_SECRET
process.env.JWT_SECRET = JWT_TEST_SECRET

const calls = []
const permissions = []
const databasePath = require.resolve('../src/config/db')
const authorizationPath = require.resolve('../src/middleware/accountingAuthorization')
const accountingServicePath = require.resolve('../src/services/accounting')
const reportServicePath = require.resolve('../src/services/financialReports')
const loggingPath = require.resolve('../src/utils/errorLogging')
const originalModules = new Map([databasePath, authorizationPath, accountingServicePath, reportServicePath, loggingPath]
  .map((modulePath) => [modulePath, require.cache[modulePath]]))

function installMockModule(modulePath, exports) {
  const mock = new Module(modulePath)
  mock.filename = modulePath
  mock.loaded = true
  mock.exports = exports
  require.cache[modulePath] = mock
}

installMockModule(databasePath, { async query() { return { rows: [], rowCount: 0 } } })
installMockModule(authorizationPath, {
  requireAccountingPermission(permission) {
    return (_req, _res, next) => {
      permissions.push(permission)
      return next()
    }
  }
})
installMockModule(accountingServicePath, {
  async postJournal() { throw new Error('Not used by report routes') },
  async reverseJournal() { throw new Error('Not used by report routes') },
  async withTransaction() { throw new Error('Not used by report routes') }
})
installMockModule(reportServicePath, {
  async getGeneralLedger(pool, tenantId, filters) {
    calls.push({ pool, tenantId, filters })
    if (filters.asOf) {
      const error = new Error('As-of dates are not supported for the general ledger; provide a start and end date or select an accounting period')
      error.statusCode = 400
      throw error
    }
    return { report: 'general_ledger', tenant_id: tenantId }
  },
  getBalanceSheet() {},
  getProfitAndLoss() {},
  getTrialBalance() {},
  cashFlowUnavailable() { return { report: 'cash_flow', available: false } }
})
installMockModule(loggingPath, { logSafeError() {} })

const router = require('../src/routes/accounting')

test('general-ledger API requires authentication and passes JWT tenant plus validated filters to the report service', async (t) => {
  const app = express()
  app.use('/api/accounting', router)
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))

  const base = `http://127.0.0.1:${server.address().port}/api/accounting/reports/general-ledger`
  const anonymous = await fetch(`${base}?account_id=${ACCOUNT_A}`)
  assert.equal(anonymous.status, 401)

  const token = jwt.sign({ userId: USER_A, tenantId: TENANT_A, role: 'reader' }, JWT_TEST_SECRET)
  const headers = { Authorization: `Bearer ${token}` }
  const rejected = await fetch(`${base}?account_id=${ACCOUNT_A}&as_of=2026-06-30&tenant_id=${TENANT_B}`, { headers })
  assert.equal(rejected.status, 400)
  assert.match((await rejected.json()).error, /As-of dates are not supported/)
  assert.equal(calls[0].tenantId, TENANT_A)
  assert.equal(calls[0].filters.asOf, '2026-06-30')

  const accepted = await fetch(`${base}?account_id=${ACCOUNT_A}&from=2026-01-01&to=2026-06-30&page=2&page_size=50&tenant_id=${TENANT_B}`, { headers })
  assert.equal(accepted.status, 200)
  assert.equal(calls[1].tenantId, TENANT_A)
  assert.deepEqual(calls[1].filters, {
    accountId: ACCOUNT_A,
    from: '2026-01-01',
    to: '2026-06-30',
    periodId: undefined,
    asOf: undefined,
    reference: undefined,
    page: '2',
    pageSize: '50'
  })
  assert.ok(permissions.length >= 2 && permissions.every((permission) => permission === 'accounting:read'))
})

test.after(() => {
  for (const [modulePath, original] of originalModules) {
    if (original) require.cache[modulePath] = original
    else delete require.cache[modulePath]
  }
  if (previousJwtSecret === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = previousJwtSecret
})

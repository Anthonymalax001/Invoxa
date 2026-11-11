const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const Module = require('node:module')
const express = require('express')
const jwt = require('jsonwebtoken')

const SECRET = 'bank-reconciliation-route-tests-only'
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const USER = '11111111-1111-4111-8111-111111111111'
const TX = '44444444-4444-4444-8444-444444444444'
const calls = []
const permissions = []
const dbPath = require.resolve('../src/config/db')
const authorizationPath = require.resolve('../src/middleware/accountingAuthorization')
const servicePath = require.resolve('../src/services/bankReconciliation')
const originals = new Map([dbPath, authorizationPath, servicePath].map((path) => [path, require.cache[path]]))

function installMock(path, exports) {
  const mock = new Module(path)
  mock.filename = path
  mock.loaded = true
  mock.exports = exports
  require.cache[path] = mock
}

installMock(dbPath, { async query() { return { rows: [], rowCount: 0 } } })
installMock(authorizationPath, {
  requireAccountingPermission(permission) {
    return (_req, _res, next) => { permissions.push(permission); next() }
  }
})
installMock(servicePath, {
  async listAccounts(tenantId) { calls.push({ action: 'accounts', tenantId }); return [{ account_id: 'bank-a' }] },
  async listAccountCandidates(tenantId) { calls.push({ action: 'candidates', tenantId }); return [] },
  async enableAccount(tenantId, userId, body) { calls.push({ action: 'enable', tenantId, userId, body }); return { account_id: body.account_id } },
  async previewImport(tenantId, body) {
    calls.push({ action: 'preview', tenantId, body })
    if (body.fail) throw Object.assign(new Error('CSV date is invalid'), { statusCode: 400 })
    return { valid: true, transactions: [], errors: [] }
  },
  async importStatement(tenantId, userId, body, idempotencyKey) {
    calls.push({ action: 'import', tenantId, userId, body, idempotencyKey })
    return { id: 'batch-a', replayed: false }
  },
  async listImports(tenantId, filters) { calls.push({ action: 'imports', tenantId, filters }); return { page: 2, imports: [] } },
  async getBatch(tenantId, id, filters) { calls.push({ action: 'batch', tenantId, id, filters }); return { batch: { id } } },
  async getSuggestions(tenantId, id, limit) { calls.push({ action: 'suggestions', tenantId, id, limit }); return [] },
  async matchTransaction(tenantId, userId, id, body) { calls.push({ action: 'match', tenantId, userId, id, body }); return { match: { status: 'matched' } } },
  async unmatchTransaction() { return { id: 'match-a' } },
  async reconcileBatch() { return { status: 'reconciled' } },
  async reopenBatch() { return { status: 'open' } },
  async postAdjustment() { return { replayed: false } }
})

process.env.JWT_SECRET = SECRET
const router = require('../src/routes/bankReconciliation')

test.after(() => {
  for (const [path, original] of originals) {
    if (original) require.cache[path] = original
    else delete require.cache[path]
  }
})

test('bank reconciliation API requires auth and scopes account and preview calls to the JWT tenant', async (t) => {
  const app = express()
  app.use(express.json())
  app.use('/api/accounting/bank-reconciliation', router)
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const base = `http://127.0.0.1:${server.address().port}/api/accounting/bank-reconciliation`
  assert.equal((await fetch(`${base}/accounts`)).status, 401)
  const headers = { Authorization: `Bearer ${jwt.sign({ userId: USER, tenantId: TENANT, role: 'admin' }, SECRET)}` }
  assert.equal((await fetch(`${base}/accounts`, { headers })).status, 200)
  const response = await fetch(`${base}/imports/preview`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', account_id: 'bank-a', csv_text: 'csv' })
  })
  assert.equal(response.status, 200)
  const previewCall = calls.find((call) => call.action === 'preview')
  assert.equal(previewCall.tenantId, TENANT)
  assert.equal(previewCall.body.tenant_id, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
  assert.equal(calls.find((call) => call.action === 'accounts').tenantId, TENANT)
})

test('API forwards pagination, idempotency and explicit match confirmation with administrator permissions', async (t) => {
  const app = express()
  app.use(express.json())
  app.use('/api/accounting/bank-reconciliation', router)
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const base = `http://127.0.0.1:${server.address().port}/api/accounting/bank-reconciliation`
  const headers = { Authorization: `Bearer ${jwt.sign({ userId: USER, tenantId: TENANT, role: 'admin' }, SECRET)}` }
  await fetch(`${base}/imports?page=2&page_size=10&account_id=22222222-2222-4222-8222-222222222222`, { headers })
  const importCall = calls.find((call) => call.action === 'imports')
  assert.equal(importCall.filters.page, '2')
  assert.equal(importCall.filters.pageSize, '10')

  const mutation = await fetch(`${base}/imports`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Idempotency-Key': 'bank-import-key-0001' },
    body: JSON.stringify({ account_id: 'bank-a', csv_text: 'statement', preview_token: 'digest' })
  })
  assert.equal(mutation.status, 201)
  const posted = calls.find((call) => call.action === 'import')
  assert.equal(posted.tenantId, TENANT)
  assert.equal(posted.userId, USER)
  assert.equal(posted.idempotencyKey, 'bank-import-key-0001')

  await fetch(`${base}/transactions/${TX}/match`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ journal_line_id: 'journal-line-a', confirm: true })
  })
  const matched = calls.find((call) => call.action === 'match')
  assert.equal(matched.tenantId, TENANT)
  assert.deepEqual(matched.body, { journal_line_id: 'journal-line-a', confirm: true })
  assert.ok(permissions.includes('accounting:manage-bank-reconciliation'))
})

test('API returns clear client validation errors from CSV preview', async (t) => {
  const app = express()
  app.use(express.json())
  app.use('/api/accounting/bank-reconciliation', router)
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const headers = {
    Authorization: `Bearer ${jwt.sign({ userId: USER, tenantId: TENANT, role: 'admin' }, SECRET)}`,
    'Content-Type': 'application/json'
  }
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/accounting/bank-reconciliation/imports/preview`, {
    method: 'POST', headers, body: JSON.stringify({ fail: true })
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error, 'CSV date is invalid')
})

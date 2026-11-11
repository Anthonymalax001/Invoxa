const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const Module = require('node:module')
const express = require('express')

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_A = '11111111-1111-4111-8111-111111111111'
const EMPLOYEE_A = '22222222-2222-4222-8222-222222222222'
const TYPE_A = '33333333-3333-4333-8333-333333333333'
const APPLICATION_A = '44444444-4444-4444-8444-444444444444'

const routePath = require.resolve('../src/routes/leave')
const authPath = require.resolve('../src/middleware/auth')
const authorizationPath = require.resolve('../src/middleware/accountingAuthorization')
const databasePath = require.resolve('../src/config/db')
const loggingPath = require.resolve('../src/utils/errorLogging')
const originalModules = new Map([routePath, authPath, authorizationPath, databasePath, loggingPath]
  .map((path) => [path, require.cache[path]]))
const state = { transaction: [], overlap: false, balance: true, decided: false }

const installMock = (path, exports) => {
  const mock = new Module(path)
  mock.filename = path
  mock.loaded = true
  mock.exports = exports
  require.cache[path] = mock
}

installMock(authPath, (req, res, next) => {
  req.user = { userId: USER_A, tenantId: TENANT_A, role: 'admin' }
  next()
})
installMock(authorizationPath, {
  requireAccountingPermission(permission) {
    return (req, res, next) => { req.permission = permission; next() }
  }
})
installMock(loggingPath, { logSafeError() {} })

const application = {
  id: APPLICATION_A, tenant_id: TENANT_A, employee_id: EMPLOYEE_A, leave_type_id: TYPE_A,
  start_date: '2026-11-03', end_date: '2026-11-05', working_days: 3,
  reason: 'Personal time', status: 'pending', approved_by: null, decision_at: null,
  rejection_reason: null, created_by: USER_A, updated_by: USER_A
}

const fakePool = {
  async query(sql, params = []) {
    if (sql.includes('FROM hr_leave_types')) return { rows: [], rowCount: 0 }
    if (sql.includes('FROM hr_leave_balances')) return { rows: [], rowCount: 0 }
    return { rows: [], rowCount: 0 }
  },
  async connect() {
    return {
      async query(sql, params = []) {
        state.transaction.push({ sql: sql.replace(/\s+/g, ' ').trim(), params })
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 }
        if (sql.includes('SELECT id FROM hr_employees')) return { rows: [{ id: EMPLOYEE_A }], rowCount: 1 }
        if (sql.includes('SELECT id FROM hr_leave_types')) return { rows: [{ id: TYPE_A }], rowCount: 1 }
        if (sql.includes('SELECT id FROM hr_leave_applications')) {
          return state.overlap ? { rows: [{ id: APPLICATION_A }], rowCount: 1 } : { rows: [], rowCount: 0 }
        }
        if (sql.includes('INSERT INTO hr_leave_applications')) {
          return { rows: [application], rowCount: 1 }
        }
        if (sql.includes('SELECT * FROM hr_leave_applications')) {
          return { rows: [{ ...application, status: state.decided ? 'approved' : 'pending' }], rowCount: 1 }
        }
        if (sql.includes('FROM hr_leave_balances')) {
          return state.balance ? { rows: [{ id: 'balance-1', entitled_days: '10.00', used_days: '0.00', allow_negative: false }], rowCount: 1 } : { rows: [], rowCount: 0 }
        }
        if (sql.includes('INSERT INTO hr_leave_audit') || sql.includes('UPDATE hr_leave_balances')) return { rows: [], rowCount: 1 }
        if (sql.includes('UPDATE hr_leave_applications')) {
          state.decided = true
          return { rows: [{ ...application, status: 'approved', approved_by: USER_A, decision_at: '2026-11-03T00:00:00.000Z' }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      },
      release() {}
    }
  }
}
installMock(databasePath, fakePool)
const router = require(routePath)

async function request(method, path, body) {
  const app = express()
  app.use(express.json())
  app.use('/api/leave', router)
  const server = http.createServer(app)
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: response.status, body: await response.json() }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

test('leave application calculates weekdays and uses authenticated tenant', async () => {
  state.transaction = []; state.overlap = false
  const response = await request('POST', '/api/leave', {
    tenant_id: TENANT_B, employee_id: EMPLOYEE_A, leave_type_id: TYPE_A,
    start_date: '2026-11-02', end_date: '2026-11-06', reason: 'Rest'
  })
  assert.equal(response.status, 201)
  const insert = state.transaction.find((query) => query.sql.includes('INSERT INTO hr_leave_applications'))
  assert.equal(insert.params[0], TENANT_A)
  assert.equal(insert.params[5], 5)
  assert.ok(state.transaction.some((query) => query.sql.includes('INSERT INTO hr_leave_audit')))
})

test('weekend-only leave, reversed dates and overlap are rejected', async () => {
  let response = await request('POST', '/api/leave', {
    employee_id: EMPLOYEE_A, leave_type_id: TYPE_A,
    start_date: '2026-11-07', end_date: '2026-11-08', reason: 'Weekend'
  })
  assert.equal(response.status, 400)
  response = await request('POST', '/api/leave', {
    employee_id: EMPLOYEE_A, leave_type_id: TYPE_A,
    start_date: '2026-11-06', end_date: '2026-11-02', reason: 'Reversed'
  })
  assert.equal(response.status, 400)
  state.overlap = true
  response = await request('POST', '/api/leave', {
    employee_id: EMPLOYEE_A, leave_type_id: TYPE_A,
    start_date: '2026-11-03', end_date: '2026-11-04', reason: 'Overlap'
  })
  state.overlap = false
  assert.equal(response.status, 409)
})

test('approval locks and updates the balance once', async () => {
  state.transaction = []; state.balance = true; state.decided = false
  const response = await request('PATCH', `/api/leave/${APPLICATION_A}/approve`, {})
  assert.equal(response.status, 200)
  assert.ok(state.transaction.some((query) => query.sql.includes('FOR UPDATE')))
  assert.ok(state.transaction.some((query) => query.sql.includes('UPDATE hr_leave_balances')))
  assert.ok(state.transaction.some((query) => query.sql.includes('INSERT INTO hr_leave_audit')))
})

test('approval requires a configured balance and remains tenant-scoped', async () => {
  state.balance = false; state.decided = false
  const response = await request('PATCH', `/api/leave/${APPLICATION_A}/approve`, {})
  state.balance = true
  assert.equal(response.status, 409)
  const locked = state.transaction.find((query) => query.sql.includes('SELECT * FROM hr_leave_applications'))
  assert.equal(locked.params[0], TENANT_A)
})

test.after(() => {
  for (const [path, original] of originalModules) {
    if (original) require.cache[path] = original
    else delete require.cache[path]
  }
})

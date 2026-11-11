const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const Module = require('node:module')
const express = require('express')

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_A = '11111111-1111-4111-8111-111111111111'
const EMPLOYEE_A = '22222222-2222-4222-8222-222222222222'
const ATTENDANCE_A = '33333333-3333-4333-8333-333333333333'

const routePath = require.resolve('../src/routes/attendance')
const authPath = require.resolve('../src/middleware/auth')
const authorizationPath = require.resolve('../src/middleware/accountingAuthorization')
const databasePath = require.resolve('../src/config/db')
const loggingPath = require.resolve('../src/utils/errorLogging')
const originalModules = new Map([routePath, authPath, authorizationPath, databasePath, loggingPath]
  .map((path) => [path, require.cache[path]]))
const state = { queries: [], transaction: [], duplicate: false }

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

const makeRow = (overrides = {}) => ({
  id: ATTENDANCE_A, tenant_id: TENANT_A, employee_id: EMPLOYEE_A,
  attendance_date: '2026-11-03', clock_in: '08:00:00', clock_out: '17:00:00',
  attendance_status: 'present', working_minutes: 540, overtime_minutes: 60, notes: null,
  created_by: USER_A, updated_by: USER_A, ...overrides
})

const fakePool = {
  async query(sql, params = []) {
    state.queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params })
    if (sql.includes('FROM hr_attendance_audit')) return { rows: [], rowCount: 0 }
    if (sql.includes('GROUP BY e.id')) return { rows: [{ employee_id: EMPLOYEE_A, recorded_days: 1, working_minutes: 540, overtime_minutes: 60 }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  },
  async connect() {
    return {
      async query(sql, params = []) {
        state.transaction.push({ sql: sql.replace(/\s+/g, ' ').trim(), params })
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 }
        if (sql.includes('SELECT id FROM hr_employees')) return { rows: [{ id: EMPLOYEE_A }], rowCount: 1 }
        if (sql.includes('INSERT INTO hr_attendance')) {
          if (state.duplicate) {
            const error = new Error('duplicate attendance')
            error.code = '23505'
            throw error
          }
          return { rows: [makeRow()], rowCount: 1 }
        }
        if (sql.includes('INSERT INTO hr_attendance_audit')) return { rows: [], rowCount: 1 }
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
  app.use('/api/attendance', router)
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

test('attendance creation calculates through the database and keeps the JWT tenant', async () => {
  state.duplicate = false; state.transaction = []
  const response = await request('POST', '/api/attendance', {
    tenant_id: TENANT_B, employee_id: EMPLOYEE_A, attendance_date: '2026-11-03',
    clock_in: '08:00', clock_out: '17:00', attendance_status: 'present'
  })
  assert.equal(response.status, 201)
  assert.equal(response.body.working_minutes, 540)
  const insert = state.transaction.find((query) => query.sql.includes('INSERT INTO hr_attendance'))
  assert.equal(insert.params[0], TENANT_A)
  assert.ok(state.transaction.some((query) => query.sql.includes('INSERT INTO hr_attendance_audit')))
})

test('invalid clock order and statuses are rejected before database access', async () => {
  state.transaction = []
  const response = await request('POST', '/api/attendance', {
    employee_id: EMPLOYEE_A, attendance_date: '2026-11-03',
    clock_in: '17:00', clock_out: '08:00', attendance_status: 'present'
  })
  assert.equal(response.status, 400)
  assert.equal(state.transaction.length, 0)
})

test('duplicate daily attendance returns a conflict', async () => {
  state.duplicate = true
  const response = await request('POST', '/api/attendance', {
    employee_id: EMPLOYEE_A, attendance_date: '2026-11-03',
    attendance_status: 'absent'
  })
  state.duplicate = false
  assert.equal(response.status, 409)
})

test('monthly summary uses tenant-scoped employee attendance', async () => {
  state.queries = []
  const response = await request('GET', '/api/attendance/summary?month=2026-11')
  assert.equal(response.status, 200)
  assert.equal(response.body.employees[0].working_minutes, 540)
  const summaryQuery = state.queries.find((query) => query.sql.includes('GROUP BY e.id'))
  assert.equal(summaryQuery.params[0], TENANT_A)
})

test.after(() => {
  for (const [path, original] of originalModules) {
    if (original) require.cache[path] = original
    else delete require.cache[path]
  }
})

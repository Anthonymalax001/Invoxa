const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const Module = require('node:module')
const express = require('express')

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_A = '11111111-1111-4111-8111-111111111111'
const EMPLOYEE_A = '22222222-2222-4222-8222-222222222222'

const routePath = require.resolve('../src/routes/employees')
const authPath = require.resolve('../src/middleware/auth')
const authorizationPath = require.resolve('../src/middleware/accountingAuthorization')
const databasePath = require.resolve('../src/config/db')
const loggingPath = require.resolve('../src/utils/errorLogging')
const originalModules = new Map([routePath, authPath, authorizationPath, databasePath, loggingPath]
  .map((path) => [path, require.cache[path]]))
const queries = []

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
    return (req, res, next) => {
      req.permission = permission
      next()
    }
  }
})
installMock(loggingPath, { logSafeError() {} })
installMock(databasePath, {
  async query(sql, params) {
    queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params })
    if (sql.includes('INSERT INTO hr_employees')) {
      return {
        rowCount: 1,
        rows: [{ id: EMPLOYEE_A, tenant_id: params[0], employee_number: 'EMP-000001', first_name: params[1] }]
      }
    }
    if (sql.includes('FROM hr_employees e')) return { rowCount: 0, rows: [] }
    return { rowCount: 0, rows: [] }
  }
})
const router = require(routePath)

async function request(method, path, body) {
  const app = express()
  app.use(express.json())
  app.use('/api/employees', router)
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve).once('error', reject)
  })
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

test('employee creation uses the authenticated tenant and validates required fields', async () => {
  queries.length = 0
  const response = await request('POST', '/api/employees', {
    tenant_id: TENANT_B,
    first_name: 'Ada',
    last_name: 'Lovelace',
    employment_type: 'permanent',
    employment_start_date: '2026-11-01'
  })
  assert.equal(response.status, 201)
  assert.equal(response.body.employee_number, 'EMP-000001')
  assert.equal(queries[0].params[0], TENANT_A)
  assert.equal(queries[0].params[1], 'Ada')
})

test('invalid employment details are rejected before database access', async () => {
  queries.length = 0
  const response = await request('POST', '/api/employees', {
    first_name: 'Ada', last_name: 'Lovelace', employment_type: 'salary',
    employment_start_date: 'not-a-date'
  })
  assert.equal(response.status, 400)
  assert.equal(queries.length, 0)
})

test('employee reads are tenant-scoped and return not found for another tenant record', async () => {
  queries.length = 0
  const response = await request('GET', `/api/employees/${EMPLOYEE_A}`)
  assert.equal(response.status, 404)
  assert.equal(queries[0].params[0], TENANT_A)
  assert.equal(queries[0].params[1], EMPLOYEE_A)
})

test.after(() => {
  for (const [path, original] of originalModules) {
    if (original) require.cache[path] = original
    else delete require.cache[path]
  }
})

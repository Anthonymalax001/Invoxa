const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const Module = require('node:module')
const express = require('express')
const jwt = require('jsonwebtoken')

const JWT_TEST_SECRET = 'invoxa-supplier-phone-tests-only'
process.env.JWT_SECRET = JWT_TEST_SECRET

const IDS = {
  tenantA: 'a1000000-0000-4000-8000-000000000001',
  tenantB: 'a1000000-0000-4000-8000-000000000002',
  userA: 'a2000000-0000-4000-8000-000000000001',
  supplierA: 'a3000000-0000-4000-8000-000000000001',
  supplierB: 'a3000000-0000-4000-8000-000000000002'
}

const state = {
  nextId: 1,
  suppliers: new Map(),
  writes: [],
  reset() {
    this.nextId = 1
    this.writes = []
    this.suppliers = new Map([
      [IDS.supplierA, {
        id: IDS.supplierA, tenant_id: IDS.tenantA, business_name: 'Tenant A Supplier',
        contact_person: null, email: null, phone: null, address: null, notes: null, is_active: true
      }],
      [IDS.supplierB, {
        id: IDS.supplierB, tenant_id: IDS.tenantB, business_name: 'Tenant B Supplier',
        contact_person: null, email: null, phone: null, address: null, notes: null, is_active: true
      }]
    ])
  }
}
state.reset()

const rowsResult = (rows) => ({ rows, rowCount: rows.length })
const fakePool = {
  async query(sql, params = []) {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    state.writes.push({ sql: normalized, params })

    if (normalized.startsWith('INSERT INTO suppliers')) {
      const id = `a3000000-0000-4000-8000-${String(state.nextId++).padStart(12, '0')}`
      const row = {
        id, tenant_id: params[0], business_name: params[1], contact_person: params[2],
        email: params[3], phone: params[4], address: params[5], notes: params[6], is_active: true
      }
      state.suppliers.set(id, row)
      return rowsResult([row])
    }

    if (normalized.startsWith('UPDATE suppliers SET business_name')) {
      const [businessName, contactPerson, email, phone, address, notes, id, tenantId] = params
      const row = state.suppliers.get(id)
      if (!row || row.tenant_id !== tenantId) return rowsResult([])
      Object.assign(row, {
        business_name: businessName, contact_person: contactPerson, email, phone, address, notes
      })
      return rowsResult([row])
    }

    throw new Error(`Unexpected database query in supplier phone test: ${normalized}`)
  }
}

const dbPath = require.resolve('../src/config/db')
const dbModule = new Module(dbPath)
dbModule.filename = dbPath
dbModule.loaded = true
dbModule.exports = fakePool
require.cache[dbPath] = dbModule

const suppliersRouter = require('../src/routes/suppliers')
const token = jwt.sign({ userId: IDS.userA, tenantId: IDS.tenantA }, JWT_TEST_SECRET)

async function withServer(run) {
  const app = express()
  app.use(express.json())
  app.use('/api/suppliers', suppliersRouter)
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    await run(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

async function request(baseUrl, path, { method = 'POST', body } = {}) {
  const headers = { Authorization: `Bearer ${token}` }
  const options = { method, headers }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    options.body = JSON.stringify(body)
  }
  const response = await fetch(new URL(path, baseUrl), options)
  const text = await response.text()
  return { status: response.status, data: text ? JSON.parse(text) : null }
}

test.beforeEach(() => state.reset())

test('accepts a trimmed ten-digit string and preserves its leading zero on create', async () => {
  await withServer(async (baseUrl) => {
    const response = await request(baseUrl, '/api/suppliers', {
      body: { business_name: 'New Supplier', phone: ' 0123456789 ', tenant_id: IDS.tenantB }
    })
    assert.equal(response.status, 201)
    assert.equal(response.data.phone, '0123456789')
    assert.equal(response.data.tenant_id, IDS.tenantA)
    assert.equal(state.writes[0].params[0], IDS.tenantA)
    assert.equal(state.writes[0].params[4], '0123456789')
  })
})

test('keeps missing and blank phone values optional and nullable', async () => {
  await withServer(async (baseUrl) => {
    const missing = await request(baseUrl, '/api/suppliers', { body: { business_name: 'No Phone' } })
    const blank = await request(baseUrl, '/api/suppliers', { body: { business_name: 'Blank Phone', phone: '  ' } })
    assert.equal(missing.status, 201)
    assert.equal(missing.data.phone, null)
    assert.equal(blank.status, 201)
    assert.equal(blank.data.phone, null)
  })
})

test('rejects malformed phone values on both create and update before database writes', async () => {
  await withServer(async (baseUrl) => {
    const invalidPhones = ['123456789', '01234567890', '0712ABC890', '0712-345678', 7123456789]
    for (const phone of invalidPhones) {
      const create = await request(baseUrl, '/api/suppliers', {
        body: { business_name: 'Invalid Create', phone }
      })
      assert.equal(create.status, 400)
      assert.match(create.data.error, /exactly 10 digits|must be text/)

      const update = await request(baseUrl, `/api/suppliers/${IDS.supplierA}`, {
        method: 'PUT', body: { business_name: 'Invalid Update', phone }
      })
      assert.equal(update.status, 400)
      assert.match(update.data.error, /exactly 10 digits|must be text/)
    }
    assert.equal(state.writes.length, 0)
    assert.equal(state.suppliers.get(IDS.supplierA).business_name, 'Tenant A Supplier')
  })
})

test('updates only a supplier owned by the JWT tenant and ignores body tenant IDs', async () => {
  await withServer(async (baseUrl) => {
    const foreignBefore = structuredClone(state.suppliers.get(IDS.supplierB))
    const foreign = await request(baseUrl, `/api/suppliers/${IDS.supplierB}`, {
      method: 'PUT', body: { business_name: 'Attempted Change', phone: '0123456789' }
    })
    assert.equal(foreign.status, 404)
    assert.deepEqual(state.suppliers.get(IDS.supplierB), foreignBefore)

    const own = await request(baseUrl, `/api/suppliers/${IDS.supplierA}`, {
      method: 'PUT', body: {
        business_name: 'Updated Supplier', phone: '0012345678', tenant_id: IDS.tenantB
      }
    })
    assert.equal(own.status, 200)
    assert.equal(own.data.tenant_id, IDS.tenantA)
    assert.equal(own.data.phone, '0012345678')
    assert.equal(state.writes.at(-1).params[7], IDS.tenantA)
  })
})

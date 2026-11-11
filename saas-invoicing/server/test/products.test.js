const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const Module = require('node:module')
const express = require('express')
const jwt = require('jsonwebtoken')

const JWT_TEST_SECRET = 'invoxa-products-route-tests-only'
process.env.JWT_SECRET = JWT_TEST_SECRET

const IDS = {
  tenantA: '50000000-0000-4000-8000-000000000001',
  tenantB: '50000000-0000-4000-8000-000000000002',
  userA: '60000000-0000-4000-8000-000000000001',
  productA: '70000000-0000-4000-8000-000000000001',
  productB: '70000000-0000-4000-8000-000000000002',
  newProduct: '70000000-0000-4000-8000-000000000003',
  movementA: '80000000-0000-4000-8000-000000000001'
}

const makeProduct = (id, tenantId, sku, stock = '10.000') => ({
  id,
  tenant_id: tenantId,
  name: `Product ${sku}`,
  sku,
  description: null,
  unit_of_measure: 'each',
  cost_price: '12.50',
  selling_price: '20.00',
  current_stock: stock,
  low_stock_threshold: '2.000',
  is_active: true,
  created_at: '2026-10-18T00:00:00.000Z',
  updated_at: '2026-10-18T00:00:00.000Z'
})

const state = {
  reset() {
    this.queries = []
    this.transactionQueries = []
    this.products = new Map([
      [IDS.productA, makeProduct(IDS.productA, IDS.tenantA, 'STOCK-A')],
      [IDS.productB, makeProduct(IDS.productB, IDS.tenantB, 'STOCK-B', '99.000')]
    ])
    this.movements = [
      {
        id: IDS.movementA,
        tenant_id: IDS.tenantA,
        product_id: IDS.productA,
        movement_type: 'receipt',
        quantity_delta: '10.000',
        quantity_before: '0.000',
        quantity_after: '10.000',
        reference: 'OPENING',
        notes: null,
        created_by: IDS.userA,
        created_at: '2026-10-18T00:00:00.000Z'
      }
    ]
    this.commitCount = 0
    this.rollbackCount = 0
    this.releases = []
    this.failMovementInsert = false
    this.failDuplicateSku = false
  }
}
state.reset()

const normalizeSql = (sql) => sql.replace(/\s+/g, ' ').trim()
const fakePool = {
  async query(sql, params = []) {
    const normalizedSql = normalizeSql(sql)
    state.queries.push({ sql: normalizedSql, params })

    if (normalizedSql.startsWith('SELECT * FROM products') && normalizedSql.includes('ORDER BY lower(name)')) {
      const [tenantId, search, active] = params
      const rows = [...state.products.values()].filter((product) => {
        const owned = product.tenant_id === tenantId
        const matchesSearch = !search || `${product.name} ${product.sku} ${product.description || ''}`
          .toLowerCase().includes(String(search).toLowerCase())
        const matchesActive = active == null || product.is_active === active
        return owned && matchesSearch && matchesActive
      })
      return { rows, rowCount: rows.length }
    }

    if (normalizedSql.startsWith('INSERT INTO products')) {
      if (state.failDuplicateSku) {
        const err = new Error('simulated unique violation')
        err.code = '23505'
        throw err
      }
      const product = {
        ...makeProduct(IDS.newProduct, params[0], params[2], '0.000'),
        name: params[1],
        description: params[3],
        unit_of_measure: params[4],
        cost_price: params[5],
        selling_price: params[6],
        low_stock_threshold: params[7]
      }
      state.products.set(product.id, product)
      return { rows: [product], rowCount: 1 }
    }

    if (normalizedSql.startsWith('SELECT id FROM products')) {
      const product = state.products.get(params[0])
      const rows = product?.tenant_id === params[1] ? [{ id: product.id }] : []
      return { rows, rowCount: rows.length }
    }

    if (normalizedSql.startsWith('SELECT sm.* FROM stock_movements')) {
      const rows = state.movements.filter((movement) =>
        movement.product_id === params[0] && movement.tenant_id === params[1]
      ).slice(0, params[2])
      return { rows, rowCount: rows.length }
    }

    if (normalizedSql.startsWith('UPDATE products SET is_active')) {
      const product = state.products.get(params[1])
      if (!product || product.tenant_id !== params[2]) return { rows: [], rowCount: 0 }
      const updated = { ...product, is_active: params[0] }
      state.products.set(updated.id, updated)
      return { rows: [updated], rowCount: 1 }
    }

    if (normalizedSql.startsWith('SELECT * FROM products WHERE id = $1')) {
      const product = state.products.get(params[0])
      const rows = product?.tenant_id === params[1] ? [product] : []
      return { rows, rowCount: rows.length }
    }

    if (normalizedSql.startsWith('UPDATE products SET name = $1')) {
      const product = state.products.get(params[7])
      if (!product || product.tenant_id !== params[8]) return { rows: [], rowCount: 0 }
      const updated = {
        ...product,
        name: params[0],
        sku: params[1],
        description: params[2],
        unit_of_measure: params[3],
        cost_price: params[4],
        selling_price: params[5],
        low_stock_threshold: params[6]
      }
      state.products.set(updated.id, updated)
      return { rows: [updated], rowCount: 1 }
    }

    throw new Error(`Unexpected pool query in test: ${normalizedSql}`)
  },

  async connect() {
    let pendingProduct = null
    let pendingMovement = null
    return {
      async query(sql, params = []) {
        const normalizedSql = normalizeSql(sql)
        state.transactionQueries.push({ sql: normalizedSql, params })

        if (normalizedSql === 'BEGIN') return { rows: [], rowCount: 0 }
        if (normalizedSql === 'COMMIT') {
          if (pendingProduct) state.products.set(pendingProduct.id, pendingProduct)
          if (pendingMovement) state.movements.unshift(pendingMovement)
          state.commitCount += 1
          return { rows: [], rowCount: 0 }
        }
        if (normalizedSql === 'ROLLBACK') {
          pendingProduct = null
          pendingMovement = null
          state.rollbackCount += 1
          return { rows: [], rowCount: 0 }
        }
        if (normalizedSql.startsWith('SELECT id, current_stock FROM products')) {
          const product = state.products.get(params[0])
          const rows = product?.tenant_id === params[1]
            ? [{ id: product.id, current_stock: product.current_stock }]
            : []
          return { rows, rowCount: rows.length }
        }
        if (normalizedSql.startsWith('UPDATE products SET current_stock')) {
          const product = state.products.get(params[1])
          if (!product || product.tenant_id !== params[2]) return { rows: [], rowCount: 0 }
          pendingProduct = { ...product, current_stock: params[0] }
          return { rows: [pendingProduct], rowCount: 1 }
        }
        if (normalizedSql.startsWith('INSERT INTO stock_movements')) {
          if (state.failMovementInsert) throw new Error('simulated movement insert failure')
          pendingMovement = {
            id: IDS.movementA.replace(/1$/, '2'),
            tenant_id: params[0],
            product_id: params[1],
            movement_type: params[2],
            quantity_delta: params[3],
            quantity_before: params[4],
            quantity_after: params[5],
            reference: params[6],
            notes: params[7],
            created_by: params[8],
            created_at: '2026-10-18T01:00:00.000Z'
          }
          return { rows: [pendingMovement], rowCount: 1 }
        }

        throw new Error(`Unexpected transaction query in test: ${normalizedSql}`)
      },
      release(error) {
        state.releases.push(error || null)
      }
    }
  }
}

function installMockModule(modulePath, exports) {
  const mock = new Module(modulePath)
  mock.filename = modulePath
  mock.loaded = true
  mock.exports = exports
  require.cache[modulePath] = mock
}

installMockModule(require.resolve('../src/config/db'), fakePool)
installMockModule(require.resolve('../src/services/inventoryAccounting'), {
  valueReceipt: async () => ({ journal: { id: 'inventory-test-journal' } }),
  valueAdjustment: async () => ({ journal: { id: 'inventory-test-journal' } }),
  valueReturn: async () => ({ journal: { id: 'inventory-test-journal' } })
})
const productsRouter = require('../src/routes/products')

const token = jwt.sign({ userId: IDS.userA, tenantId: IDS.tenantA }, JWT_TEST_SECRET)

async function withServer(run) {
  const app = express()
  app.use(express.json())
  app.use('/api/products', productsRouter)
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
}

async function request(baseUrl, pathName, { method = 'GET', body } = {}) {
  const headers = { Authorization: `Bearer ${token}` }
  const options = { method, headers }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    options.body = JSON.stringify(body)
  }
  const response = await fetch(new URL(pathName, baseUrl), options)
  return { status: response.status, data: await response.json() }
}

const validProduct = {
  tenant_id: IDS.tenantB,
  name: 'Coffee beans',
  sku: 'coffee-01',
  description: 'One kilogram bag',
  unit_of_measure: 'kg',
  cost_price: '850.50',
  selling_price: '1200.00',
  low_stock_threshold: '4.500'
}

test.beforeEach(() => state.reset())

test('product list and detail stay within the JWT tenant', async () => {
  await withServer(async (baseUrl) => {
    const list = await request(baseUrl, `/api/products?tenant_id=${IDS.tenantB}`)
    assert.equal(list.status, 200)
    assert.deepEqual(list.data.map((product) => product.id), [IDS.productA])
    assert.deepEqual(state.queries[0].params, [IDS.tenantA, '', null])
    assert.match(state.queries[0].sql, /tenant_id = \$1/)

    const foreignDetail = await request(baseUrl, `/api/products/${IDS.productB}`)
    assert.equal(foreignDetail.status, 404)
    assert.deepEqual(state.queries[1].params, [IDS.productB, IDS.tenantA])
  })
})

test('creation ignores a body tenant and normalizes SKU while validating prices', async () => {
  await withServer(async (baseUrl) => {
    const created = await request(baseUrl, '/api/products', { method: 'POST', body: validProduct })
    assert.equal(created.status, 201)
    assert.equal(created.data.tenant_id, IDS.tenantA)
    assert.equal(created.data.sku, 'COFFEE-01')
    assert.deepEqual(state.queries[0].params.slice(0, 2), [IDS.tenantA, 'Coffee beans'])

    const invalid = await request(baseUrl, '/api/products', {
      method: 'POST',
      body: { ...validProduct, cost_price: '-1.00' }
    })
    assert.equal(invalid.status, 400)
    assert.equal(state.queries.length, 1)
  })
})

test('tenant-scoped SKU uniqueness violations return 409', async (t) => {
  t.mock.method(console, 'error', () => {})
  state.failDuplicateSku = true
  await withServer(async (baseUrl) => {
    const duplicate = await request(baseUrl, '/api/products', { method: 'POST', body: validProduct })
    assert.equal(duplicate.status, 409)
    assert.deepEqual(duplicate.data, { error: 'A product with this SKU already exists' })
    assert.deepEqual(state.queries[0].params.slice(0, 2), [IDS.tenantA, 'Coffee beans'])
  })

  const migration = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '20261018_001_products_and_stock_movements.sql'),
    'utf8'
  )
  assert.match(migration, /CREATE UNIQUE INDEX products_tenant_sku_ci_unique_idx\s+ON public\.products \(tenant_id, lower\(btrim\(sku\)\)\)/i)
})

test('deactivation is scoped to the JWT tenant', async () => {
  await withServer(async (baseUrl) => {
    const foreign = await request(baseUrl, `/api/products/${IDS.productB}/status`, {
      method: 'PATCH',
      body: { is_active: false, tenant_id: IDS.tenantB }
    })
    assert.equal(foreign.status, 404)
    assert.equal(state.products.get(IDS.productB).is_active, true)
    assert.deepEqual(state.queries[0].params, [false, IDS.productB, IDS.tenantA])
  })
})

test('receiving stock locks the tenant-owned product and records an attributed movement', async () => {
  await withServer(async (baseUrl) => {
    const result = await request(baseUrl, `/api/products/${IDS.productA}/receive`, {
      method: 'POST',
      body: {
        tenant_id: IDS.tenantB,
        quantity: '2.125',
        reference: 'GRN-14',
        notes: 'Received from supplier'
      }
    })

    assert.equal(result.status, 201)
    assert.equal(result.data.product.current_stock, '12.125')
    assert.equal(result.data.movement.quantity_delta, '2.125')
    assert.equal(result.data.movement.created_by, IDS.userA)
    assert.equal(state.commitCount, 1)
    assert.equal(state.rollbackCount, 0)
    const lock = state.transactionQueries.find((query) => query.sql.startsWith('SELECT id, current_stock'))
    assert.match(lock.sql, /tenant_id = \$2[\s\S]*FOR UPDATE/)
    assert.deepEqual(lock.params, [IDS.productA, IDS.tenantA])
    const insert = state.transactionQueries.find((query) => query.sql.startsWith('INSERT INTO stock_movements'))
    assert.equal(insert.params[0], IDS.tenantA)
    assert.equal(insert.params[8], IDS.userA)
  })
})

test('an authenticated tenant cannot receive stock for another tenant product', async () => {
  await withServer(async (baseUrl) => {
    const result = await request(baseUrl, `/api/products/${IDS.productB}/receive`, {
      method: 'POST',
      body: { quantity: '3', tenant_id: IDS.tenantB }
    })

    assert.equal(result.status, 404)
    assert.deepEqual(result.data, { error: 'Product not found' })
    assert.equal(state.products.get(IDS.productB).current_stock, '99.000')
    assert.equal(state.commitCount, 0)
    assert.equal(state.rollbackCount, 1)
    assert.equal(state.transactionQueries.some((query) => query.sql.startsWith('UPDATE products SET current_stock')), false)
  })
})

test('valid negative adjustments create an adjustment movement and preserve the balance', async () => {
  await withServer(async (baseUrl) => {
    const result = await request(baseUrl, `/api/products/${IDS.productA}/adjust`, {
      method: 'POST',
      body: { quantity_delta: '-2.500', notes: 'Cycle count correction' }
    })

    assert.equal(result.status, 201)
    assert.equal(result.data.product.current_stock, '7.500')
    assert.equal(result.data.movement.movement_type, 'adjustment')
    assert.equal(result.data.movement.quantity_delta, '-2.500')
    assert.equal(result.data.movement.quantity_after, '7.500')
    assert.equal(state.commitCount, 1)
    assert.equal(state.rollbackCount, 0)
  })
})

test('stock history and adjustment endpoints are tenant-scoped', async () => {
  await withServer(async (baseUrl) => {
    const history = await request(baseUrl, `/api/products/${IDS.productA}/movements?limit=10`)
    assert.equal(history.status, 200)
    assert.equal(history.data.length, 1)
    const historyQuery = state.queries.find((query) => query.sql.startsWith('SELECT sm.* FROM stock_movements'))
    assert.match(historyQuery.sql, /p\.tenant_id = \$2/)
    assert.deepEqual(historyQuery.params, [IDS.productA, IDS.tenantA, 10])

    const foreignHistory = await request(baseUrl, `/api/products/${IDS.productB}/movements`)
    assert.equal(foreignHistory.status, 404)
    assert.deepEqual(state.queries.at(-1).params, [IDS.productB, IDS.tenantA])
  })
})

test('rejects adjustments that would make stock negative before updating product', async () => {
  await withServer(async (baseUrl) => {
    const result = await request(baseUrl, `/api/products/${IDS.productA}/adjust`, {
      method: 'POST',
      body: { quantity_delta: '-10.001', notes: 'Count correction' }
    })
    assert.equal(result.status, 400)
    assert.deepEqual(result.data, { error: 'The adjustment would result in invalid stock quantity' })
    assert.equal(state.transactionQueries.some((query) => query.sql.startsWith('UPDATE products SET current_stock')), false)
    assert.equal(state.rollbackCount, 1)
    assert.equal(state.commitCount, 0)
  })
})

test('movement insert failure rolls back the stock update', async (t) => {
  t.mock.method(console, 'error', () => {})
  state.failMovementInsert = true
  await withServer(async (baseUrl) => {
    const result = await request(baseUrl, `/api/products/${IDS.productA}/receive`, {
      method: 'POST',
      body: { quantity: '5', reference: 'GRN-15' }
    })
    assert.equal(result.status, 500)
    assert.deepEqual(result.data, { error: 'Failed to update stock' })
    assert.equal(state.products.get(IDS.productA).current_stock, '10.000')
    assert.equal(state.movements.length, 1)
    assert.equal(state.rollbackCount, 1)
    assert.equal(state.commitCount, 0)
    assert.equal(state.releases.length, 1)
  })
})

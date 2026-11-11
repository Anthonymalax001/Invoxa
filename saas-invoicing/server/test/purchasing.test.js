const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const Module = require('node:module')
const express = require('express')
const jwt = require('jsonwebtoken')

const JWT_TEST_SECRET = 'invoxa-purchasing-route-tests-only'
process.env.JWT_SECRET = JWT_TEST_SECRET

const IDS = {
  tenantA: '91000000-0000-4000-8000-000000000001',
  tenantB: '91000000-0000-4000-8000-000000000002',
  userA: '92000000-0000-4000-8000-000000000001',
  supplierA: '93000000-0000-4000-8000-000000000001',
  supplierB: '93000000-0000-4000-8000-000000000002',
  productA: '94000000-0000-4000-8000-000000000001',
  productB: '94000000-0000-4000-8000-000000000002',
  orderA: '95000000-0000-4000-8000-000000000001',
  orderItemA: '96000000-0000-4000-8000-000000000001'
}

const supplier = (id, tenantId, businessName) => ({
  id, tenant_id: tenantId, business_name: businessName, contact_person: null,
  email: null, phone: null, address: null, notes: null, is_active: true
})

const product = (id, tenantId, stock = '10.000') => ({
  id, tenant_id: tenantId, name: `Product ${id.slice(-1)}`, sku: `SKU-${id.slice(-1)}`,
  current_stock: stock, is_active: true, cost_price: '80.00'
})

const state = {
  reset() {
    this.suppliers = new Map([
      [IDS.supplierA, supplier(IDS.supplierA, IDS.tenantA, 'Tenant A Supplies')],
      [IDS.supplierB, supplier(IDS.supplierB, IDS.tenantB, 'Tenant B Supplies')]
    ])
    this.products = new Map([
      [IDS.productA, product(IDS.productA, IDS.tenantA)],
      [IDS.productB, product(IDS.productB, IDS.tenantB, '99.000')]
    ])
    this.orders = new Map([[
      IDS.orderA,
      {
        id: IDS.orderA, tenant_id: IDS.tenantA, supplier_id: IDS.supplierA,
        purchase_order_number: 'PO-0007', order_date: '2026-10-18',
        expected_delivery_date: null, status: 'ordered', subtotal: '500.00',
        tax_rate: '0.00', tax_amount: '0.00', total: '500.00', notes: null,
        created_by: IDS.userA, created_at: '2026-10-18T00:00:00.000Z'
      }
    ]])
    this.items = new Map([[
      IDS.orderItemA,
      {
        id: IDS.orderItemA, tenant_id: IDS.tenantA, purchase_order_id: IDS.orderA,
        product_id: IDS.productA, product_name: 'Product 1', product_sku: 'SKU-1',
        quantity_ordered: '5.000', quantity_received: '0.000', unit_cost: '100.00',
        line_subtotal: '500.00'
      }
    ]])
    this.receipts = new Map()
    this.receiptItems = new Map()
    this.movements = []
    this.next = 1
    this.commitCount = 0
    this.rollbackCount = 0
    this.releases = []
    this.failMovement = false
    this.queries = []
    this.transactionQueries = []
  }
}
state.reset()

const normalizeSql = (sql) => sql.replace(/\s+/g, ' ').trim()
const cloneMap = (map) => new Map([...map.entries()].map(([id, row]) => [id, structuredClone(row)]))
const cloneState = () => ({
  suppliers: cloneMap(state.suppliers), products: cloneMap(state.products),
  orders: cloneMap(state.orders), items: cloneMap(state.items),
  receipts: cloneMap(state.receipts), receiptItems: cloneMap(state.receiptItems),
  movements: structuredClone(state.movements), next: state.next
})

function rowsResult(rows) { return { rows, rowCount: rows.length } }

function readQuery(sql, params, data) {
  if (sql.startsWith('SELECT s.*') && sql.includes('FROM suppliers s')) {
    const [tenantId, search, active] = params
    const rows = [...data.suppliers.values()].filter((row) => row.tenant_id === tenantId &&
      (!search || `${row.business_name} ${row.contact_person || ''} ${row.email || ''}`.toLowerCase().includes(String(search).toLowerCase())) &&
      (active == null || row.is_active === active))
      .map((row) => ({ ...row, purchase_order_count: [...data.orders.values()].filter((order) => order.tenant_id === tenantId && order.supplier_id === row.id).length }))
    return rowsResult(rows)
  }
  if (sql.startsWith('SELECT id FROM suppliers WHERE id = $1 AND tenant_id = $2')) {
    const row = data.suppliers.get(params[0])
    return rowsResult(row?.tenant_id === params[1] ? [{ id: row.id }] : [])
  }
  if (sql.startsWith('SELECT s.*') && sql.includes('WHERE s.id = $1 AND s.tenant_id = $2')) {
    const row = data.suppliers.get(params[0])
    if (!row || row.tenant_id !== params[1]) return rowsResult([])
    return rowsResult([{ ...row, purchase_order_count: [...data.orders.values()].filter((order) => order.tenant_id === row.tenant_id && order.supplier_id === row.id).length }])
  }
  if (sql.startsWith('SELECT po.*, s.business_name AS supplier_name, (SELECT COUNT(*)::integer FROM purchase_order_items')) {
    const [tenantId, search, status, supplierId] = params
    const rows = [...data.orders.values()].filter((order) => {
      const linkedSupplier = data.suppliers.get(order.supplier_id)
      return order.tenant_id === tenantId && linkedSupplier?.tenant_id === tenantId &&
        (!search || `${order.purchase_order_number} ${linkedSupplier.business_name}`.toLowerCase().includes(String(search).toLowerCase())) &&
        (!status || order.status === status) && (!supplierId || order.supplier_id === supplierId)
    }).map((order) => ({ ...order, supplier_name: data.suppliers.get(order.supplier_id).business_name,
      item_count: [...data.items.values()].filter((item) => item.tenant_id === tenantId && item.purchase_order_id === order.id).length }))
    return rowsResult(rows)
  }
  if (sql.startsWith('SELECT po.*') && sql.includes('s.contact_person AS supplier_contact')) {
    const [orderId, tenantId] = params
    const order = data.orders.get(orderId)
    const linkedSupplier = order && data.suppliers.get(order.supplier_id)
    if (!order || order.tenant_id !== tenantId || linkedSupplier?.tenant_id !== tenantId) return rowsResult([])
    return rowsResult([{ ...order, supplier_name: linkedSupplier.business_name,
      supplier_contact: linkedSupplier.contact_person, supplier_email: linkedSupplier.email, supplier_phone: linkedSupplier.phone }])
  }
  if (sql.startsWith('SELECT * FROM purchase_order_items')) {
    const [tenantId, orderId] = params
    return rowsResult([...data.items.values()].filter((item) => item.tenant_id === tenantId && item.purchase_order_id === orderId))
  }
  if (sql.startsWith('SELECT * FROM purchase_order_receipts')) {
    const [tenantId, orderId] = params
    return rowsResult([...data.receipts.values()].filter((row) => row.tenant_id === tenantId && row.purchase_order_id === orderId))
  }
  if (sql.startsWith('SELECT ri.*, poi.product_name')) {
    const [tenantId, orderId] = params
    const rows = [...data.receiptItems.values()].filter((item) => item.tenant_id === tenantId && item.purchase_order_id === orderId)
      .map((item) => ({ ...item, product_name: data.items.get(item.purchase_order_item_id)?.product_name, product_sku: data.items.get(item.purchase_order_item_id)?.product_sku }))
    return rowsResult(rows)
  }
  if (sql.startsWith('SELECT po.*') && sql.includes('WHERE po.tenant_id = $1 AND po.supplier_id = $2')) {
    const [tenantId, supplierId] = params
    return rowsResult([...data.orders.values()].filter((order) => order.tenant_id === tenantId && order.supplier_id === supplierId)
      .map((order) => ({ ...order, item_count: [...data.items.values()].filter((item) => item.tenant_id === tenantId && item.purchase_order_id === order.id).length })))
  }
  throw new Error(`Unexpected database read query in test: ${sql}`)
}

const fakePool = {
  async query(sql, params = []) {
    const normalized = normalizeSql(sql)
    state.queries.push({ sql: normalized, params })
    return readQuery(normalized, params, state)
  },
  async connect() {
    const working = cloneState()
    let open = true
    const query = async (sql, params = []) => {
      const normalized = normalizeSql(sql)
      state.transactionQueries.push({ sql: normalized, params })
      if (normalized.startsWith('BEGIN')) return rowsResult([])
      if (normalized === 'COMMIT') {
        state.suppliers = working.suppliers
        state.products = working.products
        state.orders = working.orders
        state.items = working.items
        state.receipts = working.receipts
        state.receiptItems = working.receiptItems
        state.movements = working.movements
        state.next = working.next
        state.commitCount += 1
        open = false
        return rowsResult([])
      }
      if (normalized === 'ROLLBACK') {
        state.rollbackCount += 1
        open = false
        return rowsResult([])
      }
      if (normalized.startsWith('SELECT id FROM tenants')) {
        return rowsResult(params[0] === IDS.tenantA ? [{ id: params[0] }] : [])
      }
      if (normalized.startsWith('SELECT id FROM suppliers WHERE id = $1 AND tenant_id = $2 AND is_active = true')) {
        const row = working.suppliers.get(params[0])
        return rowsResult(row?.tenant_id === params[1] && row.is_active ? [{ id: row.id }] : [])
      }
      if (normalized.startsWith('SELECT id, name, sku FROM products')) {
        const [tenantId, ids] = params
        const rows = ids.map((id) => working.products.get(id)).filter((row) => row?.tenant_id === tenantId && row.is_active)
        return rowsResult(rows.map(({ id, name, sku }) => ({ id, name, sku })))
      }
      if (normalized.startsWith('SELECT COALESCE(MAX(SUBSTRING(purchase_order_number')) {
        const values = [...working.orders.values()].filter((row) => row.tenant_id === params[0])
          .map((row) => Number(row.purchase_order_number.match(/^PO-(\d+)$/)?.[1] || 0))
        return rowsResult([{ next_number: String(Math.max(0, ...values) + 1) }])
      }
      if (normalized.startsWith('INSERT INTO purchase_orders')) {
        const id = `97000000-0000-4000-8000-${String(working.next++).padStart(12, '0')}`
        working.orders.set(id, {
          id, tenant_id: params[0], supplier_id: params[1], purchase_order_number: params[2],
          order_date: params[3], expected_delivery_date: params[4], status: 'draft', subtotal: params[5],
          tax_rate: params[6], tax_amount: params[7], total: params[8], notes: params[9], created_by: params[10],
          created_at: '2026-10-18T00:00:00.000Z'
        })
        return rowsResult([{ id }])
      }
      if (normalized.startsWith('INSERT INTO purchase_order_items')) {
        const id = `98000000-0000-4000-8000-${String(working.next++).padStart(12, '0')}`
        const row = { id, tenant_id: params[0], purchase_order_id: params[1], product_id: params[2],
          product_name: params[3], product_sku: params[4], quantity_ordered: params[5], quantity_received: '0.000',
          unit_cost: params[6], line_subtotal: params[7] }
        working.items.set(id, row)
        return rowsResult([row])
      }
      if (normalized.startsWith('SELECT id, status FROM purchase_orders')) {
        const row = working.orders.get(params[0])
        return rowsResult(row?.tenant_id === params[1] ? [{ id: row.id, status: row.status }] : [])
      }
      if (normalized.startsWith('SELECT * FROM purchase_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE')) {
        const row = working.orders.get(params[0])
        return rowsResult(row?.tenant_id === params[1] ? [row] : [])
      }
      if (normalized.startsWith('SELECT * FROM purchase_order_receipts')) {
        const [tenantId, orderId, key] = params
        if (key === undefined) return readQuery(normalized, params, working)
        return rowsResult([...working.receipts.values()].filter((row) => row.tenant_id === tenantId && row.purchase_order_id === orderId && row.idempotency_key === key))
      }
      if (normalized.startsWith('SELECT * FROM purchase_order_items')) {
        return readQuery(normalized, params, working)
      }
      if (normalized.startsWith('SELECT id, current_stock FROM products')) {
        const [tenantId, ids] = params
        const rows = ids.map((id) => working.products.get(id)).filter((row) => row?.tenant_id === tenantId)
        return rowsResult(rows.map(({ id, current_stock }) => ({ id, current_stock })))
      }
      if (normalized.startsWith('INSERT INTO purchase_order_receipts')) {
        if ([...working.receipts.values()].some((row) => row.tenant_id === params[0] && row.purchase_order_id === params[1] && row.idempotency_key === params[2])) {
          const error = new Error('duplicate receipt key'); error.code = '23505'; throw error
        }
        const id = `99000000-0000-4000-8000-${String(working.next++).padStart(12, '0')}`
        const row = { id, tenant_id: params[0], purchase_order_id: params[1], idempotency_key: params[2],
          received_by: params[3], notes: params[4], received_at: '2026-10-18T01:00:00.000Z' }
        working.receipts.set(id, row)
        return rowsResult([row])
      }
      if (normalized.startsWith('INSERT INTO purchase_order_receipt_items')) {
        const id = `99100000-0000-4000-8000-${String(working.next++).padStart(12, '0')}`
        const row = { id, tenant_id: params[0], purchase_order_id: params[1], receipt_id: params[2],
          purchase_order_item_id: params[3], product_id: params[4], received_quantity: params[5],
          unit_cost: params[6], line_total: params[7] }
        working.receiptItems.set(id, row)
        return rowsResult([row])
      }
      if (normalized.startsWith('UPDATE purchase_order_items SET quantity_received')) {
        const [quantity, tenantId, orderId, itemId] = params
        const row = working.items.get(itemId)
        if (!row || row.tenant_id !== tenantId || row.purchase_order_id !== orderId) return rowsResult([])
        const received = (Number(row.quantity_received) + Number(quantity)).toFixed(3)
        if (Number(received) > Number(row.quantity_ordered)) return rowsResult([])
        row.quantity_received = received
        return rowsResult([{ quantity_received: received }])
      }
      if (normalized.startsWith('UPDATE products SET current_stock')) {
        const [quantity, tenantId, productId] = params
        const row = working.products.get(productId)
        if (!row || row.tenant_id !== tenantId) return rowsResult([])
        row.current_stock = (Number(row.current_stock) + Number(quantity)).toFixed(3)
        return rowsResult([{ current_stock: row.current_stock }])
      }
      if (normalized.startsWith('INSERT INTO stock_movements')) {
        if (state.failMovement) throw new Error('simulated stock ledger failure')
        const [tenant_id, product_id, quantity_delta, quantity_before, quantity_after,
          reference, notes, created_by, purchase_order_receipt_item_id] = params
        working.movements.push({ tenant_id, product_id, quantity_delta, quantity_before, quantity_after,
          reference, notes, created_by, purchase_order_receipt_item_id })
        return rowsResult([])
      }
      if (normalized.startsWith('SELECT COALESCE(bool_and')) {
        const [tenantId, orderId] = params
        const items = [...working.items.values()].filter((row) => row.tenant_id === tenantId && row.purchase_order_id === orderId)
        return rowsResult([{ fully_received: items.length > 0 && items.every((row) => row.quantity_received === row.quantity_ordered) }])
      }
      if (normalized.startsWith('UPDATE purchase_orders SET status')) {
        const [status, orderId, tenantId] = params
        const row = working.orders.get(orderId)
        if (!row || row.tenant_id !== tenantId) return rowsResult([])
        row.status = status
        return rowsResult([row])
      }
      if (normalized.startsWith('UPDATE purchase_orders SET supplier_id')) {
        const [supplierId, orderDate, expectedDate, subtotal, taxRate, taxAmount, total, notes, orderId, tenantId] = params
        const row = working.orders.get(orderId)
        if (!row || row.tenant_id !== tenantId) return rowsResult([])
        Object.assign(row, { supplier_id: supplierId, order_date: orderDate, expected_delivery_date: expectedDate,
          subtotal, tax_rate: taxRate, tax_amount: taxAmount, total, notes })
        return rowsResult([row])
      }
      if (normalized.startsWith('DELETE FROM purchase_order_items')) {
        const [tenantId, orderId] = params
        for (const [id, item] of working.items) if (item.tenant_id === tenantId && item.purchase_order_id === orderId) working.items.delete(id)
        return rowsResult([])
      }

      if (normalized.startsWith('SELECT po.*') || normalized.startsWith('SELECT s.*') || normalized.startsWith('SELECT ri.*') || normalized.startsWith('SELECT * FROM purchase_order_receipts')) {
        return readQuery(normalized, params, working)
      }
      throw new Error(`Unexpected transaction query in test: ${normalized}`)
    }
    return {
      query,
      release(error) { state.releases.push(error || null) }
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
const suppliersRouter = require('../src/routes/suppliers')
installMockModule(require.resolve('../src/services/inventoryAccounting'), {
  valueReceipt: async () => ({ journal: { id: 'inventory-test-journal' } })
})
const purchaseOrdersRouter = require('../src/routes/purchaseOrders')
const token = jwt.sign({ userId: IDS.userA, tenantId: IDS.tenantA }, JWT_TEST_SECRET)

async function withServer(run) {
  const app = express()
  app.use(express.json())
  app.use('/api/suppliers', suppliersRouter)
  app.use('/api/purchase-orders', purchaseOrdersRouter)
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

async function request(baseUrl, pathName, { method = 'GET', body, headers = {} } = {}) {
  const requestHeaders = { Authorization: `Bearer ${token}`, ...headers }
  const options = { method, headers: requestHeaders }
  if (body !== undefined) {
    requestHeaders['Content-Type'] = 'application/json'
    options.body = JSON.stringify(body)
  }
  const response = await fetch(new URL(pathName, baseUrl), options)
  return { status: response.status, data: await response.json() }
}

const validOrder = {
  tenant_id: IDS.tenantB,
  supplier_id: IDS.supplierA,
  order_date: '2026-10-18',
  expected_delivery_date: '2026-11-01',
  tax_rate: '16.00',
  notes: 'Quarterly stock order',
  items: [{ product_id: IDS.productA, quantity: '2.500', unit_cost: '120.00' }]
}

test.beforeEach(() => state.reset())

test('supplier lists and purchase order details are limited to the JWT tenant', async () => {
  await withServer(async (baseUrl) => {
    const suppliers = await request(baseUrl, `/api/suppliers?tenant_id=${IDS.tenantB}`)
    assert.equal(suppliers.status, 200)
    assert.deepEqual(suppliers.data.map((row) => row.id), [IDS.supplierA])
    assert.deepEqual(state.queries[0].params, [IDS.tenantA, '', null])

    const foreignOrder = await request(baseUrl, `/api/purchase-orders/${IDS.orderA.replace(/1$/, '2')}`)
    assert.equal(foreignOrder.status, 404)
    const detailQuery = state.queries.find((query) => query.sql.includes('s.contact_person AS supplier_contact'))
    assert.deepEqual(detailQuery.params, [IDS.orderA.replace(/1$/, '2'), IDS.tenantA])
  })
})

test('purchase order creation derives tenant from JWT and calculates totals server-side', async () => {
  await withServer(async (baseUrl) => {
    const response = await request(baseUrl, '/api/purchase-orders', { method: 'POST', body: validOrder })
    assert.equal(response.status, 201)
    assert.equal(response.data.tenant_id, IDS.tenantA)
    assert.equal(response.data.purchase_order_number, 'PO-0008')
    assert.equal(response.data.subtotal, '300.00')
    assert.equal(response.data.tax_amount, '48.00')
    assert.equal(response.data.total, '348.00')
    assert.equal(response.data.created_by, IDS.userA)
    const insertOrder = state.transactionQueries.find((query) => query.sql.startsWith('INSERT INTO purchase_orders'))
    assert.equal(insertOrder.params[0], IDS.tenantA)
    assert.equal(insertOrder.params[10], IDS.userA)
    assert.equal(state.commitCount, 1)
    assert.equal(state.rollbackCount, 0)
  })
})

test('rejects invalid order precision and a supplier from another tenant before inserting', async () => {
  await withServer(async (baseUrl) => {
    const invalid = await request(baseUrl, '/api/purchase-orders', {
      method: 'POST', body: { ...validOrder, items: [{ ...validOrder.items[0], quantity: '1.0001' }] }
    })
    assert.equal(invalid.status, 400)
    assert.equal(state.transactionQueries.length, 0)

    const foreignSupplier = await request(baseUrl, '/api/purchase-orders', {
      method: 'POST', body: { ...validOrder, supplier_id: IDS.supplierB }
    })
    assert.equal(foreignSupplier.status, 404)
    assert.deepEqual(foreignSupplier.data, { error: 'Supplier not found' })
    assert.equal(state.orders.size, 1)
    assert.equal(state.rollbackCount, 1)
  })
})

test('partial receipts atomically increment stock and keep the order partially received', async () => {
  await withServer(async (baseUrl) => {
    const response = await request(baseUrl, `/api/purchase-orders/${IDS.orderA}/receipts`, {
      method: 'POST', headers: { 'Idempotency-Key': 'receipt-part-0001' },
      body: { items: [{ purchase_order_item_id: IDS.orderItemA, quantity: '2.125' }], notes: 'First delivery' }
    })
    assert.equal(response.status, 201)
    assert.equal(response.data.purchase_order.status, 'partially_received')
    assert.equal(response.data.purchase_order.items[0].quantity_received, '2.125')
    assert.equal(response.data.receipt.received_by, IDS.userA)
    assert.equal(state.products.get(IDS.productA).current_stock, '12.125')
    assert.equal(state.movements.length, 1)
    assert.equal(state.movements[0].created_by, IDS.userA)
    assert.equal(state.movements[0].purchase_order_receipt_item_id, response.data.receipt.items[0].id)
    assert.equal(state.commitCount, 1)
    assert.equal(state.rollbackCount, 0)
    assert.match(state.transactionQueries.find((query) => query.sql.startsWith('SELECT * FROM purchase_orders WHERE')).sql, /FOR UPDATE$/)
    assert.match(state.transactionQueries.find((query) => query.sql.startsWith('SELECT * FROM purchase_order_items WHERE')).sql, /FOR UPDATE$/)
    assert.match(state.transactionQueries.find((query) => query.sql.startsWith('SELECT id, current_stock FROM products')).sql, /FOR UPDATE$/)
  })
})

test('receiving the final outstanding quantity marks the purchase order received', async () => {
  await withServer(async (baseUrl) => {
    const response = await request(baseUrl, `/api/purchase-orders/${IDS.orderA}/receipts`, {
      method: 'POST', headers: { 'Idempotency-Key': 'receipt-complete-0001' },
      body: { items: [{ purchase_order_item_id: IDS.orderItemA, quantity: '5.000' }] }
    })
    assert.equal(response.status, 201)
    assert.equal(response.data.purchase_order.status, 'received')
    assert.equal(response.data.purchase_order.items[0].quantity_received, '5.000')
    assert.equal(state.products.get(IDS.productA).current_stock, '15.000')
  })
})

test('rejects over-receipt without changing order, stock or receipt history', async () => {
  await withServer(async (baseUrl) => {
    const response = await request(baseUrl, `/api/purchase-orders/${IDS.orderA}/receipts`, {
      method: 'POST', headers: { 'Idempotency-Key': 'receipt-over-0001' },
      body: { items: [{ purchase_order_item_id: IDS.orderItemA, quantity: '5.001' }] }
    })
    assert.equal(response.status, 409)
    assert.deepEqual(response.data, { error: 'Receipt quantity exceeds the outstanding quantity' })
    assert.equal(state.products.get(IDS.productA).current_stock, '10.000')
    assert.equal(state.items.get(IDS.orderItemA).quantity_received, '0.000')
    assert.equal(state.receipts.size, 0)
    assert.equal(state.rollbackCount, 1)
    assert.equal(state.commitCount, 0)
  })
})

test('replaying a receipt idempotency key returns the prior receipt without adding stock again', async () => {
  await withServer(async (baseUrl) => {
    const requestOptions = {
      method: 'POST', headers: { 'Idempotency-Key': 'receipt-once-0001' },
      body: { items: [{ purchase_order_item_id: IDS.orderItemA, quantity: '2.000' }] }
    }
    const first = await request(baseUrl, `/api/purchase-orders/${IDS.orderA}/receipts`, requestOptions)
    const retry = await request(baseUrl, `/api/purchase-orders/${IDS.orderA}/receipts`, requestOptions)
    assert.equal(first.status, 201)
    assert.equal(retry.status, 200)
    assert.equal(retry.data.duplicate, true)
    assert.equal(retry.data.receipt.id, first.data.receipt.id)
    assert.equal(state.products.get(IDS.productA).current_stock, '12.000')
    assert.equal(state.movements.length, 1)
    assert.equal(state.receipts.size, 1)
  })
})

test('stock ledger failure rolls back receipt, order quantity and product stock', async (t) => {
  t.mock.method(console, 'error', () => {})
  state.failMovement = true
  await withServer(async (baseUrl) => {
    const response = await request(baseUrl, `/api/purchase-orders/${IDS.orderA}/receipts`, {
      method: 'POST', headers: { 'Idempotency-Key': 'receipt-fail-0001' },
      body: { items: [{ purchase_order_item_id: IDS.orderItemA, quantity: '1.000' }] }
    })
    assert.equal(response.status, 500)
    assert.deepEqual(response.data, { error: 'Failed to record goods receipt' })
    assert.equal(state.products.get(IDS.productA).current_stock, '10.000')
    assert.equal(state.items.get(IDS.orderItemA).quantity_received, '0.000')
    assert.equal(state.receipts.size, 0)
    assert.equal(state.receiptItems.size, 0)
    assert.equal(state.movements.length, 0)
    assert.equal(state.rollbackCount, 1)
    assert.equal(state.commitCount, 0)
    assert.equal(state.releases.length, 1)
  })
})

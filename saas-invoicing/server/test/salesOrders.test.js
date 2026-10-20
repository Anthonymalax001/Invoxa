const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const Module = require('node:module')
const express = require('express')
const jwt = require('jsonwebtoken')

const JWT_TEST_SECRET = 'invoxa-sales-order-tests-only'
process.env.JWT_SECRET = JWT_TEST_SECRET

const IDS = {
  tenantA: '10000000-0000-4000-8000-000000000001',
  tenantB: '10000000-0000-4000-8000-000000000002',
  clientA: '20000000-0000-4000-8000-000000000001',
  clientB: '20000000-0000-4000-8000-000000000002',
  productA: '30000000-0000-4000-8000-000000000001',
  productB: '30000000-0000-4000-8000-000000000002',
  userA: '40000000-0000-4000-8000-000000000001'
}

const makeState = () => ({
  clients: new Map([
    [IDS.clientA, { id: IDS.clientA, tenant_id: IDS.tenantA, name: 'Tenant A client', email: 'a@example.invalid' }],
    [IDS.clientB, { id: IDS.clientB, tenant_id: IDS.tenantB, name: 'Tenant B private client', email: 'b@example.invalid' }]
  ]),
  products: new Map([
    [IDS.productA, { id: IDS.productA, tenant_id: IDS.tenantA, name: 'Widget', sku: 'W-1', selling_price: '100.00', current_stock: '5.000', is_active: true }],
    [IDS.productB, { id: IDS.productB, tenant_id: IDS.tenantB, name: 'Private widget', sku: 'P-1', selling_price: '20.00', current_stock: '3.000', is_active: true }]
  ]),
  orders: new Map(),
  lines: new Map(),
  fulfillments: new Map(),
  fulfillmentItems: [],
  movements: [],
  invoices: [],
  invoiceItems: [],
  commitCount: 0,
  rollbackCount: 0,
  failStockMovement: false,
  failInvoiceItem: false
})

const state = { db: makeState() }
let nextTestId = 1
const id = () => `50000000-0000-4000-8000-${String(nextTestId++).padStart(12, '0')}`
const normalizeSql = (sql) => sql.replace(/\s+/g, ' ').trim()
const result = (rows = []) => ({ rows, rowCount: rows.length })

function queryDatabase(db, sql, params = []) {
  const q = normalizeSql(sql)
  if (q.startsWith('SELECT id FROM tenants')) {
    return result(params[0] === IDS.tenantA || params[0] === IDS.tenantB ? [{ id: params[0] }] : [])
  }
  if (q.startsWith('SELECT id FROM clients')) {
    const client = db.clients.get(params[0])
    return result(client?.tenant_id === params[1] ? [{ id: client.id }] : [])
  }
  if (q.startsWith('SELECT id, name, sku, selling_price FROM products')) {
    const rows = params[1].map((productId) => db.products.get(productId))
      .filter((product) => product?.tenant_id === params[0] && product.is_active)
      .map(({ id: productId, name, sku, selling_price }) => ({ id: productId, name, sku, selling_price }))
    return result(rows)
  }
  if (q.startsWith('SELECT COALESCE(MAX(SUBSTRING(order_number')) return result([{ next_number: '1' }])
  if (q.startsWith('SELECT COALESCE(') && q.includes('invoice_number')) {
    return result([{ next_number: String(db.invoices.filter((invoice) => invoice.tenant_id === params[0]).length + 1) }])
  }
  if (q.startsWith('INSERT INTO sales_orders')) {
    const orderId = id()
    const order = {
      id: orderId, tenant_id: params[0], client_id: params[1], order_number: params[2],
      order_date: params[3], expected_delivery_date: params[4], status: 'draft',
      subtotal: params[5], discount_total: params[6], tax_rate: params[7],
      tax_amount: params[8], total: params[9], notes: params[10], created_by: params[11],
      created_at: '2026-10-18T00:00:00.000Z'
    }
    db.orders.set(orderId, order)
    db.lines.set(orderId, [])
    return result([{ id: orderId }])
  }
  if (q.startsWith('INSERT INTO sales_order_items')) {
    const product = db.products.get(params[2])
    db.lines.get(params[1]).push({
      id: id(), tenant_id: params[0], sales_order_id: params[1], product_id: params[2],
      product_name: params[3], product_sku: params[4], quantity_ordered: params[5],
      quantity_fulfilled: '0.00', unit_price: params[6], discount_rate: params[7],
      discount_amount: params[8], line_subtotal: params[9], updated_at: '2026-10-18T00:00:00.000Z',
      product_current_stock: product.current_stock
    })
    return result([])
  }
  if (q.startsWith('SELECT so.*, c.name AS client_name')) {
    const order = db.orders.get(params[0])
    const client = order && db.clients.get(order.client_id)
    if (!order || order.tenant_id !== params[1] || client?.tenant_id !== order.tenant_id) return result([])
    return result([{ ...order, client_name: client.name, client_email: client.email, client_phone: null, client_address: null }])
  }
  if (q.startsWith('SELECT * FROM sales_order_items')) {
    const rows = (db.lines.get(params[1]) || []).filter((line) => line.tenant_id === params[0])
    return result(rows)
  }
  if (q.startsWith('SELECT * FROM sales_order_fulfillments')) {
    const rows = [...db.fulfillments.values()].filter((f) =>
      f.tenant_id === params[0] && f.sales_order_id === params[1] &&
      (params.length < 3 || f.idempotency_key === params[2])
    )
    return result(rows)
  }
  if (q.startsWith('SELECT fi.*, soi.product_name')) {
    return result(db.fulfillmentItems.filter((item) =>
      item.tenant_id === params[0] && item.sales_order_id === params[1]
    ).map((item) => {
      const line = (db.lines.get(item.sales_order_id) || []).find((candidate) => candidate.id === item.sales_order_item_id)
      return { ...item, product_name: line.product_name, product_sku: line.product_sku }
    }))
  }
  if (q.startsWith('SELECT id, invoice_number, status, created_at FROM invoices')) {
    return result(db.invoices.filter((invoice) => invoice.tenant_id === params[0] && invoice.sales_order_id === params[1]))
  }
  if (q.startsWith('SELECT * FROM sales_orders WHERE id = $1')) {
    const order = db.orders.get(params[0])
    return result(order?.tenant_id === params[1] ? [{ ...order }] : [])
  }
  if (q.startsWith('SELECT id, current_stock FROM products')) {
    const rows = params[1].map((productId) => db.products.get(productId))
      .filter((product) => product?.tenant_id === params[0])
      .map((product) => ({ id: product.id, current_stock: product.current_stock }))
    return result(rows)
  }
  if (q.startsWith('INSERT INTO sales_order_fulfillments')) {
    const fulfillment = {
      id: id(), tenant_id: params[0], sales_order_id: params[1], idempotency_key: params[2],
      fulfilled_by: params[3], notes: params[4], fulfilled_at: '2026-10-18T00:00:00.000Z'
    }
    db.fulfillments.set(fulfillment.id, fulfillment)
    return result([fulfillment])
  }
  if (q.startsWith('INSERT INTO sales_order_fulfillment_items')) {
    const item = {
      id: id(), tenant_id: params[0], sales_order_id: params[1], fulfillment_id: params[2],
      sales_order_item_id: params[3], product_id: params[4], fulfilled_quantity: params[5]
    }
    db.fulfillmentItems.push(item)
    return result([{ id: item.id }])
  }
  if (q.startsWith('UPDATE sales_order_items')) {
    const line = (db.lines.get(params[2]) || []).find((candidate) => candidate.id === params[3])
    if (!line || line.tenant_id !== params[1] || Number(line.quantity_fulfilled) + Number(params[0]) > Number(line.quantity_ordered)) return result([])
    line.quantity_fulfilled = (Number(line.quantity_fulfilled) + Number(params[0])).toFixed(2)
    return result([{ quantity_fulfilled: line.quantity_fulfilled }])
  }
  if (q.startsWith('UPDATE products SET current_stock')) {
    const product = db.products.get(params[2])
    if (!product || product.tenant_id !== params[1] || Number(product.current_stock) < Number(params[0])) return result([])
    product.current_stock = (Number(product.current_stock) - Number(params[0])).toFixed(3)
    return result([{ current_stock: product.current_stock }])
  }
  if (q.startsWith('INSERT INTO stock_movements')) {
    if (db.failStockMovement) throw new Error('Simulated stock movement insert failure')
    db.movements.push({ tenant_id: params[0], product_id: params[1], movement_type: 'adjustment', quantity_delta: params[2], quantity_before: params[3], quantity_after: params[4], reference: params[5], notes: params[6], created_by: params[7], sales_order_fulfillment_item_id: params[8] })
    return result([])
  }
  if (q.startsWith('SELECT COALESCE(bool_and')) {
    const lines = db.lines.get(params[1]) || []
    return result([{ fully_fulfilled: lines.length > 0 && lines.every((line) => line.quantity_fulfilled === line.quantity_ordered) }])
  }
  if (q.startsWith('UPDATE sales_orders SET status = $1')) {
    const order = db.orders.get(params[1])
    if (order?.tenant_id === params[2]) order.status = params[0]
    return result([])
  }
  if (q.startsWith('SELECT id, status FROM sales_orders')) {
    const order = db.orders.get(params[0])
    return result(order?.tenant_id === params[1] ? [{ id: order.id, status: order.status }] : [])
  }
  if (q.startsWith('UPDATE sales_orders SET client_id')) {
    throw new Error('Draft edits are not part of this test fixture')
  }
  if (q.startsWith('SELECT id FROM invoices WHERE tenant_id = $1 AND sales_order_id')) {
    return result(db.invoices.filter((invoice) => invoice.tenant_id === params[0] && invoice.sales_order_id === params[1]).map((invoice) => ({ id: invoice.id })))
  }
  if (q.startsWith('INSERT INTO invoices')) {
    const invoice = { id: id(), tenant_id: params[0], client_id: params[1], sales_order_id: params[2], invoice_number: params[3], due_date: null, subtotal: params[4], tax_rate: params[5], tax_amount: params[6], total: params[7], notes: params[8], status: 'draft', created_at: '2026-10-18T00:00:00.000Z' }
    db.invoices.push(invoice)
    return result([invoice])
  }
  if (q.startsWith('INSERT INTO invoice_items')) {
    if (db.failInvoiceItem) throw new Error('Simulated invoice item insert failure')
    db.invoiceItems.push({ invoice_id: params[0], description: params[1], quantity: params[2], unit_price: params[3], amount: params[4] })
    return result([])
  }
  throw new Error(`Unexpected test query: ${q}`)
}

const fakePool = {
  async query(sql, params) { return queryDatabase(state.db, sql, params) },
  async connect() {
    const working = structuredClone(state.db)
    return {
      async query(sql, params = []) {
        const q = normalizeSql(sql)
        if (q.startsWith('BEGIN ')) return result([])
        if (q === 'COMMIT') {
          working.commitCount = state.db.commitCount + 1
          state.db = working
          return result([])
        }
        if (q === 'ROLLBACK') {
          state.db.rollbackCount += 1
          return result([])
        }
        return queryDatabase(working, sql, params)
      },
      release() {}
    }
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

const salesOrderRouter = require('../src/routes/salesOrders')
const tokenFor = (tenantId = IDS.tenantA) => jwt.sign({ userId: IDS.userA, tenantId, role: 'admin' }, JWT_TEST_SECRET)

async function withServer(run) {
  const app = express()
  app.use(express.json())
  app.use('/api/sales-orders', salesOrderRouter)
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

async function request(baseUrl, path, { method = 'GET', tenantId = IDS.tenantA, body, idempotencyKey } = {}) {
  const headers = { Authorization: `Bearer ${tokenFor(tenantId)}` }
  const options = { method, headers }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    options.body = JSON.stringify(body)
  }
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
  const response = await fetch(new URL(path, baseUrl), options)
  const text = await response.text()
  return { status: response.status, data: text ? JSON.parse(text) : null }
}

const orderBody = (overrides = {}) => ({
  client_id: IDS.clientA,
  order_date: '2026-10-18',
  expected_delivery_date: '2026-10-25',
  subtotal: '0.01',
  total: '0.01',
  tax_rate: '16.00',
  items: [{ product_id: IDS.productA, quantity: '2.00', unit_price: '100.00', discount_rate: '10.00' }],
  ...overrides
})

async function createOrder(baseUrl) {
  const response = await request(baseUrl, '/api/sales-orders', { method: 'POST', body: orderBody() })
  assert.equal(response.status, 201)
  return response.data
}

test.beforeEach(() => { state.db = makeState(); nextTestId = 1 })

test('rejects a cross-tenant client and never accepts a body tenant as authority', async () => {
  await withServer(async (baseUrl) => {
    const response = await request(baseUrl, '/api/sales-orders', {
      method: 'POST',
      body: orderBody({ tenant_id: IDS.tenantB, client_id: IDS.clientB })
    })
    assert.equal(response.status, 404)
    assert.deepEqual(response.data, { error: 'Client not found' })
    assert.equal(JSON.stringify(response.data).includes('Tenant B'), false)
    assert.equal(state.db.orders.size, 0)
    assert.equal(state.db.commitCount, 0)
  })
})

test('rejects foreign products and invalid order values before creating an order', async () => {
  await withServer(async (baseUrl) => {
    const foreignProduct = await request(baseUrl, '/api/sales-orders', {
      method: 'POST',
      body: orderBody({ items: [{ product_id: IDS.productB, quantity: '1.00', unit_price: '20.00' }] })
    })
    assert.equal(foreignProduct.status, 404)
    assert.deepEqual(foreignProduct.data, { error: 'Product not found' })

    const invalid = await request(baseUrl, '/api/sales-orders', {
      method: 'POST',
      body: orderBody({ items: [{ product_id: IDS.productA, quantity: '-1', unit_price: 'NaN' }] })
    })
    assert.equal(invalid.status, 400)
    assert.equal(state.db.orders.size, 0)
    assert.equal(state.db.commitCount, 0)
  })
})

test('calculates discounted subtotal, tax and total on the server', async () => {
  await withServer(async (baseUrl) => {
    const order = await createOrder(baseUrl)
    assert.equal(order.tenant_id, IDS.tenantA)
    assert.equal(order.order_number, 'SO-0001')
    assert.equal(order.subtotal, '180.00')
    assert.equal(order.discount_total, '20.00')
    assert.equal(order.tax_amount, '28.80')
    assert.equal(order.total, '208.80')
    assert.equal(order.items[0].line_subtotal, '180.00')
  })
})

test('foreign sales order detail is hidden with a tenant-scoped lookup', async () => {
  await withServer(async (baseUrl) => {
    const order = await createOrder(baseUrl)
    const response = await request(baseUrl, `/api/sales-orders/${order.id}`, { tenantId: IDS.tenantB })
    assert.equal(response.status, 404)
    assert.deepEqual(response.data, { error: 'Sales order not found' })
  })
})

test('fulfillment supports partial receipts, rejects over-fulfillment, and safely replays an idempotency key', async () => {
  await withServer(async (baseUrl) => {
    const order = await createOrder(baseUrl)
    await request(baseUrl, `/api/sales-orders/${order.id}/status`, { method: 'PATCH', body: { status: 'confirmed' } })
    const first = await request(baseUrl, `/api/sales-orders/${order.id}/fulfillments`, {
      method: 'POST', idempotencyKey: 'shipment-0001',
      body: { items: [{ sales_order_item_id: order.items[0].id, quantity: '1.00' }] }
    })
    assert.equal(first.status, 201)
    assert.equal(first.data.sales_order.status, 'partially_fulfilled')
    assert.equal(state.db.products.get(IDS.productA).current_stock, '4.000')
    assert.equal(state.db.movements.length, 1)
    assert.equal(state.db.movements[0].movement_type, 'adjustment')
    assert.equal(state.db.movements[0].quantity_delta, '-1.000')
    assert.equal(state.db.movements[0].created_by, IDS.userA)

    const duplicate = await request(baseUrl, `/api/sales-orders/${order.id}/fulfillments`, {
      method: 'POST', idempotencyKey: 'shipment-0001',
      body: { items: [{ sales_order_item_id: order.items[0].id, quantity: '1.00' }] }
    })
    assert.equal(duplicate.status, 200)
    assert.equal(duplicate.data.duplicate, true)
    assert.equal(state.db.products.get(IDS.productA).current_stock, '4.000')
    assert.equal(state.db.movements.length, 1)

    const over = await request(baseUrl, `/api/sales-orders/${order.id}/fulfillments`, {
      method: 'POST', idempotencyKey: 'shipment-0002',
      body: { items: [{ sales_order_item_id: order.items[0].id, quantity: '1.01' }] }
    })
    assert.equal(over.status, 409)
    assert.equal(state.db.products.get(IDS.productA).current_stock, '4.000')

    const final = await request(baseUrl, `/api/sales-orders/${order.id}/fulfillments`, {
      method: 'POST', idempotencyKey: 'shipment-0003',
      body: { items: [{ sales_order_item_id: order.items[0].id, quantity: '1.00' }] }
    })
    assert.equal(final.status, 201)
    assert.equal(final.data.sales_order.status, 'fulfilled')
    assert.equal(state.db.products.get(IDS.productA).current_stock, '3.000')
    assert.equal(state.db.movements.length, 2)
  })
})

test('rejects fulfillment exceeding available stock without committing any changes', async () => {
  await withServer(async (baseUrl) => {
    const order = await createOrder(baseUrl)
    await request(baseUrl, `/api/sales-orders/${order.id}/status`, { method: 'PATCH', body: { status: 'confirmed' } })
    state.db.products.get(IDS.productA).current_stock = '0.500'
    const response = await request(baseUrl, `/api/sales-orders/${order.id}/fulfillments`, {
      method: 'POST', idempotencyKey: 'shipment-stock',
      body: { items: [{ sales_order_item_id: order.items[0].id, quantity: '1.00' }] }
    })
    assert.equal(response.status, 409)
    assert.equal(response.data.error, 'Insufficient stock for Widget')
    assert.equal(state.db.products.get(IDS.productA).current_stock, '0.500')
    assert.equal(state.db.fulfillments.size, 0)
    assert.equal(state.db.movements.length, 0)
  })
})

test('rolls back stock, fulfillment and order state if movement recording fails', async (t) => {
  t.mock.method(console, 'error', () => {})
  await withServer(async (baseUrl) => {
    const order = await createOrder(baseUrl)
    await request(baseUrl, `/api/sales-orders/${order.id}/status`, { method: 'PATCH', body: { status: 'confirmed' } })
    state.db.failStockMovement = true
    const response = await request(baseUrl, `/api/sales-orders/${order.id}/fulfillments`, {
      method: 'POST', idempotencyKey: 'shipment-rollback',
      body: { items: [{ sales_order_item_id: order.items[0].id, quantity: '1.00' }] }
    })
    assert.equal(response.status, 500)
    assert.equal(state.db.rollbackCount, 1)
    assert.equal(state.db.products.get(IDS.productA).current_stock, '5.000')
    assert.equal(state.db.fulfillments.size, 0)
    assert.equal(state.db.movements.length, 0)
    assert.equal(state.db.orders.get(order.id).status, 'confirmed')
  })
})

test('creates one invoice only after full fulfillment using the compatible invoice item shape', async () => {
  await withServer(async (baseUrl) => {
    const order = await createOrder(baseUrl)
    await request(baseUrl, `/api/sales-orders/${order.id}/status`, { method: 'PATCH', body: { status: 'confirmed' } })
    const blocked = await request(baseUrl, `/api/sales-orders/${order.id}/invoice`, { method: 'POST' })
    assert.equal(blocked.status, 409)

    await request(baseUrl, `/api/sales-orders/${order.id}/fulfillments`, {
      method: 'POST', idempotencyKey: 'invoice-shipment',
      body: { items: [{ sales_order_item_id: order.items[0].id, quantity: '2.00' }] }
    })
    const response = await request(baseUrl, `/api/sales-orders/${order.id}/invoice`, { method: 'POST' })
    assert.equal(response.status, 201)
    assert.equal(response.data.invoice_number, 'INV-0001')
    assert.equal(response.data.tenant_id, IDS.tenantA)
    assert.equal(response.data.sales_order_id, order.id)
    assert.equal(response.data.subtotal, '180.00')
    assert.equal(response.data.tax_amount, '28.80')
    assert.equal(response.data.total, '208.80')
    assert.deepEqual(response.data.items.map(({ quantity, unit_price, amount }) => ({ quantity, unit_price, amount })), [
      { quantity: '2.00', unit_price: '100.00', amount: '180.00' }
    ])
    assert.match(response.data.items[0].description, /discount 10\.00%/)
    assert.equal(state.db.invoiceItems.length, 1)
    const duplicate = await request(baseUrl, `/api/sales-orders/${order.id}/invoice`, { method: 'POST' })
    assert.equal(duplicate.status, 409)
    assert.equal(state.db.invoices.length, 1)
    assert.equal(state.db.movements.length, 1)
  })
})

test('rolls back the linked invoice when an invoice line insert fails', async (t) => {
  t.mock.method(console, 'error', () => {})
  await withServer(async (baseUrl) => {
    const order = await createOrder(baseUrl)
    await request(baseUrl, `/api/sales-orders/${order.id}/status`, { method: 'PATCH', body: { status: 'confirmed' } })
    await request(baseUrl, `/api/sales-orders/${order.id}/fulfillments`, {
      method: 'POST', idempotencyKey: 'invoice-rollback-stock',
      body: { items: [{ sales_order_item_id: order.items[0].id, quantity: '2.00' }] }
    })
    state.db.failInvoiceItem = true
    const response = await request(baseUrl, `/api/sales-orders/${order.id}/invoice`, { method: 'POST' })
    assert.equal(response.status, 500)
    assert.deepEqual(response.data, { error: 'Failed to create invoice from sales order' })
    assert.equal(state.db.rollbackCount, 1)
    assert.equal(state.db.invoices.length, 0)
    assert.equal(state.db.invoiceItems.length, 0)
    assert.equal(state.db.products.get(IDS.productA).current_stock, '3.000')
    assert.equal(state.db.movements.length, 1)
  })
})

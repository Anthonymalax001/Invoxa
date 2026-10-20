const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const Module = require('node:module')
const express = require('express')
const jwt = require('jsonwebtoken')

const JWT_TEST_SECRET = 'invoxa-expense-tests-only'
process.env.JWT_SECRET = JWT_TEST_SECRET

const IDS = {
  tenantA: '10000000-0000-4000-8000-000000000001',
  tenantB: '10000000-0000-4000-8000-000000000002',
  categoryA: '20000000-0000-4000-8000-000000000001',
  categoryB: '20000000-0000-4000-8000-000000000002',
  supplierA: '30000000-0000-4000-8000-000000000001',
  supplierB: '30000000-0000-4000-8000-000000000002',
  userA: '40000000-0000-4000-8000-000000000001'
}

const makeState = () => ({
  categories: new Map([
    [IDS.categoryA, { id: IDS.categoryA, tenant_id: IDS.tenantA, name: 'Office', description: null, is_active: true }],
    [IDS.categoryB, { id: IDS.categoryB, tenant_id: IDS.tenantB, name: 'Private category', description: null, is_active: true }]
  ]),
  suppliers: new Map([
    [IDS.supplierA, { id: IDS.supplierA, tenant_id: IDS.tenantA, business_name: 'Local Supplier', is_active: true }],
    [IDS.supplierB, { id: IDS.supplierB, tenant_id: IDS.tenantB, business_name: 'Foreign Supplier', is_active: true }]
  ]),
  expenses: new Map(),
  summaryQueries: [],
  commitCount: 0,
  rollbackCount: 0,
  failExpenseUpdate: null
})

const state = { db: makeState() }
let nextTestId = 1
const id = () => `50000000-0000-4000-8000-${String(nextTestId++).padStart(12, '0')}`
const normalizeSql = (sql) => sql.replace(/\s+/g, ' ').trim()
const result = (rows = []) => ({ rows, rowCount: rows.length })

function withNames(db, expense) {
  const category = db.categories.get(expense.category_id)
  const supplier = expense.supplier_id ? db.suppliers.get(expense.supplier_id) : null
  return {
    ...expense,
    category_name: category?.name,
    supplier_name: supplier?.tenant_id === expense.tenant_id ? supplier.business_name : null
  }
}

function queryDatabase(db, sql, params = []) {
  const q = normalizeSql(sql)
  if (q.startsWith('SELECT id FROM tenants')) {
    return result(params[0] === IDS.tenantA || params[0] === IDS.tenantB ? [{ id: params[0] }] : [])
  }
  if (q.startsWith('SELECT id FROM expense_categories')) {
    const category = db.categories.get(params[0])
    return result(category?.tenant_id === params[1] && category.is_active ? [{ id: category.id }] : [])
  }
  if (q.startsWith('SELECT id FROM suppliers')) {
    const supplier = db.suppliers.get(params[0])
    return result(supplier?.tenant_id === params[1] && supplier.is_active ? [{ id: supplier.id }] : [])
  }
  if (q.startsWith('SELECT * FROM expenses WHERE tenant_id = $1 AND idempotency_key')) {
    return result([...db.expenses.values()].filter((expense) =>
      expense.tenant_id === params[0] && expense.idempotency_key === params[1]
    ))
  }
  if (q.startsWith('SELECT COALESCE(MAX(SUBSTRING(expense_number')) return result([{ next_number: '1' }])
  if (q.startsWith('INSERT INTO expenses')) {
    const expenseId = id()
    const expense = {
      id: expenseId, tenant_id: params[0], expense_number: params[1], expense_date: params[2],
      category_id: params[3], supplier_id: params[4], payee_name: params[5], description: params[6],
      amount: params[7], currency: params[8], payment_method: params[9], payment_reference: params[10],
      notes: params[11], created_by: params[12], idempotency_key: params[13], status: 'draft',
      approved_by: null, approved_at: null, paid_by: null, paid_at: null,
      cancelled_by: null, cancelled_at: null, created_at: '2026-10-19T08:00:00.000Z',
      updated_at: '2026-10-19T08:00:00.000Z'
    }
    db.expenses.set(expenseId, expense)
    return result([{ id: expenseId }])
  }
  if (q.startsWith('SELECT e.*, c.name AS category_name')) {
    const byId = q.includes('WHERE e.id = $1 AND e.tenant_id = $2')
    if (byId) {
      const expense = db.expenses.get(params[0])
      return result(expense?.tenant_id === params[1] ? [withNames(db, expense)] : [])
    }
    let rows = [...db.expenses.values()].filter((expense) => expense.tenant_id === params[0])
    if (params[2]) rows = rows.filter((expense) => expense.status === params[2])
    if (params[3]) rows = rows.filter((expense) => expense.category_id === params[3])
    if (params[4]) rows = rows.filter((expense) => expense.expense_date >= params[4])
    if (params[5]) rows = rows.filter((expense) => expense.expense_date <= params[5])
    if (params[6]) rows = rows.filter((expense) => `${expense.payee_name || ''} ${db.suppliers.get(expense.supplier_id)?.business_name || ''}`.toLowerCase().includes(params[6].toLowerCase()))
    if (params[1]) rows = rows.filter((expense) => `${expense.expense_number} ${expense.description} ${expense.payee_name || ''}`.toLowerCase().includes(params[1].toLowerCase()))
    return result(rows.map((expense) => withNames(db, expense)))
  }
  if (q.startsWith('SELECT c.*')) {
    let rows = [...db.categories.values()].filter((category) => category.tenant_id === params[0])
    if (params[1] !== null) rows = rows.filter((category) => category.is_active === params[1])
    return result(rows.map((category) => ({ ...category, expense_count: [...db.expenses.values()].filter((e) => e.tenant_id === category.tenant_id && e.category_id === category.id).length })))
  }
  if (q.startsWith('INSERT INTO expense_categories')) {
    const exists = [...db.categories.values()].some((category) => category.tenant_id === params[0] && category.name.toLowerCase() === params[1].toLowerCase())
    if (exists) {
      const error = new Error('duplicate category')
      error.code = '23505'
      throw error
    }
    const category = { id: id(), tenant_id: params[0], name: params[1], description: params[2], is_active: true, created_at: '2026-10-19T08:00:00.000Z' }
    db.categories.set(category.id, category)
    return result([category])
  }
  if (q.startsWith('UPDATE expense_categories')) {
    const category = db.categories.get(params[0])
    if (!category || category.tenant_id !== params[1]) return result([])
    category.is_active = false
    return result([category])
  }
  if (q.startsWith('SELECT id, status FROM expenses WHERE id = $1 AND tenant_id = $2 FOR UPDATE')) {
    const expense = db.expenses.get(params[0])
    return result(expense?.tenant_id === params[1] ? [{ id: expense.id, status: expense.status }] : [])
  }
  if (q.startsWith('SELECT * FROM expenses WHERE id = $1 AND tenant_id = $2 FOR UPDATE')) {
    const expense = db.expenses.get(params[0])
    return result(expense?.tenant_id === params[1] ? [{ ...expense }] : [])
  }
  if (q.startsWith('UPDATE expenses SET expense_date')) {
    const expense = db.expenses.get(params[10])
    if (!expense || expense.tenant_id !== params[11]) return result([])
    Object.assign(expense, {
      expense_date: params[0], category_id: params[1], supplier_id: params[2], payee_name: params[3],
      description: params[4], amount: params[5], currency: params[6], payment_method: params[7],
      payment_reference: params[8], notes: params[9]
    })
    return result([expense])
  }
  if (q.startsWith("UPDATE expenses SET status = 'approved'")) {
    if (db.failExpenseUpdate === 'approved') throw new Error('Simulated status update failure')
    const expense = db.expenses.get(params[1])
    if (!expense || expense.tenant_id !== params[2] || expense.status !== 'draft') return result([])
    Object.assign(expense, { status: 'approved', approved_by: params[0], approved_at: '2026-10-19T08:01:00.000Z' })
    return result([expense])
  }
  if (q.startsWith("UPDATE expenses SET status = 'paid'")) {
    if (db.failExpenseUpdate === 'paid') throw new Error('Simulated payment status update failure')
    const expense = db.expenses.get(params[3])
    if (!expense || expense.tenant_id !== params[4] || expense.status !== 'approved') return result([])
    Object.assign(expense, {
      status: 'paid', payment_method: params[0], payment_reference: params[1],
      paid_by: params[2], paid_at: '2026-10-19T08:02:00.000Z'
    })
    return result([expense])
  }
  if (q.startsWith("UPDATE expenses SET status = 'cancelled'")) {
    const expense = db.expenses.get(params[1])
    if (!expense || expense.tenant_id !== params[2] || expense.status !== params[3]) return result([])
    Object.assign(expense, { status: 'cancelled', cancelled_by: params[0], cancelled_at: '2026-10-19T08:03:00.000Z' })
    return result([expense])
  }
  if (q.startsWith('SELECT currency, SUM(amount)')) {
    db.summaryQueries.push({ sql: q, params })
    const rows = []
    const expenses = [...db.expenses.values()].filter((expense) =>
      expense.tenant_id === params[0] && expense.expense_date >= params[1] && expense.expense_date < params[2] && ['approved', 'paid'].includes(expense.status)
    )
    for (const currency of [...new Set(expenses.map((expense) => expense.currency))]) {
      const matching = expenses.filter((expense) => expense.currency === currency)
      rows.push({ currency, total: matching.reduce((sum, expense) => sum + Number(expense.amount), 0).toFixed(2), approved_total: matching.filter((expense) => expense.status === 'approved').reduce((sum, expense) => sum + Number(expense.amount), 0).toFixed(2), paid_total: matching.filter((expense) => expense.status === 'paid').reduce((sum, expense) => sum + Number(expense.amount), 0).toFixed(2), expense_count: matching.length })
    }
    return result(rows)
  }
  if (q.startsWith('SELECT status, currency, SUM(amount)')) {
    db.summaryQueries.push({ sql: q, params })
    return result([])
  }
  if (q.startsWith('SELECT e.category_id, c.name AS category_name')) {
    db.summaryQueries.push({ sql: q, params })
    return result([])
  }
  throw new Error(`Unexpected test query: ${q}`)
}

const fakePool = {
  async query(sql, params = []) { return queryDatabase(state.db, sql, params) },
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

const expenseRouter = require('../src/routes/expenses')
const tokenFor = (tenantId = IDS.tenantA) => jwt.sign({ userId: IDS.userA, tenantId, role: 'admin' }, JWT_TEST_SECRET)

async function withServer(run) {
  const app = express()
  app.use(express.json())
  app.use('/api/expenses', expenseRouter)
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

const expenseBody = (overrides = {}) => ({
  tenant_id: IDS.tenantB,
  expense_number: 'EXP-9999',
  status: 'paid',
  expense_date: '2026-10-19',
  category_id: IDS.categoryA,
  supplier_id: IDS.supplierA,
  payee_name: 'Courier',
  description: 'Office delivery',
  amount: '12.50',
  currency: 'kes',
  payment_method: null,
  payment_reference: null,
  notes: 'Delivery documents',
  created_by: IDS.supplierB,
  ...overrides
})

async function createExpense(baseUrl, overrides = {}, tenantId = IDS.tenantA, idempotencyKey = 'expense-create-001') {
  return request(baseUrl, '/api/expenses', {
    method: 'POST', tenantId, body: expenseBody(overrides), idempotencyKey
  })
}

test.beforeEach(() => { state.db = makeState(); nextTestId = 1 })

test('creates a tenant-owned draft and ignores client-supplied identity, number, status and creator', async () => {
  await withServer(async (baseUrl) => {
    const response = await createExpense(baseUrl)
    assert.equal(response.status, 201)
    assert.equal(response.data.tenant_id, IDS.tenantA)
    assert.equal(response.data.expense_number, 'EXP-0001')
    assert.equal(response.data.status, 'draft')
    assert.equal(response.data.amount, '12.50')
    assert.equal(response.data.currency, 'KES')
    assert.equal(response.data.created_by, IDS.userA)
    assert.equal(response.data.category_name, 'Office')
    assert.equal(response.data.supplier_name, 'Local Supplier')
  })
})

test('rejects foreign categories and suppliers without exposing their records', async () => {
  await withServer(async (baseUrl) => {
    const foreignCategory = await createExpense(baseUrl, { category_id: IDS.categoryB })
    assert.equal(foreignCategory.status, 404)
    assert.deepEqual(foreignCategory.data, { error: 'Expense category not found' })
    const foreignSupplier = await createExpense(baseUrl, { supplier_id: IDS.supplierB }, IDS.tenantA, 'expense-create-002')
    assert.equal(foreignSupplier.status, 404)
    assert.deepEqual(foreignSupplier.data, { error: 'Supplier not found' })
    assert.equal(state.db.expenses.size, 0)
  })
})

test('validates amount, date, currency, category and payment method before opening a transaction', async () => {
  await withServer(async (baseUrl) => {
    for (const overrides of [
      { amount: '0' }, { amount: 'Infinity' }, { amount: '1.234' },
      { expense_date: '2026-02-30' }, { currency: 'KES1' }, { payment_method: 'wire' },
      { category_id: 'invalid' }
    ]) {
      const response = await createExpense(baseUrl, overrides, IDS.tenantA, `expense-invalid-${Math.random().toString(36).slice(2, 12)}`)
      assert.equal(response.status, 400)
    }
    assert.equal(state.db.expenses.size, 0)
    assert.equal(state.db.commitCount, 0)
    const missingKey = await request(baseUrl, '/api/expenses', { method: 'POST', body: expenseBody() })
    assert.equal(missingKey.status, 400)
  })
})

test('returns an existing expense for an identical idempotency replay and rejects key reuse with different input', async () => {
  await withServer(async (baseUrl) => {
    const first = await createExpense(baseUrl)
    const replay = await createExpense(baseUrl)
    assert.equal(first.status, 201)
    assert.equal(replay.status, 200)
    assert.equal(replay.data.id, first.data.id)
    const changed = await createExpense(baseUrl, { amount: '13.00' })
    assert.equal(changed.status, 409)
    assert.equal(state.db.expenses.size, 1)
  })
})

test('expense detail and list only return rows belonging to the JWT tenant', async () => {
  await withServer(async (baseUrl) => {
    const own = await createExpense(baseUrl)
    const foreign = await createExpense(baseUrl, { category_id: IDS.categoryB, supplier_id: IDS.supplierB }, IDS.tenantB, 'expense-foreign-001')
    assert.equal(foreign.status, 201)
    const list = await request(baseUrl, '/api/expenses')
    assert.deepEqual(list.data.map((expense) => expense.id), [own.data.id])
    const detail = await request(baseUrl, `/api/expenses/${foreign.data.id}`)
    assert.equal(detail.status, 404)
    assert.deepEqual(detail.data, { error: 'Expense not found' })
    const crossTenantEdit = await request(baseUrl, `/api/expenses/${foreign.data.id}`, { method: 'PUT', body: expenseBody() })
    assert.equal(crossTenantEdit.status, 404)
    const crossTenantApprove = await request(baseUrl, `/api/expenses/${foreign.data.id}/status`, { method: 'PATCH', body: { status: 'approved' } })
    assert.equal(crossTenantApprove.status, 404)
    assert.equal(state.db.expenses.get(foreign.data.id).status, 'draft')
  })
})

test('enforces draft to approved to paid transitions and records payment audit fields', async () => {
  await withServer(async (baseUrl) => {
    const created = await createExpense(baseUrl)
    const draftPayment = await request(baseUrl, `/api/expenses/${created.data.id}/status`, { method: 'PATCH', body: { status: 'paid', payment_method: 'mpesa' } })
    assert.equal(draftPayment.status, 409)
    const approved = await request(baseUrl, `/api/expenses/${created.data.id}/status`, { method: 'PATCH', body: { status: 'approved' } })
    assert.equal(approved.status, 200)
    assert.equal(approved.data.status, 'approved')
    assert.equal(approved.data.approved_by, IDS.userA)
    assert.ok(approved.data.approved_at)
    const missingMethod = await request(baseUrl, `/api/expenses/${created.data.id}/status`, { method: 'PATCH', body: { status: 'paid' } })
    assert.equal(missingMethod.status, 400)
    assert.equal(state.db.expenses.get(created.data.id).status, 'approved')
    const paid = await request(baseUrl, `/api/expenses/${created.data.id}/status`, { method: 'PATCH', body: { status: 'paid', payment_method: 'mpesa', payment_reference: 'QW123' } })
    assert.equal(paid.status, 200)
    assert.equal(paid.data.status, 'paid')
    assert.equal(paid.data.payment_method, 'mpesa')
    assert.equal(paid.data.payment_reference, 'QW123')
    assert.equal(paid.data.paid_by, IDS.userA)
    assert.ok(paid.data.paid_at)
    const replay = await request(baseUrl, `/api/expenses/${created.data.id}/status`, { method: 'PATCH', body: { status: 'paid', payment_method: 'mpesa', payment_reference: 'QW123' } })
    assert.equal(replay.status, 200)
    const invalidPaidMutation = await request(baseUrl, `/api/expenses/${created.data.id}/status`, { method: 'PATCH', body: { status: 'paid', payment_method: 'cash' } })
    assert.equal(invalidPaidMutation.status, 409)
    const cancelled = await request(baseUrl, `/api/expenses/${created.data.id}/status`, { method: 'PATCH', body: { status: 'cancelled' } })
    assert.equal(cancelled.status, 409)
  })
})

test('a failed payment transition rolls back and leaves the expense approved', async (t) => {
  t.mock.method(console, 'error', () => {})
  await withServer(async (baseUrl) => {
    const created = await createExpense(baseUrl)
    await request(baseUrl, `/api/expenses/${created.data.id}/status`, { method: 'PATCH', body: { status: 'approved' } })
    state.db.failExpenseUpdate = 'paid'
    const response = await request(baseUrl, `/api/expenses/${created.data.id}/status`, { method: 'PATCH', body: { status: 'paid', payment_method: 'bank_transfer', payment_reference: 'TRX-1' } })
    assert.equal(response.status, 500)
    assert.equal(state.db.rollbackCount, 1)
    assert.equal(state.db.expenses.get(created.data.id).status, 'approved')
    assert.equal(state.db.expenses.get(created.data.id).paid_by, null)
    assert.equal(state.db.expenses.get(created.data.id).paid_at, null)
  })
})

test('summarizes approved and paid expenses by currency and scopes every aggregate by tenant', async () => {
  await withServer(async (baseUrl) => {
    const first = await createExpense(baseUrl)
    await request(baseUrl, `/api/expenses/${first.data.id}/status`, { method: 'PATCH', body: { status: 'approved' } })
    await request(baseUrl, `/api/expenses/${first.data.id}/status`, { method: 'PATCH', body: { status: 'paid', payment_method: 'cash' } })
    const second = await createExpense(baseUrl, { amount: '7.00', currency: 'USD' }, IDS.tenantA, 'expense-create-002')
    await request(baseUrl, `/api/expenses/${second.data.id}/status`, { method: 'PATCH', body: { status: 'approved' } })
    const response = await request(baseUrl, '/api/expenses/summary?period=month')
    assert.equal(response.status, 200)
    assert.deepEqual(response.data.currency_totals.map((item) => item.currency), ['KES', 'USD'])
    assert.equal(response.data.currency_totals.find((item) => item.currency === 'KES').total, '12.50')
    assert.equal(response.data.currency_totals.find((item) => item.currency === 'USD').approved_total, '7.00')
    assert.equal(state.db.summaryQueries.length, 3)
    assert.ok(state.db.summaryQueries.every((query) => query.params[0] === IDS.tenantA))
  })
})

test('creates and deactivates tenant-scoped expense categories', async () => {
  await withServer(async (baseUrl) => {
    const added = await request(baseUrl, '/api/expenses/categories', { method: 'POST', body: { name: 'Travel', description: 'Local transport' } })
    assert.equal(added.status, 201)
    assert.equal(added.data.tenant_id, IDS.tenantA)
    const duplicate = await request(baseUrl, '/api/expenses/categories', { method: 'POST', body: { name: ' travel ' } })
    assert.equal(duplicate.status, 409)
    const deactivated = await request(baseUrl, `/api/expenses/categories/${added.data.id}/deactivate`, { method: 'PATCH' })
    assert.equal(deactivated.status, 200)
    assert.equal(deactivated.data.is_active, false)
    const foreign = await request(baseUrl, `/api/expenses/categories/${IDS.categoryB}/deactivate`, { method: 'PATCH' })
    assert.equal(foreign.status, 404)
  })
})

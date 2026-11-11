const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const Module = require('node:module')
const express = require('express')
const jwt = require('jsonwebtoken')

const JWT_TEST_SECRET = 'invoxa-invoice-route-tests-only'
process.env.JWT_SECRET = JWT_TEST_SECRET

const IDS = {
  tenantA: '10000000-0000-4000-8000-000000000001',
  tenantB: '10000000-0000-4000-8000-000000000002',
  clientA: '20000000-0000-4000-8000-000000000001',
  clientB: '20000000-0000-4000-8000-000000000002',
  invoiceA: '30000000-0000-4000-8000-000000000001',
  invoiceB: '30000000-0000-4000-8000-000000000002',
  newInvoice: '30000000-0000-4000-8000-000000000003',
  taxProfileA: '50000000-0000-4000-8000-000000000001',
  taxAccountA: '50000000-0000-4000-8000-000000000002',
  userA: '40000000-0000-4000-8000-000000000001',
  userReader: '40000000-0000-4000-8000-000000000002'
}

const makeInvoice = (id, tenantId, clientId, invoiceNumber) => ({
  id,
  tenant_id: tenantId,
  client_id: clientId,
  invoice_number: invoiceNumber,
  due_date: null,
  subtotal: '100.00',
  tax_rate: '16.00',
  tax_amount: '16.00',
  total: '116.00',
  notes: null,
  status: 'draft',
  created_at: '2026-10-18T00:00:00.000Z'
})

const state = {
  reset() {
    this.queries = []
    this.transactionQueries = []
    this.committedInvoices = []
    this.committedItems = []
    this.committedTaxSnapshots = []
    this.commitCount = 0
    this.rollbackCount = 0
    this.releases = []
    this.failItemInsert = false
    this.pdfCalls = 0
    this.lastPdfArgs = null
    this.finalizeCalls = []
    this.clients = new Map([
      [IDS.clientA, { id: IDS.clientA, tenant_id: IDS.tenantA, name: 'Tenant A client' }],
      [IDS.clientB, { id: IDS.clientB, tenant_id: IDS.tenantB, name: 'Tenant B private client' }]
    ])
    this.invoices = new Map([
      [IDS.invoiceA, makeInvoice(IDS.invoiceA, IDS.tenantA, IDS.clientA, 'INV-0001')],
      [IDS.invoiceB, makeInvoice(IDS.invoiceB, IDS.tenantB, IDS.clientB, 'INV-0001')]
    ])
    this.items = new Map([
      [IDS.invoiceA, [{ invoice_id: IDS.invoiceA, description: 'Tenant A item', quantity: 1, unit_price: 100, amount: 100 }]],
      [IDS.invoiceB, [{ invoice_id: IDS.invoiceB, description: 'Tenant B private item', quantity: 1, unit_price: 100, amount: 100 }]]
    ])
    this.taxProfiles = new Map([[IDS.taxProfileA, {
      id: IDS.taxProfileA, tenant_id: IDS.tenantA, profile_key: 'standard', name: 'Configured tax',
      version: 1, tax_rate: '16.00', calculation_method: 'exclusive',
      rounding_method: 'invoice_total', effective_from: '2020-01-01', effective_to: null,
      requires_tax_payable: true, tax_payable_account_id: IDS.taxAccountA,
      is_active: true, created_by: IDS.userA
    }]])
    this.taxSnapshots = []
  }
}
state.reset()

const normalizeSql = (sql) => sql.replace(/\s+/g, ' ').trim()
const fakePool = {
  async query(sql, params = []) {
    const normalizedSql = normalizeSql(sql)
    state.queries.push({ sql: normalizedSql, params })

    if (normalizedSql.startsWith("UPDATE invoices SET status = 'overdue'")) {
      return { rows: [], rowCount: 0 }
    }

    if (normalizedSql.startsWith('SELECT i.*, c.name AS client_name')) {
      if (normalizedSql.includes('ORDER BY i.created_at DESC')) {
        const rows = [...state.invoices.values()]
          .filter((invoice) => {
            const client = state.clients.get(invoice.client_id)
            return invoice.tenant_id === params[0] && client?.tenant_id === invoice.tenant_id
          })
          .map((invoice) => ({
            ...invoice,
            client_name: state.clients.get(invoice.client_id).name,
            client_email: null
          }))
        return { rows, rowCount: rows.length }
      }

      const invoice = state.invoices.get(params[0])
      const client = invoice && state.clients.get(invoice.client_id)
      if (!invoice || invoice.tenant_id !== params[1] || client?.tenant_id !== invoice.tenant_id) {
        return { rows: [], rowCount: 0 }
      }
      return {
        rows: [{ ...invoice, client_name: client.name, client_email: null }],
        rowCount: 1
      }
    }

    if (normalizedSql.startsWith('SELECT role FROM users WHERE id = $1 AND tenant_id = $2')) {
      const role = params[0] === IDS.userA && params[1] === IDS.tenantA ? 'admin'
        : params[0] === IDS.userReader && params[1] === IDS.tenantA ? 'staff' : null
      const rows = role ? [{ role }] : []
      return { rows, rowCount: rows.length }
    }

    if (normalizedSql.startsWith('SELECT ii.* FROM invoice_items ii')) {
      const invoice = state.invoices.get(params[0])
      const rows = invoice?.tenant_id === params[1] ? (state.items.get(invoice.id) || []) : []
      return { rows, rowCount: rows.length }
    }

    if (normalizedSql.startsWith('SELECT * FROM tenants WHERE id = $1')) {
      const rows = [IDS.tenantA, IDS.tenantB].includes(params[0]) ? [{ id: params[0] }] : []
      return { rows, rowCount: rows.length }
    }

    if (normalizedSql.startsWith('SELECT id FROM invoices WHERE id = $1 AND tenant_id = $2')) {
      const invoice = state.invoices.get(params[0])
      const rows = invoice?.tenant_id === params[1] ? [{ id: invoice.id }] : []
      return { rows, rowCount: rows.length }
    }
    if (normalizedSql.startsWith("UPDATE invoices SET status='overdue'")) {
      const invoice = state.invoices.get(params[0])
      const rows = invoice?.tenant_id === params[1] && ['sent', 'overdue'].includes(invoice.status)
        ? [{ ...invoice, status: 'overdue' }] : []
      return { rows, rowCount: rows.length }
    }

    if (normalizedSql.startsWith('DELETE FROM invoices')) {
      const invoice = state.invoices.get(params[0])
      const rows = invoice?.tenant_id === params[1] ? [{ id: invoice.id }] : []
      return { rows, rowCount: rows.length }
    }

    throw new Error(`Unexpected pool query in test: ${normalizedSql}`)
  },

  async connect() {
    const pendingInvoices = []
    const pendingItems = []
    const pendingTaxSnapshots = []
    const pendingDeletes = []
    return {
      async query(sql, params = []) {
        const normalizedSql = normalizeSql(sql)
        state.transactionQueries.push({ sql: normalizedSql, params })

        if (normalizedSql.startsWith('BEGIN ')) return { rows: [], rowCount: 0 }
        if (normalizedSql === 'COMMIT') {
          state.committedInvoices.push(...pendingInvoices)
          state.committedItems.push(...pendingItems)
          state.committedTaxSnapshots.push(...pendingTaxSnapshots)
          for (const invoiceId of pendingDeletes) state.invoices.delete(invoiceId)
          state.commitCount += 1
          return { rows: [], rowCount: 0 }
        }
        if (normalizedSql === 'ROLLBACK') {
          pendingInvoices.length = 0
          pendingItems.length = 0
          pendingTaxSnapshots.length = 0
          pendingDeletes.length = 0
          state.rollbackCount += 1
          return { rows: [], rowCount: 0 }
        }
        if (normalizedSql.startsWith('SELECT id FROM tenants')) {
          const rows = params[0] === IDS.tenantA ? [{ id: IDS.tenantA }] : []
          return { rows, rowCount: rows.length }
        }
        if (normalizedSql.startsWith('SELECT id FROM clients')) {
          const client = state.clients.get(params[0])
          const rows = client?.tenant_id === params[1] ? [{ id: client.id }] : []
          return { rows, rowCount: rows.length }
        }
        if (normalizedSql.startsWith('SELECT CURRENT_DATE::text AS issue_date')) {
          return { rows: [{ issue_date: '2026-10-22' }], rowCount: 1 }
        }
        if (normalizedSql.startsWith('SELECT id, tenant_id, profile_key, name, version, tax_rate')) {
          const profile = state.taxProfiles.get(params[1])
          const rows = profile?.tenant_id === params[0] ? [{ ...profile }] : []
          return { rows, rowCount: rows.length }
        }
        if (normalizedSql.startsWith('SELECT account_type, is_active FROM accounting_accounts')) {
          const rows = params[1] === IDS.taxAccountA && params[0] === IDS.tenantA
            ? [{ account_type: 'liability', is_active: true }] : []
          return { rows, rowCount: rows.length }
        }
        if (normalizedSql.startsWith('SELECT COALESCE(')) {
          return { rows: [{ next_number: '3' }], rowCount: 1 }
        }
        if (normalizedSql.startsWith('INSERT INTO invoices')) {
          const invoice = {
            ...makeInvoice(IDS.newInvoice, params[0], params[1], params[2]),
            due_date: params[3],
            subtotal: params[4],
            tax_rate: params[5],
            tax_amount: params[6],
            total: params[7],
            notes: params[8]
          }
          pendingInvoices.push(invoice)
          return { rows: [invoice], rowCount: 1 }
        }
        if (normalizedSql.startsWith('INSERT INTO invoice_items')) {
          if (state.failItemInsert) throw new Error('Simulated item insert failure')
          pendingItems.push({
            invoice_id: params[0],
            description: params[1],
            quantity: params[2],
            unit_price: params[3],
            amount: params[4]
          })
          return { rows: [], rowCount: 1 }
        }
        if (normalizedSql.startsWith('INSERT INTO accounting_invoice_tax_snapshots')) {
          const snapshot = {
            tenant_id: params[0], source_type: params[1], source_id: params[2],
            tax_profile_id: params[3], profile_version: params[4], profile_key: params[5],
            profile_name: params[6], tax_rate: params[7], calculation_method: params[8],
            rounding_method: params[9], requires_tax_payable: params[10],
            tax_payable_account_id: params[11], subtotal: params[12],
            tax_amount: params[13], total: params[14], created_by: params[15], issued_at: null
          }
          pendingTaxSnapshots.push(snapshot)
          return { rows: [{ id: '60000000-0000-4000-8000-000000000001' }], rowCount: 1 }
        }
        if (normalizedSql.startsWith('SELECT id, status FROM invoices WHERE id = $1 AND tenant_id = $2 FOR UPDATE')) {
          const invoice = state.invoices.get(params[0])
          const rows = invoice?.tenant_id === params[1] ? [{ id: invoice.id, status: invoice.status }] : []
          return { rows, rowCount: rows.length }
        }
        if (normalizedSql.startsWith('DELETE FROM accounting_invoice_tax_snapshots')) return { rows: [], rowCount: 0 }
        if (normalizedSql.startsWith("DELETE FROM invoices WHERE id = $1 AND tenant_id = $2 AND status = 'draft'")) {
          const invoice = state.invoices.get(params[0])
          if (invoice?.tenant_id === params[1] && invoice.status === 'draft') pendingDeletes.push(invoice.id)
          return { rows: invoice?.tenant_id === params[1] && invoice.status === 'draft' ? [{ id: invoice.id }] : [], rowCount: invoice?.tenant_id === params[1] && invoice.status === 'draft' ? 1 : 0 }
        }

        throw new Error(`Unexpected transaction query in test: ${normalizedSql}`)
      },
      release(error) {
        state.releases.push(error || null)
      }
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
installMockModule(require.resolve('../src/config/pdf'), {
  async generateInvoicePDF(...args) {
    state.pdfCalls += 1
    state.lastPdfArgs = args
    return Buffer.from('%PDF-test')
  }
})
installMockModule(require.resolve('../src/services/invoiceAccounting'), {
  async finalizeInvoice(_pool, input) {
    state.finalizeCalls.push(input)
    if (input.tenantId === IDS.tenantA && input.invoiceId === IDS.invoiceB) {
      const error = new Error('Invoice not found')
      error.statusCode = 404
      throw error
    }
    return { invoice: { id: input.invoiceId, status: 'sent' }, journal: { id: '70000000-0000-4000-8000-000000000001' }, replayed: false }
  }
})

const invoiceRouter = require('../src/routes/invoices')

const tokenFor = (tenantId = IDS.tenantA, userId = IDS.userA, role = 'admin') => jwt.sign({
  userId,
  tenantId,
  email: 'test@example.invalid',
  role
}, JWT_TEST_SECRET)

async function withServer(run) {
  const app = express()
  app.use(express.json())
  app.use('/api/invoices', invoiceRouter)
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

async function request(baseUrl, path, {
  method = 'GET', tenantId = IDS.tenantA, userId = IDS.userA, role = 'admin', authenticated = true, body
} = {}) {
  const headers = {}
  if (authenticated) headers.Authorization = `Bearer ${tokenFor(tenantId, userId, role)}`
  const options = { method, headers }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    options.body = JSON.stringify(body)
  }
  const response = await fetch(new URL(path, baseUrl), options)
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/pdf')) {
    return { status: response.status, data: Buffer.from(await response.arrayBuffer()), response }
  }
  const text = await response.text()
  return { status: response.status, data: text ? JSON.parse(text) : null, response }
}

test.beforeEach(() => state.reset())

test('rejects malformed invoice items before opening a transaction', async () => {
  await withServer(async (baseUrl) => {
    const result = await request(baseUrl, '/api/invoices', {
      method: 'POST',
      body: {
        client_id: IDS.clientA,
        tax_profile_id: IDS.taxProfileA,
        items: [{ description: 'Consulting', quantity: '', unit_price: 100 }]
      }
    })

    assert.equal(result.status, 400)
    assert.match(result.data.error, /precision|range/)
    assert.equal(state.transactionQueries.length, 0)
    assert.equal(state.releases.length, 0)
  })
})

test('creates an invoice for an owned client using the JWT tenant, not body tenant_id', async () => {
  await withServer(async (baseUrl) => {
    const result = await request(baseUrl, '/api/invoices', {
      method: 'POST',
      body: {
        tenant_id: IDS.tenantB,
        client_id: IDS.clientA,
        tax_profile_id: IDS.taxProfileA,
        tax_rate: 0,
        items: [{ description: 'Consulting', quantity: 1, unit_price: 100 }]
      }
    })

    assert.equal(result.status, 201)
    assert.equal(result.data.tenant_id, IDS.tenantA)
    assert.equal(result.data.invoice_number, 'INV-0003')
    assert.equal(result.data.subtotal, '100.00')
    assert.equal(result.data.tax_amount, '16.00')
    assert.equal(result.data.total, '116.00')
    assert.equal(state.commitCount, 1)
    assert.equal(state.rollbackCount, 0)
    assert.equal(state.committedInvoices.length, 1)
    assert.equal(state.committedTaxSnapshots.length, 1)
    assert.equal(state.committedTaxSnapshots[0].tax_rate, '16.00')
    assert.equal(state.committedInvoices[0].tenant_id, IDS.tenantA)
    assert.equal(state.finalizeCalls.length, 0)
    assert.deepEqual(state.committedItems.map((item) => item.invoice_id), [IDS.newInvoice])
    assert.deepEqual(
      state.transactionQueries.find((query) => query.sql.startsWith('SELECT id FROM clients')).params,
      [IDS.clientA, IDS.tenantA]
    )
  })
})

test('invoice finalization is explicitly authorized and tenant-scoped at the route boundary', async () => {
  await withServer(async (baseUrl) => {
    const forbidden = await request(baseUrl, `/api/invoices/${IDS.invoiceA}/finalize`, {
      method: 'POST', userId: IDS.userReader, role: 'staff', body: {}
    })
    assert.equal(forbidden.status, 403)
    assert.equal(state.finalizeCalls.length, 0)

    const foreign = await request(baseUrl, `/api/invoices/${IDS.invoiceB}/finalize`, {
      method: 'POST', body: { issue_date: '2026-10-22' }
    })
    assert.equal(foreign.status, 404)
    assert.deepEqual(foreign.data, { error: 'Invoice not found' })
    assert.equal(state.finalizeCalls.length, 1)
    assert.equal(state.finalizeCalls[0].invoiceId, IDS.invoiceB)

    const issued = await request(baseUrl, `/api/invoices/${IDS.invoiceA}/finalize`, {
      method: 'POST', body: { issue_date: '2026-10-22', total: '0.01' }
    })
    assert.equal(issued.status, 400)
    assert.equal(state.finalizeCalls.length, 1)

    const valid = await request(baseUrl, `/api/invoices/${IDS.invoiceA}/finalize`, {
      method: 'POST', body: { issue_date: '2026-10-22' }
    })
    assert.equal(valid.status, 201)
    assert.equal(state.finalizeCalls.length, 2)
    assert.equal(state.finalizeCalls[1].tenantId, IDS.tenantA)
  })
})

test('unauthenticated invoice finalization is rejected before invoice or journal work', async () => {
  await withServer(async (baseUrl) => {
    const before = structuredClone(state.invoices.get(IDS.invoiceA))
    const response = await request(baseUrl, `/api/invoices/${IDS.invoiceA}/finalize`, {
      method: 'POST', authenticated: false, body: { issue_date: '2026-10-22' }
    })

    assert.equal(response.status, 401)
    assert.deepEqual(response.data, { error: 'No token provided' })
    assert.deepEqual(state.invoices.get(IDS.invoiceA), before)
    assert.equal(state.finalizeCalls.length, 0)
    assert.equal(state.queries.length, 0)
    assert.equal(state.transactionQueries.length, 0)
    assert.equal(state.commitCount, 0)
    assert.equal(state.rollbackCount, 0)
    assert.deepEqual(state.committedInvoices, [])
    assert.deepEqual(state.committedTaxSnapshots, [])
  })
})

test('rejects a client owned by another tenant with a generic 404 and rolls back', async () => {
  await withServer(async (baseUrl) => {
    const result = await request(baseUrl, '/api/invoices', {
      method: 'POST',
      body: {
        client_id: IDS.clientB,
        tax_profile_id: IDS.taxProfileA,
        items: [{ description: 'Consulting', quantity: 1, unit_price: 100 }]
      }
    })

    assert.equal(result.status, 404)
    assert.deepEqual(result.data, { error: 'Client not found' })
    assert.equal(JSON.stringify(result.data).includes('Tenant B'), false)
    assert.equal(state.rollbackCount, 1)
    assert.equal(state.commitCount, 0)
    assert.equal(state.committedInvoices.length, 0)
    assert.equal(state.transactionQueries.some((query) => query.sql.startsWith('SELECT COALESCE(')), false)
  })
})

test('list and invoice detail, status, and deletion remain tenant-scoped', async () => {
  await withServer(async (baseUrl) => {
    const list = await request(baseUrl, '/api/invoices')
    assert.equal(list.status, 200)
    assert.deepEqual(list.data.map((invoice) => invoice.id), [IDS.invoiceA])
    const listQuery = state.queries.find((query) => query.sql.includes('ORDER BY i.created_at DESC'))
    assert.match(listQuery.sql, /i\.tenant_id = \$1/)
    assert.match(listQuery.sql, /c\.tenant_id = i\.tenant_id/)

    const detail = await request(baseUrl, `/api/invoices/${IDS.invoiceB}`)
    assert.equal(detail.status, 404)
    assert.deepEqual(detail.data, { error: 'Invoice not found' })

    const status = await request(baseUrl, `/api/invoices/${IDS.invoiceB}/status`, {
      method: 'PATCH',
      body: { status: 'paid', tenant_id: IDS.tenantB }
    })
    assert.equal(status.status, 404)
    assert.deepEqual(status.data, { error: 'Invoice not found' })

    for (const requestedStatus of ['sent', 'paid']) {
      const guarded = await request(baseUrl, `/api/invoices/${IDS.invoiceA}/status`, {
        method: 'PATCH', body: { status: requestedStatus }
      })
      assert.equal(guarded.status, 409)
      assert.match(guarded.data.error, /authorized invoice issuance or verified payment workflow/)
    }
    assert.equal(state.invoices.get(IDS.invoiceA).status, 'draft')

    const deletion = await request(baseUrl, `/api/invoices/${IDS.invoiceB}`, {
      method: 'DELETE'
    })
    assert.equal(deletion.status, 404)
    assert.deepEqual(deletion.data, { error: 'Invoice not found' })

    const statusQuery = state.queries.find((query) => query.sql.startsWith('SELECT id FROM invoices WHERE id = $1 AND tenant_id = $2'))
    const deleteQuery = state.transactionQueries.find((query) => query.sql.startsWith('SELECT id, status FROM invoices WHERE id = $1 AND tenant_id = $2 FOR UPDATE'))
    assert.deepEqual(statusQuery.params, [IDS.invoiceB, IDS.tenantA])
    assert.deepEqual(deleteQuery.params, [IDS.invoiceB, IDS.tenantA])
  })
})

test('invoice item and PDF reads are scoped through the authenticated tenant invoice', async () => {
  await withServer(async (baseUrl) => {
    const foreignPdf = await request(baseUrl, `/api/invoices/${IDS.invoiceB}/pdf`)
    assert.equal(foreignPdf.status, 404)
    assert.equal(state.pdfCalls, 0)
    assert.equal(state.queries.some((query) => query.sql.startsWith('SELECT ii.* FROM invoice_items ii')), false)

    const ownDetail = await request(baseUrl, `/api/invoices/${IDS.invoiceA}`)
    assert.equal(ownDetail.status, 200)
    assert.equal(ownDetail.data.items[0].description, 'Tenant A item')

    const ownPdf = await request(baseUrl, `/api/invoices/${IDS.invoiceA}/pdf`)
    assert.equal(ownPdf.status, 200)
    assert.equal(ownPdf.response.headers.get('content-type'), 'application/pdf')
    assert.equal(state.pdfCalls, 1)
    assert.equal(state.lastPdfArgs[1][0].description, 'Tenant A item')

    const itemQueries = state.queries.filter((query) => query.sql.startsWith('SELECT ii.* FROM invoice_items ii'))
    assert.equal(itemQueries.length, 2)
    for (const query of itemQueries) {
      assert.match(query.sql, /JOIN invoices i ON i\.id = ii\.invoice_id/)
      assert.match(query.sql, /i\.id = \$1 AND i\.tenant_id = \$2/)
      assert.deepEqual(query.params, [IDS.invoiceA, IDS.tenantA])
    }
  })
})

test('invoice creation rolls back when a line-item insert fails', async (t) => {
  t.mock.method(console, 'error', () => {})
  state.failItemInsert = true
  await withServer(async (baseUrl) => {
    const result = await request(baseUrl, '/api/invoices', {
      method: 'POST',
      body: {
        client_id: IDS.clientA,
        tax_profile_id: IDS.taxProfileA,
        items: [{ description: 'Consulting', quantity: 1, unit_price: 100 }]
      }
    })

    assert.equal(result.status, 500)
    assert.deepEqual(result.data, { error: 'Failed to create invoice' })
    assert.equal(state.rollbackCount, 1)
    assert.equal(state.commitCount, 0)
    assert.equal(state.committedInvoices.length, 0)
    assert.equal(state.committedItems.length, 0)
    assert.equal(state.releases.length, 1)
  })
})

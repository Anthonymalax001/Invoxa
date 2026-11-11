const test = require('node:test')
const assert = require('node:assert/strict')

const IDS = {
  tenant: '10000000-0000-4000-8000-000000000001',
  otherTenant: '10000000-0000-4000-8000-000000000002',
  user: '20000000-0000-4000-8000-000000000001',
  client: '30000000-0000-4000-8000-000000000001',
  invoice: '40000000-0000-4000-8000-000000000001',
  profile: '50000000-0000-4000-8000-000000000001',
  receivables: '60000000-0000-4000-8000-000000000001',
  revenue: '60000000-0000-4000-8000-000000000002',
  payable: '60000000-0000-4000-8000-000000000003',
  period: '70000000-0000-4000-8000-000000000001',
  journal: '80000000-0000-4000-8000-000000000001',
  order: '90000000-0000-4000-8000-000000000001'
}

const accounting = require('../src/services/accounting')
const postCalls = []
let failPostingAfterJournalWrites = false
accounting.postJournal = async (_pool, input, { client } = {}) => {
  postCalls.push({ input, client })
  const journal = {
    id: IDS.journal,
    tenant_id: input.tenantId,
    accounting_period_id: input.body.accounting_period_id,
    entry_date: input.body.entry_date,
    description: input.body.description,
    status: 'posted',
    functional_currency: 'KES',
    source_type: input.body.source_type,
    source_id: input.body.source_id,
    source_reference: input.body.source_reference,
    event_type: input.body.event_type,
    posting_event_id: '81000000-0000-4000-8000-000000000001',
    created_by: input.userId,
    posted_by: input.userId
  }
  const postingEvent = {
    id: journal.posting_event_id, tenant_id: input.tenantId, status: 'processing', journal_entry_id: null
  }
  client.data.postingEvents.push(postingEvent)
  client.data.journals.push(journal)
  const lines = input.body.lines.map((line, index) => ({ line_number: index + 1, ...line }))
  client.data.journalLines.push(...lines.map((line) => ({ ...line, tenant_id: input.tenantId, journal_entry_id: journal.id })))
  if (failPostingAfterJournalWrites) throw new Error('Simulated posting failure after journal writes')
  postingEvent.status = 'posted'
  postingEvent.journal_entry_id = journal.id
  return { journal, lines, replayed: false }
}

const invoiceAccountingPath = require.resolve('../src/services/invoiceAccounting')
delete require.cache[invoiceAccountingPath]
const { finalizeInvoice } = require('../src/services/invoiceAccounting')

function makeState(overrides = {}) {
  const profile = {
    id: IDS.profile,
    tenant_id: IDS.tenant,
    profile_key: 'configured-standard',
    name: 'Tenant configured tax',
    version: 1,
    tax_rate: '16.00',
    calculation_method: 'exclusive',
    rounding_method: 'invoice_total',
    effective_from: '2020-01-01',
    effective_to: null,
    requires_tax_payable: true,
    tax_payable_account_id: IDS.payable,
    is_active: true
  }
  const snapshot = {
    tenant_id: IDS.tenant,
    source_type: 'invoice',
    source_id: IDS.invoice,
    tax_profile_id: profile.id,
    profile_version: profile.version,
    profile_key: profile.profile_key,
    profile_name: profile.name,
    tax_rate: profile.tax_rate,
    calculation_method: profile.calculation_method,
    rounding_method: profile.rounding_method,
    requires_tax_payable: profile.requires_tax_payable,
    tax_payable_account_id: profile.tax_payable_account_id,
    subtotal: '100.00',
    tax_amount: '16.00',
    total: '116.00',
    issued_on: null,
    issued_by: null,
    issued_at: null,
    journal_entry_id: null
  }
  return {
    invoice: {
      id: IDS.invoice,
      tenant_id: IDS.tenant,
      client_id: IDS.client,
      invoice_number: 'INV-0001',
      sales_order_id: null,
      subtotal: '100.00',
      tax_rate: '16.00',
      tax_amount: '16.00',
      total: '116.00',
      status: 'draft'
    },
    clientTenant: IDS.tenant,
    snapshot,
    profile,
    settings: { base_currency: 'KES' },
    invoiceLines: [{
      invoice_id: IDS.invoice,
      description: 'Consulting',
      quantity: '1.00',
      unit_price: '100.00',
      amount: '100.00'
    }],
    mapping: { receivables_account_id: IDS.receivables, sales_revenue_account_id: IDS.revenue },
    accounts: [
      { id: IDS.receivables, account_type: 'asset', is_active: true },
      { id: IDS.revenue, account_type: 'revenue', is_active: true },
      { id: IDS.payable, account_type: 'liability', is_active: true }
    ],
    period: { id: IDS.period },
    salesOrder: null,
    salesOrderLines: [],
    journals: [],
    journalLines: [],
    postingEvents: [],
    failCommit: false,
    commitCount: 0,
    rollbackCount: 0,
    ...overrides
  }
}

function result(rows = []) {
  return { rows, rowCount: rows.length }
}

function makePool(initialState = makeState()) {
  const pool = {
    data: initialState,
    connectedClients: [],
    transactionCommands: [],
    async connect() {
      const client = { data: structuredClone(pool.data), released: false }
      client.query = async (sql, params = []) => {
        const query = sql.replace(/\s+/g, ' ').trim()
        if (query.startsWith('BEGIN ')) {
          pool.transactionCommands.push('BEGIN')
          return result()
        }
        if (query === 'COMMIT') {
          pool.transactionCommands.push('COMMIT')
          if (pool.data.failCommit) {
            const error = new Error('Simulated deferred constraint failure at COMMIT')
            error.code = '23514'
            throw error
          }
          client.data.commitCount += 1
          pool.data = client.data
          return result()
        }
        if (query === 'ROLLBACK') {
          pool.transactionCommands.push('ROLLBACK')
          pool.data.rollbackCount += 1
          return result()
        }
        if (query.startsWith('SELECT i.*, c.id AS verified_client_id')) {
          const invoice = client.data.invoice
          if (invoice.id !== params[0] || invoice.tenant_id !== params[1] || client.data.clientTenant !== invoice.tenant_id) return result()
          return result([{ ...invoice, verified_client_id: invoice.client_id }])
        }
        if (query.startsWith('SELECT * FROM accounting_invoice_tax_snapshots')) {
          const snapshot = client.data.snapshot
          return snapshot?.tenant_id === params[0] && snapshot.source_type === 'invoice' && snapshot.source_id === params[1]
            ? result([{ ...snapshot }]) : result()
        }
        if (query.startsWith('SELECT id, tenant_id, profile_key, name, version, tax_rate')) {
          const profile = client.data.profile
          return profile?.tenant_id === params[0] && profile.id === params[1] && profile.version === params[2]
            ? result([{ ...profile }]) : result()
        }
        if (query.startsWith('SELECT base_currency FROM accounting_settings')) {
          return client.data.settings ? result([{ ...client.data.settings }]) : result()
        }
        if (query === 'SELECT CURRENT_DATE::text AS issue_date') {
          return result([{ issue_date: '2026-10-22' }])
        }
        if (query.startsWith('SELECT invoice_id, description, quantity, unit_price, amount FROM invoice_items')) {
          return result(client.data.invoiceLines.map((line) => ({ ...line })))
        }
        if (query.startsWith('SELECT receivables_account_id, sales_revenue_account_id FROM accounting_invoice_mappings')) {
          return client.data.mapping ? result([{ ...client.data.mapping }]) : result()
        }
        if (query.startsWith('SELECT id, account_type, is_active FROM accounting_accounts')) {
          const accountIds = params[1]
          return result(client.data.accounts.filter((account) => accountIds.includes(account.id)).map((account) => ({ ...account })))
        }
        if (query.startsWith('SELECT id FROM accounting_periods')) {
          return client.data.period ? result([{ ...client.data.period }]) : result()
        }
        if (query.startsWith('SELECT id, client_id, status, subtotal, tax_rate, tax_amount, total FROM sales_orders')) {
          const order = client.data.salesOrder
          return order?.tenant_id === params[0] && order.id === params[1] ? result([{ ...order }]) : result()
        }
        if (query.startsWith('SELECT quantity_ordered, line_subtotal FROM sales_order_items')) {
          return result(client.data.salesOrderLines.map((line) => ({ ...line })))
        }
        if (query.startsWith("UPDATE invoices SET status = 'sent'")) {
          if (client.data.invoice.id !== params[0] || client.data.invoice.tenant_id !== params[1] || client.data.invoice.status !== 'draft') return result()
          client.data.invoice.status = 'sent'
          return result([{}])
        }
        if (query.startsWith('UPDATE accounting_invoice_tax_snapshots')) {
          const snapshot = client.data.snapshot
          if (!snapshot || snapshot.tenant_id !== params[3] || snapshot.source_id !== params[4] || snapshot.issued_at) return result()
          snapshot.issued_on = params[0]
          snapshot.issued_by = params[1]
          snapshot.issued_at = '2026-10-22T00:00:00.000Z'
          snapshot.journal_entry_id = params[2]
          return result([{}])
        }
        if (query.startsWith('SELECT * FROM invoices WHERE id = $1 AND tenant_id = $2')) {
          return client.data.invoice.id === params[0] && client.data.invoice.tenant_id === params[1]
            ? result([{ ...client.data.invoice }]) : result()
        }
        if (query.startsWith('SELECT * FROM accounting_journal_entries')) {
          const journal = client.data.journals.find((entry) => entry.id === params[1] && entry.tenant_id === params[0])
          return journal ? result([{ ...journal }]) : result()
        }
        if (query.startsWith('SELECT line_number, account_id, description, debit, credit')) {
          const lines = client.data.journalLines.filter((line) => line.tenant_id === params[0] && line.journal_entry_id === params[1])
          return result(lines.map(({ line_number, account_id, description, debit, credit, transaction_currency, transaction_amount, exchange_rate, exchange_rate_source, exchange_rate_at }) => ({
            line_number, account_id, description, debit, credit, transaction_currency,
            transaction_amount, exchange_rate, exchange_rate_source, exchange_rate_at
          })))
        }
        throw new Error(`Unexpected invoice accounting query: ${query}`)
      }
      client.release = () => { client.released = true }
      pool.connectedClients.push(client)
      return client
    }
  }
  return pool
}

function request(pool, overrides = {}) {
  return finalizeInvoice(pool, {
    tenantId: IDS.tenant,
    userId: IDS.user,
    invoiceId: IDS.invoice,
    ...overrides
  })
}

test('finalizes a direct draft invoice with exact balanced KES journal lines in one caller transaction', async () => {
  postCalls.length = 0
  const pool = makePool()
  const result = await request(pool, { issueDate: '2026-10-22' })

  assert.equal(result.invoice.status, 'sent')
  assert.equal(result.journal.status, 'posted')
  assert.equal(result.replayed, false)
  assert.deepEqual(result.lines.map(({ account_id, debit, credit }) => ({ account_id, debit, credit })), [
    { account_id: IDS.receivables, debit: '116.00', credit: '0.00' },
    { account_id: IDS.revenue, debit: '0.00', credit: '100.00' },
    { account_id: IDS.payable, debit: '0.00', credit: '16.00' }
  ])
  assert.equal(postCalls.length, 1)
  assert.equal(postCalls[0].input.idempotencyKey, `invoice:${IDS.invoice}:issue:v1`)
  assert.equal(postCalls[0].input.body.source_id, IDS.invoice)
  assert.equal(postCalls[0].client, pool.connectedClients[0])
  assert.deepEqual(pool.transactionCommands, ['BEGIN', 'COMMIT'])
  assert.equal(pool.data.commitCount, 1)
  assert.equal(pool.data.journals.length, 1)
  assert.equal(pool.data.postingEvents.length, 1)
  assert.equal(pool.data.postingEvents[0].status, 'posted')
  assert.equal(pool.data.snapshot.issued_on, '2026-10-22')
})

test('same-date retry returns the linked journal and changed issue dates conflict without another posting', async () => {
  postCalls.length = 0
  const pool = makePool()
  await request(pool, { issueDate: '2026-10-22' })
  const retried = await request(pool, { issueDate: '2026-10-22' })
  assert.equal(retried.replayed, true)
  assert.equal(retried.journal.id, IDS.journal)
  assert.equal(postCalls.length, 1)
  await assert.rejects(request(pool, { issueDate: '2026-10-23' }), (error) => error.statusCode === 409)
  assert.equal(postCalls.length, 1)
  assert.equal(pool.data.journals.length, 1)
})

test('Sales Order invoice finalization taxes the discounted line once using the saved snapshot', async () => {
  postCalls.length = 0
  const state = makeState({
    invoice: {
      ...makeState().invoice,
      sales_order_id: IDS.order,
      subtotal: '180.00', tax_amount: '28.80', total: '208.80'
    },
    snapshot: {
      ...makeState().snapshot,
      subtotal: '180.00', tax_amount: '28.80', total: '208.80'
    },
    invoiceLines: [{ invoice_id: IDS.invoice, description: 'Widget - discount 10%', quantity: '2.00', unit_price: '100.00', amount: '180.00' }],
    salesOrder: {
      id: IDS.order, tenant_id: IDS.tenant, client_id: IDS.client, status: 'fulfilled',
      subtotal: '180.00', tax_rate: '16.00', tax_amount: '28.80', total: '208.80'
    },
    salesOrderLines: [{ quantity_ordered: '2.00', line_subtotal: '180.00' }]
  })
  const pool = makePool(state)
  const issued = await request(pool, { issueDate: '2026-10-22' })
  assert.equal(issued.invoice.total, '208.80')
  assert.deepEqual(issued.lines.map(({ debit, credit }) => ({ debit, credit })), [
    { debit: '208.80', credit: '0.00' },
    { debit: '0.00', credit: '180.00' },
    { debit: '0.00', credit: '28.80' }
  ])
  assert.equal(postCalls.length, 1)
})

test('foreign invoices are hidden and previously sent invoices without an issuance snapshot require cutover review', async () => {
  const foreignPool = makePool(makeState({ invoice: { ...makeState().invoice, tenant_id: IDS.otherTenant } }))
  await assert.rejects(request(foreignPool), (error) => error.statusCode === 404)

  const legacyPool = makePool(makeState({ invoice: { ...makeState().invoice, status: 'sent' } }))
  await assert.rejects(request(legacyPool), (error) => error.statusCode === 409 && /approved cutover review/.test(error.message))
  assert.equal(legacyPool.data.journals.length, 0)
})

test('non-KES settings, invalid mappings, missing tax configuration, bad totals, and closed periods prevent posting', async (t) => {
  const cases = [
    ['non-KES base currency', { settings: { base_currency: 'USD' } }],
    ['missing account mappings', { mapping: null }],
    ['missing revenue mapping', { mapping: {
      receivables_account_id: IDS.receivables, sales_revenue_account_id: null
    } }],
    ['unknown revenue account mapping', { mapping: {
      receivables_account_id: IDS.receivables, sales_revenue_account_id: '60000000-0000-4000-8000-000000000099'
    } }],
    ['inactive revenue account mapping', { accounts: [
      { id: IDS.receivables, account_type: 'asset', is_active: true },
      { id: IDS.revenue, account_type: 'revenue', is_active: false },
      { id: IDS.payable, account_type: 'liability', is_active: true }
    ] }],
    ['revenue mapping with incompatible account type', { mapping: {
      receivables_account_id: IDS.receivables, sales_revenue_account_id: IDS.receivables
    } }],
    ['revenue mapping to a liability account', { mapping: {
      receivables_account_id: IDS.receivables, sales_revenue_account_id: IDS.payable
    } }],
    ['wrong receivables account type', { accounts: [
      { id: IDS.receivables, account_type: 'expense', is_active: true },
      { id: IDS.revenue, account_type: 'revenue', is_active: true },
      { id: IDS.payable, account_type: 'liability', is_active: true }
    ] }],
    ['missing tax liability mapping in the saved snapshot', (() => {
      const initial = makeState()
      return {
        profile: { ...initial.profile, tax_payable_account_id: null },
        snapshot: { ...initial.snapshot, tax_payable_account_id: null }
      }
    })()],
    ['unknown tax liability account mapping', (() => {
      const initial = makeState()
      const accountId = '60000000-0000-4000-8000-000000000098'
      return {
        profile: { ...initial.profile, tax_payable_account_id: accountId },
        snapshot: { ...initial.snapshot, tax_payable_account_id: accountId }
      }
    })()],
    ['inactive tax liability account', { accounts: [
      { id: IDS.receivables, account_type: 'asset', is_active: true },
      { id: IDS.revenue, account_type: 'revenue', is_active: true },
      { id: IDS.payable, account_type: 'liability', is_active: false }
    ] }],
    ['tax liability mapping with incompatible account type', { accounts: [
      { id: IDS.receivables, account_type: 'asset', is_active: true },
      { id: IDS.revenue, account_type: 'revenue', is_active: true },
      { id: IDS.payable, account_type: 'asset', is_active: true }
    ] }],
    ['missing tax profile', { profile: null }],
    ['tax profile outside its effective dates', { profile: { ...makeState().profile, effective_from: '2027-01-01' } }],
    ['invalid tax rate in the saved configuration', { profile: { ...makeState().profile, tax_rate: '101.00' } }],
    ['incorrect invoice total', { invoice: { ...makeState().invoice, total: '117.00' } }],
    ['closed accounting period', { period: null }]
  ]
  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      postCalls.length = 0
      const pool = makePool(makeState(overrides))
      await assert.rejects(request(pool), (error) => error.statusCode === 409 || error.statusCode === 400)
      assert.equal(postCalls.length, 0)
      assert.equal(pool.data.journals.length, 0)
      assert.equal(pool.data.invoice.status, 'draft')
      assert.equal(pool.data.snapshot.issued_at, null)
      assert.equal(pool.data.commitCount, 0)
      assert.equal(pool.data.rollbackCount, 1)
    })
  }
})

test('a deferred constraint failure at COMMIT rolls back invoice issuance and journal together', async () => {
  postCalls.length = 0
  const pool = makePool(makeState({ failCommit: true }))
  await assert.rejects(request(pool, { issueDate: '2026-10-22' }), (error) => error.code === '23514')
  assert.equal(postCalls.length, 1)
  assert.deepEqual(pool.transactionCommands, ['BEGIN', 'COMMIT', 'ROLLBACK'])
  assert.equal(pool.data.invoice.status, 'draft')
  assert.equal(pool.data.snapshot.issued_at, null)
  assert.equal(pool.data.journals.length, 0)
  assert.equal(pool.data.journalLines.length, 0)
  assert.equal(pool.data.postingEvents.length, 0)
  assert.equal(pool.data.rollbackCount, 1)
})

test('posting failure after transactional journal writes leaves no issued invoice or partial journal', async () => {
  postCalls.length = 0
  failPostingAfterJournalWrites = true
  const pool = makePool()
  try {
    await assert.rejects(request(pool, { issueDate: '2026-10-22' }), /Simulated posting failure after journal writes/)
  } finally {
    failPostingAfterJournalWrites = false
  }

  assert.deepEqual(pool.transactionCommands, ['BEGIN', 'ROLLBACK'])
  assert.equal(pool.data.commitCount, 0)
  assert.equal(pool.data.rollbackCount, 1)
  assert.equal(pool.data.invoice.status, 'draft')
  assert.equal(pool.data.snapshot.issued_on, null)
  assert.equal(pool.data.snapshot.issued_by, null)
  assert.equal(pool.data.snapshot.issued_at, null)
  assert.equal(pool.data.snapshot.journal_entry_id, null)
  assert.deepEqual(pool.data.journals, [])
  assert.deepEqual(pool.data.journalLines, [])
  assert.deepEqual(pool.data.postingEvents, [])

  assert.equal(postCalls.length, 1)
  assert.equal(postCalls[0].client.data.journals.length, 1, 'the simulated posting wrote a header inside the uncommitted client')
  assert.equal(postCalls[0].client.data.journalLines.length, 3, 'the simulated posting wrote lines inside the uncommitted client')
  assert.equal(postCalls[0].client.data.postingEvents.length, 1, 'the simulated posting wrote an event inside the uncommitted client')
})

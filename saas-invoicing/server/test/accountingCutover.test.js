const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_A = '11111111-1111-4111-8111-111111111111'
const USER_B = '12121212-1212-4121-8121-121212121212'
const PERIOD_A = '22222222-2222-4222-8222-222222222222'
const ACCOUNT_ASSET = '33333333-3333-4333-8333-333333333333'
const ACCOUNT_EQUITY = '44444444-4444-4444-8444-444444444444'
const ACCOUNT_REVENUE = '55555555-5555-4555-8555-555555555555'

function makePool() {
  const state = {
    period: { id: PERIOD_A, tenant_id: TENANT_A, name: '2026', starts_on: '2026-01-01', ends_on: '2026-12-31', status: 'open' },
    accounts: [
      { id: ACCOUNT_ASSET, tenant_id: TENANT_A, account_type: 'asset', normal_balance: 'debit', is_active: true },
      { id: ACCOUNT_EQUITY, tenant_id: TENANT_A, account_type: 'equity', normal_balance: 'credit', is_active: true },
      { id: ACCOUNT_REVENUE, tenant_id: TENANT_A, account_type: 'revenue', normal_balance: 'credit', is_active: true },
      { id: ACCOUNT_EQUITY, tenant_id: TENANT_B, account_type: 'equity', normal_balance: 'credit', is_active: true }
    ],
    batches: new Map(), lines: [], events: [], journals: new Map(), queries: [], failPost: false,
    previewSummaries: {}, previewExamples: {}
  }
  let idCounter = 0
  let transactionQueue = Promise.resolve()

  const execute = async (sql, params = []) => {
    const q = sql.replace(/\s+/g, ' ').trim()
    const lower = q.toLowerCase()
    state.queries.push({ sql: q, params })
    if (lower === 'begin isolation level read committed' || lower === 'begin isolation level repeatable read read only' || lower === 'commit') {
      return { rows: [], rowCount: 0 }
    }
    if (lower.startsWith('select id from tenants where id = $1 for update')) {
      const ok = params[0] === TENANT_A || params[0] === TENANT_B
      return { rows: ok ? [{ id: params[0] }] : [], rowCount: ok ? 1 : 0 }
    }
    if (lower.includes('from information_schema.columns')) {
      const fields = {
        invoices: { id: 'uuid', tenant_id: 'uuid', invoice_number: 'varchar', total: 'numeric', status: 'varchar' },
        customer_receipts: { id: 'uuid', tenant_id: 'uuid', status: 'varchar', amount: 'numeric', currency: 'bpchar', payment_date: 'date', receipt_reference: 'varchar', journal_entry_id: 'uuid', reversal_journal_entry_id: 'uuid' },
        supplier_bills: { id: 'uuid', tenant_id: 'uuid', bill_number: 'varchar', bill_date: 'date', total: 'numeric', currency: 'bpchar', status: 'varchar', journal_entry_id: 'uuid', reversal_journal_entry_id: 'uuid' },
        supplier_payments: { id: 'uuid', tenant_id: 'uuid', payment_number: 'varchar', payment_date: 'date', amount: 'numeric', currency: 'bpchar', status: 'varchar', journal_entry_id: 'uuid', reversal_journal_entry_id: 'uuid' },
        expenses: { id: 'uuid', tenant_id: 'uuid', expense_number: 'varchar', expense_date: 'date', amount: 'numeric', currency: 'varchar', status: 'varchar' },
        accounting_settings: { tenant_id: 'uuid', base_currency: 'varchar' },
        accounting_invoice_tax_snapshots: { tenant_id: 'uuid', source_type: 'varchar', source_id: 'uuid', total: 'numeric', issued_at: 'timestamptz', journal_entry_id: 'uuid' },
        accounting_journal_entries: { id: 'uuid', tenant_id: 'uuid', status: 'varchar', functional_currency: 'varchar', source_type: 'varchar', source_id: 'uuid', event_type: 'varchar', reversal_of_entry_id: 'uuid' }
      }
      const rows = []
      for (const table of params[0]) {
        for (const [column_name, udt_name] of Object.entries(fields[table] || {})) rows.push({ table_name: table, column_name, udt_name })
      }
      return { rows, rowCount: rows.length }
    }
    if (lower.includes('group by classification, currency')) {
      const source = ['invoices', 'customer_receipts', 'supplier_bills', 'supplier_payments', 'expenses']
        .find((name) => lower.includes(`from ${name} `))
      return { rows: state.previewSummaries[source] || [], rowCount: (state.previewSummaries[source] || []).length }
    }
    if (lower.includes('select record_id, reference, amount, currency, status, classification, reason')) {
      const source = ['invoices', 'customer_receipts', 'supplier_bills', 'supplier_payments', 'expenses']
        .find((name) => lower.includes(`from ${name} `))
      return { rows: state.previewExamples[source] || [], rowCount: (state.previewExamples[source] || []).length }
    }
    if (lower.startsWith('select id, status, effective_date, accounting_period_id, journal_entry_id')) {
      return { rows: [...state.batches.values()].filter((batch) => batch.tenant_id === params[0]).map((batch) => ({
        id: batch.id, status: batch.status, effective_date: batch.effective_date,
        accounting_period_id: batch.accounting_period_id, journal_entry_id: batch.journal_entry_id,
        reversal_journal_entry_id: batch.reversal_journal_entry_id
      })), rowCount: state.batches.size }
    }
    if (lower.startsWith('select id from accounting_opening_balance_batches')) {
      const rows = [...state.batches.values()].filter((batch) => batch.tenant_id === params[0]).map((batch) => ({ id: batch.id }))
      return { rows, rowCount: rows.length }
    }
    if (lower.startsWith('select id, payload_hash from accounting_opening_balance_batches')) {
      const batch = [...state.batches.values()].find((item) => item.tenant_id === params[0] && item.idempotency_key === params[1])
      return { rows: batch ? [{ id: batch.id, payload_hash: batch.payload_hash }] : [], rowCount: batch ? 1 : 0 }
    }
    if (lower.startsWith('select batch.id, batch.tenant_id')) {
      const batch = state.batches.get(params[1])
      const ok = batch && batch.tenant_id === params[0]
      const period = state.period
      return { rows: ok ? [{ ...batch, accounting_period_name: period.name }] : [], rowCount: ok ? 1 : 0 }
    }
    if (lower.startsWith('select line.line_number')) {
      const rows = state.lines.filter((line) => line.tenant_id === params[0] && line.batch_id === params[1])
        .sort((a, b) => a.line_number - b.line_number).map((line) => ({
          ...line,
          account_code: line.account_id === ACCOUNT_ASSET ? '1000' : '3000',
          account_name: line.account_id === ACCOUNT_ASSET ? 'Cash' : 'Opening equity',
          account_type: line.account_id === ACCOUNT_ASSET ? 'asset' : 'equity',
          normal_balance: line.account_id === ACCOUNT_ASSET ? 'debit' : 'credit'
        }))
      return { rows, rowCount: rows.length }
    }
    if (lower.startsWith('select id, event_type, actor_id, reason, idempotency_key, payload_hash, details, created_at from accounting_opening_balance_events')) {
      const rows = state.events.filter((event) => event.tenant_id === params[0] && event.batch_id === params[1])
      return { rows, rowCount: rows.length }
    }
    if (lower.includes('from accounting_opening_balance_events') && lower.includes('idempotency_key = $2')) {
      const event = state.events.find((item) => item.tenant_id === params[0] && item.idempotency_key === params[1])
      return { rows: event ? [{ batch_id: event.batch_id, payload_hash: event.payload_hash }] : [], rowCount: event ? 1 : 0 }
    }
    if (lower.includes('from accounting_opening_balance_events') && lower.includes('idempotency_key = $3')) {
      const event = state.events.find((item) => item.tenant_id === params[0] && item.batch_id === params[1] && item.idempotency_key === params[2])
      return { rows: event ? [{ payload_hash: event.payload_hash }] : [], rowCount: event ? 1 : 0 }
    }
    if (lower.startsWith('select base_currency from accounting_settings')) {
      const ok = params[0] === TENANT_A || params[0] === TENANT_B
      return { rows: ok ? [{ base_currency: 'KES' }] : [], rowCount: ok ? 1 : 0 }
    }
    if (lower.startsWith('select id, status, starts_on, ends_on from accounting_periods')) {
      const period = state.period
      const ok = period.tenant_id === params[0] && period.id === params[1]
      return { rows: ok ? [{ ...period }] : [], rowCount: ok ? 1 : 0 }
    }
    if (lower.startsWith('select effective_date from accounting_opening_balance_batches')) {
      const batch = [...state.batches.values()].filter((item) => item.tenant_id === params[0] && item.status === 'reversed')
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).at(0)
      return { rows: batch ? [{ effective_date: batch.effective_date }] : [], rowCount: batch ? 1 : 0 }
    }
    if (lower.startsWith('select id, account_type, normal_balance, is_active from accounting_accounts')) {
      const rows = state.accounts.filter((account) => account.tenant_id === params[0] && params[1].includes(account.id))
      return { rows, rowCount: rows.length }
    }
    if (lower.startsWith('insert into accounting_opening_balance_batches')) {
      if ([...state.batches.values()].some((batch) => batch.tenant_id === params[0] && ['draft', 'posted'].includes(batch.status))) {
        throw Object.assign(new Error('one cutover per tenant'), { code: '23505' })
      }
      const reversed = [...state.batches.values()].filter((batch) => batch.tenant_id === params[0] && batch.status === 'reversed')
      if (reversed.some((batch) => batch.effective_date !== params[2])) {
        throw Object.assign(new Error('replacement must use prior effective date'), { code: '23514' })
      }
      const batch = {
        id: nextId(), tenant_id: params[0], accounting_period_id: params[1], effective_date: params[2],
        description: params[3], status: 'draft', idempotency_key: params[4], payload_hash: params[5],
        created_by: params[6], created_at: '2026-10-31T09:00:00.000Z', journal_entry_id: null,
        reversal_journal_entry_id: null, approved_by: null, approved_at: null, approval_reason: null,
        cancelled_by: null, cancelled_at: null, cancellation_reason: null, reversed_by: null,
        reversed_at: null, reversal_reason: null
      }
      state.batches.set(batch.id, batch)
      return { rows: [{ id: batch.id }], rowCount: 1 }
    }
    if (lower.startsWith('insert into accounting_opening_balance_lines')) {
      const line = {
        tenant_id: params[0], batch_id: params[1], line_number: params[2], account_id: params[3],
        description: params[4], debit: params[5], credit: params[6]
      }
      state.lines.push(line)
      return { rows: [], rowCount: 1 }
    }
    if (lower.startsWith('insert into accounting_opening_balance_events')) {
      if (state.events.some((event) => event.tenant_id === params[0] && event.idempotency_key === params[5])) {
        throw Object.assign(new Error('duplicate audit key'), { code: '23505' })
      }
      const event = {
        id: nextId(), tenant_id: params[0], batch_id: params[1], event_type: params[2], actor_id: params[3],
        reason: params[4], idempotency_key: params[5], payload_hash: params[6], details: JSON.parse(params[7]),
        created_at: '2026-10-31T09:00:00.000Z'
      }
      state.events.push(event)
      return { rows: [event], rowCount: 1 }
    }
    if (lower.startsWith('update accounting_opening_balance_batches set status =')) {
      const isCancelled = lower.includes("set status = 'cancelled'")
      const batchId = isCancelled ? params[3] : params[4]
      const batch = state.batches.get(batchId)
      if (!batch || batch.tenant_id !== (isCancelled ? params[2] : params[3])) return { rows: [], rowCount: 0 }
      if (lower.includes("set status = 'posted'")) {
        Object.assign(batch, { status: 'posted', journal_entry_id: params[0], approved_by: params[1], approved_at: '2026-10-31T09:00:00.000Z', approval_reason: params[2] })
      } else if (lower.includes("set status = 'cancelled'")) {
        Object.assign(batch, { status: 'cancelled', cancelled_by: params[0], cancelled_at: '2026-10-31T09:00:00.000Z', cancellation_reason: params[1] })
      } else if (lower.includes("set status = 'reversed'")) {
        Object.assign(batch, { status: 'reversed', reversal_journal_entry_id: params[0], reversed_by: params[1], reversed_at: '2026-10-31T09:00:00.000Z', reversal_reason: params[2] })
      }
      return { rows: [{ ...batch }], rowCount: 1 }
    }
    if (lower.startsWith('select id, accounting_period_id, entry_date, description, status, functional_currency')) {
      const journal = state.journals.get(params[1])
      return { rows: journal && journal.tenant_id === params[0] ? [{ ...journal }] : [], rowCount: journal ? 1 : 0 }
    }
    if (lower.startsWith('select line_number, account_id, description, debit::text as debit, credit::text as credit')) {
      const journal = state.journals.get(params[1])
      return { rows: journal?.lines || [], rowCount: journal?.lines.length || 0 }
    }
    throw new Error(`Unexpected cutover query: ${q}`)
  }

  function nextId() {
    idCounter += 1
    return `77777777-7777-4777-8777-${String(idCounter).padStart(12, '0')}`
  }

  const pool = {
    state,
    async query(sql, params) { return execute(sql, params) },
    async connect() {
      const previous = transactionQueue
      let unlock
      transactionQueue = new Promise((resolve) => { unlock = resolve })
      await previous
      let snapshot
      return {
        async query(sql, params = []) {
          const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
          if (normalized.startsWith('begin ')) {
            snapshot = structuredClone(state)
            return { rows: [], rowCount: 0 }
          }
          if (normalized === 'rollback') {
            for (const key of Object.keys(state)) delete state[key]
            Object.assign(state, snapshot)
            return { rows: [], rowCount: 0 }
          }
          if (normalized === 'commit') return { rows: [], rowCount: 0 }
          return execute(sql, params)
        },
        release() { unlock() }
      }
    }
  }
  return pool
}

const accountingPath = require.resolve('../src/services/accounting')
const cutoverPath = require.resolve('../src/services/accountingCutover')
const originalAccounting = require.cache[accountingPath]
const originalCutover = require.cache[cutoverPath]
let activePool
const mockedAccounting = new Module(accountingPath)
mockedAccounting.filename = accountingPath
mockedAccounting.loaded = true
mockedAccounting.exports = {
  async withTransaction(pool, work) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  },
  async postJournal(_pool, input, { client }) {
    const { normalizeJournal } = require('../src/utils/accounting')
    const payload = normalizeJournal(input.body, input.idempotencyKey)
    const id = `88888888-8888-4888-8888-${String(activePool.state.journals.size + 1).padStart(12, '0')}`
    const journal = {
      id, tenant_id: input.tenantId, accounting_period_id: payload.accounting_period_id,
      entry_date: payload.entry_date, description: payload.description, status: 'posted',
      functional_currency: 'KES', source_type: payload.source_type, source_id: payload.source_id,
      source_reference: payload.source_reference, event_type: payload.event_type,
      reversal_of_entry_id: null, reversal_reason: null, lines: payload.lines
    }
    activePool.state.journals.set(id, journal)
    if (activePool.state.failPost) throw new Error('simulated journal failure')
    return { journal, lines: payload.lines, replayed: false }
  },
  async reverseJournal(_pool, input) {
    const id = `99999999-9999-4999-8999-${String(activePool.state.journals.size + 1).padStart(12, '0')}`
    const journal = {
      id, tenant_id: input.tenantId, accounting_period_id: input.periodId,
      entry_date: input.reversalDate, status: 'posted', functional_currency: 'KES',
      source_type: 'journal_reversal', source_id: input.journalId,
      event_type: 'reversal', reversal_of_entry_id: input.journalId, reversal_reason: input.reason,
      lines: []
    }
    activePool.state.journals.set(id, journal)
    return { journal, lines: [], replayed: false }
  }
}
require.cache[accountingPath] = mockedAccounting
const { cancelOpeningBalanceDraft, createOpeningBalanceDraft, getAccountingCutoverPreview, normalizeDraft, postOpeningBalanceDraft, reverseOpeningBalance } = require(cutoverPath)

test.after(() => {
  delete require.cache[cutoverPath]
  if (originalCutover) require.cache[cutoverPath] = originalCutover
  if (originalAccounting) require.cache[accountingPath] = originalAccounting
  else delete require.cache[accountingPath]
})

function draftBody(overrides = {}) {
  return {
    accounting_period_id: PERIOD_A,
    effective_date: '2026-01-01',
    description: 'Opening balances at cutover',
    lines: [
      { account_id: ACCOUNT_ASSET, debit: '100.100001', credit: '0' },
      { account_id: ACCOUNT_EQUITY, debit: '0', credit: '100.100001' }
    ],
    ...overrides
  }
}

test('opening-balance validation uses exact six-place decimals and requires a balanced journal', () => {
  const normalized = normalizeDraft(draftBody({ lines: [
    { account_id: ACCOUNT_ASSET, debit: '0.100001', credit: '0' },
    { account_id: ACCOUNT_EQUITY, debit: '0', credit: '0.1000010'.slice(0, 8) }
  ] }), 'opening-balance-key-001')
  assert.equal(normalized.lines[0].debit, '0.100001')
  assert.equal(normalized.lines[1].credit, '0.100001')
  assert.throws(() => normalizeDraft(draftBody({
    lines: [
      { account_id: ACCOUNT_ASSET, debit: '100', credit: '0' },
      { account_id: ACCOUNT_EQUITY, debit: '0', credit: '99' }
    ]
  }), 'opening-balance-key-002'), /Add an explicitly reviewed equity or retained-earnings line/)
  assert.throws(() => normalizeDraft(draftBody({
    lines: [
      { account_id: ACCOUNT_ASSET, debit: '1.0000001', credit: '0' },
      { account_id: ACCOUNT_EQUITY, debit: '0', credit: '1.0000001' }
    ]
  }), 'opening-balance-key-003'), /at most 6 decimal places/)
  assert.throws(() => normalizeDraft(draftBody({
    lines: [
      { account_id: ACCOUNT_ASSET, debit: '1', credit: '0', transaction_currency: 'USD',
        transaction_amount: '1', exchange_rate: '1', exchange_rate_source: 'reviewed',
        exchange_rate_at: '2026-01-01T00:00:00.000Z' },
      { account_id: ACCOUNT_EQUITY, debit: '0', credit: '1' }
    ]
  }), 'opening-balance-key-004'), /functional currency/)
})

test('opening-balance staging is tenant and period scoped and rejects P&L accounts', async () => {
  activePool = makePool()
  const result = await createOpeningBalanceDraft(activePool, {
    tenantId: TENANT_A, userId: USER_A, idempotencyKey: 'opening-create-001', body: draftBody()
  })
  assert.equal(result.status, 'draft')
  assert.equal(result.events[0].event_type, 'draft_created')
  await assert.rejects(createOpeningBalanceDraft(activePool, {
    tenantId: TENANT_B, userId: USER_A, idempotencyKey: 'opening-tenant-b-1', body: draftBody()
  }), { statusCode: 404 })
  await assert.rejects(createOpeningBalanceDraft(activePool, {
    tenantId: TENANT_A, userId: USER_A, idempotencyKey: 'opening-foreign-acct-1',
    body: draftBody({ lines: [
      { account_id: ACCOUNT_ASSET, debit: '100', credit: '0' },
      { account_id: '66666666-6666-4666-8666-666666666666', debit: '0', credit: '100' }
    ] })
  }), { statusCode: 400 })
  await assert.rejects(createOpeningBalanceDraft(activePool, {
    tenantId: TENANT_A, userId: USER_A, idempotencyKey: 'opening-revenue-acct-1',
    body: draftBody({ lines: [
      { account_id: ACCOUNT_ASSET, debit: '100', credit: '0' },
      { account_id: ACCOUNT_REVENUE, debit: '0', credit: '100' }
    ] })
  }), /balance-sheet accounts only/)
})

test('closed periods reject an opening-balance draft', async () => {
  activePool = makePool()
  activePool.state.period.status = 'closed'
  await assert.rejects(createOpeningBalanceDraft(activePool, {
    tenantId: TENANT_A, userId: USER_A, idempotencyKey: 'opening-closed-period-1', body: draftBody()
  }), { statusCode: 409, message: /closed accounting period/ })
})

test('duplicate create retries replay and conflicting idempotency-key reuse is rejected', async () => {
  activePool = makePool()
  const first = await createOpeningBalanceDraft(activePool, {
    tenantId: TENANT_A, userId: USER_A, idempotencyKey: 'opening-replay-key-1', body: draftBody()
  })
  const replay = await createOpeningBalanceDraft(activePool, {
    tenantId: TENANT_A, userId: USER_A, idempotencyKey: 'opening-replay-key-1', body: draftBody()
  })
  assert.equal(replay.replayed, true)
  assert.equal(first.id, replay.id)
  await assert.rejects(createOpeningBalanceDraft(activePool, {
    tenantId: TENANT_A, userId: USER_A, idempotencyKey: 'opening-replay-key-1',
    body: draftBody({ description: 'Changed description' })
  }), { statusCode: 409, message: /different opening balance/ })
  activePool = makePool()
  const results = await Promise.all([
    createOpeningBalanceDraft(activePool, {
      tenantId: TENANT_A, userId: USER_A, idempotencyKey: 'opening-concurrent-key-1', body: draftBody()
    }),
    createOpeningBalanceDraft(activePool, {
      tenantId: TENANT_A, userId: USER_A, idempotencyKey: 'opening-concurrent-key-1', body: draftBody()
    })
  ])
  assert.equal(results[0].id, results[1].id)
})

test('draft cancellation requires confirmation, retains an audit event, and replays idempotently', async () => {
  activePool = makePool()
  const draft = await createOpeningBalanceDraft(activePool, {
    tenantId: TENANT_A, userId: USER_A, idempotencyKey: 'opening-cancel-draft-1', body: draftBody()
  })
  await assert.rejects(cancelOpeningBalanceDraft(activePool, {
    tenantId: TENANT_A, userId: USER_B, batchId: draft.id, idempotencyKey: 'opening-cancel-action-1',
    body: { confirm: false, reason: 'Cancel the draft' }
  }), { statusCode: 400 })
  const first = await cancelOpeningBalanceDraft(activePool, {
    tenantId: TENANT_A, userId: USER_B, batchId: draft.id, idempotencyKey: 'opening-cancel-action-1',
    body: { confirm: true, reason: 'The reviewed balances need correction' }
  })
  const retry = await cancelOpeningBalanceDraft(activePool, {
    tenantId: TENANT_A, userId: USER_B, batchId: draft.id, idempotencyKey: 'opening-cancel-action-1',
    body: { confirm: true, reason: 'The reviewed balances need correction' }
  })
  assert.equal(first.batch.status, 'cancelled')
  assert.equal(first.batch.events.at(-1).actor_id, USER_B)
  assert.equal(first.batch.events.at(-1).reason, 'The reviewed balances need correction')
  assert.equal(retry.replayed, true)
})

test('posting requires explicit approval by a different administrator and records the journal atomically', async () => {
  activePool = makePool()
  const draft = await createOpeningBalanceDraft(activePool, {
    tenantId: TENANT_A, userId: USER_A, idempotencyKey: 'opening-post-draft-1', body: draftBody()
  })
  await assert.rejects(postOpeningBalanceDraft(activePool, {
    tenantId: TENANT_A, userId: USER_A, batchId: draft.id, idempotencyKey: 'opening-post-self-1',
    body: { confirm: true, reason: 'I reviewed it' }
  }), { statusCode: 403, message: /different accounting administrator/ })
  const request = {
    tenantId: TENANT_A, userId: USER_B, batchId: draft.id, idempotencyKey: 'opening-post-approval-1',
    body: { confirm: true, reason: 'Independent administrator reviewed the opening trial balance' }
  }
  const [result, replay] = await Promise.all([
    postOpeningBalanceDraft(activePool, request),
    postOpeningBalanceDraft(activePool, request)
  ])
  assert.equal(result.batch.status, 'posted')
  assert.deepEqual([result.replayed, replay.replayed].sort(), [false, true])
  assert.equal(result.journal.source_type, 'opening_balance_cutover')
  assert.equal(result.journal.source_id, draft.id)
  assert.equal(activePool.state.events.at(-1).event_type, 'posted')
  assert.equal(activePool.state.journals.size, 1)
})

test('journal failures roll back the cutover status and posting audit event', async () => {
  activePool = makePool()
  const draft = await createOpeningBalanceDraft(activePool, {
    tenantId: TENANT_A, userId: USER_A, idempotencyKey: 'opening-rollback-draft-1', body: draftBody()
  })
  activePool.state.failPost = true
  await assert.rejects(postOpeningBalanceDraft(activePool, {
    tenantId: TENANT_A, userId: USER_B, batchId: draft.id, idempotencyKey: 'opening-rollback-post-1',
    body: { confirm: true, reason: 'Reviewed, test failure path' }
  }), /simulated journal failure/)
  assert.equal(activePool.state.batches.get(draft.id).status, 'draft')
  assert.equal(activePool.state.events.filter((event) => event.event_type === 'posted').length, 0)
  assert.equal(activePool.state.journals.size, 0)
})

test('posted opening balances reverse through a linked journal and retain the original entry', async () => {
  activePool = makePool()
  const draft = await createOpeningBalanceDraft(activePool, {
    tenantId: TENANT_A, userId: USER_A, idempotencyKey: 'opening-reverse-draft-1', body: draftBody()
  })
  const posted = await postOpeningBalanceDraft(activePool, {
    tenantId: TENANT_A, userId: USER_B, batchId: draft.id, idempotencyKey: 'opening-reverse-post-1',
    body: { confirm: true, reason: 'Reviewed and approved' }
  })
  activePool.state.period.status = 'closed'
  await assert.rejects(reverseOpeningBalance(activePool, {
    tenantId: TENANT_A, userId: USER_A, batchId: draft.id, idempotencyKey: 'opening-reverse-closed-period',
    body: { confirm: true, reason: 'Invalid closed-period attempt', reversal_date: '2026-02-01', accounting_period_id: PERIOD_A }
  }), { statusCode: 409, message: /closed accounting period/ })
  activePool.state.period.status = 'open'
  const reversed = await reverseOpeningBalance(activePool, {
    tenantId: TENANT_A, userId: USER_A, batchId: draft.id, idempotencyKey: 'opening-reverse-action-1',
    body: { confirm: true, reason: 'Cutover correction', reversal_date: '2026-02-01', accounting_period_id: PERIOD_A }
  })
  assert.equal(reversed.batch.status, 'reversed')
  assert.equal(reversed.journal.reversal_of_entry_id, posted.journal.id)
  assert.equal(activePool.state.journals.get(posted.journal.id).status, 'posted')
  assert.deepEqual(activePool.state.events.map((event) => event.event_type), ['draft_created', 'posted', 'reversed'])
  const replacement = await createOpeningBalanceDraft(activePool, {
    tenantId: TENANT_A, userId: USER_A, idempotencyKey: 'opening-replacement-same-date', body: draftBody()
  })
  assert.equal(replacement.status, 'draft')
  await assert.rejects(createOpeningBalanceDraft(activePool, {
    tenantId: TENANT_A, userId: USER_A, idempotencyKey: 'opening-replacement-new-date',
    body: draftBody({ effective_date: '2026-01-02' })
  }), { statusCode: 409, message: /same effective date/ })
})

test('cutover preview is read-only, tenant-scoped, and distinguishes represented, excluded and ambiguous sources', async () => {
  activePool = makePool()
  activePool.state.previewSummaries.invoices = [
    { classification: 'already_accounted_for', currency: 'KES', record_count: '1', amount_total: '500.00' },
    { classification: 'excluded', currency: 'KES', record_count: '1', amount_total: '100.00' },
    { classification: 'ambiguous', currency: 'KES', record_count: '1', amount_total: '75.00' }
  ]
  activePool.state.previewExamples.invoices = [
    { record_id: 'inv-1', reference: 'I-1', amount: '500.00', currency: 'KES', status: 'sent', classification: 'already_accounted_for', reason: 'Posted journal' }
  ]
  const beforeBatches = activePool.state.batches.size
  const preview = await getAccountingCutoverPreview(activePool, TENANT_A)
  const invoices = preview.sources.find((source) => source.source === 'invoices')
  assert.equal(preview.historical_posting_supported, false)
  assert.equal(invoices.eligible.count, '0')
  assert.equal(invoices.already_accounted_for.count, '1')
  assert.equal(invoices.excluded.count, '1')
  assert.equal(invoices.ambiguous.count, '1')
  assert.equal(invoices.already_accounted_for.totals_by_currency[0].amount, '500.00')
  assert.equal(preview.sources.find((source) => source.source === 'legacy_payments').available, false)
  assert.equal(activePool.state.batches.size, beforeBatches)
  assert.ok(activePool.state.queries.filter((item) => /from invoices i|from customer_receipts|from supplier_bills|from supplier_payments|from expenses/.test(item.sql.toLowerCase()))
    .every((item) => item.params[0] === TENANT_A))
  assert.ok(activePool.state.queries.every((item) => !/^(insert|update|delete)\b/i.test(item.sql)))
})

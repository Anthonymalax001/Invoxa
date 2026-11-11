const test = require('node:test')
const assert = require('node:assert/strict')
const { closeAccountingPeriod, getAccountingPeriodReadiness, SCHEMA_REQUIREMENTS } = require('../src/services/accountingPeriodClose')
const { assertDateNotInClosedPeriod } = require('../src/services/accounting')

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_A = '11111111-1111-4111-8111-111111111111'
const PERIOD_A = '22222222-2222-4222-8222-222222222222'
const PERIOD_B = '33333333-3333-4333-8333-333333333333'
const UUID = () => `44444444-4444-4444-8444-${String(++UUID.sequence).padStart(12, '0')}`
UUID.sequence = 0

function makePool() {
  const state = {
    periods: new Map([
      [PERIOD_A, { id: PERIOD_A, tenant_id: TENANT_A, name: 'FY 2026', starts_on: '2026-01-01', ends_on: '2026-12-31', status: 'open' }],
      [PERIOD_B, { id: PERIOD_B, tenant_id: TENANT_B, name: 'FY 2026 B', starts_on: '2026-01-01', ends_on: '2026-12-31', status: 'open' }]
    ]),
    issues: new Map(),
    missingSchema: new Set(),
    events: [],
    queries: []
  }
  let beginQueue = Promise.resolve()
  const query = async (sql, params = []) => {
    const q = sql.replace(/\s+/g, ' ').trim()
    state.queries.push({ sql: q, params })
    const lower = q.toLowerCase()
    if (lower.includes('from information_schema.columns')) {
      const rows = []
      for (const table of params[0]) {
        if (state.missingSchema.has(table)) continue
        for (const column of SCHEMA_REQUIREMENTS[table] || []) rows.push({ table_name: table, column_name: column })
      }
      return { rows, rowCount: rows.length }
    }
    if (lower.includes('from accounting_period_events')) {
      if (state.missingSchema.has('accounting_period_events')) throw Object.assign(new Error('missing audit relation'), { code: '42P01' })
      if (lower.startsWith('select id, accounting_period_id, outcome')) {
        const event = state.events.find((item) => item.tenant_id === params[0] && item.idempotency_key === params[1])
        return { rows: event ? [{ ...event }] : [], rowCount: event ? 1 : 0 }
      }
      const rows = state.events.filter((item) => item.tenant_id === params[0] && item.accounting_period_id === params[1])
      return { rows, rowCount: rows.length }
    }
    const periodQuery = lower.startsWith('select id, tenant_id, name, starts_on, ends_on, status')
    if (periodQuery) {
      const row = state.periods.get(params[1])
      const rows = row?.tenant_id === params[0] ? [{ ...row }] : []
      return { rows, rowCount: rows.length }
    }
    const checks = [
      ['draft_journals', 'accounting_journal_entries'],
      ['draft_opening_balances', 'accounting_opening_balance_batches'],
      ['pending_receipts', 'customer_receipts'],
      ['failed_receipts', 'customer_receipts'],
      ['pending_supplier_payments', 'supplier_payments'],
      ['failed_supplier_payments', 'supplier_payments'],
      ['unposted_supplier_bills', 'supplier_bills'],
      ['unposted_expenses', 'expenses'],
      ['unaccounted_inventory_movements', 'stock_movements'],
      ['unbalanced_posted_journals', 'accounting_journal_lines'],
      ['incomplete_bank_reconciliations', 'bank_reconciliation_import_batches'],
      ['unresolved_mpesa_initiations', 'mpesa_stk_initiation_requests']
    ]
    for (const [id, table] of checks) {
      const isCheck = id === 'draft_journals'
        ? lower.includes("j.status = 'draft'")
        : id === 'unbalanced_posted_journals'
          ? lower.includes('having count(l.id) < 2')
          : id === 'failed_receipts' || id === 'failed_supplier_payments'
            ? lower.includes("status = 'failed'")
            : id === 'pending_receipts' || id === 'pending_supplier_payments'
              ? lower.includes("status = 'pending'")
          : lower.includes(`from ${table}`)
      if (isCheck) {
        if (state.missingSchema.has(table)) throw Object.assign(new Error('missing check relation'), { code: '42P01' })
        const rows = state.issues.get(`${params[0]}:${params[1]}:${id}`) || []
        return { rows: rows.map((item) => ({ ...item, total_count: rows.length })), rowCount: rows.length }
      }
    }
    if (lower.startsWith('update accounting_periods set status')) {
      const row = state.periods.get(params[2])
      if (!row || row.tenant_id !== params[1] || row.status !== 'open') return { rows: [], rowCount: 0 }
      Object.assign(row, { status: 'closed', closed_by: params[0], closed_at: '2026-10-30T00:00:00.000Z' })
      return { rows: [{ ...row }], rowCount: 1 }
    }
    if (lower.startsWith('insert into accounting_period_events')) {
      const row = state.periods.get(params[1])
      if (!row || row.tenant_id !== params[0]) throw new Error('tenant scoped period FK failed')
      if (state.events.some((event) => event.tenant_id === params[0] && event.idempotency_key === params[5])) {
        throw Object.assign(new Error('duplicate idempotency key'), { code: '23505' })
      }
      const event = {
        id: UUID(), tenant_id: params[0], accounting_period_id: params[1], event_type: 'close',
        outcome: params[2], actor_id: params[3], reason: params[4], idempotency_key: params[5],
        payload_hash: params[6], details: JSON.parse(params[7]), created_at: '2026-10-30T00:00:00.000Z'
      }
      state.events.push(event)
      return { rows: [event], rowCount: 1 }
    }
    throw new Error(`Unexpected period close query: ${q}`)
  }

  return {
    state,
    async connect() {
      let releaseLock
      let locked = false
      return {
        async query(sql, params = []) {
          if (sql.startsWith('BEGIN')) {
            const previous = beginQueue
            beginQueue = new Promise((resolve) => { releaseLock = resolve })
            await previous
            locked = true
            return { rows: [], rowCount: 0 }
          }
          if (sql === 'COMMIT' || sql === 'ROLLBACK') {
            if (locked) {
              locked = false
              releaseLock()
            }
            return { rows: [], rowCount: 0 }
          }
          return query(sql, params)
        },
        release() {
          if (locked) {
            locked = false
            releaseLock()
          }
        }
      }
    }
  }
}

function closeRequest(overrides = {}) {
  return {
    tenantId: TENANT_A, userId: USER_A, periodId: PERIOD_A,
    idempotencyKey: 'period-close-2026-01', reason: 'Management reviewed the period close checklist', confirm: true,
    ...overrides
  }
}

test('readiness does not pass while legacy M-Pesa activity has no reviewed schema contract', async () => {
  const pool = makePool()
  const ready = await getAccountingPeriodReadiness(pool, TENANT_A, PERIOD_A)
  assert.equal(ready.can_close, false)
  assert.equal(ready.checks.length, 15)
  assert.equal(ready.checks.find((check) => check.id === 'unresolved_mpesa_initiations').status, 'passed')
  assert.equal(ready.checks.find((check) => check.id === 'legacy_mpesa_coverage').status, 'unavailable')
  assert.equal(ready.blockers.length, 1)
  assert.match(ready.blockers[0].message, /no repository-defined date or status contract/)
  assert.deepEqual(ready.warnings, [])
})

test('approved and paid expenses block period close because the expense workflow has no journal posting', async () => {
  const pool = makePool()
  pool.state.issues.set(`${TENANT_A}:${PERIOD_A}:unposted_expenses`, [
    { id: 'expense-approved', expense_number: 'EXP-10', status: 'approved', amount: '12.34' },
    { id: 'expense-paid', expense_number: 'EXP-11', status: 'paid', amount: '56.78' }
  ])
  const readiness = await getAccountingPeriodReadiness(pool, TENANT_A, PERIOD_A)
  const check = readiness.checks.find((item) => item.id === 'unposted_expenses')
  assert.equal(readiness.can_close, false)
  assert.equal(check.status, 'blocked')
  assert.equal(check.count, 2)
  assert.deepEqual(check.items.map((item) => item.expense_number), ['EXP-10', 'EXP-11'])
})

test('inventory movement rows block close because current stock records carry no accounting valuation', async () => {
  const pool = makePool()
  pool.state.issues.set(`${TENANT_A}:${PERIOD_A}:unaccounted_inventory_movements`, [
    { id: 'movement-1', product_id: 'product-1', movement_type: 'receipt', quantity_delta: '2.000', reference: 'PO-1' },
    { id: 'movement-2', product_id: 'product-1', movement_type: 'adjustment', quantity_delta: '-1.000', reference: 'SO-1' }
  ])
  const readiness = await getAccountingPeriodReadiness(pool, TENANT_A, PERIOD_A)
  const check = readiness.checks.find((item) => item.id === 'unaccounted_inventory_movements')
  assert.equal(readiness.can_close, false)
  assert.equal(check.status, 'blocked')
  assert.equal(check.count, 2)
  assert.deepEqual(check.items.map((item) => item.movement_type), ['receipt', 'adjustment'])
})

test('drafts, pending receipts, payments, bills, and incomplete reconciliations block closure with detail', async () => {
  const pool = makePool()
  for (const id of ['draft_journals', 'draft_opening_balances', 'pending_receipts', 'pending_supplier_payments', 'unposted_supplier_bills', 'incomplete_bank_reconciliations']) {
    pool.state.issues.set(`${TENANT_A}:${PERIOD_A}:${id}`, [{ id: `${id}-item`, status: 'pending' }])
  }
  const readiness = await getAccountingPeriodReadiness(pool, TENANT_A, PERIOD_A)
  assert.equal(readiness.can_close, false)
  assert.equal(readiness.blockers.length, 7)
  assert.deepEqual(readiness.blockers.map((check) => check.id), [
    'draft_journals', 'draft_opening_balances', 'pending_receipts', 'pending_supplier_payments', 'unposted_supplier_bills', 'incomplete_bank_reconciliations', 'legacy_mpesa_coverage'
  ])
  assert.equal(readiness.blockers[2].items[0].id, 'pending_receipts-item')
})

test('failed receipt and supplier payment records are visible as warnings but do not block closure', async () => {
  const pool = makePool()
  pool.state.issues.set(`${TENANT_A}:${PERIOD_A}:failed_receipts`, [{ id: 'failed-receipt-1', receipt_reference: 'R-FAIL' }])
  pool.state.issues.set(`${TENANT_A}:${PERIOD_A}:failed_supplier_payments`, [{ id: 'failed-payment-1', payment_reference: 'P-FAIL' }])
  const readiness = await getAccountingPeriodReadiness(pool, TENANT_A, PERIOD_A)
  assert.equal(readiness.can_close, false)
  assert.deepEqual(readiness.blockers.map((check) => check.id), ['legacy_mpesa_coverage'])
  assert.deepEqual(readiness.warnings.map((check) => check.id), ['failed_receipts', 'failed_supplier_payments'])
})

test('unavailable accounting or bank reconciliation schema is an unavailable blocker, never a pass', async () => {
  const pool = makePool()
  pool.state.missingSchema.add('bank_reconciliation_import_batches')
  pool.state.missingSchema.add('accounting_period_events')
  pool.state.missingSchema.add('expenses')
  pool.state.missingSchema.add('stock_movements')
  pool.state.missingSchema.add('mpesa_payment_reconciliation_audit')
  const readiness = await getAccountingPeriodReadiness(pool, TENANT_A, PERIOD_A)
  assert.equal(readiness.can_close, false)
  assert.equal(readiness.history, null)
  assert.equal(readiness.checks.find((item) => item.id === 'incomplete_bank_reconciliations').status, 'unavailable')
  assert.equal(readiness.checks.find((item) => item.id === 'unposted_expenses').status, 'unavailable')
  assert.equal(readiness.checks.find((item) => item.id === 'unaccounted_inventory_movements').status, 'unavailable')
  assert.equal(readiness.checks.find((item) => item.id === 'unresolved_mpesa_initiations').status, 'unavailable')
  assert.equal(readiness.checks.find((item) => item.id === 'close_audit').status, 'unavailable')
})

test('period lookup and all readiness data remain tenant scoped', async () => {
  const pool = makePool()
  await assert.rejects(getAccountingPeriodReadiness(pool, TENANT_A, PERIOD_B), (error) => error.statusCode === 404)
  pool.state.issues.set(`${TENANT_B}:${PERIOD_B}:pending_receipts`, [{ id: 'tenant-b-secret' }])
  const tenantA = await getAccountingPeriodReadiness(pool, TENANT_A, PERIOD_A)
  assert.equal(tenantA.can_close, false)
  assert.equal(tenantA.blockers.some((check) => check.id === 'legacy_mpesa_coverage'), true)
  assert.ok(!JSON.stringify(tenantA).includes('tenant-b-secret'))
})

test('close requires explicit confirmation and a reason', async () => {
  const pool = makePool()
  await assert.rejects(closeAccountingPeriod(pool, closeRequest({ confirm: false })), (error) => error.statusCode === 400)
  await assert.rejects(closeAccountingPeriod(pool, closeRequest({ reason: ' ' })), (error) => error.statusCode === 400)
  assert.equal(pool.state.events.length, 0)
})

test('period closure fails closed and audits the unavailable legacy M-Pesa evidence', async () => {
  const pool = makePool()
  const result = await closeAccountingPeriod(pool, closeRequest())
  assert.equal(result.outcome, 'blocked')
  assert.equal(result.period.status, 'open')
  assert.equal(pool.state.events.length, 1)
  assert.equal(pool.state.events[0].actor_id, USER_A)
  assert.equal(pool.state.events[0].accounting_period_id, PERIOD_A)
  assert.equal(pool.state.events[0].outcome, 'blocked')
  assert.equal(pool.state.events[0].reason, 'Management reviewed the period close checklist')
  assert.equal(pool.state.events[0].details.readiness.can_close, false)
  assert.equal(pool.state.events[0].details.readiness.blockers[0].id, 'legacy_mpesa_coverage')
  assert.ok(pool.state.queries.some((query) => query.sql.includes('FOR UPDATE')))
})

test('ineligible close attempt is audited, remains open, and idempotent retries replay it', async () => {
  const pool = makePool()
  pool.state.issues.set(`${TENANT_A}:${PERIOD_A}:pending_receipts`, [{ id: 'receipt-1', receipt_reference: 'R-1' }])
  const first = await closeAccountingPeriod(pool, closeRequest())
  assert.equal(first.outcome, 'blocked')
  assert.equal(pool.state.periods.get(PERIOD_A).status, 'open')
  assert.equal(pool.state.events[0].outcome, 'blocked')
  assert.equal(pool.state.events[0].details.readiness.blockers[0].id, 'pending_receipts')
  const replay = await closeAccountingPeriod(pool, closeRequest())
  assert.equal(replay.outcome, 'blocked')
  assert.equal(replay.replayed, true)
  assert.equal(pool.state.events.length, 1)
  await assert.rejects(closeAccountingPeriod(pool, closeRequest({ reason: 'Changed reason' })), (error) => error.statusCode === 409)
})

test('simultaneous identical blocked close requests serialize and produce one close audit event', async () => {
  const pool = makePool()
  const results = await Promise.all([
    closeAccountingPeriod(pool, closeRequest()),
    closeAccountingPeriod(pool, closeRequest())
  ])
  assert.deepEqual(results.map((item) => item.outcome), ['blocked', 'blocked'])
  assert.deepEqual(results.map((item) => item.replayed).sort(), [false, true])
  assert.equal(pool.state.events.length, 1)
  assert.equal(pool.state.periods.get(PERIOD_A).status, 'open')
})

test('close refuses to proceed when its append-only audit table is missing', async () => {
  const pool = makePool()
  pool.state.missingSchema.add('accounting_period_events')
  await assert.rejects(closeAccountingPeriod(pool, closeRequest()), (error) => error.statusCode === 503)
  assert.equal(pool.state.periods.get(PERIOD_A).status, 'open')
})

test('dated pending source records take a shared period lock and reject closed dates', async () => {
  const queries = []
  const client = {
    async query(sql, params) {
      queries.push({ sql, params })
      return { rows: [{ id: PERIOD_A, status: 'open' }], rowCount: 1 }
    }
  }
  await assert.doesNotReject(assertDateNotInClosedPeriod(client, TENANT_A, '2026-10-01', 'Receipt date'))
  assert.match(queries[0].sql, /FOR SHARE/)
  assert.deepEqual(queries[0].params, [TENANT_A, '2026-10-01'])

  client.query = async () => ({ rows: [{ id: PERIOD_A, status: 'closed' }], rowCount: 1 })
  await assert.rejects(assertDateNotInClosedPeriod(client, TENANT_A, '2026-10-01', 'Receipt date'),
    (error) => error.statusCode === 409 && /closed accounting period/.test(error.message))
})

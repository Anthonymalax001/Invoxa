const test = require('node:test')
const assert = require('node:assert/strict')
const { postJournal } = require('../src/services/accounting')
const {
  getBalanceSheet,
  getGeneralLedger,
  getProfitAndLoss,
  getTrialBalance
} = require('../src/services/financialReports')
const { closeAccountingPeriod, SCHEMA_REQUIREMENTS } = require('../src/services/accountingPeriodClose')

const IDS = {
  tenant: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  otherTenant: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  user: '11111111-1111-4111-8111-111111111111',
  period: '22222222-2222-4222-8222-222222222222',
  otherPeriod: '33333333-3333-4333-8333-333333333333',
  invoice: '44444444-4444-4444-8444-444444444441',
  receipt: '44444444-4444-4444-8444-444444444442',
  bill: '44444444-4444-4444-8444-444444444443',
  payment: '44444444-4444-4444-8444-444444444444',
  receivables: '55555555-5555-4555-8555-555555555551',
  cash: '55555555-5555-4555-8555-555555555552',
  revenue: '55555555-5555-4555-8555-555555555553',
  taxPayable: '55555555-5555-4555-8555-555555555554',
  expense: '55555555-5555-4555-8555-555555555555',
  equipment: '55555555-5555-4555-8555-555555555556',
  payables: '55555555-5555-4555-8555-555555555557',
  otherCash: '66666666-6666-4666-8666-666666666661',
  otherEquity: '66666666-6666-4666-8666-666666666662'
}

const account = (tenant_id, id, account_code, name, account_type, normal_balance) => ({
  tenant_id, id, account_code, name, account_type, normal_balance, is_active: true
})

function initialState() {
  return {
    settings: [
      { tenant_id: IDS.tenant, base_currency: 'KES' },
      { tenant_id: IDS.otherTenant, base_currency: 'KES' }
    ],
    periods: [
      { id: IDS.period, tenant_id: IDS.tenant, name: 'FY 2026', starts_on: '2026-10-01', ends_on: '2026-10-31', status: 'open' },
      { id: IDS.otherPeriod, tenant_id: IDS.otherTenant, name: 'FY 2026 B', starts_on: '2026-10-01', ends_on: '2026-10-31', status: 'open' }
    ],
    accounts: [
      account(IDS.tenant, IDS.receivables, '1100', 'Trade receivables', 'asset', 'debit'),
      account(IDS.tenant, IDS.cash, '1000', 'Operating bank', 'asset', 'debit'),
      account(IDS.tenant, IDS.revenue, '4000', 'Sales revenue', 'revenue', 'credit'),
      account(IDS.tenant, IDS.taxPayable, '2200', 'Tax payable', 'liability', 'credit'),
      account(IDS.tenant, IDS.expense, '6000', 'Office supplies', 'expense', 'debit'),
      account(IDS.tenant, IDS.equipment, '1500', 'Small equipment', 'asset', 'debit'),
      account(IDS.tenant, IDS.payables, '2000', 'Accounts payable', 'liability', 'credit'),
      account(IDS.otherTenant, IDS.otherCash, '1000', 'Other tenant cash', 'asset', 'debit'),
      account(IDS.otherTenant, IDS.otherEquity, '3000', 'Other tenant equity', 'equity', 'credit')
    ],
    postingEvents: [],
    journals: [],
    journalLines: [],
    periodEvents: [],
    // Synthetic unresolved source records. These represent unsupported activity
    // for close-readiness checks and do not claim production expense/inventory policy.
    expenses: [{ tenant_id: IDS.tenant, id: 'expense-test-1', expense_number: 'EXP-TEST-1', expense_date: '2026-10-12', amount: '5.00', currency: 'KES', status: 'approved' }],
    stockMovements: [{ tenant_id: IDS.tenant, id: 'movement-test-1', product_id: 'product-test-1', movement_type: 'adjustment', quantity_delta: '-1', reference: 'synthetic-fixture', created_at: '2026-10-12T10:00:00Z' }],
    nextJournal: 1,
    nextPostingEvent: 1,
    nextLine: 1
  }
}

const rows = (items = []) => ({ rows: items, rowCount: items.length })
const units = (value) => {
  const [whole, fraction = ''] = String(value || '0').split('.')
  return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'))
}
const decimal = (value) => (value / 1000000n).toString() + '.' + (value % 1000000n).toString().padStart(6, '0')

function makePool() {
  const pool = { data: initialState(), failNextLineInsert: false }
  function queryData(data, sql, params = []) {
    const q = sql.replace(/\s+/g, ' ').trim().toLowerCase()
    if (q.startsWith('insert into accounting_posting_events')) {
      const existing = data.postingEvents.find((event) => event.tenant_id === params[0] && event.idempotency_key === params[1])
      if (existing) return rows()
      const event = {
        id: `81000000-0000-4000-8000-${String(data.nextPostingEvent++).padStart(12, '0')}`,
        tenant_id: params[0], idempotency_key: params[1], payload_hash: params[2], source_type: params[3],
        source_id: params[4], source_reference: params[5], event_type: params[6], created_by: params[7],
        status: 'processing', journal_entry_id: null
      }
      data.postingEvents.push(event)
      return rows([{ id: event.id }])
    }
    if (q.startsWith('select id, payload_hash, status, journal_entry_id from accounting_posting_events')) {
      const event = data.postingEvents.find((item) => item.tenant_id === params[0] && item.idempotency_key === params[1])
      return event ? rows([event]) : rows()
    }
    if (q.startsWith('select base_currency from accounting_settings')) {
      const settings = data.settings.find((item) => item.tenant_id === params[0])
      return settings ? rows([{ base_currency: settings.base_currency }]) : rows()
    }
    if (q.startsWith('select id, status, ($3::date between starts_on and ends_on) as entry_date_in_period from accounting_periods')) {
      const period = data.periods.find((item) => item.tenant_id === params[0] && item.id === params[1])
      return period ? rows([{ id: period.id, status: period.status, entry_date_in_period: params[2] >= period.starts_on && params[2] <= period.ends_on }]) : rows()
    }
    if (q.startsWith('select id, account_type, normal_balance, is_active from accounting_accounts')) {
      const accounts = data.accounts.filter((item) => item.tenant_id === params[0] && params[1].includes(item.id))
      return rows(accounts.map(({ id, account_type, normal_balance, is_active }) => ({ id, account_type, normal_balance, is_active })))
    }
    if (q.startsWith('insert into accounting_journal_entries')) {
      const event = data.postingEvents.find((item) => item.tenant_id === params[0] && item.id === params[9])
      if (!event) throw new Error('Posting event must exist before its journal header')
      const sequence = data.nextJournal++
      const id = `82000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
      data.journals.push({
        id, tenant_id: params[0], accounting_period_id: params[1], entry_date: String(params[2]).slice(0, 10),
        description: params[3], status: 'draft', functional_currency: params[4], source_type: params[5],
        source_id: params[6], source_reference: params[7], event_type: params[8], posting_event_id: params[9],
        reversal_of_entry_id: params[10], reversal_reason: params[11], created_by: params[12],
        created_at: new Date(Date.UTC(2026, 9, 15, 0, 0, sequence)).toISOString()
      })
      return rows([{ id }])
    }
    if (q.startsWith('insert into accounting_journal_lines')) {
      if (pool.failNextLineInsert) {
        pool.failNextLineInsert = false
        throw new Error('simulated journal line insert failure')
      }
      const id = `83000000-0000-4000-8000-${String(data.nextLine++).padStart(12, '0')}`
      data.journalLines.push({
        id, tenant_id: params[0], journal_entry_id: params[1], line_number: params[2], account_id: params[3],
        description: params[4], debit: params[5], credit: params[6], transaction_currency: params[7],
        transaction_amount: params[8], exchange_rate: params[9], exchange_rate_source: params[10], exchange_rate_at: params[11]
      })
      return rows()
    }
    if (q.startsWith("update accounting_journal_entries set status = 'posted'")) {
      const journal = data.journals.find((item) => item.tenant_id === params[1] && item.id === params[2] && item.status === 'draft')
      if (!journal) return rows()
      journal.status = 'posted'
      journal.posted_by = params[0]
      journal.posted_at = '2026-11-01T00:00:00Z'
      return rows([journal])
    }
    if (q.startsWith("update accounting_posting_events set status = 'posted'")) {
      const event = data.postingEvents.find((item) => item.tenant_id === params[1] && item.id === params[2] && item.status === 'processing')
      if (!event) return rows()
      event.status = 'posted'
      event.journal_entry_id = params[0]
      return rows([{ id: event.id }])
    }
    if (q.startsWith('select id, accounting_period_id, entry_date, description, status, functional_currency, source_type, source_id, source_reference, event_type, reversal_of_entry_id, reversal_reason, created_by, posted_by, created_at, posted_at from accounting_journal_entries')) {
      const journal = data.journals.find((item) => item.tenant_id === params[0] && item.id === params[1])
      return journal ? rows([journal]) : rows()
    }
    if (q.startsWith('select line_number, account_id, description, debit, credit, transaction_currency, transaction_amount, exchange_rate, exchange_rate_source, exchange_rate_at from accounting_journal_lines')) {
      return rows(data.journalLines.filter((item) => item.tenant_id === params[0] && item.journal_entry_id === params[1])
        .sort((a, b) => a.line_number - b.line_number))
    }
    if (q.startsWith('with posted as (')) {
      const tenantId = params[0]
      const from = params[1]
      const to = params[2]
      return rows(data.accounts.filter((item) => item.tenant_id === tenantId).map((item) => {
        const sums = { opening_debit: 0n, opening_credit: 0n, period_debit: 0n, period_credit: 0n }
        for (const line of data.journalLines) {
          const journal = data.journals.find((entry) => entry.tenant_id === tenantId && entry.id === line.journal_entry_id && entry.status === 'posted')
          if (!journal || line.account_id !== item.id || journal.entry_date > to) continue
          const prefix = from && journal.entry_date < from ? 'opening' : 'period'
          sums[`${prefix}_debit`] += units(line.debit)
          sums[`${prefix}_credit`] += units(line.credit)
        }
        return {
          id: item.id, account_code: item.account_code, name: item.name,
          account_type: item.account_type, normal_balance: item.normal_balance,
          opening_debit: decimal(sums.opening_debit), opening_credit: decimal(sums.opening_credit),
          period_debit: decimal(sums.period_debit), period_credit: decimal(sums.period_credit)
        }
      }))
    }
    if (q.startsWith('select id, account_code, name, account_type, normal_balance from accounting_accounts')) {
      const found = data.accounts.find((item) => item.tenant_id === params[0] && item.id === params[1])
      return found
        ? rows([{ id: found.id, account_code: found.account_code, name: found.name,
          account_type: found.account_type, normal_balance: found.normal_balance }])
        : rows()
    }
    if (q.startsWith('select coalesce(sum(case when a.normal_balance')) {
      const accountRow = data.accounts.find((item) => item.tenant_id === params[0] && item.id === params[1])
      if (!accountRow) return rows([{ opening_balance: '0.000000' }])
      const opening = data.journalLines.reduce((total, line) => {
        const journal = data.journals.find((item) => item.tenant_id === params[0] &&
          item.id === line.journal_entry_id && item.status === 'posted' && item.entry_date < params[2])
        if (!journal || line.tenant_id !== params[0] || line.account_id !== params[1]) return total
        return total + (accountRow.normal_balance === 'debit'
          ? units(line.debit) - units(line.credit)
          : units(line.credit) - units(line.debit))
      }, 0n)
      return rows([{ opening_balance: decimal(opening) }])
    }
    if (q.startsWith('select count(*)::integer as total')) {
      const total = data.journalLines.filter((line) => {
        const journal = data.journals.find((item) => item.tenant_id === params[0] &&
          item.id === line.journal_entry_id && item.status === 'posted')
        return journal && line.tenant_id === params[0] && line.account_id === params[1] &&
          journal.entry_date >= params[2] && journal.entry_date <= params[3] &&
          (!params[4] || String(journal.source_reference || '').toLowerCase().includes(String(params[4]).toLowerCase()))
      }).length
      return rows([{ total }])
    }
    if (q.startsWith('with ledger_lines as (')) {
      const accountRow = data.accounts.find((item) => item.tenant_id === params[0] && item.id === params[1])
      if (!accountRow) return rows()
      const opening = units(params[4])
      const ledgerRows = data.journalLines.flatMap((line) => {
        const journal = data.journals.find((item) => item.tenant_id === params[0] &&
          item.id === line.journal_entry_id && item.status === 'posted')
        if (!journal || line.tenant_id !== params[0] || line.account_id !== params[1] ||
            journal.entry_date < params[2] || journal.entry_date > params[3] ||
            (params[5] && !String(journal.source_reference || '').toLowerCase().includes(String(params[5]).toLowerCase()))) {
          return []
        }
        return [{ journal, line }]
      }).sort((left, right) => left.journal.entry_date.localeCompare(right.journal.entry_date) ||
        left.journal.created_at.localeCompare(right.journal.created_at) ||
        left.journal.id.localeCompare(right.journal.id) ||
        left.line.line_number - right.line.line_number || left.line.id.localeCompare(right.line.id))
      let running = opening
      return rows(ledgerRows.slice(params[7], params[7] + params[6]).map(({ journal, line }) => {
        running += accountRow.normal_balance === 'debit'
          ? units(line.debit) - units(line.credit)
          : units(line.credit) - units(line.debit)
        return {
          journal_entry_id: journal.id, journal_line_id: line.id, entry_date: journal.entry_date,
          created_at: journal.created_at, source_reference: journal.source_reference,
          source_type: journal.source_type, event_type: journal.event_type,
          reversal_of_entry_id: journal.reversal_of_entry_id, journal_description: journal.description,
          line_description: line.description, debit: line.debit, credit: line.credit,
          running_balance: decimal(running)
        }
      }))
    }
    if (q.startsWith('select base_currency from accounting_settings')) {
      const settings = data.settings.find((item) => item.tenant_id === params[0])
      return settings ? rows([{ base_currency: settings.base_currency }]) : rows()
    }
    if (q.startsWith('select id, name, starts_on, ends_on from accounting_periods')) {
      const period = data.periods.find((item) => item.tenant_id === params[0] && item.id === params[1])
      return period ? rows([period]) : rows()
    }
    if (q.includes('from information_schema.columns')) {
      const tableNames = params[0]
      return rows(tableNames.flatMap((table_name) => (SCHEMA_REQUIREMENTS[table_name] || []).map((column_name) => ({ table_name, column_name }))))
    }
    if (q.startsWith('select id, tenant_id, name, starts_on, ends_on, status, created_by, closed_by, created_at, closed_at from accounting_periods')) {
      const period = data.periods.find((item) => item.tenant_id === params[0] && item.id === params[1])
      return period ? rows([{ ...period }]) : rows()
    }
    if (q.startsWith('select id, accounting_period_id, outcome, reason, details, payload_hash from accounting_period_events')) {
      const event = data.periodEvents.find((item) => item.tenant_id === params[0] && item.idempotency_key === params[1])
      return event ? rows([event]) : rows()
    }
    if (q.startsWith('select id, event_type, outcome, actor_id, reason, details, idempotency_key, created_at from accounting_period_events')) {
      return rows(data.periodEvents.filter((item) => item.tenant_id === params[0] && item.accounting_period_id === params[1]))
    }
    if (q.includes("j.status = 'draft'")) {
      return rows(data.journals.filter((item) => item.tenant_id === params[0] && item.accounting_period_id === params[1] && item.status === 'draft'))
    }
    if (q.includes('having count(l.id) < 2')) {
      const posted = data.journals.filter((item) => item.tenant_id === params[0] && item.accounting_period_id === params[1] && item.status === 'posted')
      const bad = posted.filter((journal) => {
        const lines = data.journalLines.filter((line) => line.tenant_id === journal.tenant_id && line.journal_entry_id === journal.id)
        return lines.length < 2 || lines.reduce((sum, line) => sum + units(line.debit), 0n) !== lines.reduce((sum, line) => sum + units(line.credit), 0n)
      })
      return rows(bad.map((journal) => ({ id: journal.id, total_count: bad.length })))
    }
    if (q.includes('from expenses')) {
      const matches = data.expenses.filter((item) => item.tenant_id === params[0] && item.expense_date >= params[2] && item.expense_date <= params[3] && ['approved', 'paid'].includes(item.status))
      return rows(matches.map((item) => ({ ...item, total_count: matches.length })))
    }
    if (q.includes('from stock_movements')) {
      const matches = data.stockMovements.filter((item) => item.tenant_id === params[0] && item.created_at.slice(0, 10) >= params[2] && item.created_at.slice(0, 10) <= params[3])
      return rows(matches.map((item) => ({ ...item, total_count: matches.length })))
    }
    if (q.startsWith('update accounting_periods set status')) {
      const period = data.periods.find((item) => item.tenant_id === params[1] && item.id === params[2] && item.status === 'open')
      if (!period) return rows()
      Object.assign(period, { status: 'closed', closed_by: params[0], closed_at: '2026-11-01T00:00:00Z' })
      return rows([period])
    }
    if (q.startsWith('insert into accounting_period_events')) {
      const event = {
        id: `84000000-0000-4000-8000-${String(data.periodEvents.length + 1).padStart(12, '0')}`,
        tenant_id: params[0], accounting_period_id: params[1], event_type: 'close', outcome: params[2],
        actor_id: params[3], reason: params[4], idempotency_key: params[5], payload_hash: params[6],
        details: JSON.parse(params[7]), created_at: '2026-11-01T00:00:00Z'
      }
      data.periodEvents.push(event)
      return rows([event])
    }
    const noIssues = [
      'from accounting_opening_balance_batches', 'from customer_receipts', 'from supplier_payments',
      'from supplier_bills', 'from bank_reconciliation_import_batches', 'from mpesa_stk_initiation_requests request'
    ].some((source) => q.includes(source))
    if (noIssues) return rows()
    throw new Error(`Unexpected financial workflow SQL: ${q}`)
  }
  pool.query = (sql, params) => queryData(pool.data, sql, params)
  pool.connect = async () => {
    const client = { data: structuredClone(pool.data) }
    client.query = async (sql, params = []) => {
      const q = sql.replace(/\s+/g, ' ').trim().toLowerCase()
      if (q.startsWith('begin')) return rows()
      if (q === 'commit') {
        pool.data = client.data
        return rows()
      }
      if (q === 'rollback') return rows()
      return queryData(client.data, sql, params)
    }
    client.release = () => {}
    return client
  }
  return pool
}

function journalRequest({ tenantId = IDS.tenant, userId = IDS.user, periodId = IDS.period, idempotencyKey, sourceType, sourceId, sourceReference, description, lines }) {
  return {
    tenantId, userId, idempotencyKey,
    body: {
      accounting_period_id: periodId,
      entry_date: '2026-10-15',
      description,
      source_type: sourceType,
      source_id: sourceId,
      source_reference: sourceReference,
      event_type: sourceType === 'invoice' ? 'issue' : sourceType === 'supplier_bill' ? 'approve' : sourceType === 'supplier_payment' || sourceType === 'customer_receipt' ? 'verify' : 'adjustment',
      lines
    }
  }
}

const line = (account_id, description, debit, credit) => ({ account_id, description, debit, credit })

async function postSampleWorkflowHistory(pool) {
  const entries = [
    journalRequest({ idempotencyKey: `invoice:${IDS.invoice}:issue:v1`, sourceType: 'invoice', sourceId: IDS.invoice, sourceReference: 'INV-0001', description: 'Invoice INV-0001', lines: [
      line(IDS.receivables, 'Invoice receivable', '116.00', '0.00'),
      line(IDS.revenue, 'Sales revenue', '0.00', '100.00'),
      line(IDS.taxPayable, 'Output tax', '0.00', '16.00')
    ] }),
    journalRequest({ idempotencyKey: `customer-receipt:${IDS.receipt}:verify:v1`, sourceType: 'customer_receipt', sourceId: IDS.receipt, sourceReference: 'RCPT-0001', description: 'Verify customer receipt RCPT-0001', lines: [
      line(IDS.cash, 'Customer receipt received', '116.00', '0.00'),
      line(IDS.receivables, 'Customer receivable settled', '0.00', '116.00')
    ] }),
    journalRequest({ idempotencyKey: `supplier-bill:${IDS.bill}:approve:v1`, sourceType: 'supplier_bill', sourceId: IDS.bill, sourceReference: 'SUP-INV-001', description: 'Supplier bill BILL-000001', lines: [
      line(IDS.expense, 'Office supplies', '60.00', '0.00'),
      line(IDS.equipment, 'Small equipment', '40.00', '0.00'),
      line(IDS.payables, 'Accounts payable', '0.00', '100.00')
    ] }),
    journalRequest({ idempotencyKey: `supplier-payment:${IDS.payment}:verify:v1`, sourceType: 'supplier_payment', sourceId: IDS.payment, sourceReference: 'SPAY-000001', description: 'Supplier payment SPAY-000001', lines: [
      line(IDS.payables, 'Supplier payment', '40.00', '0.00'),
      line(IDS.cash, 'Supplier payment', '0.00', '40.00')
    ] })
  ]
  for (const entry of entries) await postJournal(pool, entry)
  return entries
}

test('source workflow journal history flows into tenant-scoped General Ledger and financial reports', async () => {
  const pool = makePool()
  const entries = await postSampleWorkflowHistory(pool)
  assert.equal(pool.data.journals.length, 4)
  assert.equal(pool.data.journalLines.length, 10)
  assert.ok(pool.data.journals.every((journal) => journal.status === 'posted'))

  const retry = await postJournal(pool, entries[0])
  assert.equal(retry.replayed, true)
  assert.equal(pool.data.journals.length, 4)

  const otherTenant = journalRequest({ tenantId: IDS.otherTenant, periodId: IDS.otherPeriod,
    idempotencyKey: 'other-tenant-adjustment-01', sourceType: 'manual_adjustment',
    sourceId: '77777777-7777-4777-8777-777777777777', sourceReference: 'OTHER-1',
    description: 'Other tenant journal', lines: [
      line(IDS.otherCash, 'Other tenant cash', '10.00', '0.00'),
      line(IDS.otherEquity, 'Other tenant equity', '0.00', '10.00')
    ]
  })
  await postJournal(pool, otherTenant)

  const filters = { from: '2026-10-01', to: '2026-10-31' }
  const trialBalance = await getTrialBalance(pool, IDS.tenant, filters)
  const receivablesLedger = await getGeneralLedger(pool, IDS.tenant, {
    accountId: IDS.receivables, ...filters
  })
  const cashLedger = await getGeneralLedger(pool, IDS.tenant, {
    accountId: IDS.cash, ...filters
  })
  const profitAndLoss = await getProfitAndLoss(pool, IDS.tenant, filters)
  const balanceSheet = await getBalanceSheet(pool, IDS.tenant, { asOf: '2026-10-31' })
  assert.equal(trialBalance.balanced, true)
  assert.equal(trialBalance.totals.debit_movement, '372.000000')
  assert.equal(trialBalance.totals.credit_movement, '372.000000')
  const tenantJournals = pool.data.journals.filter((journal) => journal.tenant_id === IDS.tenant)
  for (const journal of tenantJournals) {
    const journalLines = pool.data.journalLines.filter((item) =>
      item.tenant_id === IDS.tenant && item.journal_entry_id === journal.id)
    assert.equal(journalLines.reduce((sum, item) => sum + units(item.debit), 0n),
      journalLines.reduce((sum, item) => sum + units(item.credit), 0n),
    `journal ${journal.source_reference} must balance`)
  }
  assert.equal(trialBalance.rows.find((row) => row.account_id === IDS.receivables).closing_debit, '0.000000')
  assert.equal(trialBalance.rows.find((row) => row.account_id === IDS.cash).closing_debit, '76.000000')
  assert.equal(receivablesLedger.total_rows, 2)
  assert.deepEqual(receivablesLedger.rows.map((row) => row.reference), ['INV-0001', 'RCPT-0001'])
  assert.deepEqual(receivablesLedger.rows.map(({ debit, credit }) => ({ debit, credit })), [
    { debit: '116.000000', credit: '0.000000' },
    { debit: '0.000000', credit: '116.000000' }
  ])
  assert.deepEqual(receivablesLedger.rows.map((row) => row.journal_entry_id),
    pool.data.journals.filter((journal) => journal.tenant_id === IDS.tenant &&
      [IDS.invoice, IDS.receipt].includes(journal.source_id)).map((journal) => journal.id))
  assert.deepEqual(receivablesLedger.rows.map((row) => row.running_debit), ['116.000000', '0.000000'])
  assert.equal(receivablesLedger.rows.at(-1).running_debit,
    trialBalance.rows.find((row) => row.account_id === IDS.receivables).closing_debit)
  assert.equal(cashLedger.total_rows, 2)
  assert.deepEqual(cashLedger.rows.map((row) => row.reference), ['RCPT-0001', 'SPAY-000001'])
  assert.deepEqual(cashLedger.rows.map(({ debit, credit }) => ({ debit, credit })), [
    { debit: '116.000000', credit: '0.000000' },
    { debit: '0.000000', credit: '40.000000' }
  ])
  assert.deepEqual(cashLedger.rows.map((row) => row.running_debit), ['116.000000', '76.000000'])
  assert.equal(cashLedger.rows.at(-1).running_debit,
    trialBalance.rows.find((row) => row.account_id === IDS.cash).closing_debit)
  await assert.rejects(getGeneralLedger(pool, IDS.tenant, {
    accountId: IDS.otherCash, ...filters
  }), (error) => error.statusCode === 404 && /Account not found/.test(error.message))
  const otherTenantLedger = await getGeneralLedger(pool, IDS.otherTenant, {
    accountId: IDS.otherCash, ...filters
  })
  assert.equal(otherTenantLedger.total_rows, 1)
  assert.deepEqual(otherTenantLedger.rows.map((row) => row.reference), ['OTHER-1'])
  assert.equal(trialBalance.rows.find((row) => row.account_id === IDS.payables).closing_credit, '60.000000')
  assert.equal(profitAndLoss.revenue_total, '100.000000')
  assert.equal(profitAndLoss.expense_total, '60.000000')
  assert.equal(profitAndLoss.net_profit, '40.000000')
  assert.equal(balanceSheet.total_assets, '116.000000')
  assert.equal(balanceSheet.total_liabilities, '76.000000')
  assert.equal(balanceSheet.unclosed_earnings, '40.000000')
  assert.equal(balanceSheet.total_liabilities_and_equity, '116.000000')
  assert.equal(balanceSheet.balanced, true)
})

test('period close records blockers for unsupported expense and unaccounted inventory activity without closing', async () => {
  const pool = makePool()
  await postSampleWorkflowHistory(pool)
  const result = await closeAccountingPeriod(pool, {
    tenantId: IDS.tenant, userId: IDS.user, periodId: IDS.period,
    idempotencyKey: 'period-close-workflow-test-01',
    reason: 'Synthetic integration close-readiness check', confirm: true
  })
  assert.equal(result.outcome, 'blocked')
  assert.equal(result.period.status, 'open')
  assert.equal(result.readiness.can_close, false)
  assert.ok(result.readiness.blockers.some((item) => item.id === 'unposted_expenses' && item.count === 1))
  assert.ok(result.readiness.blockers.some((item) => item.id === 'unaccounted_inventory_movements' && item.count === 1))
  assert.ok(result.readiness.blockers.some((item) => item.id === 'legacy_mpesa_coverage'))
  assert.equal(pool.data.periodEvents.length, 1)
  assert.equal(pool.data.periodEvents[0].outcome, 'blocked')
  assert.equal(pool.data.periods.find((item) => item.id === IDS.period).status, 'open')
})

test('a failed journal line insert rolls back its posting event and header from shared ledger history', async () => {
  const pool = makePool()
  await postSampleWorkflowHistory(pool)
  const before = {
    postingEvents: pool.data.postingEvents.length,
    journals: pool.data.journals.length,
    lines: pool.data.journalLines.length
  }
  pool.failNextLineInsert = true
  await assert.rejects(postJournal(pool, journalRequest({
    idempotencyKey: 'supplier-payment-rollback-01', sourceType: 'supplier_payment',
    sourceId: '77777777-7777-4777-8777-777777777777', sourceReference: 'ROLLBACK-1',
    description: 'Simulated failed supplier posting', lines: [
      line(IDS.payables, 'Supplier payment', '5.00', '0.00'),
      line(IDS.cash, 'Supplier payment', '0.00', '5.00')
    ]
  })), /simulated journal line insert failure/)
  assert.equal(pool.data.postingEvents.length, before.postingEvents)
  assert.equal(pool.data.journals.length, before.journals)
  assert.equal(pool.data.journalLines.length, before.lines)
})

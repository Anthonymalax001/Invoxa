const test = require('node:test')
const assert = require('node:assert/strict')
const {
  amountUnits,
  buildBalanceSheet,
  buildCashFlow,
  buildProfitAndLoss,
  buildTrialBalance,
  cashFlowUnavailable,
  formatUnits,
  getBalanceSheet,
  getGeneralLedger,
  getProfitAndLoss,
  getTrialBalance,
  resolveDateRange
} = require('../src/services/financialReports')

const tenantId = '00000000-0000-4000-8000-000000000001'
const periodId = '00000000-0000-4000-8000-000000000002'
const accountId = '00000000-0000-4000-8000-000000000003'

function reportingAccounts() {
  return [
    {
      id: 'cash', account_code: '1000', name: 'Cash', account_type: 'asset', normal_balance: 'debit',
      opening_debit: '100.000000', opening_credit: '0.000000',
      period_debit: '0.100001', period_credit: '0.030000'
    },
    {
      id: 'equity', account_code: '3000', name: 'Capital', account_type: 'equity', normal_balance: 'credit',
      opening_debit: '0.000000', opening_credit: '100.000000',
      period_debit: '0.000000', period_credit: '0.000000'
    },
    {
      id: 'receivables', account_code: '1100', name: 'Receivables', account_type: 'asset', normal_balance: 'debit',
      opening_debit: '0.000000', opening_credit: '0.000000',
      period_debit: '0.100001', period_credit: '0.100001'
    },
    {
      id: 'payables', account_code: '2000', name: 'Payables', account_type: 'liability', normal_balance: 'credit',
      opening_debit: '0.000000', opening_credit: '0.000000',
      period_debit: '0.030000', period_credit: '0.030000'
    },
    {
      id: 'revenue', account_code: '4000', name: 'Sales', account_type: 'revenue', normal_balance: 'credit',
      opening_debit: '0.000000', opening_credit: '0.000000',
      period_debit: '0.000000', period_credit: '0.100001'
    },
    {
      id: 'expense', account_code: '6000', name: 'Supplies', account_type: 'expense', normal_balance: 'debit',
      opening_debit: '0.000000', opening_credit: '0.000000',
      period_debit: '0.030000', period_credit: '0.000000'
    }
  ]
}

test('trial balance totals opening, movement, and closing balances exactly', () => {
  const report = buildTrialBalance(reportingAccounts())
  assert.equal(report.balanced, true)
  assert.deepEqual(report.totals, {
    opening_debit: '100.000000',
    opening_credit: '100.000000',
    debit_movement: '0.260002',
    credit_movement: '0.260002',
    closing_debit: '100.100001',
    closing_credit: '100.100001'
  })
  assert.equal(report.rows.find((row) => row.account_id === 'cash').closing_debit, '100.070001')
})

test('profit and loss uses exact posted-period balances by revenue and expense account type', () => {
  const report = buildProfitAndLoss(reportingAccounts())
  assert.equal(report.revenue_total, '0.100001')
  assert.equal(report.expense_total, '0.030000')
  assert.equal(report.net_profit, '0.070001')
  assert.equal(report.revenue_accounts.length, 1)
  assert.equal(report.expense_accounts.length, 1)
  assert.match(report.classification_note, /subcategories/)
})

test('balance sheet includes unclosed earnings and checks the accounting equation exactly', () => {
  const report = buildBalanceSheet(reportingAccounts())
  assert.equal(report.total_assets, '100.070001')
  assert.equal(report.total_liabilities, '0.000000')
  assert.equal(report.total_equity, '100.000000')
  assert.equal(report.unclosed_earnings, '0.070001')
  assert.equal(report.total_liabilities_and_equity, '100.070001')
  assert.equal(report.balanced, true)
  assert.match(report.classification_note, /Current and non-current/)
})

test('profit and loss and balance sheet treat opposite-normal-balance accounts as contra balances', () => {
  const accounts = [
    { id: 'asset', account_code: '1000', name: 'Cash', account_type: 'asset', normal_balance: 'debit', opening_debit: '0', opening_credit: '0', period_debit: '100', period_credit: '0' },
    { id: 'contra-asset', account_code: '1090', name: 'Accumulated depreciation', account_type: 'asset', normal_balance: 'credit', opening_debit: '0', opening_credit: '0', period_debit: '0', period_credit: '10' },
    { id: 'liability', account_code: '2000', name: 'Payables', account_type: 'liability', normal_balance: 'credit', opening_debit: '0', opening_credit: '0', period_debit: '0', period_credit: '20' },
    { id: 'contra-liability', account_code: '2090', name: 'Contra liability', account_type: 'liability', normal_balance: 'debit', opening_debit: '3', opening_credit: '0', period_debit: '0', period_credit: '0' },
    { id: 'equity', account_code: '3000', name: 'Capital', account_type: 'equity', normal_balance: 'credit', opening_debit: '0', opening_credit: '0', period_debit: '0', period_credit: '50' },
    { id: 'contra-equity', account_code: '3090', name: 'Treasury stock', account_type: 'equity', normal_balance: 'debit', opening_debit: '0', opening_credit: '0', period_debit: '5', period_credit: '0' },
    { id: 'revenue', account_code: '4000', name: 'Sales', account_type: 'revenue', normal_balance: 'credit', opening_debit: '0', opening_credit: '0', period_debit: '0', period_credit: '40' },
    { id: 'contra-revenue', account_code: '4090', name: 'Sales returns', account_type: 'revenue', normal_balance: 'debit', opening_debit: '0', opening_credit: '0', period_debit: '2', period_credit: '0' },
    { id: 'expense', account_code: '6000', name: 'Supplies', account_type: 'expense', normal_balance: 'debit', opening_debit: '0', opening_credit: '0', period_debit: '14', period_credit: '0' },
    { id: 'contra-expense', account_code: '6090', name: 'Expense recovery', account_type: 'expense', normal_balance: 'credit', opening_debit: '0', opening_credit: '0', period_debit: '0', period_credit: '4' }
  ]

  const profitAndLoss = buildProfitAndLoss(accounts)
  assert.equal(profitAndLoss.revenue_total, '38.000000')
  assert.equal(profitAndLoss.expense_total, '10.000000')
  assert.equal(profitAndLoss.net_profit, '28.000000')
  assert.equal(profitAndLoss.revenue_accounts.find((row) => row.account_id === 'contra-revenue').amount, '-2.000000')
  assert.equal(profitAndLoss.expense_accounts.find((row) => row.account_id === 'contra-expense').amount, '-4.000000')

  const balanceSheet = buildBalanceSheet(accounts)
  assert.equal(balanceSheet.total_assets, '90.000000')
  assert.equal(balanceSheet.total_liabilities, '17.000000')
  assert.equal(balanceSheet.total_equity, '45.000000')
  assert.equal(balanceSheet.unclosed_earnings, '28.000000')
  assert.equal(balanceSheet.balanced, true)
})

test('exact decimal conversion does not use binary floating point', () => {
  assert.equal(formatUnits(amountUnits('9007199254740991.123456') + amountUnits('0.000001')), '9007199254740991.123457')
})

test('date range filters resolve tenant-owned periods and reject conflicting dates', async () => {
  const calls = []
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params })
      return {
        rowCount: 1,
        rows: [{ id: periodId, name: 'FY 2026', starts_on: '2026-01-01', ends_on: '2026-12-31' }]
      }
    }
  }
  const range = await resolveDateRange(pool, tenantId, { periodId })
  assert.equal(range.from, '2026-01-01')
  assert.equal(range.to, '2026-12-31')
  assert.match(calls[0].sql, /tenant_id = \$1 AND id = \$2/)
  assert.deepEqual(calls[0].params, [tenantId, periodId])
  await assert.rejects(
    resolveDateRange(pool, tenantId, { periodId, from: '2026-02-01' }),
    /Date range must match/
  )
  await assert.rejects(
    resolveDateRange(pool, tenantId, { from: '2026-02-30', to: '2026-03-31' }),
    (error) => error.statusCode === 400 && /Start date is invalid/.test(error.message)
  )
})

test('as-of date range remains available for balance-sheet cutoffs', async () => {
  const range = await resolveDateRange({ async query() { throw new Error('No period lookup expected') } }, tenantId, { asOf: '2026-06-30' })
  assert.deepEqual(range, { from: null, to: '2026-06-30', period: null, as_of: '2026-06-30' })
})

test('general ledger rejects as-of filters before running nullable date predicates', async () => {
  const calls = []
  const client = {
    async query(sql) {
      calls.push(sql)
      return { rowCount: 0, rows: [] }
    },
    release() {}
  }
  const pool = { async connect() { return client } }
  await assert.rejects(
    getGeneralLedger(pool, tenantId, { accountId, asOf: '2026-06-30' }),
    (error) => error.statusCode === 400 && /As-of dates are not supported for the general ledger/.test(error.message)
  )
  assert.deepEqual(calls, [
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    'ROLLBACK'
  ])
})

test('general ledger rejects malformed pagination instead of truncating it', async () => {
  const fixture = ledgerFixturePool()
  await assert.rejects(
    getGeneralLedger(fixture.pool, tenantId, {
      accountId,
      from: '2026-01-01',
      to: '2026-01-31',
      page: '2junk'
    }),
    (error) => error.statusCode === 400 && /General ledger page must be positive/.test(error.message)
  )
  assert.deepEqual(fixture.calls.map((call) => call.sql), [
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    'ROLLBACK'
  ])
})

function ledgerFixturePool() {
  const calls = []
  const originalId = '00000000-0000-4000-8000-000000000100'
  const reversalId = '00000000-0000-4000-8000-000000000101'
  const laterDebitId = '00000000-0000-4000-8000-000000000102'
  const laterCreditId = '00000000-0000-4000-8000-000000000103'
  const rows = [
    { journal_entry_id: originalId, journal_line_id: '00000000-0000-4000-8000-000000000200', entry_date: '2026-01-03', created_at: '2026-01-03T09:00:00Z', source_reference: 'INV-1', source_type: 'invoice', event_type: 'invoice_issued', reversal_of_entry_id: null, journal_description: 'Original', line_description: null, debit: '10.000000', credit: '0.000000', running_balance: '110.000000' },
    { journal_entry_id: reversalId, journal_line_id: '00000000-0000-4000-8000-000000000201', entry_date: '2026-01-04', created_at: '2026-01-04T09:00:00Z', source_reference: 'REV-1', source_type: 'reversal', event_type: 'journal_reversed', reversal_of_entry_id: originalId, journal_description: 'Reversal', line_description: null, debit: '0.000000', credit: '10.000000', running_balance: '100.000000' },
    { journal_entry_id: laterDebitId, journal_line_id: '00000000-0000-4000-8000-000000000202', entry_date: '2026-01-05', created_at: '2026-01-05T09:00:00Z', source_reference: 'RCPT-2', source_type: 'receipt', event_type: 'receipt_recorded', reversal_of_entry_id: null, journal_description: 'Receipt', line_description: 'Cash received', debit: '0.100001', credit: '0.000000', running_balance: '100.100001' },
    { journal_entry_id: laterCreditId, journal_line_id: '00000000-0000-4000-8000-000000000203', entry_date: '2026-01-06', created_at: '2026-01-06T09:00:00Z', source_reference: 'FEE-2', source_type: 'expense', event_type: 'expense_recorded', reversal_of_entry_id: null, journal_description: 'Fee', line_description: null, debit: '0.000000', credit: '0.020002', running_balance: '100.079999' }
  ]
  const client = {
    async query(sql, params) {
      calls.push({ sql, params })
      if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] }
      if (sql.includes('accounting_settings')) return { rowCount: 1, rows: [{ base_currency: 'KES' }] }
      if (sql.startsWith('SELECT id, account_code, name, account_type, normal_balance')) {
        return { rowCount: 1, rows: [{ id: accountId, account_code: '1000', name: 'Cash', account_type: 'asset', normal_balance: 'debit' }] }
      }
      if (sql.startsWith('SELECT id, name, starts_on, ends_on FROM accounting_periods')) {
        return { rowCount: 1, rows: [{ id: periodId, name: 'January 2026', starts_on: '2026-01-01', ends_on: '2026-01-31' }] }
      }
      if (sql.includes('AS opening_balance')) return { rowCount: 1, rows: [{ opening_balance: '100.000000' }] }
      if (sql.includes('count(*)::integer AS total')) return { rowCount: 1, rows: [{ total: rows.length }] }
      if (sql.includes('WITH ledger_lines AS')) return { rowCount: Math.min(2, rows.length - params[7]), rows: rows.slice(params[7], params[7] + params[6]) }
      throw new Error('Unexpected ledger fixture query')
    },
    release() {}
  }
  return { pool: { async connect() { return client } }, calls, originalId }
}

test('general ledger opening and running balances continue across pages and retain posted reversals', async () => {
  const fixture = ledgerFixturePool()
  const common = { accountId, from: '2026-01-01', to: '2026-01-31', pageSize: 2 }
  const first = await getGeneralLedger(fixture.pool, tenantId, { ...common, page: 1 })
  const second = await getGeneralLedger(fixture.pool, tenantId, { ...common, page: 2 })

  assert.deepEqual(first.opening_balance, { debit: '100.000000', credit: '0.000000' })
  assert.equal(first.total_rows, 4)
  assert.deepEqual(first.rows.map((row) => row.running_debit), ['110.000000', '100.000000'])
  assert.equal(first.rows[1].reversal_of_entry_id, fixture.originalId)
  assert.deepEqual(second.rows.map((row) => row.running_debit), ['100.100001', '100.079999'])
  assert.deepEqual(second.rows.map((row) => row.running_credit), ['0.000000', '0.000000'])
  assert.equal(second.page, 2)

  const countQuery = fixture.calls.find((call) => call.sql.includes('count(*)::integer AS total'))
  const ledgerQueries = fixture.calls.filter((call) => call.sql.includes('WITH ledger_lines AS'))
  assert.match(countQuery.sql, /j\.tenant_id = \$1 AND j\.status = 'posted'/)
  assert.doesNotMatch(countQuery.sql, /reversal_of_entry_id IS NULL/)
  assert.equal(countQuery.params[0], tenantId)
  assert.deepEqual(ledgerQueries.map((call) => call.params.slice(-2)), [[2, 0], [2, 2]])
  assert.ok(ledgerQueries.every((call) => call.params[0] === tenantId && call.sql.includes('j.tenant_id = $1')))
  assert.ok(ledgerQueries.every((call) => call.sql.indexOf('SUM(signed_amount) OVER') < call.sql.indexOf('LIMIT $7 OFFSET $8')))
})

test('general ledger preserves accounting-period date resolution', async () => {
  const fixture = ledgerFixturePool()
  const report = await getGeneralLedger(fixture.pool, tenantId, { accountId, periodId, pageSize: 2 })
  assert.deepEqual(report.range, {
    from: '2026-01-01',
    to: '2026-01-31',
    period: { id: periodId, name: 'January 2026' }
  })
  const ledgerQuery = fixture.calls.find((call) => call.sql.includes('WITH ledger_lines AS'))
  assert.deepEqual(ledgerQuery.params.slice(2, 4), ['2026-01-01', '2026-01-31'])
})

test('profit and loss service applies inclusive selected dates to posted account movements', async () => {
  const calls = []
  const client = {
    async query(sql, params) {
      calls.push({ sql, params })
      if (sql.startsWith('BEGIN') || sql === 'COMMIT') return { rowCount: 0, rows: [] }
      if (sql.includes('accounting_settings')) return { rowCount: 1, rows: [{ base_currency: 'KES' }] }
      if (sql.includes('WITH posted AS')) {
        return { rowCount: 2, rows: [
          { id: 'rev', account_code: '4000', name: 'Sales', account_type: 'revenue', normal_balance: 'credit', opening_debit: '0', opening_credit: '0', period_debit: '0', period_credit: '25.000001' },
          { id: 'exp', account_code: '6000', name: 'Supplies', account_type: 'expense', normal_balance: 'debit', opening_debit: '0', opening_credit: '0', period_debit: '5.000001', period_credit: '0' }
        ] }
      }
      throw new Error('Unexpected profit and loss fixture query')
    },
    release() {}
  }
  const report = await getProfitAndLoss({ async connect() { return client } }, tenantId, { from: '2026-03-01', to: '2026-03-31' })
  const aggregateQuery = calls.find((call) => call.sql.includes('WITH posted AS'))
  assert.deepEqual(aggregateQuery.params, [tenantId, '2026-03-01', '2026-03-31'])
  assert.match(aggregateQuery.sql, /j\.entry_date <= \$3::date/)
  assert.match(aggregateQuery.sql, /p\.entry_date >= \$2::date/)
  assert.equal(report.revenue_total, '25.000001')
  assert.equal(report.expense_total, '5.000001')
  assert.equal(report.net_profit, '20.000000')
})

test('balance sheet service aggregates all posted history through its as-of date', async () => {
  const calls = []
  const client = {
    async query(sql, params) {
      calls.push({ sql, params })
      if (sql.startsWith('BEGIN') || sql === 'COMMIT') return { rowCount: 0, rows: [] }
      if (sql.includes('accounting_settings')) return { rowCount: 1, rows: [{ base_currency: 'KES' }] }
      if (sql.includes('WITH posted AS')) {
        return { rowCount: 2, rows: [
          { id: 'asset', account_code: '1000', name: 'Cash', account_type: 'asset', normal_balance: 'debit', opening_debit: '0', opening_credit: '0', period_debit: '100.000000', period_credit: '0' },
          { id: 'equity', account_code: '3000', name: 'Capital', account_type: 'equity', normal_balance: 'credit', opening_debit: '0', opening_credit: '0', period_debit: '0', period_credit: '100.000000' }
        ] }
      }
      throw new Error('Unexpected balance sheet fixture query')
    },
    release() {}
  }
  const report = await getBalanceSheet({ async connect() { return client } }, tenantId, { asOf: '2026-06-30' })
  const aggregateQuery = calls.find((call) => call.sql.includes('WITH posted AS'))
  assert.deepEqual(aggregateQuery.params, [tenantId, null, '2026-06-30'])
  assert.match(aggregateQuery.sql, /j\.entry_date <= \$3::date/)
  assert.equal(report.range.as_of, '2026-06-30')
  assert.equal(report.total_assets, '100.000000')
  assert.equal(report.total_liabilities_and_equity, '100.000000')
  assert.equal(report.balanced, true)
})

test('trial-balance query is tenant scoped, includes posted journals, and leaves posted reversals in the ledger', async () => {
  const calls = []
  const client = {
    async query(sql, params) {
      calls.push({ sql, params })
      if (sql.startsWith('BEGIN')) return { rowCount: 0, rows: [] }
      if (sql === 'COMMIT') return { rowCount: 0, rows: [] }
      if (sql.includes('accounting_settings')) {
        return { rowCount: 1, rows: [{ base_currency: 'KES' }] }
      }
      return { rowCount: 0, rows: [] }
    },
    release() {}
  }
  const pool = { async connect() { return client } }
  const report = await getTrialBalance(pool, tenantId, { from: '2026-01-01', to: '2026-12-31' })
  const ledgerQuery = calls.find((call) => call.sql.includes('WITH posted AS'))
  assert.ok(ledgerQuery)
  assert.match(ledgerQuery.sql, /l\.tenant_id = \$1 AND j\.tenant_id = \$1 AND j\.status = 'posted'/)
  assert.doesNotMatch(ledgerQuery.sql, /reversal_of_entry_id IS NULL/)
  assert.deepEqual(ledgerQuery.params, [tenantId, '2026-01-01', '2026-12-31'])
  assert.equal(calls[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(calls.at(-1).sql, 'COMMIT')
  assert.equal(report.currency, 'KES')
  assert.deepEqual(report.rows, [])
  assert.equal(report.balanced, true)
})

test('cash flow remains unavailable until account and posted-line classifications exist', () => {
  const report = cashFlowUnavailable()
  assert.equal(report.report, 'cash_flow')
  assert.equal(report.available, false)
  assert.match(report.reason, /cash equivalents/)
  assert.ok(report.required_configuration.some((item) => item.includes('journal line')))
})

test('cash flow derives exact movements from designated ledger accounts', () => {
  const report = buildCashFlow([
    { id: 'cash', account_code: '1000', name: 'Cash' }
  ], [
    { account_id: 'cash', debit: '100.000001', credit: '0.000000', in_period: false, counterpart_types: ['equity'] },
    { account_id: 'cash', debit: '25.000002', credit: '0.000000', in_period: true, counterpart_types: ['revenue'] },
    { account_id: 'cash', debit: '0.000000', credit: '4.000001', in_period: true, counterpart_types: ['expense'] }
  ])
  assert.equal(report.opening_cash, '100.000001')
  assert.equal(report.net_change, '21.000001')
  assert.equal(report.closing_cash, '121.000002')
  assert.deepEqual(report.sections.operating, {
    inflows: '25.000002', outflows: '4.000001', net: '21.000001'
  })
  assert.deepEqual(report.sections.financing, {
    inflows: '0.000000', outflows: '0.000000', net: '0.000000'
  })
  assert.equal(report.accounts[0].closing_balance, '121.000002')
})

test('CSV export quotes delimiters, escapes quotes and newlines, and protects text formulas', async () => {
  const { createFinancialReportCsv } = await import('../../client/src/utils/financialReportCsv.js')
  const csv = createFinancialReportCsv(
    [
      { key: 'reference', label: 'Reference', type: 'text' },
      { key: 'amount', label: 'Amount', type: 'number' },
      { key: 'description', label: 'Description', type: 'text' }
    ],
    [{ reference: '=IMPORTXML("secret")', amount: '-10.250000', description: 'Line 1,\n"Line 2"' }]
  )
  assert.equal(
    csv,
    '\uFEFF"Reference","Amount","Description"\r\n"\u0027=IMPORTXML(""secret"")","-10.250000","Line 1,\n""Line 2"""'
  )
})

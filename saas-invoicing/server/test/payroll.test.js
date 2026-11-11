const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const { componentInput, compensationInput, formatUnits, moneyUnits, payrollPeriod, remittanceInput, settingsInput, percentage, statutoryValue } = require('../src/utils/payroll')

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'

test('payroll inputs reject unsupported statutory assumptions and preserve decimal strings', () => {
  const component = componentInput({
    code: 'paye', name: 'PAYE', component_kind: 'deduction',
    calculation_type: 'percentage', amount: '12.345600', effective_from: '2026-01-01',
    configuration: { bands: [{ threshold: 'configured-by-tenant' }] }
  })
  assert.equal(component.amount, '12.345600')
  assert.deepEqual(component.configuration, { bands: [{ threshold: 'configured-by-tenant' }] })
  assert.equal(component.is_statutory, false)
  assert.throws(() => componentInput({
    code: 'bad rate', name: 'Bad', component_kind: 'deduction',
    calculation_type: 'percentage', amount: '16', effective_from: '2026-01-01'
  }), /Component code is invalid/)
})

test('statutory components require explicit source metadata and remittances preserve exact amounts', () => {
  const component = componentInput({
    code: 'nssf', name: 'NSSF', component_kind: 'deduction',
    calculation_type: 'percentage', amount: '6.000000', effective_from: '2026-02-01',
    is_statutory: true, statutory_authority: 'NSSF', statutory_code: 'YEAR_4_2026'
  })
  assert.equal(component.statutory_authority, 'NSSF')
  assert.equal(component.statutory_code, 'YEAR_4_2026')
  assert.throws(() => componentInput({
    code: 'paye', name: 'PAYE', component_kind: 'deduction',
    calculation_type: 'percentage', amount: '10', effective_from: '2026-01-01', is_statutory: true
  }), /required|invalid/i)
  const remittance = remittanceInput({
    obligation_id: RUN, payment_date: '2026-11-09', amount: '123.450001',
    payment_reference: 'SHA-001', payment_account_id: USER
  })
  assert.equal(remittance.amount, '123.450001')
  assert.equal(formatUnits(percentage('1000.000000', '1.5')), '15.000000')
  assert.equal(formatUnits(moneyUnits('123.450001')), '123.450001')
})

test('PAYE applies monthly bands and only grants explicitly eligible personal relief', () => {
  const component = componentInput({
    code: 'paye', name: 'PAYE', component_kind: 'deduction',
    calculation_type: 'percentage', amount: '0', effective_from: '2026-02-01',
    is_statutory: true, statutory_authority: 'KRA', statutory_code: 'PAYE'
  })
  assert.equal(formatUnits(statutoryValue(component, { gross: moneyUnits('24000'), values: new Map() }).value), '2400.000000')
  assert.equal(formatUnits(statutoryValue(component, { gross: moneyUnits('32333'), values: new Map(), profile: { tax_resident: true } }).value), '2083.250000')
  assert.equal(formatUnits(statutoryValue(component, { gross: moneyUnits('800000'), values: new Map() }).value), '242283.350000')
})

test('NSSF tiers, SHIF minimum and housing levy use exact effective rules and cent rounding', () => {
  const make = (code, kind = 'deduction') => componentInput({
    code: code.toLowerCase(), name: code, component_kind: kind, calculation_type: 'percentage',
    amount: '0', effective_from: code === 'NSSF' ? '2026-02-01' : '2026-01-01',
    is_statutory: true, statutory_authority: code === 'SHIF' ? 'SHA' : code, statutory_code: code
  })
  const values = new Map()
  assert.equal(formatUnits(statutoryValue(make('NSSF'), { gross: moneyUnits('9000'), values }).value), '540.000000')
  assert.equal(formatUnits(statutoryValue(make('NSSF'), { gross: moneyUnits('200000'), values }).value), '6480.000000')
  assert.equal(formatUnits(statutoryValue(make('NSSF', 'employer_contribution'), { gross: moneyUnits('100000'), values }).value), '6000.000000')
  assert.equal(formatUnits(statutoryValue(make('SHIF'), { gross: moneyUnits('10000'), values }).value), '300.000000')
  assert.equal(formatUnits(statutoryValue(make('SHIF'), { gross: moneyUnits('10001'), values }).value), '300.000000')
  assert.equal(formatUnits(statutoryValue(make('SHIF'), { gross: moneyUnits('20000'), values }).value), '550.000000')
  assert.equal(formatUnits(statutoryValue(make('HOUSING', 'employer_contribution'), { gross: moneyUnits('100000'), values }).value), '1500.000000')
})

test('payroll period and compensation validation are tenant-neutral and exact', () => {
  assert.deepEqual(payrollPeriod({
    period_start: '2026-11-01', period_end: '2026-11-30',
    pay_frequency: 'monthly', accounting_period_id: RUN
  }).period_end, '2026-11-30')
  assert.equal(compensationInput({
    employee_id: USER, effective_from: '2026-01-01',
    pay_frequency: 'monthly', basic_salary: '123456.789012', currency: 'kes'
  }).basic_salary, '123456.789012')
  assert.throws(() => payrollPeriod({
    period_start: '2026-11-30', period_end: '2026-11-01',
    pay_frequency: 'monthly', accounting_period_id: RUN
  }), /Period end/)
})

test('payroll settings require all supported frequencies and ISO currency', () => {
  assert.equal(settingsInput({ currency: 'kes', pay_frequency: 'monthly' }).currency, 'KES')
  assert.throws(() => settingsInput({ currency: 'KES', pay_frequency: 'daily' }), /Pay frequency/)
})

test('payroll journal lines omit zero numeric totals returned by PostgreSQL', () => {
  const servicePath = require.resolve('../src/services/payroll')
  const { payrollJournalLines } = require(servicePath)
  const settings = {
    salary_expense_account_id: '33333333-3333-4333-8333-333333333331',
    employer_contribution_expense_account_id: '33333333-3333-4333-8333-333333333332',
    employee_deductions_payable_account_id: '33333333-3333-4333-8333-333333333333',
    employer_contributions_payable_account_id: '33333333-3333-4333-8333-333333333334',
    net_salary_payable_account_id: '33333333-3333-4333-8333-333333333335'
  }
  const lines = payrollJournalLines({
    total_gross: '100000.000000',
    total_employer_contributions: '0.000000',
    total_employee_deductions: '6000.000000',
    total_net: '94000.000000'
  }, settings)
  assert.deepEqual(lines.map((line) => line.account_id), [
    settings.salary_expense_account_id,
    settings.employee_deductions_payable_account_id,
    settings.net_salary_payable_account_id
  ])
})

test('payroll journal date normalizes PostgreSQL date values without shifting the calendar day', () => {
  const servicePath = require.resolve('../src/services/payroll')
  const { payrollJournalBody } = require(servicePath)
  const body = payrollJournalBody({
    accounting_period_id: RUN,
    id: '44444444-4444-4444-8444-444444444444',
    period_start: '2026-11-01',
    period_end: new Date('2026-11-30T00:00:00.000Z')
  }, {}, [], 'payroll_approval')
  assert.equal(body.entry_date, '2026-11-30')
})

test('payroll service calculates exact snapshots and locks the run', async () => {
  const servicePath = require.resolve('../src/services/payroll')
  const accountingPath = require.resolve('../src/services/accounting')
  const original = require.cache[accountingPath]
  const calls = []
  const mock = new Module(accountingPath)
  mock.filename = accountingPath
  mock.loaded = true
  mock.exports = { postJournal: async () => ({ journal: { id: 'journal-1' }, replayed: false }), withTransaction: async (pool, work) => work(pool) }
  require.cache[accountingPath] = mock
  delete require.cache[servicePath]
  const { calculateRun } = require(servicePath)
  const queries = []
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params })
      if (sql.includes('SELECT * FROM hr_payroll_runs')) return { rowCount: 1, rows: [{ id: RUN, tenant_id: TENANT, status: 'draft', period_start: '2026-11-01', period_end: '2026-11-30' }] }
      if (sql.includes('FROM hr_employees e')) return { rowCount: 1, rows: [{ id: USER, employee_number: 'EMP-1', first_name: 'A', last_name: 'User', compensation_id: 'comp-1', basic_salary: '1000.000000', currency: 'KES', pay_frequency: 'monthly' }] }
      if (sql.includes('FROM hr_payroll_components')) return { rows: [{ code: 'allowance', name: 'Allowance', component_kind: 'earning', calculation_type: 'fixed', amount: '0.100001', configuration: {} }], rowCount: 1 }
      if (sql.includes('FROM hr_attendance')) return { rows: [{ overtime_minutes: 0 }], rowCount: 1 }
      if (sql.includes('FROM hr_leave_applications')) return { rows: [{ unpaid_days: 0 }], rowCount: 1 }
      if (sql.includes('UPDATE hr_payroll_runs')) return { rows: [{ id: RUN, status: 'calculated', total_gross: '1000.100001' }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }
  }
  const result = await calculateRun(client, TENANT, RUN, USER)
  assert.equal(result.status, 'calculated')
  assert.ok(queries.some((query) => query.sql.includes('FOR UPDATE')))
  assert.ok(queries.some((query) => query.sql.includes('INSERT INTO hr_payroll_items')))
  assert.ok(queries.some((query) => query.sql.includes('effective_from <= $2::date') && query.sql.includes('effective_to >= $3::date')))
  require.cache[accountingPath] = original
  delete require.cache[servicePath]
  calls.length = 0
})

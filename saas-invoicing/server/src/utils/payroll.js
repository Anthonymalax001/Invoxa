const { validate: isUuid } = require('uuid')
const { validationError } = require('./accounting')

const PAY_FREQUENCIES = ['weekly', 'biweekly', 'monthly']
const COMPONENT_KINDS = ['earning', 'deduction', 'employer_contribution']
const CALCULATION_TYPES = ['fixed', 'percentage']
const RUN_STATUSES = ['draft', 'calculated', 'approved', 'paid']
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/
const MICRO = 1000000n
const CENT = 10000n
const STATUTORY_SOURCES = {
  PAYE: 'https://www.kra.go.ke/individual/filing-paying/types-of-taxes/paye',
  NSSF: 'https://www.nssf.or.ke/notice-to-employers-year-4-2026-nssf-contribution-rates/',
  SHIF: 'https://new.kenyalaw.org/akn/ke/act/ln/2024/49/eng%402025-02-28/source',
  HOUSING: 'https://www.kra.go.ke/news-center/public-notices/2099-collection-of-the-affordable-housing-levy-by-kenya-revenue-authority'
}

const STATUTORY_DEFAULTS = {
  PAYE: {
    rule_type: 'paye', frequency: 'monthly', effective_from: '2026-01-01', source_url: STATUTORY_SOURCES.PAYE,
    bands: [['24000', '10'], ['8333', '25'], ['467667', '30'], ['300000', '32.5'], [null, '35']],
    personal_relief: '2400', relief_eligibility: 'explicit', allowable_deduction_codes: []
  },
  NSSF: {
    rule_type: 'nssf', frequency: 'monthly', effective_from: '2026-02-01', source_url: STATUTORY_SOURCES.NSSF,
    employee_rate: '6', employer_rate: '6', lower_earnings_limit: '9000',
    upper_earnings_limit: '108000', max_employee: '6480', max_employer: '6480',
    rounding: 'half_up_cent'
  },
  SHIF: {
    rule_type: 'shif', frequency: 'monthly', effective_from: '2024-10-01', source_url: STATUTORY_SOURCES.SHIF,
    employee_rate: '2.75', minimum_employee: '300', rounding: 'half_up_cent'
  },
  HOUSING: {
    rule_type: 'housing_levy', frequency: 'monthly', effective_from: '2024-03-19', source_url: STATUTORY_SOURCES.HOUSING,
    employee_rate: '1.5', employer_rate: '1.5', rounding: 'half_up_cent'
  }
}

function date(value, label) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) throw validationError(`${label} must use YYYY-MM-DD`)
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw validationError(`${label} is invalid`)
  return value
}

function decimal(value, label, { required = true } = {}) {
  if ((value == null || value === '') && !required) return null
  if (!DECIMAL.test(String(value))) throw validationError(`${label} must be a non-negative decimal with at most six decimal places`)
  return String(value)
}

function payrollPeriod(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw validationError('Payroll period is required')
  const start = date(body.period_start, 'Period start')
  const end = date(body.period_end, 'Period end')
  if (end < start) throw validationError('Period end must not be before period start')
  if (!PAY_FREQUENCIES.includes(body.pay_frequency)) throw validationError('Pay frequency is invalid')
  if (!isUuid(body.accounting_period_id)) throw validationError('Accounting period is required')
  return { period_start: start, period_end: end, pay_frequency: body.pay_frequency, accounting_period_id: body.accounting_period_id }
}

function componentInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw validationError('Payroll component is required')
  const code = String(body.code || '').trim().toLowerCase()
  const name = String(body.name || '').trim()
  if (!/^[a-z][a-z0-9_-]{1,49}$/.test(code)) throw validationError('Component code is invalid')
  if (!name || name.length > 120) throw validationError('Component name is required')
  if (!COMPONENT_KINDS.includes(body.component_kind)) throw validationError('Component kind is invalid')
  if (!CALCULATION_TYPES.includes(body.calculation_type)) throw validationError('Calculation type is invalid')
  if (body.is_statutory === true && (!body.statutory_authority || !body.statutory_code)) {
    throw validationError('Statutory authority and code are required for statutory components')
  }
  return {
    code, name, component_kind: body.component_kind, calculation_type: body.calculation_type,
    amount: decimal(body.amount, 'Component amount'), base_component_code: body.base_component_code || null,
    is_taxable: body.is_taxable === true, is_active: body.is_active !== false,
    effective_from: date(body.effective_from, 'Effective from'),
    effective_to: body.effective_to ? date(body.effective_to, 'Effective to') : null,
    is_statutory: body.is_statutory === true,
    statutory_authority: body.is_statutory === true && body.statutory_authority ? String(body.statutory_authority).trim().toUpperCase() : null,
    statutory_code: body.is_statutory === true && body.statutory_code ? String(body.statutory_code).trim().toUpperCase() : null,
    configuration: body.is_statutory === true
      ? { ...(statutoryDefaults(body.statutory_code || code) || {}), ...(body.configuration && typeof body.configuration === 'object' ? body.configuration : {}) }
      : (body.configuration && typeof body.configuration === 'object' ? body.configuration : {})
  }
}

function compensationInput(body) {
  if (!body || !isUuid(body.employee_id)) throw validationError('Employee is required')
  if (!PAY_FREQUENCIES.includes(body.pay_frequency)) throw validationError('Pay frequency is invalid')
  return {
    employee_id: body.employee_id, effective_from: date(body.effective_from, 'Effective from'),
    effective_to: body.effective_to ? date(body.effective_to, 'Effective to') : null,
    pay_frequency: body.pay_frequency, basic_salary: decimal(body.basic_salary, 'Basic salary'),
    currency: String(body.currency || '').trim().toUpperCase(),
    statutory_profile: body.statutory_profile && typeof body.statutory_profile === 'object' ? body.statutory_profile : {}
  }
}

function settingsInput(body) {
  if (!body || typeof body !== 'object') throw validationError('Payroll settings are required')
  if (!/^[A-Z]{3}$/.test(String(body.currency || '').trim().toUpperCase())) throw validationError('Currency must be a three-letter ISO code')
  if (!PAY_FREQUENCIES.includes(body.pay_frequency)) throw validationError('Pay frequency is invalid')
  const accounts = ['salary_expense_account_id', 'employer_contribution_expense_account_id',
    'employer_contributions_payable_account_id', 'employee_deductions_payable_account_id',
    'net_salary_payable_account_id', 'payroll_cash_account_id']
  for (const account of accounts) if (body[account] != null && !isUuid(body[account])) throw validationError(`${account} must be a valid account`)
  return { currency: body.currency.trim().toUpperCase(), pay_frequency: body.pay_frequency, ...Object.fromEntries(accounts.map((account) => [account, body[account] || null])) }
}

function remittanceInput(body) {
  if (!body || typeof body !== 'object') throw validationError('Remittance is required')
  if (!isUuid(body.obligation_id)) throw validationError('Statutory obligation is required')
  if (!DATE_PATTERN.test(String(body.payment_date || ''))) throw validationError('Payment date must use YYYY-MM-DD')
  const paymentDate = date(body.payment_date, 'Payment date')
  if (!isUuid(body.payment_account_id)) throw validationError('Payment account is required')
  const amount = decimal(body.amount, 'Remittance amount')
  const reference = String(body.payment_reference || '').trim()
  if (!reference || reference.length > 120) throw validationError('Payment reference is required')
  return { obligation_id: body.obligation_id, payment_date: paymentDate, amount, payment_account_id: body.payment_account_id, payment_reference: reference }
}

function moneyUnits(value) {
  const [whole, fraction = ''] = String(value).split('.')
  return BigInt(whole) * 1000000n + BigInt((fraction + '000000').slice(0, 6))
}

function formatUnits(units) {
  const sign = units < 0n ? '-' : ''
  const absolute = units < 0n ? -units : units
  return `${sign}${absolute / 1000000n}.${(absolute % 1000000n).toString().padStart(6, '0')}`
}

function percentage(base, rate) {
  const rateText = String(rate)
  const rateFraction = rateText.includes('.') ? rateText.split('.')[1].length : 0
  const rateNumerator = BigInt(rateText.replace('.', ''))
  return divideRounded(moneyUnits(base) * rateNumerator, (10n ** BigInt(rateFraction)) * 100n)
}

function divideRounded(numerator, denominator) {
  if (denominator <= 0n) throw new RangeError('Denominator must be positive')
  const quotient = numerator / denominator
  return numerator % denominator * 2n >= denominator ? quotient + 1n : quotient
}

function roundToCent(units) {
  return divideRounded(units, CENT) * CENT
}

function decimalUnits(value, label) {
  if (!DECIMAL.test(String(value))) throw validationError(`${label} must be a non-negative decimal`)
  return moneyUnits(String(value))
}

function statutoryDefaults(code) {
  const normalized = String(code || '').toUpperCase()
  if (normalized.includes('PAYE')) return { ...STATUTORY_DEFAULTS.PAYE }
  if (normalized.includes('NSSF')) return { ...STATUTORY_DEFAULTS.NSSF }
  if (normalized.includes('SHIF') || normalized.includes('NHIF')) return { ...STATUTORY_DEFAULTS.SHIF }
  if (normalized.includes('HOUS') || normalized.includes('AHL')) return { ...STATUTORY_DEFAULTS.HOUSING }
  return null
}

function statutoryConfiguration(component) {
  const defaults = statutoryDefaults(component.statutory_code || component.code)
  const configuration = component.configuration && typeof component.configuration === 'object'
    ? component.configuration : {}
  const rule = { ...(defaults || {}), ...configuration }
  if (!rule.rule_type || !rule.source_url || !rule.effective_from) {
    throw validationError(`Statutory component ${component.code} has incomplete verified rule configuration`)
  }
  if (component.effective_from && component.effective_from < rule.effective_from) {
    throw validationError(`Statutory component ${component.code} predates its configured rule`)
  }
  return rule
}

function bandTax(taxable, bands) {
  let remaining = taxable
  let tax = 0n
  for (const [limit, rate] of bands) {
    if (remaining <= 0n) break
    const slice = limit == null ? remaining : remaining < decimalUnits(limit, 'PAYE band') ? remaining : decimalUnits(limit, 'PAYE band')
    tax += percentage(formatUnits(slice), rate)
    remaining -= slice
  }
  return tax
}

function statutoryValue(component, { gross, details, values, profile = {} }) {
  const rule = statutoryConfiguration(component)
  const base = gross
  let value
  let breakdown
  if (rule.rule_type === 'paye') {
    const deductionCodes = profile.allowable_deduction_codes || rule.allowable_deduction_codes || []
    const allowable = deductionCodes.reduce(
      (total, code) => total + (values.get(String(code).toLowerCase()) || 0n), 0n
    )
    const taxable = base > allowable ? base - allowable : 0n
    const beforeRelief = bandTax(taxable, rule.bands)
    const reliefEligible = profile.personal_relief_eligible === true || profile.tax_resident === true
    const relief = reliefEligible ? decimalUnits(rule.personal_relief || '0', 'Personal relief') : 0n
    value = beforeRelief > relief ? beforeRelief - relief : 0n
    breakdown = { taxable_base: formatUnits(taxable), tax_before_relief: formatUnits(beforeRelief), relief: formatUnits(relief), relief_eligible: reliefEligible, allowable_deduction_codes: deductionCodes }
  } else if (rule.rule_type === 'nssf') {
    const lower = decimalUnits(rule.lower_earnings_limit, 'NSSF lower earnings limit')
    const upper = decimalUnits(rule.upper_earnings_limit, 'NSSF upper earnings limit')
    const tierOne = base < lower ? base : lower
    const tierTwo = base > lower ? (base < upper ? base - lower : upper - lower) : 0n
    const rate = component.component_kind === 'employer_contribution' ? rule.employer_rate : rule.employee_rate
    value = percentage(formatUnits(tierOne + tierTwo), rate)
    const maximum = component.component_kind === 'employer_contribution' ? rule.max_employer : rule.max_employee
    if (maximum != null) value = value > decimalUnits(maximum, 'NSSF maximum') ? decimalUnits(maximum, 'NSSF maximum') : value
    breakdown = { tier_one_base: formatUnits(tierOne), tier_two_base: formatUnits(tierTwo), rate, cap: maximum || null }
  } else if (rule.rule_type === 'shif') {
    value = percentage(formatUnits(base), rule.employee_rate)
    const minimum = decimalUnits(rule.minimum_employee, 'SHIF minimum')
    if (value < minimum) value = minimum
    breakdown = { gross_base: formatUnits(base), rate: rule.employee_rate, minimum: rule.minimum_employee }
  } else if (rule.rule_type === 'housing_levy') {
    const rate = component.component_kind === 'employer_contribution' ? rule.employer_rate : rule.employee_rate
    value = percentage(formatUnits(base), rate)
    breakdown = { gross_base: formatUnits(base), rate }
  } else {
    throw validationError(`Unsupported statutory rule type for ${component.code}`)
  }
  if (rule.rounding !== 'none') value = roundToCent(value)
  return { value, rule, breakdown }
}

module.exports = {
  CALCULATION_TYPES, COMPONENT_KINDS, PAY_FREQUENCIES, RUN_STATUSES,
  compensationInput, componentInput, date, decimal, formatUnits, moneyUnits, payrollPeriod,
  percentage, remittanceInput, settingsInput, statutoryConfiguration, statutoryDefaults,
  statutoryValue, roundToCent, STATUTORY_SOURCES
}

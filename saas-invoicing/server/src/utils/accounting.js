const crypto = require('node:crypto')
const { validate: isUuid } = require('uuid')

const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense']
const NORMAL_BALANCES = ['debit', 'credit']
const CURRENCIES = /^[A-Z]{3}$/
const PERIOD_DATE = /^\d{4}-\d{2}-\d{2}$/
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/

function validationError(message) {
  const error = new Error(message)
  error.statusCode = 400
  return error
}

function httpError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function text(value, label, maxLength, { required = false } = {}) {
  if (value == null) {
    if (required) throw validationError(`${label} is required`)
    return null
  }
  if (typeof value !== 'string') throw validationError(`${label} must be text`)
  const normalized = value.trim()
  if (required && normalized.length === 0) throw validationError(`${label} is required`)
  if (normalized.length > maxLength) throw validationError(`${label} must be ${maxLength} characters or fewer`)
  return normalized || null
}

function date(value, label, { required = true } = {}) {
  if ((value == null || value === '') && !required) return null
  if (typeof value !== 'string' || !PERIOD_DATE.test(value)) {
    throw validationError(`${label} must use YYYY-MM-DD`)
  }
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw validationError(`${label} is invalid`)
  }
  return value
}

function decimalUnits(value, scale, label, { allowZero = false } = {}) {
  if (typeof value !== 'string') {
    throw validationError(`${label} must be a decimal string`)
  }
  const match = DECIMAL.exec(value)
  if (!match) throw validationError(`${label} must be a non-negative decimal`)
  const fraction = match[1] || ''
  if (fraction.length > scale) throw validationError(`${label} supports at most ${scale} decimal places`)
  const integer = value.split('.')[0]
  if (integer.length > 20 - scale) throw validationError(`${label} is too large`)
  const units = BigInt(integer) * (10n ** BigInt(scale)) + BigInt((fraction + '0'.repeat(scale)).slice(0, scale) || '0')
  if (!allowZero && units <= 0n) throw validationError(`${label} must be greater than zero`)
  return units
}

function formatUnits(units, scale) {
  const factor = 10n ** BigInt(scale)
  const integer = units / factor
  const fraction = (units % factor).toString().padStart(scale, '0')
  return `${integer}.${fraction}`
}

function decimal(value, scale, label, options) {
  return formatUnits(decimalUnits(value, scale, label, options), scale)
}

function normalizeIdempotencyKey(value) {
  const key = text(value, 'Idempotency-Key', 100, { required: true })
  if (!key || key.length < 8 || /[\r\n]/.test(key)) {
    throw validationError('Idempotency-Key must contain 8 to 100 characters')
  }
  return key
}

function normalizeCurrency(value, label = 'Currency') {
  if (typeof value !== 'string') throw validationError(`${label} must be a three-letter ISO code`)
  const currency = value.trim().toUpperCase()
  if (!CURRENCIES.test(currency)) throw validationError(`${label} must be a three-letter ISO code`)
  return currency
}

function normalizeAccount(body) {
  const source = object(body)
  const accountCode = text(source.account_code, 'Account code', 30, { required: true })
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(accountCode)) {
    throw validationError('Account code contains unsupported characters')
  }
  const accountType = source.account_type
  const normalBalance = source.normal_balance
  if (!ACCOUNT_TYPES.includes(accountType)) throw validationError('Invalid account type')
  if (!NORMAL_BALANCES.includes(normalBalance)) throw validationError('Invalid normal balance')
  return {
    account_code: accountCode.toUpperCase(),
    name: text(source.name, 'Account name', 150, { required: true }),
    account_type: accountType,
    normal_balance: normalBalance
  }
}

function normalizePeriod(body) {
  const source = object(body)
  const normalized = {
    name: text(source.name, 'Period name', 100, { required: true }),
    starts_on: date(source.starts_on, 'Period start date'),
    ends_on: date(source.ends_on, 'Period end date')
  }
  if (normalized.starts_on > normalized.ends_on) {
    throw validationError('Period start date must not be after its end date')
  }
  return normalized
}

function normalizeLine(line, index) {
  const source = object(line)
  const label = `Journal line ${index + 1}`
  if (!isUuid(source.account_id)) throw validationError(`${label} has an invalid account`)
  const debitUnits = decimalUnits(source.debit == null ? '0' : source.debit, 6, `${label} debit`, { allowZero: true })
  const creditUnits = decimalUnits(source.credit == null ? '0' : source.credit, 6, `${label} credit`, { allowZero: true })
  if ((debitUnits > 0n) === (creditUnits > 0n)) {
    throw validationError(`${label} must have either a positive debit or a positive credit`)
  }

  const transactionCurrency = source.transaction_currency == null
    ? null
    : normalizeCurrency(source.transaction_currency, `${label} transaction currency`)
  const suppliedConversion = [source.transaction_amount, source.exchange_rate,
    source.exchange_rate_source, source.exchange_rate_at].some((value) => value != null)
  let transactionAmount = null
  let exchangeRate = null
  let exchangeRateSource = null
  let exchangeRateAt = null
  if (transactionCurrency || suppliedConversion) {
    if (!transactionCurrency || source.transaction_amount == null || source.exchange_rate == null ||
        source.exchange_rate_source == null || source.exchange_rate_at == null) {
      throw validationError(`${label} currency conversion requires currency, amount, rate, rate source and rate timestamp`)
    }
    transactionAmount = decimal(source.transaction_amount, 6, `${label} transaction amount`)
    exchangeRate = decimal(source.exchange_rate, 10, `${label} exchange rate`)
    exchangeRateSource = text(source.exchange_rate_source, `${label} exchange-rate source`, 100, { required: true })
    const rawExchangeRateAt = source.exchange_rate_at instanceof Date
      ? source.exchange_rate_at.toISOString()
      : source.exchange_rate_at
    if (typeof rawExchangeRateAt !== 'string' || Number.isNaN(Date.parse(rawExchangeRateAt))) {
      throw validationError(`${label} exchange-rate timestamp is invalid`)
    }
    exchangeRateAt = new Date(rawExchangeRateAt).toISOString()

    const converted = (decimalUnits(transactionAmount, 6, `${label} transaction amount`) *
      decimalUnits(exchangeRate, 10, `${label} exchange rate`))
    const divisor = 10n ** 10n
    const rounded = (converted + divisor / 2n) / divisor
    const baseUnits = debitUnits + creditUnits
    if (rounded !== baseUnits) throw validationError(`${label} base amount does not match its explicit currency conversion`)
  }

  return {
    account_id: source.account_id,
    description: text(source.description, `${label} description`, 255),
    debit: formatUnits(debitUnits, 6),
    credit: formatUnits(creditUnits, 6),
    transaction_currency: transactionCurrency,
    transaction_amount: transactionAmount,
    exchange_rate: exchangeRate,
    exchange_rate_source: exchangeRateSource,
    exchange_rate_at: exchangeRateAt
  }
}

function hashJournalPayload(payload) {
  const hashable = {
    accounting_period_id: payload.accounting_period_id,
    entry_date: payload.entry_date,
    description: payload.description,
    source_type: payload.source_type,
    source_id: payload.source_id,
    source_reference: payload.source_reference,
    event_type: payload.event_type,
    reversal_of_entry_id: payload.reversal_of_entry_id || null,
    reversal_reason: payload.reversal_reason || null,
    lines: payload.lines
  }
  return crypto.createHash('sha256').update(JSON.stringify(hashable)).digest('hex')
}

function normalizeJournal(body, idempotencyKey) {
  const source = object(body)
  const linesInput = source.lines
  if (!Array.isArray(linesInput) || linesInput.length < 2 || linesInput.length > 500) {
    throw validationError('A journal must contain between 2 and 500 lines')
  }
  if (!isUuid(source.accounting_period_id)) throw validationError('A valid accounting period is required')
  const lines = linesInput.map(normalizeLine)
  const debitTotal = lines.reduce((sum, line) => sum + decimalUnits(line.debit, 6, 'Debit', { allowZero: true }), 0n)
  const creditTotal = lines.reduce((sum, line) => sum + decimalUnits(line.credit, 6, 'Credit', { allowZero: true }), 0n)
  if (debitTotal !== creditTotal) throw validationError('Journal debits and credits must balance exactly')

  const normalized = {
    idempotency_key: normalizeIdempotencyKey(idempotencyKey),
    accounting_period_id: source.accounting_period_id,
    entry_date: date(source.entry_date, 'Journal date'),
    description: text(source.description, 'Journal description', 2000, { required: true }),
    source_type: text(source.source_type, 'Source type', 50, { required: true }),
    source_id: source.source_id == null ? null : source.source_id,
    source_reference: text(source.source_reference, 'Source reference', 255),
    event_type: text(source.event_type, 'Event type', 50, { required: true }),
    reversal_of_entry_id: null,
    lines
  }
  if (normalized.source_id != null && !isUuid(normalized.source_id)) {
    throw validationError('Source ID must be a UUID')
  }
  if (!/^[a-z][a-z0-9_.-]*$/i.test(normalized.source_type) ||
      !/^[a-z][a-z0-9_.-]*$/i.test(normalized.event_type)) {
    throw validationError('Source type and event type contain unsupported characters')
  }
  normalized.payload_hash = hashJournalPayload(normalized)
  return normalized
}

module.exports = {
  ACCOUNT_TYPES,
  NORMAL_BALANCES,
  decimal,
  decimalUnits,
  formatUnits,
  hashJournalPayload,
  httpError,
  normalizeAccount,
  normalizeCurrency,
  normalizeIdempotencyKey,
  normalizeJournal,
  normalizePeriod,
  text,
  validationError
}

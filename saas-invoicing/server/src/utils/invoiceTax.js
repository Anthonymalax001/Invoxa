const RATE_SCALE = 2
const MONEY_SCALE = 2
const RATE_DENOMINATOR = 100n * (10n ** BigInt(RATE_SCALE))
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/
const MAX_MONEY_UNITS = 999999999999n

function validationError(message) {
  const error = new Error(message)
  error.statusCode = 400
  return error
}

function parseUnits(value, scale, maxIntegerDigits, label, { allowZero = true } = {}) {
  if (!(typeof value === 'number' || typeof value === 'string') ||
      (typeof value === 'number' && !Number.isFinite(value))) {
    throw validationError(`${label} must be a finite non-negative decimal`)
  }
  const normalized = String(value).trim()
  const match = normalized.match(DECIMAL_PATTERN)
  if (!match || match[1]?.length > scale || normalized.split('.')[0].length > maxIntegerDigits) {
    throw validationError(`${label} has invalid precision or range`)
  }
  const fraction = (match[1] || '').padEnd(scale, '0')
  const units = BigInt(normalized.split('.')[0]) * (10n ** BigInt(scale)) + BigInt(fraction || '0')
  if (!allowZero && units === 0n) throw validationError(`${label} must be greater than zero`)
  return units
}

function formatUnits(units, scale) {
  const factor = 10n ** BigInt(scale)
  const integer = units / factor
  const fraction = (units % factor).toString().padStart(scale, '0')
  return `${integer}.${fraction}`
}

function roundDivide(numerator, denominator) {
  return (numerator + denominator / 2n) / denominator
}

function lineAmountUnits(quantity, unitPrice, label = 'Line amount') {
  const quantityHundredths = parseUnits(quantity, 2, 8, `${label} quantity`, { allowZero: false })
  const priceCents = parseUnits(unitPrice, MONEY_SCALE, 10, `${label} unit price`)
  const amount = roundDivide(quantityHundredths * priceCents, 100n)
  if (amount > MAX_MONEY_UNITS) throw validationError(`${label} exceeds the supported invoice amount`)
  return amount
}

function calculateTaxTotals(amountUnits, profile) {
  if (!Array.isArray(amountUnits) || amountUnits.length === 0 || amountUnits.some((amount) => typeof amount !== 'bigint' || amount < 0n)) {
    throw validationError('At least one valid invoice line amount is required')
  }
  const rate = parseUnits(profile.tax_rate, RATE_SCALE, 3, 'Tax rate')
  if (rate > RATE_DENOMINATOR) throw validationError('Tax rate must be between 0 and 100')
  const method = profile.calculation_method
  const roundingMethod = profile.rounding_method
  if (!['exclusive', 'inclusive'].includes(method)) {
    throw validationError('Tax calculation method is not supported')
  }
  if (!['invoice_total', 'line_item'].includes(roundingMethod)) {
    throw validationError('Tax rounding method is not supported')
  }

  const grossOrBase = amountUnits.reduce((sum, amount) => sum + amount, 0n)
  const taxFor = (amount) => method === 'exclusive'
    ? roundDivide(amount * rate, RATE_DENOMINATOR)
    : roundDivide(amount * rate, RATE_DENOMINATOR + rate)
  const tax = roundingMethod === 'line_item'
    ? amountUnits.reduce((sum, amount) => sum + taxFor(amount), 0n)
    : taxFor(grossOrBase)
  const subtotal = method === 'exclusive' ? grossOrBase : grossOrBase - tax
  const total = method === 'exclusive' ? grossOrBase + tax : grossOrBase
  if (subtotal > MAX_MONEY_UNITS || tax > MAX_MONEY_UNITS || total > MAX_MONEY_UNITS) {
    throw validationError('Invoice totals exceed the supported amount')
  }

  return {
    subtotal: formatUnits(subtotal, MONEY_SCALE),
    tax_amount: formatUnits(tax, MONEY_SCALE),
    total: formatUnits(total, MONEY_SCALE)
  }
}

function normalizeDirectInvoiceItems(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 200) {
    throw validationError('At least one and no more than 200 invoice lines are required')
  }
  return items.map((item) => {
    if (!item || typeof item.description !== 'string' || !item.description.trim() || item.description.trim().length > 500) {
      throw validationError('Each invoice line requires a description of 1 to 500 characters')
    }
    const amount = lineAmountUnits(item.quantity, item.unit_price)
    return {
      description: item.description.trim(),
      quantity: formatUnits(parseUnits(item.quantity, 2, 8, 'Quantity', { allowZero: false }), 2),
      unit_price: formatUnits(parseUnits(item.unit_price, 2, 10, 'Unit price'), MONEY_SCALE),
      amount: formatUnits(amount, MONEY_SCALE),
      amountUnits: amount
    }
  })
}

function normalizeTaxProfileRow(row) {
  if (!row || typeof row !== 'object') throw validationError('A valid tenant tax profile is required')
  const rateUnits = parseUnits(row.tax_rate, RATE_SCALE, 3, 'Tax rate')
  if (rateUnits > RATE_DENOMINATOR) throw validationError('Tax rate must be between 0 and 100')
  if (!['exclusive', 'inclusive'].includes(row.calculation_method) ||
      !['invoice_total', 'line_item'].includes(row.rounding_method)) {
    throw validationError('Tax profile calculation or rounding method is invalid')
  }
  return {
    ...row,
    tax_rate: formatUnits(rateUnits, RATE_SCALE)
  }
}

function dateOnly(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw validationError(`${label} must use YYYY-MM-DD`)
  }
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw validationError(`${label} is invalid`)
  }
  return value
}

function normalizeTaxProfileInput(value) {
  const body = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const profileKey = typeof body.profile_key === 'string' ? body.profile_key.trim() : ''
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/.test(profileKey)) {
    throw validationError('Tax profile key must be 1 to 50 letters, digits, dots, dashes or underscores')
  }
  if (!name || name.length > 150) throw validationError('Tax profile name is required and must be 150 characters or fewer')
  const rate = parseUnits(body.tax_rate, RATE_SCALE, 3, 'Tax rate')
  if (rate > RATE_DENOMINATOR) throw validationError('Tax rate must be between 0 and 100')
  if (!['exclusive', 'inclusive'].includes(body.calculation_method)) {
    throw validationError('Tax calculation method must be exclusive or inclusive')
  }
  if (!['invoice_total', 'line_item'].includes(body.rounding_method)) {
    throw validationError('Tax rounding method must be invoice_total or line_item')
  }
  if (typeof body.requires_tax_payable !== 'boolean') {
    throw validationError('requires_tax_payable must be true or false')
  }
  if (rate > 0n && !body.requires_tax_payable) {
    throw validationError('A non-zero tax rate requires an explicit tax payable account')
  }
  if (body.requires_tax_payable !== Boolean(body.tax_payable_account_id)) {
    throw validationError('Provide a tax payable account exactly when the profile requires one')
  }
  if (body.tax_payable_account_id && !require('uuid').validate(body.tax_payable_account_id)) {
    throw validationError('A valid tax payable account is required')
  }
  const effectiveFrom = dateOnly(body.effective_from, 'Effective from date')
  const effectiveTo = body.effective_to == null || body.effective_to === ''
    ? null
    : dateOnly(body.effective_to, 'Effective to date')
  if (effectiveTo && effectiveTo < effectiveFrom) {
    throw validationError('Effective to date must not precede effective from date')
  }
  return {
    profile_key: profileKey,
    name,
    tax_rate: formatUnits(rate, RATE_SCALE),
    calculation_method: body.calculation_method,
    rounding_method: body.rounding_method,
    effective_from: effectiveFrom,
    effective_to: effectiveTo,
    requires_tax_payable: body.requires_tax_payable,
    tax_payable_account_id: body.tax_payable_account_id || null
  }
}

module.exports = {
  calculateTaxTotals,
  dateOnly,
  formatUnits,
  lineAmountUnits,
  normalizeDirectInvoiceItems,
  normalizeTaxProfileInput,
  normalizeTaxProfileRow,
  MAX_MONEY_UNITS,
  parseUnits,
  validationError
}

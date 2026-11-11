const { validate: isUuid } = require('uuid')

const PAYMENT_METHODS = ['cash', 'bank_transfer', 'card', 'mpesa', 'cheque', 'other']

function validationError(message) {
  const error = new Error(message)
  error.statusCode = 400
  return error
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

function date(value, label, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw validationError(`${label} is required`)
    return null
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw validationError(`${label} must use YYYY-MM-DD`)
  }
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw validationError(`${label} is invalid`)
  }
  return value
}

function amount(value, { allowZero = false } = {}) {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw validationError('Amount must be a positive number')
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw validationError('Amount must be a positive finite number')
  }
  const match = String(value).trim().match(/^(0|[1-9]\d{0,9})(?:\.(\d{1,2}))?$/)
  if (!match) throw validationError('Amount must be positive and have at most two decimal places')
  const cents = BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0') || '0')
  if (allowZero ? cents < 0n : cents <= 0n) throw validationError(allowZero ? 'Amount must not be negative' : 'Amount must be greater than zero')
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`
}

function normalizeExpense(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  if (!isUuid(source.category_id)) throw validationError('A valid expense category is required')
  if (source.supplier_id != null && source.supplier_id !== '' && !isUuid(source.supplier_id)) {
    throw validationError('Supplier must be a valid supplier')
  }
  const currency = (source.currency == null ? 'KES' : source.currency)
  if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency.trim())) {
    throw validationError('Currency must be a three-letter code')
  }
  const paymentMethod = source.payment_method == null || source.payment_method === ''
    ? null
    : source.payment_method
  if (paymentMethod != null && !PAYMENT_METHODS.includes(paymentMethod)) {
    throw validationError('Invalid payment method')
  }
  const inputVatAmount = source.input_vat_amount == null || source.input_vat_amount === ''
    ? '0.00' : amount(source.input_vat_amount, { allowZero: true })
  const inputVatDocumentReference = text(source.input_vat_document_reference, 'Tax document reference', 255)
  if (BigInt(inputVatAmount.replace('.', '')) > BigInt(amount(source.amount).replace('.', ''))) {
    throw validationError('Input VAT amount cannot exceed the total expense amount')
  }
  if (inputVatAmount !== '0.00' && !inputVatDocumentReference) {
    throw validationError('A tax document reference is required when input VAT is recorded')
  }
  if (inputVatAmount === '0.00' && inputVatDocumentReference) {
    throw validationError('A tax document reference requires a positive recorded input VAT amount')
  }
  if (source.input_vat_recoverable != null && typeof source.input_vat_recoverable !== 'boolean') {
    throw validationError('Input VAT recoverability must be explicitly true or false')
  }
  const inputVatRecoverable = source.input_vat_recoverable === true
  if (inputVatRecoverable && inputVatAmount === '0.00') {
    throw validationError('Recoverable input VAT requires a positive recorded VAT amount')
  }
  return {
    expense_date: date(source.expense_date, 'Expense date', { required: true }),
    category_id: source.category_id.toLowerCase(),
    supplier_id: source.supplier_id ? source.supplier_id.toLowerCase() : null,
    payee_name: text(source.payee_name, 'Payee', 255),
    description: text(source.description, 'Description', 2000, { required: true }),
    amount: amount(source.amount),
    currency: currency.trim().toUpperCase(),
    input_vat_amount: inputVatAmount,
    input_vat_document_reference: inputVatDocumentReference,
    input_vat_recoverable: inputVatRecoverable,
    payment_method: paymentMethod,
    payment_reference: text(source.payment_reference, 'Payment reference', 255),
    notes: text(source.notes, 'Notes', 10000)
  }
}

function normalizeCategory(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  const accountingAccountId = source.accounting_account_id == null || source.accounting_account_id === ''
    ? null : source.accounting_account_id
  if (accountingAccountId != null && !isUuid(accountingAccountId)) {
    throw validationError('A valid tenant expense account is required')
  }
  return {
    name: text(source.name, 'Category name', 100, { required: true }),
    description: text(source.description, 'Category description', 1000),
    accounting_account_id: accountingAccountId?.toLowerCase() || null
  }
}

function normalizePaymentTransition(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  const paymentMethod = source.payment_method
  if (typeof paymentMethod !== 'string' || !PAYMENT_METHODS.includes(paymentMethod)) {
    throw validationError('A valid payment method is required to mark an expense paid')
  }
  if (!isUuid(source.cash_account_id)) throw validationError('Select a valid tenant cash or bank account')
  return {
    payment_method: paymentMethod,
    payment_reference: text(source.payment_reference, 'Payment reference', 255),
    cash_account_id: source.cash_account_id.toLowerCase(),
    payment_date: date(source.payment_date, 'Payment date', { required: true })
  }
}

function normalizeExpenseReversal(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  if (source.confirm !== true) throw validationError('Explicit confirmation is required to reverse expense accounting')
  return {
    reversal_date: date(source.reversal_date, 'Reversal date', { required: true }),
    reason: text(source.reason, 'Reversal reason', 1800, { required: true })
  }
}

module.exports = {
  PAYMENT_METHODS,
  amount,
  date,
  normalizeCategory,
  normalizeExpense,
  normalizeExpenseReversal,
  normalizePaymentTransition
}

const { validate: isUuid } = require('uuid')
const { validationError } = require('./accounting')

const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled']
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function date(value, label) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) throw validationError(`${label} must use YYYY-MM-DD`)
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw validationError(`${label} is invalid`)
  }
  return value
}

function workingDays(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00.000Z`)
  const end = new Date(`${endDate}T00:00:00.000Z`)
  let total = 0
  for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const weekday = cursor.getUTCDay()
    if (weekday !== 0 && weekday !== 6) total += 1
  }
  return total
}

function text(value, label, maxLength, required = false) {
  if (value == null) {
    if (required) throw validationError(`${label} is required`)
    return null
  }
  if (typeof value !== 'string') throw validationError(`${label} must be text`)
  const normalized = value.trim()
  if (required && !normalized) throw validationError(`${label} is required`)
  if (normalized.length > maxLength) throw validationError(`${label} must be ${maxLength} characters or fewer`)
  return normalized || null
}

function applicationInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw validationError('Leave application details are required')
  if (!isUuid(body.employee_id)) throw validationError('Employee must be a valid ID')
  if (!isUuid(body.leave_type_id)) throw validationError('Leave type must be a valid ID')
  const startDate = date(body.start_date, 'Start date')
  const endDate = date(body.end_date, 'End date')
  if (endDate < startDate) throw validationError('End date must not be before start date')
  if (startDate.slice(0, 4) !== endDate.slice(0, 4)) throw validationError('Leave dates must be within one leave year')
  const days = workingDays(startDate, endDate)
  if (days <= 0) throw validationError('Leave must include at least one working day')
  return {
    employee_id: body.employee_id,
    leave_type_id: body.leave_type_id,
    start_date: startDate,
    end_date: endDate,
    working_days: days,
    reason: text(body.reason, 'Reason', 10000, true)
  }
}

function leaveTypeInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw validationError('Leave type details are required')
  const code = text(body.code, 'Code', 40, true)
  if (!/^[a-z][a-z0-9_-]{1,39}$/.test(code)) throw validationError('Code must contain lowercase letters, numbers, underscores or hyphens')
  const name = text(body.name, 'Name', 120, true)
  const rawEntitlement = body.annual_entitlement
  let annualEntitlement = null
  if (rawEntitlement !== null && rawEntitlement !== undefined && rawEntitlement !== '') {
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(String(rawEntitlement))) throw validationError('Annual entitlement must be a non-negative number')
    annualEntitlement = String(rawEntitlement)
  }
  return {
    code, name, annual_entitlement: annualEntitlement,
    allow_negative: body.allow_negative === true,
    is_active: body.is_active !== false
  }
}

function balanceInput(body) {
  if (!body || !isUuid(body.employee_id) || !isUuid(body.leave_type_id)) throw validationError('Employee and leave type are required')
  const year = Number(body.leave_year)
  if (!Number.isInteger(year) || year < 2000 || year > 2200) throw validationError('Leave year is invalid')
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(String(body.entitled_days ?? ''))) throw validationError('Entitled days must be a non-negative number')
  return {
    employee_id: body.employee_id, leave_type_id: body.leave_type_id, leave_year: year,
    entitled_days: String(body.entitled_days), allow_negative: body.allow_negative === true
  }
}

module.exports = { applicationInput, balanceInput, date, leaveTypeInput, workingDays, LEAVE_STATUSES }

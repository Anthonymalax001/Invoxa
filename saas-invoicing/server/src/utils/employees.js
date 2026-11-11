const { validate: isUuid } = require('uuid')
const { validationError } = require('./accounting')

const EMPLOYMENT_TYPES = ['permanent', 'contract', 'temporary', 'intern', 'casual', 'consultant']
const EMPLOYMENT_STATUSES = ['active', 'inactive', 'suspended', 'terminated']
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function optionalText(value, label, maxLength) {
  if (value == null || value === '') return null
  if (typeof value !== 'string') throw validationError(`${label} must be text`)
  const text = value.trim()
  if (text.length > maxLength) throw validationError(`${label} must be ${maxLength} characters or fewer`)
  return text || null
}

function requiredText(value, label, maxLength) {
  const text = optionalText(value, label, maxLength)
  if (!text) throw validationError(`${label} is required`)
  return text
}

function employeeInput(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw validationError('Employee details are required')
  }
  const source = body
  const firstName = requiredText(source.first_name, 'First name', 100)
  const middleName = optionalText(source.middle_name, 'Middle name', 100)
  const lastName = requiredText(source.last_name, 'Last name', 100)
  const email = optionalText(source.work_email, 'Work email', 254)
  if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)) {
    throw validationError('Work email is invalid')
  }
  const phone = optionalText(source.phone, 'Phone', 30)
  if (phone && !/^[0-9+() .-]{7,30}$/.test(phone)) throw validationError('Phone is invalid')
  const departmentId = source.department_id == null || source.department_id === '' ? null : source.department_id
  if (departmentId && !isUuid(departmentId)) throw validationError('Department must be a valid ID')
  const managerId = source.reporting_manager_id == null || source.reporting_manager_id === '' ? null : source.reporting_manager_id
  if (managerId && !isUuid(managerId)) throw validationError('Reporting manager must be a valid ID')
  const employmentType = source.employment_type
  if (!EMPLOYMENT_TYPES.includes(employmentType)) throw validationError('Employment type is invalid')
  const status = source.employment_status == null ? 'active' : source.employment_status
  if (!EMPLOYMENT_STATUSES.includes(status)) throw validationError('Employment status is invalid')
  const startDate = source.employment_start_date
  if (typeof startDate !== 'string' || !DATE_PATTERN.test(startDate)) throw validationError('Employment start date must use YYYY-MM-DD')
  const parsed = new Date(`${startDate}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== startDate) {
    throw validationError('Employment start date is invalid')
  }
  if (partial && source.first_name == null && source.last_name == null) {
    throw validationError('At least one employee field is required')
  }
  return {
    first_name: firstName, middle_name: middleName, last_name: lastName,
    work_email: email ? email.toLowerCase() : null, phone, department_id: departmentId,
    job_title: optionalText(source.job_title, 'Job title', 150),
    employment_type: employmentType, employment_start_date: startDate,
    employment_status: status, reporting_manager_id: managerId,
    notes: optionalText(source.notes, 'Notes', 10000)
  }
}

module.exports = { employeeInput, EMPLOYMENT_TYPES, EMPLOYMENT_STATUSES }

const { validate: isUuid } = require('uuid')
const { validationError } = require('./accounting')

const ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'half-day', 'on leave']
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/

function date(value, label) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) throw validationError(`${label} must use YYYY-MM-DD`)
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw validationError(`${label} is invalid`)
  }
  return value
}

function optionalTime(value, label) {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || !TIME_PATTERN.test(value)) throw validationError(`${label} must use HH:MM or HH:MM:SS`)
  return value.length === 5 ? `${value}:00` : value
}

function attendanceInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw validationError('Attendance details are required')
  if (!isUuid(body.employee_id)) throw validationError('Employee must be a valid ID')
  const attendanceDate = date(body.attendance_date, 'Attendance date')
  const status = body.attendance_status
  if (!ATTENDANCE_STATUSES.includes(status)) throw validationError('Attendance status is invalid')
  const clockIn = optionalTime(body.clock_in, 'Clock-in time')
  const clockOut = optionalTime(body.clock_out, 'Clock-out time')
  if (['absent', 'on leave'].includes(status) && (clockIn || clockOut)) {
    throw validationError('Absent and on-leave records cannot have clock times')
  }
  if (!['absent', 'on leave'].includes(status) && Boolean(clockIn) !== Boolean(clockOut)) {
    throw validationError('Clock-in and clock-out must be provided together')
  }
  if (clockIn && clockOut && clockOut < clockIn) throw validationError('Clock-out cannot be before clock-in')
  if (body.notes != null && typeof body.notes !== 'string') throw validationError('Notes must be text')
  const notes = body.notes == null ? null : body.notes.trim() || null
  if (notes && notes.length > 10000) throw validationError('Notes must be 10000 characters or fewer')
  return {
    employee_id: body.employee_id,
    attendance_date: attendanceDate,
    clock_in: clockIn,
    clock_out: clockOut,
    attendance_status: status,
    notes
  }
}

function monthRange(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}$/.test(value)) throw validationError('Month must use YYYY-MM')
  const start = `${value}-01`
  const parsed = new Date(`${start}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 7) !== value) throw validationError('Month is invalid')
  const end = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 0)).toISOString().slice(0, 10)
  return { start, end }
}

module.exports = { attendanceInput, date, monthRange, ATTENDANCE_STATUSES }

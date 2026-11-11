const express = require('express')
const { validate: isUuid } = require('uuid')
const pool = require('../config/db')
const auth = require('../middleware/auth')
const { requireAccountingPermission } = require('../middleware/accountingAuthorization')
const { attendanceInput, date, monthRange, ATTENDANCE_STATUSES } = require('../utils/attendance')
const { logSafeError } = require('../utils/errorLogging')

const router = express.Router()

const RECORD_COLUMNS = `a.id, a.tenant_id, a.employee_id, a.attendance_date, a.clock_in, a.clock_out,
  a.attendance_status, a.working_minutes, a.overtime_minutes, a.notes, a.created_by,
  a.updated_by, a.created_at, a.updated_at, e.employee_number, e.first_name,
  e.middle_name, e.last_name, e.department_id, d.name AS department_name,
  (SELECT json_agg(json_build_object(
      'id', leave.id, 'leave_type_name', leave_type.name,
      'start_date', leave.start_date, 'end_date', leave.end_date,
      'working_days', leave.working_days
    ) ORDER BY leave.start_date)
   FROM hr_leave_applications leave
   JOIN hr_leave_types leave_type
     ON leave_type.tenant_id = leave.tenant_id AND leave_type.id = leave.leave_type_id
   WHERE leave.tenant_id = a.tenant_id AND leave.employee_id = a.employee_id
     AND leave.status = 'approved'
     AND a.attendance_date BETWEEN leave.start_date AND leave.end_date) AS approved_leave`

function sendError(res, error, fallback) {
  if (error.statusCode) return res.status(error.statusCode).json({ error: error.message })
  if (error.code === '23505') return res.status(409).json({ error: 'Attendance for this employee and date already exists' })
  if (error.code === '23503') return res.status(400).json({ error: 'Employee reference is invalid for this tenant' })
  if (error.code === '23514') return res.status(400).json({ error: 'Attendance violates a required integrity rule' })
  logSafeError(fallback, error)
  return res.status(500).json({ error: fallback })
}

function validId(id, res, label = 'Attendance record') {
  if (!isUuid(id)) {
    res.status(404).json({ error: `${label} not found` })
    return false
  }
  return true
}

function snapshot(row) {
  return {
    id: row.id, tenant_id: row.tenant_id, employee_id: row.employee_id,
    attendance_date: row.attendance_date, clock_in: row.clock_in, clock_out: row.clock_out,
    attendance_status: row.attendance_status, working_minutes: row.working_minutes,
    overtime_minutes: row.overtime_minutes, notes: row.notes, updated_by: row.updated_by
  }
}

async function findRecord(client, tenantId, attendanceId) {
  const result = await client.query(
    `SELECT ${RECORD_COLUMNS}
     FROM hr_attendance a
     JOIN hr_employees e ON e.tenant_id = a.tenant_id AND e.id = a.employee_id
     LEFT JOIN hr_departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
     WHERE a.tenant_id = $1 AND a.id = $2`,
    [tenantId, attendanceId]
  )
  return result.rows[0] || null
}

router.get('/summary', auth, requireAccountingPermission('hr:read'), async (req, res) => {
  let range
  try {
    range = monthRange(req.query.month)
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message })
  }
  const departmentId = req.query.department_id || null
  if (departmentId && !isUuid(departmentId)) return res.status(400).json({ error: 'Department must be a valid ID' })
  try {
    const result = await pool.query(
      `SELECT e.id AS employee_id, e.employee_number, e.first_name, e.last_name,
              d.name AS department_name,
              count(a.id)::integer AS recorded_days,
              count(*) FILTER (WHERE a.attendance_status = 'present')::integer AS present_days,
              count(*) FILTER (WHERE a.attendance_status = 'absent')::integer AS absent_days,
              count(*) FILTER (WHERE a.attendance_status = 'late')::integer AS late_days,
              count(*) FILTER (WHERE a.attendance_status = 'half-day')::integer AS half_days,
              count(*) FILTER (WHERE a.attendance_status = 'on leave')::integer AS leave_days,
              COALESCE(sum(a.working_minutes), 0)::integer AS working_minutes,
              COALESCE(sum(a.overtime_minutes), 0)::integer AS overtime_minutes
       FROM hr_employees e
       LEFT JOIN hr_departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
       LEFT JOIN hr_attendance a ON a.tenant_id = e.tenant_id AND a.employee_id = e.id
         AND a.attendance_date BETWEEN $2::date AND $3::date
       WHERE e.tenant_id = $1 AND ($4::uuid IS NULL OR e.department_id = $4)
       GROUP BY e.id, e.employee_number, e.first_name, e.last_name, d.name
       ORDER BY lower(e.last_name), lower(e.first_name), e.id`,
      [req.user.tenantId, range.start, range.end, departmentId]
    )
    res.json({ month: req.query.month, start_date: range.start, end_date: range.end, employees: result.rows })
  } catch (error) {
    sendError(res, error, 'Failed to calculate attendance summary')
  }
})

router.get('/employee/:employeeId/history', auth, requireAccountingPermission('hr:read'), async (req, res) => {
  if (!validId(req.params.employeeId, res, 'Employee')) return
  let from = null
  let to = null
  try {
    if (req.query.from) from = date(req.query.from, 'Start date')
    if (req.query.to) to = date(req.query.to, 'End date')
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message })
  }
  if (from && to && from > to) return res.status(400).json({ error: 'Start date must not be after end date' })
  try {
    const result = await pool.query(
      `SELECT ${RECORD_COLUMNS}
       FROM hr_attendance a
       JOIN hr_employees e ON e.tenant_id = a.tenant_id AND e.id = a.employee_id
       LEFT JOIN hr_departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
       WHERE a.tenant_id = $1 AND a.employee_id = $2
         AND ($3::date IS NULL OR a.attendance_date >= $3)
         AND ($4::date IS NULL OR a.attendance_date <= $4)
       ORDER BY a.attendance_date DESC`,
      [req.user.tenantId, req.params.employeeId, from, to]
    )
    res.json(result.rows)
  } catch (error) {
    sendError(res, error, 'Failed to fetch attendance history')
  }
})

router.get('/', auth, requireAccountingPermission('hr:read'), async (req, res) => {
  let attendanceDate = null
  let from = null
  let to = null
  try {
    if (req.query.date) attendanceDate = date(req.query.date, 'Attendance date')
    if (req.query.from) from = date(req.query.from, 'Start date')
    if (req.query.to) to = date(req.query.to, 'End date')
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message })
  }
  const employeeId = req.query.employee_id || null
  const departmentId = req.query.department_id || null
  if (employeeId && !isUuid(employeeId)) return res.status(400).json({ error: 'Employee must be a valid ID' })
  if (departmentId && !isUuid(departmentId)) return res.status(400).json({ error: 'Department must be a valid ID' })
  const status = ATTENDANCE_STATUSES.includes(req.query.status) ? req.query.status : null
  if (req.query.status && !status) return res.status(400).json({ error: 'Attendance status is invalid' })
  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : ''
  try {
    const result = await pool.query(
      `SELECT ${RECORD_COLUMNS}
       FROM hr_attendance a
       JOIN hr_employees e ON e.tenant_id = a.tenant_id AND e.id = a.employee_id
       LEFT JOIN hr_departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
       WHERE a.tenant_id = $1
         AND ($2::date IS NULL OR a.attendance_date = $2)
         AND ($3::date IS NULL OR a.attendance_date >= $3)
         AND ($4::date IS NULL OR a.attendance_date <= $4)
         AND ($5::uuid IS NULL OR a.employee_id = $5)
         AND ($6::uuid IS NULL OR e.department_id = $6)
         AND ($7::text IS NULL OR a.attendance_status = $7)
         AND ($8 = '' OR e.employee_number ILIKE '%' || $8 || '%'
              OR e.first_name ILIKE '%' || $8 || '%' OR e.last_name ILIKE '%' || $8 || '%')
       ORDER BY a.attendance_date DESC, lower(e.last_name), lower(e.first_name), a.id`,
      [req.user.tenantId, attendanceDate, from, to, employeeId, departmentId, status, search]
    )
    res.json(result.rows)
  } catch (error) {
    sendError(res, error, 'Failed to fetch attendance')
  }
})

router.post('/', auth, requireAccountingPermission('hr:manage-employees'), async (req, res) => {
  let input
  try {
    input = attendanceInput(req.body)
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message })
  }
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN')
    const employee = await client.query(
      'SELECT id FROM hr_employees WHERE tenant_id = $1 AND id = $2',
      [req.user.tenantId, input.employee_id]
    )
    if (employee.rowCount !== 1) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Employee not found' })
    }
    const created = await client.query(
      `INSERT INTO hr_attendance
         (tenant_id, employee_id, attendance_date, clock_in, clock_out, attendance_status, notes, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       RETURNING *`,
      [req.user.tenantId, input.employee_id, input.attendance_date, input.clock_in, input.clock_out,
        input.attendance_status, input.notes, req.user.userId]
    )
    const row = created.rows[0]
    await client.query(
      `INSERT INTO hr_attendance_audit
         (tenant_id, attendance_id, action, changed_by, after_data)
       VALUES ($1, $2, 'created', $3, $4::jsonb)`,
      [req.user.tenantId, row.id, req.user.userId, JSON.stringify(snapshot(row))]
    )
    await client.query('COMMIT')
    res.status(201).json(row)
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK') } catch (rollbackError) { logSafeError('Attendance rollback failed', rollbackError) }
    }
    sendError(res, error, 'Failed to create attendance')
  } finally {
    client?.release()
  }
})

router.put('/:id', auth, requireAccountingPermission('hr:manage-employees'), async (req, res) => {
  if (!validId(req.params.id, res)) return
  let input
  try {
    input = attendanceInput(req.body)
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message })
  }
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN')
    const before = await findRecord(client, req.user.tenantId, req.params.id)
    if (!before) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Attendance record not found' })
    }
    const updated = await client.query(
      `UPDATE hr_attendance
       SET employee_id = $1, attendance_date = $2, clock_in = $3, clock_out = $4,
           attendance_status = $5, notes = $6, updated_by = $7, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $8 AND id = $9
       RETURNING *`,
      [input.employee_id, input.attendance_date, input.clock_in, input.clock_out,
        input.attendance_status, input.notes, req.user.userId, req.user.tenantId, req.params.id]
    )
    if (updated.rowCount !== 1) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Attendance record not found' })
    }
    const after = updated.rows[0]
    await client.query(
      `INSERT INTO hr_attendance_audit
         (tenant_id, attendance_id, action, changed_by, before_data, after_data)
       VALUES ($1, $2, 'updated', $3, $4::jsonb, $5::jsonb)`,
      [req.user.tenantId, after.id, req.user.userId, JSON.stringify(snapshot(before)), JSON.stringify(snapshot(after))]
    )
    await client.query('COMMIT')
    res.json(after)
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK') } catch (rollbackError) { logSafeError('Attendance rollback failed', rollbackError) }
    }
    sendError(res, error, 'Failed to update attendance')
  } finally {
    client?.release()
  }
})

router.get('/:id/audit', auth, requireAccountingPermission('hr:read'), async (req, res) => {
  if (!validId(req.params.id, res)) return
  try {
    const result = await pool.query(
      `SELECT audit.id, audit.attendance_id, audit.action, audit.changed_by,
              audit.before_data, audit.after_data, audit.changed_at
       FROM hr_attendance_audit audit
       JOIN hr_attendance a ON a.tenant_id = audit.tenant_id AND a.id = audit.attendance_id
       WHERE audit.tenant_id = $1 AND audit.attendance_id = $2
       ORDER BY audit.changed_at DESC, audit.id DESC`,
      [req.user.tenantId, req.params.id]
    )
    res.json(result.rows)
  } catch (error) {
    sendError(res, error, 'Failed to fetch attendance audit history')
  }
})

module.exports = router

const express = require('express')
const { validate: isUuid } = require('uuid')
const pool = require('../config/db')
const auth = require('../middleware/auth')
const { requireAccountingPermission } = require('../middleware/accountingAuthorization')
const { applicationInput, balanceInput, date, leaveTypeInput, LEAVE_STATUSES } = require('../utils/leave')
const { logSafeError } = require('../utils/errorLogging')

const router = express.Router()
const APPLICATION_COLUMNS = `a.id, a.tenant_id, a.employee_id, a.leave_type_id, a.start_date,
  a.end_date, a.working_days, a.reason, a.status, a.approved_by, a.decision_at,
  a.rejection_reason, a.created_by, a.updated_by, a.created_at, a.updated_at,
  e.employee_number, e.first_name, e.middle_name, e.last_name, e.department_id,
  d.name AS department_name, t.code AS leave_type_code, t.name AS leave_type_name`

function tenantId(req) {
  return req.user.company_id || req.user.tenantId
}

function validId(id, res, label) {
  if (!isUuid(id)) {
    res.status(404).json({ error: `${label} not found` })
    return false
  }
  return true
}

function sendError(res, error, fallback) {
  if (error.statusCode) return res.status(error.statusCode).json({ error: error.message })
  if (error.code === '23505') return res.status(409).json({ error: 'A duplicate leave type, balance or overlapping application exists' })
  if (error.code === '23503') return res.status(400).json({ error: 'Leave reference is invalid for this tenant' })
  if (error.code === '23514') return res.status(400).json({ error: 'Leave data violates a required integrity rule' })
  logSafeError(fallback, error)
  return res.status(500).json({ error: fallback })
}

function snapshot(row) {
  return {
    id: row.id, tenant_id: row.tenant_id, employee_id: row.employee_id,
    leave_type_id: row.leave_type_id, start_date: row.start_date, end_date: row.end_date,
    working_days: row.working_days, reason: row.reason, status: row.status,
    approved_by: row.approved_by, decision_at: row.decision_at,
    rejection_reason: row.rejection_reason, updated_by: row.updated_by
  }
}

async function findApplication(client, tenant, id) {
  const result = await client.query(
    `SELECT ${APPLICATION_COLUMNS}
     FROM hr_leave_applications a
     JOIN hr_employees e ON e.tenant_id = a.tenant_id AND e.id = a.employee_id
     JOIN hr_leave_types t ON t.tenant_id = a.tenant_id AND t.id = a.leave_type_id
     LEFT JOIN hr_departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
     WHERE a.tenant_id = $1 AND a.id = $2`,
    [tenant, id]
  )
  return result.rows[0] || null
}

router.get('/types', auth, requireAccountingPermission('hr:read'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, code, name, annual_entitlement, allow_negative, is_active, is_system, created_at, updated_at
       FROM hr_leave_types WHERE tenant_id = $1 ORDER BY is_active DESC, lower(name), id`,
      [tenantId(req)]
    )
    res.json(result.rows)
  } catch (error) {
    sendError(res, error, 'Failed to fetch leave types')
  }
})

router.post('/types', auth, requireAccountingPermission('hr:manage-employees'), async (req, res) => {
  let input
  try { input = leaveTypeInput(req.body) } catch (error) { return res.status(error.statusCode || 400).json({ error: error.message }) }
  try {
    const result = await pool.query(
      `INSERT INTO hr_leave_types
         (tenant_id, code, name, annual_entitlement, allow_negative, is_active, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, code, name, annual_entitlement, allow_negative, is_active, is_system, created_at, updated_at`,
      [tenantId(req), input.code, input.name, input.annual_entitlement, input.allow_negative, input.is_active, req.user.userId]
    )
    res.status(201).json(result.rows[0])
  } catch (error) {
    sendError(res, error, 'Failed to create leave type')
  }
})

router.put('/types/:id', auth, requireAccountingPermission('hr:manage-employees'), async (req, res) => {
  if (!validId(req.params.id, res, 'Leave type')) return
  let input
  try { input = leaveTypeInput(req.body) } catch (error) { return res.status(error.statusCode || 400).json({ error: error.message }) }
  try {
    const result = await pool.query(
      `UPDATE hr_leave_types
       SET code = $1, name = $2, annual_entitlement = $3, allow_negative = $4,
           is_active = $5, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $6 AND id = $7 AND is_system = false
       RETURNING id, code, name, annual_entitlement, allow_negative, is_active, is_system, created_at, updated_at`,
      [input.code, input.name, input.annual_entitlement, input.allow_negative, input.is_active, tenantId(req), req.params.id]
    )
    if (result.rowCount !== 1) return res.status(404).json({ error: 'Configurable leave type not found' })
    res.json(result.rows[0])
  } catch (error) {
    sendError(res, error, 'Failed to update leave type')
  }
})

router.get('/balances', auth, requireAccountingPermission('hr:read'), async (req, res) => {
  const tenant = tenantId(req)
  const employeeId = req.query.employee_id || null
  const year = req.query.leave_year == null ? new Date().getUTCFullYear() : Number(req.query.leave_year)
  if (employeeId && !isUuid(employeeId)) return res.status(400).json({ error: 'Employee must be a valid ID' })
  if (!Number.isInteger(year) || year < 2000 || year > 2200) return res.status(400).json({ error: 'Leave year is invalid' })
  try {
    const result = await pool.query(
      `SELECT b.id, b.employee_id, b.leave_type_id, b.leave_year, b.entitled_days, b.used_days,
              b.allow_negative, (b.entitled_days - b.used_days) AS remaining_days,
              e.employee_number, e.first_name, e.last_name, t.code AS leave_type_code, t.name AS leave_type_name
       FROM hr_leave_balances b
       JOIN hr_employees e ON e.tenant_id = b.tenant_id AND e.id = b.employee_id
       JOIN hr_leave_types t ON t.tenant_id = b.tenant_id AND t.id = b.leave_type_id
       WHERE b.tenant_id = $1 AND b.leave_year = $2
         AND ($3::uuid IS NULL OR b.employee_id = $3)
       ORDER BY lower(e.last_name), lower(e.first_name), lower(t.name), b.id`,
      [tenant, year, employeeId]
    )
    res.json({ leave_year: year, balances: result.rows })
  } catch (error) {
    sendError(res, error, 'Failed to fetch leave balances')
  }
})

router.put('/balances', auth, requireAccountingPermission('hr:manage-employees'), async (req, res) => {
  let input
  try { input = balanceInput(req.body) } catch (error) { return res.status(error.statusCode || 400).json({ error: error.message }) }
  try {
    const result = await pool.query(
      `INSERT INTO hr_leave_balances
         (tenant_id, employee_id, leave_type_id, leave_year, entitled_days, allow_negative, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       ON CONFLICT (tenant_id, employee_id, leave_type_id, leave_year)
       DO UPDATE SET entitled_days = EXCLUDED.entitled_days, allow_negative = EXCLUDED.allow_negative,
                     updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP
       WHERE EXCLUDED.allow_negative = true OR EXCLUDED.entitled_days >= hr_leave_balances.used_days
       RETURNING *`,
      [tenantId(req), input.employee_id, input.leave_type_id, input.leave_year, input.entitled_days, input.allow_negative, req.user.userId]
    )
    if (result.rowCount !== 1) return res.status(409).json({ error: 'Entitlement cannot be lower than already used days unless negative balances are allowed' })
    res.json(result.rows[0])
  } catch (error) {
    sendError(res, error, 'Failed to save leave balance')
  }
})

router.get('/', auth, requireAccountingPermission('hr:read'), async (req, res) => {
  const employeeId = req.query.employee_id || null
  const leaveTypeId = req.query.leave_type_id || null
  const status = req.query.status || null
  if (employeeId && !isUuid(employeeId)) return res.status(400).json({ error: 'Employee must be a valid ID' })
  if (leaveTypeId && !isUuid(leaveTypeId)) return res.status(400).json({ error: 'Leave type must be a valid ID' })
  if (status && !LEAVE_STATUSES.includes(status)) return res.status(400).json({ error: 'Leave status is invalid' })
  let from = null
  let to = null
  try {
    if (req.query.from) from = date(req.query.from, 'Start date')
    if (req.query.to) to = date(req.query.to, 'End date')
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message })
  }
  try {
    const result = await pool.query(
      `SELECT ${APPLICATION_COLUMNS}
       FROM hr_leave_applications a
       JOIN hr_employees e ON e.tenant_id = a.tenant_id AND e.id = a.employee_id
       JOIN hr_leave_types t ON t.tenant_id = a.tenant_id AND t.id = a.leave_type_id
       LEFT JOIN hr_departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
       WHERE a.tenant_id = $1
         AND ($2::uuid IS NULL OR a.employee_id = $2)
         AND ($3::uuid IS NULL OR a.leave_type_id = $3)
         AND ($4::text IS NULL OR a.status = $4)
         AND ($5::date IS NULL OR a.end_date >= $5)
         AND ($6::date IS NULL OR a.start_date <= $6)
       ORDER BY a.created_at DESC, a.id DESC`,
      [tenantId(req), employeeId, leaveTypeId, status, from, to]
    )
    res.json(result.rows)
  } catch (error) {
    sendError(res, error, 'Failed to fetch leave applications')
  }
})

router.post('/', auth, requireAccountingPermission('hr:manage-employees'), async (req, res) => {
  let input
  try { input = applicationInput(req.body) } catch (error) { return res.status(error.statusCode || 400).json({ error: error.message }) }
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN')
    const employee = await client.query(
      `SELECT id FROM hr_employees WHERE tenant_id = $1 AND id = $2 AND employment_status <> 'terminated'`,
      [tenantId(req), input.employee_id]
    )
    const leaveType = await client.query(
      `SELECT id FROM hr_leave_types WHERE tenant_id = $1 AND id = $2 AND is_active = true`,
      [tenantId(req), input.leave_type_id]
    )
    if (employee.rowCount !== 1 || leaveType.rowCount !== 1) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Employee or active leave type was not found' })
    }
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`${tenantId(req)}:${input.employee_id}`]
    )
    const overlap = await client.query(
      `SELECT id FROM hr_leave_applications
       WHERE tenant_id = $1 AND employee_id = $2 AND status IN ('pending', 'approved')
         AND start_date <= $4::date AND end_date >= $3::date
       FOR UPDATE`,
      [tenantId(req), input.employee_id, input.start_date, input.end_date]
    )
    if (overlap.rowCount > 0) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'This leave overlaps an existing active application' })
    }
    const created = await client.query(
      `INSERT INTO hr_leave_applications
         (tenant_id, employee_id, leave_type_id, start_date, end_date, working_days, reason, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       RETURNING *`,
      [tenantId(req), input.employee_id, input.leave_type_id, input.start_date, input.end_date,
        input.working_days, input.reason, req.user.userId]
    )
    const row = created.rows[0]
    await client.query(
      `INSERT INTO hr_leave_audit (tenant_id, application_id, action, changed_by, after_data)
       VALUES ($1, $2, 'created', $3, $4::jsonb)`,
      [tenantId(req), row.id, req.user.userId, JSON.stringify(snapshot(row))]
    )
    await client.query('COMMIT')
    res.status(201).json(row)
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK') } catch (rollbackError) { logSafeError('Leave rollback failed', rollbackError) }
    }
    sendError(res, error, 'Failed to create leave application')
  } finally {
    client?.release()
  }
})

router.patch('/:id/approve', auth, requireAccountingPermission('hr:manage-employees'), async (req, res) => {
  await decide(req, res, 'approved', null)
})

router.patch('/:id/reject', auth, requireAccountingPermission('hr:manage-employees'), async (req, res) => {
  const reason = typeof req.body?.rejection_reason === 'string' ? req.body.rejection_reason.trim() : ''
  if (!reason || reason.length > 10000) return res.status(400).json({ error: 'Rejection reason is required' })
  await decide(req, res, 'rejected', reason)
})

router.patch('/:id/cancel', auth, requireAccountingPermission('hr:manage-employees'), async (req, res) => {
  if (!validId(req.params.id, res, 'Leave application')) return
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN')
    const current = await client.query(
      'SELECT * FROM hr_leave_applications WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
      [tenantId(req), req.params.id]
    )
    if (current.rowCount !== 1) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Leave application not found' }) }
    const before = current.rows[0]
    if (!['pending', 'approved'].includes(before.status)) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'Only pending or approved leave can be cancelled' })
    }
    if (before.status === 'approved') {
      const balance = await client.query(
        `SELECT * FROM hr_leave_balances
         WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3 AND leave_year = EXTRACT(YEAR FROM $4::date)::integer
         FOR UPDATE`,
        [tenantId(req), before.employee_id, before.leave_type_id, before.start_date]
      )
      if (balance.rowCount === 1) {
        await client.query(
          `UPDATE hr_leave_balances SET used_days = used_days - $1, updated_by = $2, updated_at = CURRENT_TIMESTAMP
           WHERE tenant_id = $3 AND id = $4`,
          [before.working_days, req.user.userId, tenantId(req), balance.rows[0].id]
        )
      }
    }
    const updated = await client.query(
      `UPDATE hr_leave_applications
       SET status = 'cancelled', updated_by = $1, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $2 AND id = $3 RETURNING *`,
      [req.user.userId, tenantId(req), req.params.id]
    )
    await client.query(
      `INSERT INTO hr_leave_audit (tenant_id, application_id, action, changed_by, before_data, after_data)
       VALUES ($1, $2, 'cancelled', $3, $4::jsonb, $5::jsonb)`,
      [tenantId(req), req.params.id, req.user.userId, JSON.stringify(snapshot(before)), JSON.stringify(snapshot(updated.rows[0]))]
    )
    await client.query('COMMIT')
    res.json(updated.rows[0])
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK') } catch (rollbackError) { logSafeError('Leave rollback failed', rollbackError) }
    }
    sendError(res, error, 'Failed to cancel leave application')
  } finally {
    client?.release()
  }
})

async function decide(req, res, decision, rejectionReason) {
  if (!validId(req.params.id, res, 'Leave application')) return
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN')
    const current = await client.query(
      'SELECT * FROM hr_leave_applications WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
      [tenantId(req), req.params.id]
    )
    if (current.rowCount !== 1) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Leave application not found' }) }
    const before = current.rows[0]
    if (before.status !== 'pending') {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'Leave application has already been decided or cancelled' })
    }
    let balance = null
    if (decision === 'approved') {
      const result = await client.query(
        `SELECT * FROM hr_leave_balances
         WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3
           AND leave_year = EXTRACT(YEAR FROM $4::date)::integer
         FOR UPDATE`,
        [tenantId(req), before.employee_id, before.leave_type_id, before.start_date]
      )
      balance = result.rows[0]
      if (!balance) {
        await client.query('ROLLBACK')
        return res.status(409).json({ error: 'A leave balance must be configured before approval' })
      }
      if (!balance.allow_negative && Number(balance.used_days) + Number(before.working_days) > Number(balance.entitled_days)) {
        await client.query('ROLLBACK')
        return res.status(409).json({ error: 'Insufficient leave balance' })
      }
      await client.query(
        `UPDATE hr_leave_balances SET used_days = used_days + $1, updated_by = $2, updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = $3 AND id = $4`,
        [before.working_days, req.user.userId, tenantId(req), balance.id]
      )
    }
    const updated = await client.query(
      `UPDATE hr_leave_applications
       SET status = $1, approved_by = $2, decision_at = CURRENT_TIMESTAMP,
           rejection_reason = $3, updated_by = $2, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $4 AND id = $5 RETURNING *`,
      [decision, req.user.userId, rejectionReason, tenantId(req), req.params.id]
    )
    await client.query(
      `INSERT INTO hr_leave_audit (tenant_id, application_id, action, changed_by, before_data, after_data)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
      [tenantId(req), req.params.id, decision, req.user.userId, JSON.stringify(snapshot(before)), JSON.stringify(snapshot(updated.rows[0]))]
    )
    await client.query('COMMIT')
    res.json(updated.rows[0])
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK') } catch (rollbackError) { logSafeError('Leave decision rollback failed', rollbackError) }
    }
    sendError(res, error, 'Failed to decide leave application')
  } finally {
    client?.release()
  }
}

router.get('/:id', auth, requireAccountingPermission('hr:read'), async (req, res) => {
  if (!validId(req.params.id, res, 'Leave application')) return
  try {
    const result = await pool.query(
      `SELECT ${APPLICATION_COLUMNS}
       FROM hr_leave_applications a
       JOIN hr_employees e ON e.tenant_id = a.tenant_id AND e.id = a.employee_id
       JOIN hr_leave_types t ON t.tenant_id = a.tenant_id AND t.id = a.leave_type_id
       LEFT JOIN hr_departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
       WHERE a.tenant_id = $1 AND a.id = $2`,
      [tenantId(req), req.params.id]
    )
    if (result.rowCount !== 1) return res.status(404).json({ error: 'Leave application not found' })
    res.json(result.rows[0])
  } catch (error) {
    sendError(res, error, 'Failed to fetch leave application')
  }
})

router.get('/:id/audit', auth, requireAccountingPermission('hr:read'), async (req, res) => {
  if (!validId(req.params.id, res, 'Leave application')) return
  try {
    const result = await pool.query(
      `SELECT h.id, h.application_id, h.action, h.changed_by, h.before_data, h.after_data, h.changed_at
       FROM hr_leave_audit h
       JOIN hr_leave_applications a ON a.tenant_id = h.tenant_id AND a.id = h.application_id
       WHERE h.tenant_id = $1 AND h.application_id = $2
       ORDER BY h.changed_at DESC, h.id DESC`,
      [tenantId(req), req.params.id]
    )
    res.json(result.rows)
  } catch (error) {
    sendError(res, error, 'Failed to fetch leave audit history')
  }
})

module.exports = router

const express = require('express')
const { validate: isUuid } = require('uuid')
const pool = require('../config/db')
const auth = require('../middleware/auth')
const { requireAccountingPermission } = require('../middleware/accountingAuthorization')
const { employeeInput } = require('../utils/employees')
const { logSafeError } = require('../utils/errorLogging')

const router = express.Router()

function validId(id, res) {
  if (!isUuid(id)) {
    res.status(404).json({ error: 'Employee not found' })
    return false
  }
  return true
}

function sendError(res, error, fallback) {
  if (error.statusCode) return res.status(error.statusCode).json({ error: error.message })
  if (error.code === '23505') return res.status(409).json({ error: 'Employee number or work email already exists' })
  if (error.code === '23503' || error.code === '23514') return res.status(400).json({ error: 'Employee reference violates a required integrity rule' })
  logSafeError(fallback, error)
  return res.status(500).json({ error: fallback })
}

router.get('/departments', auth, requireAccountingPermission('hr:read'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, description, is_active, created_at, updated_at
       FROM hr_departments WHERE tenant_id = $1
       ORDER BY is_active DESC, lower(name), id`,
      [req.user.tenantId]
    )
    res.json(result.rows)
  } catch (error) {
    sendError(res, error, 'Failed to fetch departments')
  }
})

router.post('/departments', auth, requireAccountingPermission('hr:manage-employees'), async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
  const description = req.body?.description == null ? null : String(req.body.description).trim() || null
  if (!name || name.length > 120 || (description && description.length > 10000)) {
    return res.status(400).json({ error: 'Department name and description are invalid' })
  }
  try {
    const result = await pool.query(
      `INSERT INTO hr_departments (tenant_id, name, description, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, description, is_active, created_at, updated_at`,
      [req.user.tenantId, name, description, req.user.userId]
    )
    res.status(201).json(result.rows[0])
  } catch (error) {
    sendError(res, error, 'Failed to create department')
  }
})

router.get('/', auth, requireAccountingPermission('hr:read'), async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : ''
  const status = ['active', 'inactive', 'suspended', 'terminated'].includes(req.query.status)
    ? req.query.status : null
  try {
    const result = await pool.query(
      `SELECT e.id, e.tenant_id, e.employee_number, e.first_name, e.middle_name, e.last_name,
              e.work_email, e.phone, e.job_title, e.employment_type, e.employment_start_date,
              e.employment_status, e.department_id, d.name AS department_name,
              e.reporting_manager_id,
              manager.employee_number AS reporting_manager_number,
              manager.first_name AS reporting_manager_first_name,
              manager.last_name AS reporting_manager_last_name
       FROM hr_employees e
       LEFT JOIN hr_departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
       LEFT JOIN hr_employees manager ON manager.tenant_id = e.tenant_id AND manager.id = e.reporting_manager_id
       WHERE e.tenant_id = $1
         AND ($2 = '' OR e.employee_number ILIKE '%' || $2 || '%'
              OR e.first_name ILIKE '%' || $2 || '%'
              OR e.last_name ILIKE '%' || $2 || '%'
              OR COALESCE(e.work_email, '') ILIKE '%' || $2 || '%')
         AND ($3::text IS NULL OR e.employment_status = $3)
       ORDER BY e.employment_status = 'active' DESC, lower(e.last_name), lower(e.first_name), e.id`,
      [req.user.tenantId, search, status]
    )
    res.json(result.rows)
  } catch (error) {
    sendError(res, error, 'Failed to fetch employees')
  }
})

router.post('/', auth, requireAccountingPermission('hr:manage-employees'), async (req, res) => {
  let employee
  try {
    employee = employeeInput(req.body)
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message })
  }
  try {
    const result = await pool.query(
      `INSERT INTO hr_employees
         (tenant_id, first_name, middle_name, last_name, work_email, phone, department_id,
          job_title, employment_type, employment_start_date, employment_status,
          reporting_manager_id, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [req.user.tenantId, employee.first_name, employee.middle_name, employee.last_name,
        employee.work_email, employee.phone, employee.department_id, employee.job_title,
        employee.employment_type, employee.employment_start_date, employee.employment_status,
        employee.reporting_manager_id, employee.notes, req.user.userId]
    )
    res.status(201).json(result.rows[0])
  } catch (error) {
    sendError(res, error, 'Failed to create employee')
  }
})

router.get('/:id', auth, requireAccountingPermission('hr:read'), async (req, res) => {
  if (!validId(req.params.id, res)) return
  try {
    const result = await pool.query(
      `SELECT e.*, d.name AS department_name,
              manager.employee_number AS reporting_manager_number,
              manager.first_name AS reporting_manager_first_name,
              manager.last_name AS reporting_manager_last_name
       FROM hr_employees e
       LEFT JOIN hr_departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
       LEFT JOIN hr_employees manager ON manager.tenant_id = e.tenant_id AND manager.id = e.reporting_manager_id
       WHERE e.tenant_id = $1 AND e.id = $2`,
      [req.user.tenantId, req.params.id]
    )
    if (result.rowCount !== 1) return res.status(404).json({ error: 'Employee not found' })
    res.json(result.rows[0])
  } catch (error) {
    sendError(res, error, 'Failed to fetch employee')
  }
})

router.put('/:id', auth, requireAccountingPermission('hr:manage-employees'), async (req, res) => {
  if (!validId(req.params.id, res)) return
  let employee
  try {
    employee = employeeInput(req.body)
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message })
  }
  try {
    const result = await pool.query(
      `UPDATE hr_employees SET first_name = $1, middle_name = $2, last_name = $3,
         work_email = $4, phone = $5, department_id = $6, job_title = $7,
         employment_type = $8, employment_start_date = $9, employment_status = $10,
         reporting_manager_id = $11, notes = $12, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $13 AND id = $14
       RETURNING *`,
      [employee.first_name, employee.middle_name, employee.last_name, employee.work_email,
        employee.phone, employee.department_id, employee.job_title, employee.employment_type,
        employee.employment_start_date, employee.employment_status, employee.reporting_manager_id,
        employee.notes, req.user.tenantId, req.params.id]
    )
    if (result.rowCount !== 1) return res.status(404).json({ error: 'Employee not found' })
    res.json(result.rows[0])
  } catch (error) {
    sendError(res, error, 'Failed to update employee')
  }
})

router.patch('/:id/status', auth, requireAccountingPermission('hr:manage-employees'), async (req, res) => {
  if (!validId(req.params.id, res)) return
  const status = req.body?.employment_status
  if (!['active', 'inactive', 'suspended', 'terminated'].includes(status)) {
    return res.status(400).json({ error: 'Employment status is invalid' })
  }
  try {
    const result = await pool.query(
      `UPDATE hr_employees SET employment_status = $1, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $2 AND id = $3 RETURNING *`,
      [status, req.user.tenantId, req.params.id]
    )
    if (result.rowCount !== 1) return res.status(404).json({ error: 'Employee not found' })
    res.json(result.rows[0])
  } catch (error) {
    sendError(res, error, 'Failed to update employee status')
  }
})

module.exports = router

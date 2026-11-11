const express = require('express')
const { validate: isUuid } = require('uuid')
const PDFDocument = require('pdfkit')
const pool = require('../config/db')
const auth = require('../middleware/auth')
const { requireAccountingPermission } = require('../middleware/accountingAuthorization')
const { withTransaction, postJournal } = require('../services/accounting')
const { approveRun, calculateRun, settleRemittance } = require('../services/payroll')
const { componentInput, compensationInput, payrollPeriod, remittanceInput, settingsInput } = require('../utils/payroll')
const { httpError, validationError } = require('../utils/accounting')
const { logSafeError } = require('../utils/errorLogging')

const router = express.Router()
const tenant = (req) => req.user.company_id || req.user.tenantId

function sendError(res, error, fallback) {
  if (error.statusCode) return res.status(error.statusCode).json({ error: error.message })
  if (error.code === '23505') return res.status(409).json({ error: 'Payroll record already exists' })
  if (error.code === '23503' || error.code === '23514') return res.status(409).json({ error: 'Payroll data violates a required integrity rule' })
  logSafeError(fallback, error)
  return res.status(500).json({ error: fallback })
}

function validId(id, res, label) {
  if (!isUuid(id)) {
    res.status(404).json({ error: `${label} not found` })
    return false
  }
  return true
}

router.get('/settings', auth, requireAccountingPermission('hr:read'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM hr_payroll_settings WHERE tenant_id = $1', [tenant(req)])
    res.json(result.rows[0] || null)
  } catch (error) { sendError(res, error, 'Failed to fetch payroll settings') }
})

router.put('/settings', auth, requireAccountingPermission('hr:manage-employees'), async (req, res) => {
  let input
  try { input = settingsInput(req.body) } catch (error) { return res.status(error.statusCode || 400).json({ error: error.message }) }
  try {
    const result = await pool.query(
      `INSERT INTO hr_payroll_settings
       (tenant_id, currency, pay_frequency, salary_expense_account_id,
        employer_contribution_expense_account_id, employer_contributions_payable_account_id,
        employee_deductions_payable_account_id, net_salary_payable_account_id, payroll_cash_account_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (tenant_id) DO UPDATE SET currency = EXCLUDED.currency, pay_frequency = EXCLUDED.pay_frequency,
         salary_expense_account_id = EXCLUDED.salary_expense_account_id,
         employer_contribution_expense_account_id = EXCLUDED.employer_contribution_expense_account_id,
         employer_contributions_payable_account_id = EXCLUDED.employer_contributions_payable_account_id,
         employee_deductions_payable_account_id = EXCLUDED.employee_deductions_payable_account_id,
         net_salary_payable_account_id = EXCLUDED.net_salary_payable_account_id,
         payroll_cash_account_id = EXCLUDED.payroll_cash_account_id, updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [tenant(req), input.currency, input.pay_frequency, input.salary_expense_account_id,
        input.employer_contribution_expense_account_id, input.employer_contributions_payable_account_id,
        input.employee_deductions_payable_account_id, input.net_salary_payable_account_id,
        input.payroll_cash_account_id, req.user.userId]
    )
    res.json(result.rows[0])
  } catch (error) { sendError(res, error, 'Failed to save payroll settings') }
})

router.get('/components', auth, requireAccountingPermission('hr:read'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM hr_payroll_components WHERE tenant_id = $1 ORDER BY is_active DESC, code', [tenant(req)])
    res.json(result.rows)
  } catch (error) { sendError(res, error, 'Failed to fetch payroll components') }
})

router.post('/components', auth, requireAccountingPermission('hr:manage-employees'), async (req, res) => {
  let input
  try { input = componentInput(req.body) } catch (error) { return res.status(error.statusCode || 400).json({ error: error.message }) }
  try {
    const result = await pool.query(
      `INSERT INTO hr_payroll_components
       (tenant_id, code, name, component_kind, calculation_type, amount, base_component_code,
        is_taxable, is_active, effective_from, effective_to, is_statutory, statutory_authority,
        statutory_code, configuration, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16)
       RETURNING *`,
      [tenant(req), input.code, input.name, input.component_kind, input.calculation_type, input.amount,
        input.base_component_code, input.is_taxable, input.is_active, input.effective_from, input.effective_to,
        input.is_statutory, input.statutory_authority, input.statutory_code,
        JSON.stringify(input.configuration), req.user.userId]
    )
    res.status(201).json(result.rows[0])
  } catch (error) { sendError(res, error, 'Failed to create payroll component') }
})

router.put('/components/:id', auth, requireAccountingPermission('hr:manage-employees'), async (req, res) => {
  if (!validId(req.params.id, res, 'Payroll component')) return
  let input
  try { input = componentInput(req.body) } catch (error) { return res.status(error.statusCode || 400).json({ error: error.message }) }
  try {
    const result = await pool.query(
      `UPDATE hr_payroll_components SET code = $1, name = $2, component_kind = $3,
       calculation_type = $4, amount = $5, base_component_code = $6, is_taxable = $7,
       is_active = $8, effective_from = $9, effective_to = $10, is_statutory = $11,
       statutory_authority = $12, statutory_code = $13, configuration = $14::jsonb,
       updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $15 AND id = $16 RETURNING *`,
      [input.code, input.name, input.component_kind, input.calculation_type, input.amount,
        input.base_component_code, input.is_taxable, input.is_active, input.effective_from,
        input.effective_to, input.is_statutory, input.statutory_authority, input.statutory_code,
        JSON.stringify(input.configuration), tenant(req), req.params.id]
    )
    if (result.rowCount !== 1) return res.status(404).json({ error: 'Payroll component not found' })
    res.json(result.rows[0])
  } catch (error) { sendError(res, error, 'Failed to update payroll component') }
})

router.get('/remittances/obligations', auth, requireAccountingPermission('hr:read'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.*, r.period_start, r.period_end, r.status
       FROM hr_payroll_statutory_obligations o
       JOIN hr_payroll_runs r ON r.tenant_id = o.tenant_id AND r.id = o.payroll_run_id
       WHERE o.tenant_id = $1 ORDER BY r.period_end DESC, o.authority, o.statutory_code`,
      [tenant(req)]
    )
    res.json(result.rows)
  } catch (error) { sendError(res, error, 'Failed to fetch statutory obligations') }
})

router.post('/remittances', auth, requireAccountingPermission('hr:manage-employees'), async (req, res) => {
  let input
  try { input = remittanceInput(req.body) } catch (error) { return res.status(error.statusCode || 400).json({ error: error.message }) }
  const key = req.get('Idempotency-Key')
  if (!key) return res.status(400).json({ error: 'Idempotency-Key is required' })
  try {
    const result = await settleRemittance(pool, { tenantId: tenant(req), userId: req.user.userId, idempotencyKey: key, input })
    res.status(result.replayed ? 200 : 201).json(result)
  } catch (error) { sendError(res, error, 'Failed to record statutory remittance') }
})

router.get('/compensation', auth, requireAccountingPermission('hr:read'), async (req, res) => {
  const employeeId = req.query.employee_id || null
  if (employeeId && !isUuid(employeeId)) return res.status(400).json({ error: 'Employee must be a valid ID' })
  try {
    const result = await pool.query(
      `SELECT c.*, e.employee_number, e.first_name, e.last_name
       FROM hr_employee_compensation c JOIN hr_employees e
       ON e.tenant_id = c.tenant_id AND e.id = c.employee_id
       WHERE c.tenant_id = $1 AND ($2::uuid IS NULL OR c.employee_id = $2)
       ORDER BY c.effective_from DESC, c.id DESC`,
      [tenant(req), employeeId]
    )
    res.json(result.rows)
  } catch (error) { sendError(res, error, 'Failed to fetch compensation') }
})

router.post('/compensation', auth, requireAccountingPermission('hr:manage-employees'), async (req, res) => {
  let input
  try {
    input = compensationInput(req.body)
    if (!/^[A-Z]{3}$/.test(input.currency)) throw validationError('Compensation currency is invalid')
    if (input.effective_to && input.effective_to < input.effective_from) throw validationError('Effective end must not be before start')
  } catch (error) { return res.status(error.statusCode || 400).json({ error: error.message }) }
  try {
    const result = await pool.query(
      `INSERT INTO hr_employee_compensation
       (tenant_id, employee_id, effective_from, effective_to, pay_frequency, basic_salary, currency, statutory_profile, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) RETURNING *`,
      [tenant(req), input.employee_id, input.effective_from, input.effective_to, input.pay_frequency,
        input.basic_salary, input.currency, JSON.stringify(input.statutory_profile), req.user.userId]
    )
    res.status(201).json(result.rows[0])
  } catch (error) { sendError(res, error, 'Failed to create compensation record') }
})

router.get('/runs', auth, requireAccountingPermission('hr:read'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM hr_payroll_runs WHERE tenant_id = $1 ORDER BY period_end DESC, created_at DESC`,
      [tenant(req)]
    )
    res.json(result.rows)
  } catch (error) { sendError(res, error, 'Failed to fetch payroll runs') }
})

router.post('/runs', auth, requireAccountingPermission('hr:manage-employees'), async (req, res) => {
  let input
  try { input = payrollPeriod(req.body) } catch (error) { return res.status(error.statusCode || 400).json({ error: error.message }) }
  try {
    const result = await pool.query(
      `INSERT INTO hr_payroll_runs
       (tenant_id, period_start, period_end, pay_frequency, currency, accounting_period_id, created_by)
       SELECT $1, $2, $3, $4, s.currency, $5, $6
       FROM hr_payroll_settings s WHERE s.tenant_id = $1 RETURNING *`,
      [tenant(req), input.period_start, input.period_end, input.pay_frequency, input.accounting_period_id, req.user.userId]
    )
    if (result.rowCount !== 1) return res.status(409).json({ error: 'Configure payroll settings before creating a run' })
    res.status(201).json(result.rows[0])
  } catch (error) { sendError(res, error, 'Failed to create payroll run') }
})

router.post('/runs/:id/calculate', auth, requireAccountingPermission('hr:manage-employees'), async (req, res) => {
  if (!validId(req.params.id, res, 'Payroll run')) return
  try {
    const result = await withTransaction(pool, (client) => calculateRun(client, tenant(req), req.params.id, req.user.userId))
    res.json(result)
  } catch (error) { sendError(res, error, 'Failed to calculate payroll run') }
})

router.patch('/runs/:id/approve', auth, requireAccountingPermission('hr:manage-employees'), async (req, res) => {
  if (!validId(req.params.id, res, 'Payroll run')) return
  const key = req.get('Idempotency-Key')
  if (!key) return res.status(400).json({ error: 'Idempotency-Key is required' })
  try {
    const result = await approveRun(pool, { tenantId: tenant(req), userId: req.user.userId, runId: req.params.id, idempotencyKey: key })
    res.json(result)
  } catch (error) { sendError(res, error, 'Failed to approve payroll run') }
})

router.patch('/runs/:id/pay', auth, requireAccountingPermission('hr:manage-employees'), async (req, res) => {
  if (!validId(req.params.id, res, 'Payroll run')) return
  const key = req.get('Idempotency-Key')
  if (!key) return res.status(400).json({ error: 'Idempotency-Key is required' })
  try {
    const result = await withTransaction(pool, async (client) => {
      const current = await client.query('SELECT * FROM hr_payroll_runs WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenant(req), req.params.id])
      if (current.rowCount !== 1) throw httpError(404, 'Payroll run not found')
      const run = current.rows[0]
      if (run.status !== 'approved') throw httpError(409, 'Only approved payroll runs can be paid')
      const settings = await client.query('SELECT * FROM hr_payroll_settings WHERE tenant_id = $1 FOR SHARE', [tenant(req)])
      if (!settings.rows[0]?.net_salary_payable_account_id || !settings.rows[0]?.payroll_cash_account_id) throw httpError(409, 'Configure payroll payable and cash accounts before payment')
      const posting = await postJournal(pool, {
        tenantId: tenant(req), userId: req.user.userId, idempotencyKey: key,
        body: {
          accounting_period_id: run.accounting_period_id, entry_date: run.period_end,
          description: `Payroll payment ${run.period_start} to ${run.period_end}`,
          source_type: 'payroll_payment', source_id: run.id, source_reference: run.id,
          event_type: 'payroll_payment',
          lines: [
            { account_id: settings.rows[0].net_salary_payable_account_id, description: 'Net salaries payable settled', debit: run.total_net, credit: '0' },
            { account_id: settings.rows[0].payroll_cash_account_id, description: 'Payroll cash payment', debit: '0', credit: run.total_net }
          ]
        }
      }, { client })
      const updated = await client.query(
        `UPDATE hr_payroll_runs SET status = 'paid', paid_by = $1, paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = $2 AND id = $3 RETURNING *`,
        [req.user.userId, tenant(req), req.params.id]
      )
      await client.query(
        `INSERT INTO hr_payroll_audit (tenant_id, payroll_run_id, action, changed_by, details)
         VALUES ($1, $2, 'paid', $3, $4::jsonb)`,
        [tenant(req), req.params.id, req.user.userId, JSON.stringify({ journal_entry_id: posting.journal.id })]
      )
      return { run: updated.rows[0], journal: posting.journal, replayed: posting.replayed }
    })
    res.json(result)
  } catch (error) { sendError(res, error, 'Failed to pay payroll run') }
})

router.get('/runs/:id/items', auth, requireAccountingPermission('hr:read'), async (req, res) => {
  if (!validId(req.params.id, res, 'Payroll run')) return
  try {
    const result = await pool.query(
      `SELECT i.*, e.employee_number, e.first_name, e.last_name
       FROM hr_payroll_items i JOIN hr_employees e ON e.tenant_id = i.tenant_id AND e.id = i.employee_id
       WHERE i.tenant_id = $1 AND i.payroll_run_id = $2 ORDER BY lower(e.last_name), lower(e.first_name)`,
      [tenant(req), req.params.id]
    )
    res.json(result.rows)
  } catch (error) { sendError(res, error, 'Failed to fetch payroll breakdown') }
})

router.get('/items/:id/payslip.pdf', auth, requireAccountingPermission('hr:read'), async (req, res) => {
  if (!validId(req.params.id, res, 'Payroll item')) return
  try {
    const result = await pool.query(
      `SELECT i.*, r.period_start, r.period_end, r.currency, e.employee_number, e.first_name, e.last_name
       FROM hr_payroll_items i JOIN hr_payroll_runs r ON r.tenant_id = i.tenant_id AND r.id = i.payroll_run_id
       JOIN hr_employees e ON e.tenant_id = i.tenant_id AND e.id = i.employee_id
       WHERE i.tenant_id = $1 AND i.id = $2`,
      [tenant(req), req.params.id]
    )
    if (result.rowCount !== 1) return res.status(404).json({ error: 'Payroll item not found' })
    const item = result.rows[0]
    const doc = new PDFDocument({ margin: 50 })
    const chunks = []
    doc.on('data', (chunk) => chunks.push(chunk))
    doc.on('end', () => {
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `attachment; filename="payslip-${item.employee_number}-${item.period_end}.pdf"`)
      res.send(Buffer.concat(chunks))
    })
    doc.fontSize(22).text('INVOXA PAYSLIP').moveDown()
      .fontSize(11).text(`Employee: ${item.employee_number} - ${item.first_name} ${item.last_name}`)
      .text(`Period: ${item.period_start} to ${item.period_end}`).moveDown()
      .text(`Gross earnings: ${item.gross_pay} ${item.currency}`)
      .text(`Employee deductions: ${item.employee_deductions} ${item.currency}`)
      .text(`Employer contributions: ${item.employer_contributions} ${item.currency}`)
      .fontSize(14).text(`Net pay: ${item.net_pay} ${item.currency}`)
    doc.end()
  } catch (error) { sendError(res, error, 'Failed to generate payslip') }
})

module.exports = router

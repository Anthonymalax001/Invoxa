const { postJournal, withTransaction } = require('./accounting')
const { httpError, hashJournalPayload } = require('../utils/accounting')
const { formatUnits, moneyUnits, percentage, statutoryValue } = require('../utils/payroll')

function weekdays(start, end) {
  const first = new Date(`${start}T00:00:00.000Z`)
  const last = new Date(`${end}T00:00:00.000Z`)
  let count = 0
  for (const cursor = new Date(first); cursor <= last; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    if (![0, 6].includes(cursor.getUTCDay())) count += 1
  }
  return count
}

function componentValue(component, basic, gross, days) {
  if (component.calculation_type === 'fixed') return moneyUnits(component.amount)
  const base = component.base_component_code === 'gross' ? gross : basic
  return percentage(formatUnits(base), component.amount)
}

async function calculateRun(client, tenantId, runId, userId) {
  const runResult = await client.query(
    'SELECT * FROM hr_payroll_runs WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
    [tenantId, runId]
  )
  if (runResult.rowCount !== 1) throw httpError(404, 'Payroll run not found')
  const run = runResult.rows[0]
  if (!['draft', 'calculated'].includes(run.status)) throw httpError(409, 'Only draft or calculated payroll runs can be calculated')

  const employees = await client.query(
    `SELECT e.id, e.employee_number, e.first_name, e.middle_name, e.last_name,
            c.id AS compensation_id, c.basic_salary, c.currency, c.pay_frequency,
            c.effective_from, c.effective_to, c.statutory_profile
     FROM hr_employees e
     JOIN LATERAL (
       SELECT * FROM hr_employee_compensation c
       WHERE c.tenant_id = e.tenant_id AND c.employee_id = e.id
         AND c.effective_from <= $2::date
         AND (c.effective_to IS NULL OR c.effective_to >= $1::date)
       ORDER BY c.effective_from DESC, c.id DESC LIMIT 1
     ) c ON true
     WHERE e.tenant_id = $3 AND e.employment_status = 'active'
     ORDER BY e.id
     FOR UPDATE OF e`,
    [run.period_start, run.period_end, tenantId]
  )
  const components = await client.query(
    `SELECT DISTINCT ON (code) * FROM hr_payroll_components
     WHERE tenant_id = $1 AND is_active = true AND effective_from <= $2::date
     AND (effective_to IS NULL OR effective_to >= $3::date)
     ORDER BY code, effective_from DESC, id DESC`,
    [tenantId, run.period_start, run.period_end]
  )
  await client.query('DELETE FROM hr_payroll_items WHERE tenant_id = $1 AND payroll_run_id = $2', [tenantId, runId])
  const periodWeekdays = weekdays(run.period_start, run.period_end)
  let totalGross = 0n
  let totalDeductions = 0n
  let totalEmployer = 0n
  let totalNet = 0n

  for (const employee of employees.rows) {
    const attendance = await client.query(
      `SELECT COALESCE(sum(overtime_minutes), 0)::integer AS overtime_minutes
       FROM hr_attendance WHERE tenant_id = $1 AND employee_id = $2
         AND attendance_date BETWEEN $3::date AND $4::date`,
      [tenantId, employee.id, run.period_start, run.period_end]
    )
    const unpaid = await client.query(
      `SELECT COALESCE(sum((
         SELECT count(*) FROM generate_series(
           greatest(a.start_date, $3::date), least(a.end_date, $4::date), interval '1 day'
         ) day WHERE extract(isodow FROM day) < 6
       )), 0) AS unpaid_days
       FROM hr_leave_applications a JOIN hr_leave_types t
         ON t.tenant_id = a.tenant_id AND t.id = a.leave_type_id
       WHERE a.tenant_id = $1 AND a.employee_id = $2 AND a.status = 'approved'
         AND t.code = 'unpaid' AND a.start_date <= $4::date AND a.end_date >= $3::date`,
      [tenantId, employee.id, run.period_start, run.period_end]
    )
    const basic = moneyUnits(employee.basic_salary)
    const unpaidDays = Number(unpaid.rows[0].unpaid_days || 0)
    const unpaidDeduction = periodWeekdays > 0
      ? (basic * BigInt(unpaidDays) / BigInt(periodWeekdays)) : 0n
    let gross = basic - unpaidDeduction
    if (gross < 0n) gross = 0n
    const details = [{ code: 'basic_salary', name: 'Basic salary', kind: 'earning', amount: formatUnits(gross), is_statutory: false }]
    let deductions = unpaidDeduction
    let employer = 0n
    const statutoryComponents = []
    const values = new Map()
    for (const component of components.rows) {
      if (component.is_statutory === true) {
        statutoryComponents.push(component)
        continue
      }
      const overtimeRate = component.configuration?.overtime_rate
      const value = overtimeRate && component.component_kind === 'earning'
        ? (moneyUnits(overtimeRate) * BigInt(attendance.rows[0].overtime_minutes || 0) / 60n)
        : componentValue(component, basic, gross, periodWeekdays)
      if (component.component_kind === 'earning') gross += value
      else if (component.component_kind === 'deduction') deductions += value
      else employer += value
      details.push({
        code: component.code, name: component.name, kind: component.component_kind, amount: formatUnits(value),
        is_statutory: component.is_statutory === true, statutory_authority: component.statutory_authority,
        statutory_code: component.statutory_code, configuration: component.configuration
      })
    }
    const ruleOrder = { nssf: 1, shif: 2, housing_levy: 3, paye: 4 }
    statutoryComponents.sort((left, right) => {
      const leftType = left.configuration?.rule_type || ''
      const rightType = right.configuration?.rule_type || ''
      return (ruleOrder[leftType] || 99) - (ruleOrder[rightType] || 99)
    })
    for (const component of statutoryComponents) {
      if (run.pay_frequency !== 'monthly' && component.configuration?.frequency === 'monthly') {
        throw httpError(409, `Monthly statutory rule ${component.code} cannot be applied to a ${run.pay_frequency} payroll run`)
      }
      const result = statutoryValue(component, { gross, details, values, profile: employee.statutory_profile || {} })
      const value = result.value
      values.set(component.code.toLowerCase(), value)
      if (component.component_kind === 'earning') gross += value
      else if (component.component_kind === 'deduction') deductions += value
      else employer += value
      details.push({
        code: component.code, name: component.name, kind: component.component_kind,
        amount: formatUnits(value), is_statutory: true, statutory_authority: component.statutory_authority,
        statutory_code: component.statutory_code, configuration: result.rule, calculation: result.breakdown
      })
    }
    const net = gross - deductions
    if (net < 0n) throw httpError(409, `Payroll deductions exceed net pay for employee ${employee.employee_number}`)
    totalGross += gross; totalDeductions += deductions; totalEmployer += employer; totalNet += net
    await client.query(
      `INSERT INTO hr_payroll_items
       (tenant_id, payroll_run_id, employee_id, compensation_snapshot, component_snapshot,
        attendance_snapshot, gross_pay, employee_deductions, employer_contributions, net_pay)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9, $10)`,
      [tenantId, runId, employee.id,
        JSON.stringify({ compensation_id: employee.compensation_id, basic_salary: employee.basic_salary, currency: employee.currency, pay_frequency: employee.pay_frequency, statutory_profile: employee.statutory_profile || {} }),
        JSON.stringify(details),
        JSON.stringify({ overtime_minutes: attendance.rows[0].overtime_minutes, unpaid_leave_days: unpaidDays }),
        formatUnits(gross), formatUnits(deductions), formatUnits(employer), formatUnits(net)]
    )
  }
  const updated = await client.query(
    `UPDATE hr_payroll_runs SET status = 'calculated', total_gross = $1,
       total_employee_deductions = $2, total_employer_contributions = $3,
       total_net = $4, updated_at = CURRENT_TIMESTAMP
     WHERE tenant_id = $5 AND id = $6 RETURNING *`,
    [formatUnits(totalGross), formatUnits(totalDeductions), formatUnits(totalEmployer), formatUnits(totalNet), tenantId, runId]
  )
  await client.query(
    `INSERT INTO hr_payroll_audit (tenant_id, payroll_run_id, action, changed_by, details)
     VALUES ($1, $2, 'calculated', $3, $4::jsonb)`,
    [tenantId, runId, userId, JSON.stringify({ employee_count: employees.rowCount })]
  )
  return updated.rows[0]
}

function payrollJournalBody(run, settings, lines, eventType) {
  const entryDate = run.period_end instanceof Date
    ? `${run.period_end.getFullYear()}-${String(run.period_end.getMonth() + 1).padStart(2, '0')}-${String(run.period_end.getDate()).padStart(2, '0')}`
    : run.period_end
  return {
    accounting_period_id: run.accounting_period_id,
    entry_date: entryDate,
    description: `Payroll ${run.period_start} to ${run.period_end}`,
    source_type: 'payroll',
    source_id: run.id,
    source_reference: run.id,
    event_type: eventType,
    lines
  }
}

function payrollJournalLines(run, settings) {
  return [
    { account_id: settings.salary_expense_account_id, description: 'Gross salary expense', debit: run.total_gross, credit: '0' },
    { account_id: settings.employer_contribution_expense_account_id, description: 'Employer contribution expense', debit: run.total_employer_contributions, credit: '0' },
    { account_id: settings.employee_deductions_payable_account_id, description: 'Employee deductions payable', debit: '0', credit: run.total_employee_deductions },
    { account_id: settings.employer_contributions_payable_account_id, description: 'Employer contributions payable', debit: '0', credit: run.total_employer_contributions },
    { account_id: settings.net_salary_payable_account_id, description: 'Net salaries payable', debit: '0', credit: run.total_net }
  ].filter((line) => moneyUnits(line.debit) > 0n || moneyUnits(line.credit) > 0n)
}

async function approveRun(pool, { tenantId, userId, runId, idempotencyKey }) {
  return withTransaction(pool, async (client) => {
    const runResult = await client.query('SELECT * FROM hr_payroll_runs WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, runId])
    if (runResult.rowCount !== 1) throw httpError(404, 'Payroll run not found')
    const run = runResult.rows[0]
    if (run.status !== 'calculated') throw httpError(409, 'Only calculated payroll runs can be approved')
    const settingsResult = await client.query('SELECT * FROM hr_payroll_settings WHERE tenant_id = $1 FOR SHARE', [tenantId])
    if (settingsResult.rowCount !== 1) throw httpError(409, 'Payroll accounting settings are incomplete')
    const settings = settingsResult.rows[0]
    const required = ['salary_expense_account_id', 'employer_contribution_expense_account_id',
      'employee_deductions_payable_account_id', 'employer_contributions_payable_account_id', 'net_salary_payable_account_id']
    if (required.some((key) => !settings[key])) throw httpError(409, 'Configure all payroll accounting accounts before approval')
    const accounts = await client.query(
      `SELECT id, account_type, normal_balance, is_active
       FROM accounting_accounts WHERE tenant_id = $1 AND id = ANY($2::uuid[]) FOR SHARE`,
      [tenantId, required.map((key) => settings[key])]
    )
    if (accounts.rowCount !== required.length || accounts.rows.some((account) => !account.is_active)) {
      throw httpError(409, 'All payroll accounting accounts must be active tenant accounts')
    }
    const accountMap = new Map(accounts.rows.map((account) => [account.id, account]))
    if (accountMap.get(settings.salary_expense_account_id)?.account_type !== 'expense' ||
        accountMap.get(settings.salary_expense_account_id)?.normal_balance !== 'debit' ||
        accountMap.get(settings.employer_contribution_expense_account_id)?.account_type !== 'expense' ||
        accountMap.get(settings.employer_contribution_expense_account_id)?.normal_balance !== 'debit' ||
        [settings.employee_deductions_payable_account_id, settings.employer_contributions_payable_account_id, settings.net_salary_payable_account_id]
          .some((id) => accountMap.get(id)?.account_type !== 'liability' || accountMap.get(id)?.normal_balance !== 'credit')) {
      throw httpError(409, 'Payroll expense and payable account mappings have unsuitable account types')
    }
    const lines = payrollJournalLines(run, settings)
    const posting = await postJournal(pool, {
      tenantId, userId, idempotencyKey,
      body: payrollJournalBody(run, settings, lines, 'payroll_approval')
    }, { client })
    const updated = await client.query(
      `UPDATE hr_payroll_runs SET status = 'approved', journal_entry_id = $1,
         approved_by = $2, approved_at = CURRENT_TIMESTAMP, idempotency_key = $3,
         updated_at = CURRENT_TIMESTAMP WHERE tenant_id = $4 AND id = $5 RETURNING *`,
      [posting.journal.id, userId, idempotencyKey, tenantId, runId]
    )
    await client.query(
      `INSERT INTO hr_payroll_audit (tenant_id, payroll_run_id, action, changed_by, details)
       VALUES ($1, $2, 'approved', $3, $4::jsonb)`,
      [tenantId, runId, userId, JSON.stringify({ journal_entry_id: posting.journal.id })]
    )
    const statutory = await client.query(
      `SELECT d->>'statutory_authority' AS authority, d->>'statutory_code' AS statutory_code,
              d->>'kind' AS component_kind, SUM((d->>'amount')::numeric) AS amount
       FROM hr_payroll_items i, LATERAL jsonb_array_elements(i.component_snapshot) d
       WHERE i.tenant_id = $1 AND i.payroll_run_id = $2
         AND (d->>'is_statutory')::boolean = true
       GROUP BY d->>'statutory_authority', d->>'statutory_code', d->>'kind'`,
      [tenantId, runId]
    )
    const obligations = new Map()
    for (const row of statutory.rows) {
      const key = `${row.authority}:${row.statutory_code}`
      const current = obligations.get(key) || { authority: row.authority, statutory_code: row.statutory_code, employee_amount: 0n, employer_amount: 0n }
      if (row.component_kind === 'employer_contribution') current.employer_amount += moneyUnits(row.amount)
      else if (row.component_kind === 'deduction') current.employee_amount += moneyUnits(row.amount)
      obligations.set(key, current)
    }
    for (const obligation of obligations.values()) {
      await client.query(
        `INSERT INTO hr_payroll_statutory_obligations
         (tenant_id, payroll_run_id, authority, statutory_code, employee_amount, employer_amount)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenantId, runId, obligation.authority, obligation.statutory_code,
          formatUnits(obligation.employee_amount), formatUnits(obligation.employer_amount)]
      )
    }
    return { run: updated.rows[0], journal: posting.journal, replayed: posting.replayed }
  })
}

async function settleRemittance(pool, { tenantId, userId, idempotencyKey, input }) {
  return withTransaction(pool, async (client) => {
    const existing = await client.query(
      `SELECT * FROM hr_payroll_remittances WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey]
    )
    if (existing.rowCount) {
      const row = existing.rows[0]
      const existingPaymentDate = row.payment_date instanceof Date
        ? row.payment_date.toISOString().slice(0, 10)
        : String(row.payment_date).slice(0, 10)
      if (row.obligation_id !== input.obligation_id || row.amount !== input.amount ||
          existingPaymentDate !== input.payment_date ||
          row.payment_reference !== input.payment_reference || row.payment_account_id !== input.payment_account_id) {
        throw httpError(409, 'Idempotency-Key was already used for a different remittance')
      }
      return { remittance: row, replayed: true }
    }
    const obligationResult = await client.query(
      `SELECT o.*, r.accounting_period_id, s.employee_deductions_payable_account_id,
              s.employer_contributions_payable_account_id, s.payroll_cash_account_id
       FROM hr_payroll_statutory_obligations o
       JOIN hr_payroll_runs r ON r.tenant_id = o.tenant_id AND r.id = o.payroll_run_id
       JOIN hr_payroll_settings s ON s.tenant_id = o.tenant_id
       WHERE o.tenant_id = $1 AND o.id = $2 FOR UPDATE`,
      [tenantId, input.obligation_id]
    )
    if (obligationResult.rowCount !== 1) throw httpError(404, 'Statutory obligation not found')
    const obligation = obligationResult.rows[0]
    const amount = moneyUnits(input.amount)
    const employeeDue = moneyUnits(obligation.employee_amount) - moneyUnits(obligation.employee_settled)
    const employerDue = moneyUnits(obligation.employer_amount) - moneyUnits(obligation.employer_settled)
    if (amount <= 0n || amount > employeeDue + employerDue) throw httpError(409, 'Remittance exceeds the outstanding statutory liability')
    const employeeAmount = amount <= employeeDue ? amount : employeeDue
    const employerAmount = amount - employeeAmount
    const accounts = await client.query(
      `SELECT id, account_type, normal_balance, is_active FROM accounting_accounts
       WHERE tenant_id = $1 AND id = ANY($2::uuid[]) FOR SHARE`,
      [tenantId, [obligation.employee_deductions_payable_account_id, obligation.employer_contributions_payable_account_id, input.payment_account_id]]
    )
    const accountIds = new Set([obligation.employee_deductions_payable_account_id, obligation.employer_contributions_payable_account_id, input.payment_account_id])
    const accountMap = new Map(accounts.rows.map((account) => [account.id, account]))
    const employeePayable = accountMap.get(obligation.employee_deductions_payable_account_id)
    const employerPayable = accountMap.get(obligation.employer_contributions_payable_account_id)
    const paymentAccount = accountMap.get(input.payment_account_id)
    if (accounts.rowCount !== accountIds.size || accounts.rows.some((account) => !account.is_active) ||
        employeePayable?.account_type !== 'liability' || employeePayable?.normal_balance !== 'credit' ||
        employerPayable?.account_type !== 'liability' || employerPayable?.normal_balance !== 'credit' ||
        paymentAccount?.account_type !== 'asset' || paymentAccount?.normal_balance !== 'debit') {
      throw httpError(409, 'Payment account must be an active tenant-owned asset account')
    }
    const period = await client.query(
      `SELECT id FROM accounting_periods
       WHERE tenant_id = $1 AND status = 'open' AND $2::date BETWEEN starts_on AND ends_on
       FOR SHARE`,
      [tenantId, input.payment_date]
    )
    if (period.rowCount !== 1) throw httpError(409, 'Payment date must fall in one open accounting period')
    const lines = [
      { account_id: obligation.employee_deductions_payable_account_id, description: `${obligation.authority} employee liability settled`, debit: formatUnits(employeeAmount), credit: '0' },
      { account_id: obligation.employer_contributions_payable_account_id, description: `${obligation.authority} employer liability settled`, debit: formatUnits(employerAmount), credit: '0' },
      { account_id: input.payment_account_id, description: `${obligation.authority} remittance payment`, debit: '0', credit: input.amount }
    ].filter((line) => line.debit !== '0.000000')
    const posting = await postJournal(pool, {
      tenantId, userId, idempotencyKey,
      body: {
        accounting_period_id: period.rows[0].id, entry_date: input.payment_date,
        description: `${obligation.authority} ${obligation.statutory_code} remittance`,
        source_type: 'payroll_remittance', source_id: obligation.id, source_reference: input.payment_reference,
        event_type: 'payroll_remittance', lines
      }
    }, { client })
    const remittance = await client.query(
      `INSERT INTO hr_payroll_remittances
       (tenant_id, obligation_id, payment_date, amount, employee_amount, employer_amount,
        payment_reference, payment_account_id, journal_entry_id, idempotency_key, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [tenantId, obligation.id, input.payment_date, input.amount, formatUnits(employeeAmount),
        formatUnits(employerAmount), input.payment_reference, input.payment_account_id, posting.journal.id,
        idempotencyKey, userId]
    )
    await client.query(
      `UPDATE hr_payroll_statutory_obligations
       SET employee_settled = employee_settled + $1, employer_settled = employer_settled + $2,
           updated_at = CURRENT_TIMESTAMP WHERE tenant_id = $3 AND id = $4`,
      [formatUnits(employeeAmount), formatUnits(employerAmount), tenantId, obligation.id]
    )
    await client.query(
      `INSERT INTO hr_payroll_audit (tenant_id, payroll_run_id, action, changed_by, details)
       VALUES ($1, $2, 'remitted', $3, $4::jsonb)`,
      [tenantId, obligation.payroll_run_id, userId, JSON.stringify({ remittance_id: remittance.rows[0].id, journal_entry_id: posting.journal.id })]
    )
    return { remittance: remittance.rows[0], journal: posting.journal, replayed: posting.replayed }
  })
}

module.exports = { approveRun, calculateRun, payrollJournalBody, payrollJournalLines, settleRemittance }

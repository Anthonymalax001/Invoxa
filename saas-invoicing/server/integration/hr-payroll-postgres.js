// Explicitly invoked disposable PostgreSQL integration suite.
// This file is outside test/ so the normal mocked suite never opens a database connection.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { Pool } = require('pg')
const { v4: uuid } = require('uuid')
const { calculateRun, approveRun } = require('../src/services/payroll')
const { CONFIRMATION, DATABASE, ROLE, HOST, targetFromEnvironment } = require('./hr-payroll-target')
const COMMENT = 'INVOXA_DISPOSABLE_HR_PAYROLL_TEST'
const RUN_MARKER = `INVOXA_HR_PAYROLL_IT_${crypto.randomUUID().replaceAll('-', '')}`
const pool = new Pool({ ...targetFromEnvironment(), max: 4, connectionTimeoutMillis: 30000,
  application_name: 'invoxa-hr-payroll-integration-tests',
  options: '-c statement_timeout=15000 -c lock_timeout=5000 -c search_path=public,pg_catalog' })

const root = path.join(__dirname, '..')
const migrationNames = [
  '20261021_001_accounting_foundation.sql',
  '20261103_001_hr_foundation.sql',
  '20261103_002_hr_attendance.sql',
  '20261103_003_hr_leave.sql',
  '20261103_004_hr_payroll.sql',
  '20261103_005_payroll_statutory_remittances.sql'
]
const migrationSql = migrationNames.map((name) => fs.readFileSync(path.join(root, 'migrations', name), 'utf8'))
const ids = {
  tenantA: uuid(), tenantB: uuid(), userA: uuid(), userB: uuid(),
  employeeA: uuid(), employeeB: uuid(), runA: uuid(), periodA: uuid()
}
let lockClient
let ready = false
const BASELINE_TABLES = ['users', 'tenants']
const OWNED_TABLE_CLEANUP = [
  'hr_payroll_remittances', 'hr_payroll_statutory_obligations', 'hr_payroll_audit',
  'hr_payroll_items', 'hr_payroll_runs', 'hr_employee_compensation',
  'hr_payroll_components', 'hr_payroll_settings', 'hr_leave_audit',
  'hr_leave_applications', 'hr_leave_balances', 'hr_leave_types',
  'hr_attendance_audit', 'hr_attendance', 'hr_employees',
  'hr_employee_sequences', 'hr_departments', 'accounting_journal_lines',
  'accounting_journal_entries', 'accounting_posting_events',
  'accounting_accounts', 'accounting_periods', 'accounting_settings',
  ...BASELINE_TABLES
]
const OWNED_FUNCTION_CLEANUP = [
  'hr_generate_employee_number', 'hr_attendance_audit_immutable',
  'hr_calculate_attendance_minutes', 'hr_leave_audit_immutable',
  'accounting_guard_posting_event_mutation', 'accounting_guard_settings_mutation',
  'accounting_assert_posting_event_completed', 'accounting_prevent_overlapping_periods',
  'accounting_guard_period_mutation', 'accounting_guard_journal_entry_mutation',
  'accounting_guard_journal_line_mutation', 'accounting_assert_posted_journal_balanced'
]
const EMPTY_PUBLIC_SCHEMA_QUERY = `
  WITH public_objects AS (
    SELECT 'pg_class'::regclass AS classid, c.oid
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
    UNION ALL
    SELECT 'pg_proc'::regclass, p.oid
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
    UNION ALL
    SELECT 'pg_type'::regclass, t.oid
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typtype <> 'p'
    UNION ALL
    SELECT 'pg_collation'::regclass, c.oid
      FROM pg_collation c JOIN pg_namespace n ON n.oid = c.collnamespace
     WHERE n.nspname = 'public'
    UNION ALL
    SELECT 'pg_conversion'::regclass, c.oid
      FROM pg_conversion c JOIN pg_namespace n ON n.oid = c.connamespace
     WHERE n.nspname = 'public'
    UNION ALL
    SELECT 'pg_operator'::regclass, o.oid
      FROM pg_operator o JOIN pg_namespace n ON n.oid = o.oprnamespace
     WHERE n.nspname = 'public'
    UNION ALL
    SELECT 'pg_opclass'::regclass, o.oid
      FROM pg_opclass o JOIN pg_namespace n ON n.oid = o.opcnamespace
     WHERE n.nspname = 'public'
    UNION ALL
    SELECT 'pg_opfamily'::regclass, o.oid
      FROM pg_opfamily o JOIN pg_namespace n ON n.oid = o.opfnamespace
     WHERE n.nspname = 'public'
  )
  SELECT count(*)::integer AS count
    FROM public_objects o
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_depend d
       JOIN pg_extension e ON e.oid = d.refobjid
      WHERE d.classid = o.classid
        AND d.objid = o.oid
        AND d.deptype = 'e'
        AND e.extname = 'uuid-ossp'
   )`

async function verifyTarget(client) {
  const identity = await client.query(
    `SELECT d.datname AS database_name, shobj_description(d.oid, 'pg_database') AS database_comment,
            current_user AS role_name, pg_is_in_recovery() AS in_recovery,
            current_setting('transaction_read_only') = 'on' AS read_only, r.rolsuper AS is_superuser,
            pg_get_userbyid(d.datdba) = current_user AS is_owner,
            has_schema_privilege(current_user, 'public', 'USAGE') AS schema_usage,
            has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create,
            to_regprocedure('uuid_generate_v4()') IS NOT NULL AS uuid_available,
            EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'uuid-ossp') AS uuid_ossp
     FROM pg_database d JOIN pg_roles r ON r.rolname = current_user
     WHERE d.datname = current_database()`
  )
  const row = identity.rows[0]
  assert.equal(row.database_name, DATABASE)
  assert.equal(row.database_comment, COMMENT)
  assert.equal(row.role_name, ROLE)
  assert.equal(row.in_recovery, false)
  assert.equal(row.read_only, false)
  assert.equal(row.is_superuser, false)
  assert.equal(row.is_owner, true)
  assert.equal(row.schema_usage, true)
  assert.equal(row.schema_create, true)
  assert.equal(row.uuid_available, true)
  assert.equal(row.uuid_ossp, true)
  const publicObjects = await client.query(EMPTY_PUBLIC_SCHEMA_QUERY)
  assert.equal(publicObjects.rows[0].count, 0)
}

async function applyMigrations(client) {
  for (const sql of migrationSql) await client.query(sql)
  const tables = ['hr_departments', 'hr_employees', 'hr_attendance', 'hr_leave_types',
    'hr_leave_balances', 'hr_leave_applications', 'hr_payroll_settings', 'hr_payroll_components',
    'hr_employee_compensation', 'hr_payroll_runs', 'hr_payroll_items',
    'hr_payroll_statutory_obligations', 'hr_payroll_remittances']
  const result = await client.query(
    `SELECT count(*)::integer AS count FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])`, [tables]
  )
  assert.equal(result.rows[0].count, tables.length)
}

async function createBaselineSchema(client) {
  await client.query(`
    CREATE TABLE public.tenants (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      name character varying(255) NOT NULL,
      email character varying(255),
      phone character varying(50)
    );
    CREATE TABLE public.users (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
      name character varying(255) NOT NULL,
      email character varying(255) NOT NULL,
      password_hash text NOT NULL,
      role character varying(50) NOT NULL,
      CONSTRAINT hr_payroll_it_users_tenant_id_unique UNIQUE (tenant_id, id)
    );
  `)
}

async function cleanupOwnedObjects(client) {
  await client.query(`DROP TABLE IF EXISTS ${OWNED_TABLE_CLEANUP.map((name) => `public.${name}`).join(', ')}`)
  for (const name of OWNED_FUNCTION_CLEANUP) {
    await client.query(`DROP FUNCTION IF EXISTS public.${name}()`)
  }
}

async function createBaseFixtures(client) {
  await client.query(
    `INSERT INTO tenants (id, name) VALUES ($1, 'HR Tenant A'), ($2, 'HR Tenant B')`,
    [ids.tenantA, ids.tenantB]
  )
  await client.query(
    `INSERT INTO users (id, tenant_id, name, email, password_hash, role)
     VALUES ($1, $2, 'Admin A', 'admin-a@example.test', 'fixture', 'admin'),
            ($3, $4, 'Admin B', 'admin-b@example.test', 'fixture', 'admin')`,
    [ids.userA, ids.tenantA, ids.userB, ids.tenantB]
  )
}

async function createFixtures(client) {
  await client.query(
    `INSERT INTO accounting_settings (tenant_id, base_currency, created_by)
     VALUES ($1, 'KES', $2)`,
    [ids.tenantA, ids.userA]
  )
  const accounts = await client.query(
    `INSERT INTO accounting_accounts
     (tenant_id, account_code, name, account_type, normal_balance, created_by)
     VALUES ($1, '6100', 'Salary expense', 'expense', 'debit', $2),
            ($1, '6110', 'Employer contribution expense', 'expense', 'debit', $2),
            ($1, '2200', 'Employee deductions payable', 'liability', 'credit', $2),
            ($1, '2210', 'Employer contributions payable', 'liability', 'credit', $2),
            ($1, '2220', 'Net salary payable', 'liability', 'credit', $2),
            ($1, '1010', 'Payroll bank', 'asset', 'debit', $2)
     RETURNING account_code, id`,
    [ids.tenantA, ids.userA]
  )
  const account = Object.fromEntries(accounts.rows.map((row) => [row.account_code, row.id]))
  await client.query(
    `INSERT INTO accounting_periods (id, tenant_id, name, starts_on, ends_on, status, created_by)
     VALUES ($1, $2, 'November 2026', '2026-11-01', '2026-11-30', 'open', $3)`,
    [ids.periodA, ids.tenantA, ids.userA]
  )
  await client.query(
    `INSERT INTO hr_payroll_settings
     (tenant_id, currency, pay_frequency, salary_expense_account_id,
      employer_contribution_expense_account_id, employer_contributions_payable_account_id,
      employee_deductions_payable_account_id, net_salary_payable_account_id, payroll_cash_account_id, created_by)
     VALUES ($1, 'KES', 'monthly', $3, $4, $5, $6, $7, $8, $2)`,
    [ids.tenantA, ids.userA, account['6100'], account['6110'], account['2210'], account['2200'], account['2220'], account['1010']]
  )
  await client.query(
    `INSERT INTO hr_employees
     (id, tenant_id, first_name, last_name, employment_type, employment_start_date, created_by)
     VALUES ($1, $2, 'Ada', 'Accountant', 'permanent', '2026-01-01', $3),
            ($4, $5, 'Ben', 'OtherTenant', 'permanent', '2026-01-01', $6)`,
    [ids.employeeA, ids.tenantA, ids.userA, ids.employeeB, ids.tenantB, ids.userB]
  )
  await client.query(
    `INSERT INTO hr_employee_compensation
     (tenant_id, employee_id, effective_from, pay_frequency, basic_salary, currency, created_by)
     VALUES ($1, $2, '2026-01-01', 'monthly', '100000', 'KES', $3)`,
    [ids.tenantA, ids.employeeA, ids.userA]
  )
  await client.query(
    `INSERT INTO hr_payroll_components
     (tenant_id, code, name, component_kind, calculation_type, amount, effective_from,
      is_statutory, statutory_authority, statutory_code, configuration, created_by)
     VALUES ($1, 'nssf', 'NSSF', 'deduction', 'percentage', 0, '2026-02-01', true, 'NSSF', 'NSSF', $2::jsonb, $3),
            ($1, 'nssf_employer', 'NSSF Employer', 'employer_contribution', 'percentage', 0, '2026-02-01', true, 'NSSF', 'NSSF', $2::jsonb, $3)`,
    [ids.tenantA, JSON.stringify({ rule_type: 'nssf', frequency: 'monthly', effective_from: '2026-02-01',
      source_url: 'https://www.nssf.or.ke/notice-to-employers-year-4-2026-nssf-contribution-rates/',
      employee_rate: '6', employer_rate: '6', lower_earnings_limit: '9000',
      upper_earnings_limit: '108000', max_employee: '6480', max_employer: '6480', rounding: 'half_up_cent' }), ids.userA]
  )
  await client.query(
    `INSERT INTO hr_payroll_runs
     (id, tenant_id, period_start, period_end, pay_frequency, currency, accounting_period_id, created_by)
     VALUES ($1, $2, '2026-11-01', '2026-11-30', 'monthly', 'KES', $3, $4)`,
    [ids.runA, ids.tenantA, ids.periodA, ids.userA]
  )
}

test.before(async () => {
  lockClient = await pool.connect()
  await lockClient.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [DATABASE])
  await cleanupOwnedObjects(lockClient)
  await verifyTarget(lockClient)
  await createBaselineSchema(lockClient)
  await createBaseFixtures(lockClient)
  await applyMigrations(lockClient)
  await createFixtures(lockClient)
  ready = true
})

test('HR/payroll migrations create tenant-scoped schema and required constraints', async () => {
  assert.equal(ready, true)
  const constraints = await lockClient.query(
    `SELECT count(*)::integer AS count FROM pg_constraint
     WHERE conname IN ('hr_employees_tenant_number_unique', 'hr_attendance_daily_unique',
       'hr_leave_balances_unique', 'hr_payroll_items_unique',
       'hr_payroll_remittance_idempotency_unique')`
  )
  assert.equal(constraints.rows[0].count, 5)
  const indexes = await lockClient.query(
    `SELECT count(*)::integer AS count FROM pg_indexes
     WHERE schemaname = 'public' AND indexname IN
       ('hr_employees_tenant_search_idx', 'hr_attendance_tenant_date_idx',
        'hr_leave_applications_filter_idx', 'hr_payroll_items_employee_idx',
        'hr_payroll_statutory_obligations_lookup_idx')`
  )
  assert.equal(indexes.rows[0].count, 5)
  const triggers = await lockClient.query(
    `SELECT count(*)::integer AS count FROM pg_trigger
     WHERE NOT tgisinternal AND tgname IN
       ('hr_employees_generate_number', 'hr_attendance_calculate_minutes',
        'hr_attendance_audit_immutable', 'hr_leave_audit_immutable')`
  )
  assert.equal(triggers.rows[0].count, 4)
})

test('employee, attendance, leave approval and balance changes remain tenant-scoped', async () => {
  const employee = await lockClient.query('SELECT employee_number FROM hr_employees WHERE tenant_id = $1 AND id = $2', [ids.tenantA, ids.employeeA])
  assert.equal(employee.rows[0].employee_number, 'EMP-000001')
  await lockClient.query(
    `INSERT INTO hr_attendance (tenant_id, employee_id, attendance_date, clock_in, clock_out, attendance_status, created_by, updated_by)
     VALUES ($1, $2, '2026-11-03', '08:00', '18:00', 'present', $3, $3)`,
    [ids.tenantA, ids.employeeA, ids.userA]
  )
  const attendance = await lockClient.query('SELECT working_minutes, overtime_minutes FROM hr_attendance WHERE tenant_id = $1 AND employee_id = $2', [ids.tenantA, ids.employeeA])
  assert.deepEqual(attendance.rows[0], { working_minutes: 600, overtime_minutes: 120 })
  const leaveType = await lockClient.query('SELECT id FROM hr_leave_types WHERE tenant_id = $1 AND code = $2', [ids.tenantA, 'annual'])
  const balance = await lockClient.query(
    `INSERT INTO hr_leave_balances (tenant_id, employee_id, leave_type_id, leave_year, entitled_days, created_by, updated_by)
     VALUES ($1, $2, $3, 2026, 20, $4, $4) RETURNING id`,
    [ids.tenantA, ids.employeeA, leaveType.rows[0].id, ids.userA]
  )
  const application = await lockClient.query(
    `INSERT INTO hr_leave_applications
     (tenant_id, employee_id, leave_type_id, start_date, end_date, working_days, reason, created_by, updated_by)
     VALUES ($1, $2, $3, '2026-12-01', '2026-12-02', 2, 'Rest', $4, $4) RETURNING id`,
    [ids.tenantA, ids.employeeA, leaveType.rows[0].id, ids.userA]
  )
  await lockClient.query('UPDATE hr_leave_applications SET status = $1, approved_by = $2, decision_at = CURRENT_TIMESTAMP WHERE tenant_id = $3 AND id = $4', ['approved', ids.userA, ids.tenantA, application.rows[0].id])
  await lockClient.query('UPDATE hr_leave_balances SET used_days = used_days + 2, updated_by = $1 WHERE tenant_id = $2 AND id = $3', [ids.userA, ids.tenantA, balance.rows[0].id])
  assert.equal((await lockClient.query('SELECT used_days FROM hr_leave_balances WHERE tenant_id = $1 AND id = $2', [ids.tenantA, balance.rows[0].id])).rows[0].used_days, '2.00')
  const isolated = await lockClient.query('SELECT id FROM hr_employees WHERE tenant_id = $1 AND id = $2', [ids.tenantB, ids.employeeA])
  assert.equal(isolated.rowCount, 0)
})

test('database constraints roll back invalid attendance without leaving a row', async () => {
  await lockClient.query('BEGIN')
  await assert.rejects(
    () => lockClient.query(
      `INSERT INTO hr_attendance
       (tenant_id, employee_id, attendance_date, clock_in, clock_out, attendance_status, created_by, updated_by)
       VALUES ($1, $2, '2026-11-04', '18:00', '08:00', 'present', $3, $3)`,
      [ids.tenantA, ids.employeeA, ids.userA]
    ),
    (error) => error.code === 'P0001' || error.code === '23514'
  )
  await lockClient.query('ROLLBACK')
  const result = await lockClient.query(
    `SELECT count(*)::integer AS count FROM hr_attendance
     WHERE tenant_id = $1 AND employee_id = $2 AND attendance_date = '2026-11-04'`,
    [ids.tenantA, ids.employeeA]
  )
  assert.equal(result.rows[0].count, 0)
})

test('payroll calculation, approval, statutory obligation and cross-tenant FK protection work', async () => {
  await calculateRun(lockClient, ids.tenantA, ids.runA, ids.userA)
  const item = await lockClient.query('SELECT gross_pay, employee_deductions, net_pay, component_snapshot FROM hr_payroll_items WHERE tenant_id = $1 AND payroll_run_id = $2', [ids.tenantA, ids.runA])
  assert.equal(item.rows[0].gross_pay, '100000.000000')
  assert.equal(item.rows[0].employee_deductions, '6000.000000')
  assert.equal(item.rows[0].net_pay, '94000.000000')
  const approved = await approveRun(pool, { tenantId: ids.tenantA, userId: ids.userA, runId: ids.runA, idempotencyKey: `${RUN_MARKER}_approve` })
  assert.equal(approved.run.status, 'approved')
  const obligation = await lockClient.query('SELECT authority, employee_amount, employer_amount FROM hr_payroll_statutory_obligations WHERE tenant_id = $1 AND payroll_run_id = $2', [ids.tenantA, ids.runA])
  assert.deepEqual(obligation.rows[0], { authority: 'NSSF', employee_amount: '6000.000000', employer_amount: '6000.000000' })
  await assert.rejects(
    () => lockClient.query(`INSERT INTO hr_employee_compensation (tenant_id, employee_id, effective_from, pay_frequency, basic_salary, currency, created_by)
      VALUES ($1, $2, '2026-01-01', 'monthly', 1, 'KES', $3)`, [ids.tenantA, ids.employeeB, ids.userA]),
    (error) => error.code === '23503'
  )
})

test.after(async () => {
  try {
    if (lockClient) {
      await lockClient.query('ROLLBACK').catch(() => {})
      await cleanupOwnedObjects(lockClient)
    }
  } finally {
    if (lockClient) lockClient.release()
    await pool.end()
  }
})

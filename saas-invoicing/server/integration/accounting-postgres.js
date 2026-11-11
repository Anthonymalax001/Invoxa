// Explicitly invoked integration suite. It is intentionally outside test/ so
// the ordinary mocked `node --test` suite never opens a database connection.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { Pool } = require('pg')
const { v4: uuid } = require('uuid')
const { postJournal, reverseJournal } = require('../src/services/accounting')

const CONFIRMATION = 'I_CONFIRM_THIS_IS_DISPOSABLE'
const DATABASE_COMMENT = 'INVOXA_DISPOSABLE_ACCOUNTING_TEST'
const TEST_DATABASE_URL = process.env.ACCOUNTING_TEST_DATABASE_URL

if (!TEST_DATABASE_URL) {
  throw new Error('ACCOUNTING_TEST_DATABASE_URL is required; this harness never falls back to DATABASE_URL.')
}
if (process.env.ACCOUNTING_TEST_DATABASE_CONFIRMATION !== CONFIRMATION) {
  throw new Error(`Set ACCOUNTING_TEST_DATABASE_CONFIRMATION=${CONFIRMATION} only for a disposable test database.`)
}

let targetDatabaseName
let targetRoleName
let parsedTestUrl
try {
  parsedTestUrl = new URL(TEST_DATABASE_URL)
} catch {
  throw new Error('ACCOUNTING_TEST_DATABASE_URL must be a valid PostgreSQL URL. The URL is not displayed.')
}
if (!['postgres:', 'postgresql:'].includes(parsedTestUrl.protocol) || !parsedTestUrl.hostname || !parsedTestUrl.username) {
  throw new Error('ACCOUNTING_TEST_DATABASE_URL must contain a PostgreSQL scheme, hostname and username. The URL is not displayed.')
}
if (!parsedTestUrl.password) {
  throw new Error('The dedicated PostgreSQL URL has no password; use the secure local launcher. The URL is not displayed.')
}
targetDatabaseName = decodeURIComponent(parsedTestUrl.pathname.replace(/^\/+/, ''))
targetRoleName = decodeURIComponent(parsedTestUrl.username)

if (!/^invoxa_accounting_test_[a-z0-9_]+$/i.test(targetDatabaseName)) {
  throw new Error('The test database name must begin with invoxa_accounting_test_. No connection was attempted.')
}

const pool = new Pool({
  connectionString: TEST_DATABASE_URL,
  max: 4,
  connectionTimeoutMillis: 5000,
  application_name: 'invoxa-accounting-integration-tests'
})

const migrationSql = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '20261021_001_accounting_foundation.sql'),
  'utf8'
)
const invoiceConfigurationMigrationSql = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '20261022_001_invoice_accounting_configuration.sql'),
  'utf8'
)

const ids = {
  tenantA: uuid(),
  tenantB: uuid(),
  user: uuid(),
  openPeriodA: uuid(),
  closedPeriodA: uuid(),
  periodB: uuid(),
  accountDebitA: uuid(),
  accountCreditA: uuid(),
  accountInactiveA: uuid(),
  accountDebitB: uuid(),
  accountCreditB: uuid(),
  invoiceReceivablesA: uuid(),
  invoiceRevenueA: uuid(),
  invoiceTaxPayableA: uuid()
}

let databaseConfirmedDisposable = false
let baselineCreated = false
let migrationApplied = false
let lockClient

function assertSqlState(expected) {
  return (error) => {
    assert.equal(error && error.code, expected)
    return true
  }
}

function safeErrorDescription(error) {
  const name = error && typeof error.name === 'string' ? error.name : 'Error'
  const code = error && typeof error.code === 'string' ? ` [${error.code}]` : ''
  let message = error && typeof error.message === 'string' ? error.message : 'Unknown failure'
  if (TEST_DATABASE_URL) message = message.split(TEST_DATABASE_URL).join('[test connection URL redacted]')
  message = message.replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[PostgreSQL connection URL redacted]')
  message = message.replace(/((?:password|passfile|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
  return `${name}${code}: ${message}`
}

function safeIdentifier(value) {
  if (typeof value !== 'string') return '<missing>'
  return value.replace(/[^A-Za-z0-9_.-]/g, '?').slice(0, 64)
}

async function inspectEmptyTarget(client) {
  const identity = await client.query(
    `SELECT d.datname AS database_name,
            shobj_description(d.oid, 'pg_database') AS database_comment,
            current_user AS role_name,
            pg_is_in_recovery() AS in_recovery,
            current_setting('transaction_read_only') = 'on' AS read_only,
            r.rolsuper AS is_superuser,
            has_schema_privilege(current_user, 'public', 'USAGE') AS public_schema_usage,
            has_schema_privilege(current_user, 'public', 'CREATE') AS public_schema_create,
            to_regprocedure('uuid_generate_v4()') IS NOT NULL AS has_uuid_generator
     FROM pg_database d JOIN pg_roles r ON r.rolname = current_user
     WHERE d.datname = current_database()`
  )
  const target = identity.rows[0]
  const failedChecks = []
  if (!target) {
    failedChecks.push('identity_row_present=false')
  } else {
    if (target.database_name !== targetDatabaseName) {
      failedChecks.push(`database_name_mismatch(expected=${safeIdentifier(targetDatabaseName)}, actual=${safeIdentifier(target.database_name)})`)
    }
    if (target.role_name !== targetRoleName) {
      failedChecks.push(`role_name_mismatch(expected=${safeIdentifier(targetRoleName)}, actual=${safeIdentifier(target.role_name)})`)
    }
    if (target.database_comment !== DATABASE_COMMENT) {
      const commentLength = typeof target.database_comment === 'string' ? target.database_comment.length : 'null'
      failedChecks.push(`database_comment_mismatch(expected=${DATABASE_COMMENT}, matches=false, actual_length=${commentLength})`)
    }
    if (target.in_recovery !== false) {
      failedChecks.push(`database_in_recovery=${String(target.in_recovery)} (expected=false)`)
    }
    if (target.read_only !== false) {
      failedChecks.push(`transaction_read_only=${String(target.read_only)} (expected=false)`)
    }
    if (target.is_superuser !== false) {
      failedChecks.push(`role_is_superuser=${String(target.is_superuser)} (expected=false)`)
    }
    if (target.has_uuid_generator !== true) {
      failedChecks.push(`uuid_generate_v4_visible=${String(target.has_uuid_generator)} (expected=true)`)
    }
  }
  if (failedChecks.length > 0) {
    throw new Error(`Database verification failed: ${failedChecks.join('; ')}`)
  }
  if (!target.public_schema_usage || !target.public_schema_create) {
    throw new Error(`Schema privilege verification failed: public_usage=${String(target.public_schema_usage)} (expected=true); public_create=${String(target.public_schema_create)} (expected=true). No test objects were created.`)
  }

  const relations = await client.query(
    `SELECT count(*)::integer AS relation_count
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')`
  )
  if (relations.rows[0].relation_count !== 0) {
    throw new Error(`Disposable database must be empty: user_relation_count=${relations.rows[0].relation_count} (expected=0). No test objects were created.`)
  }
  databaseConfirmedDisposable = true
}

async function createMinimalTenantFixture(client) {
  await client.query(
    `CREATE TABLE public.tenants (
       id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
       name character varying(255) NOT NULL,
       email character varying(255),
       phone character varying(50)
     )`
  )
  baselineCreated = true
}

async function applyMigration(client) {
  try {
    await client.query(migrationSql)
    migrationApplied = true
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* migration transaction may already be closed */ }
    throw new Error(`Accounting migration application failed: ${safeErrorDescription(error)}`)
  }

  const objects = await client.query(
    `SELECT count(*)::integer AS object_count
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])`,
    [[
      'accounting_settings', 'accounting_periods', 'accounting_accounts',
      'accounting_posting_events', 'accounting_journal_entries', 'accounting_journal_lines'
    ]]
  )
  if (objects.rows[0].object_count !== 6) {
    throw new Error('Accounting migration did not create the complete expected table set.')
  }
}

async function applyInvoiceConfigurationMigration(client) {
  try {
    await client.query(invoiceConfigurationMigrationSql)
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* migration transaction may already be closed */ }
    throw new Error(`Invoice accounting configuration migration application failed: ${safeErrorDescription(error)}`)
  }

  const objects = await client.query(
    `SELECT count(*)::integer AS object_count
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])`,
    [['accounting_invoice_mappings', 'accounting_tax_profiles', 'accounting_invoice_tax_snapshots']]
  )
  if (objects.rows[0].object_count !== 3) {
    throw new Error('Invoice accounting configuration migration did not create the expected tables.')
  }
}

async function seedSyntheticFixtures(client) {
  await client.query(
    `INSERT INTO public.tenants (id, name, email, phone)
     VALUES ($1, 'Integration Tenant A', $3, NULL), ($2, 'Integration Tenant B', $4, NULL)`,
    [ids.tenantA, ids.tenantB, `accounting-it-${ids.tenantA}@example.invalid`, `accounting-it-${ids.tenantB}@example.invalid`]
  )

  for (const tenantId of [ids.tenantA, ids.tenantB]) {
    await client.query(
      `INSERT INTO public.accounting_settings (tenant_id, base_currency, created_by)
       VALUES ($1, 'KES', $2)`,
      [tenantId, ids.user]
    )
  }

  await client.query(
    `INSERT INTO public.accounting_periods (id, tenant_id, name, starts_on, ends_on, created_by)
     VALUES
       ($1, $2, 'Open test period', '2020-01-01', '2099-12-31', $3),
       ($4, $2, 'Closed test period', '1900-01-01', '1910-12-31', $3),
       ($5, $6, 'Tenant B period', '2020-01-01', '2099-12-31', $3)`,
    [ids.openPeriodA, ids.tenantA, ids.user, ids.closedPeriodA, ids.periodB, ids.tenantB]
  )
  await client.query(
    `UPDATE public.accounting_periods
     SET status = 'closed', closed_by = $1, closed_at = CURRENT_TIMESTAMP
     WHERE id = $2 AND tenant_id = $3`,
    [ids.user, ids.closedPeriodA, ids.tenantA]
  )

  const accounts = [
    [ids.accountDebitA, ids.tenantA, '1010', 'Debit A', true],
    [ids.accountCreditA, ids.tenantA, '2010', 'Credit A', true],
    [ids.accountInactiveA, ids.tenantA, '3010', 'Inactive A', false],
    [ids.accountDebitB, ids.tenantB, '1010', 'Debit B', true],
    [ids.accountCreditB, ids.tenantB, '2010', 'Credit B', true]
  ]
  for (const [accountId, tenantId, code, name, active] of accounts) {
    await client.query(
      `INSERT INTO public.accounting_accounts
         (id, tenant_id, account_code, name, account_type, normal_balance, is_active, created_by)
       VALUES ($1, $2, $3, $4, 'asset', 'debit', $5, $6)`,
      [accountId, tenantId, code, name, active, ids.user]
    )
  }

  const invoiceAccounts = [
    [ids.invoiceReceivablesA, ids.tenantA, '1100', 'Invoice receivables', 'asset', 'debit'],
    [ids.invoiceRevenueA, ids.tenantA, '4100', 'Invoice revenue', 'revenue', 'credit'],
    [ids.invoiceTaxPayableA, ids.tenantA, '2200', 'Invoice tax payable', 'liability', 'credit']
  ]
  for (const [accountId, tenantId, code, name, type, normalBalance] of invoiceAccounts) {
    await client.query(
      `INSERT INTO public.accounting_accounts
         (id, tenant_id, account_code, name, account_type, normal_balance, is_active, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, true, $7)`,
      [accountId, tenantId, code, name, type, normalBalance, ids.user]
    )
  }
}

async function cleanDisposableDatabase() {
  if (!databaseConfirmedDisposable) return
  let client
  try {
    client = await pool.connect()
    const lineTable = await client.query(
      `SELECT to_regclass('public.accounting_journal_lines') IS NOT NULL AS table_exists`
    )
    if (lineTable.rows[0].table_exists) {
      await client.query('DROP TRIGGER IF EXISTS zz_accounting_it_fail_second_line ON public.accounting_journal_lines')
    }
    await client.query('DROP FUNCTION IF EXISTS public.accounting_it_fail_second_line()')

    await client.query('DROP TABLE IF EXISTS public.accounting_invoice_tax_snapshots CASCADE')
    await client.query('DROP TABLE IF EXISTS public.accounting_tax_profiles CASCADE')
    await client.query('DROP TABLE IF EXISTS public.accounting_invoice_mappings CASCADE')
    await client.query('DROP TABLE IF EXISTS public.accounting_journal_lines CASCADE')
    await client.query('DROP TABLE IF EXISTS public.accounting_journal_entries CASCADE')
    await client.query('DROP TABLE IF EXISTS public.accounting_posting_events CASCADE')
    await client.query('DROP TABLE IF EXISTS public.accounting_accounts CASCADE')
    await client.query('DROP TABLE IF EXISTS public.accounting_periods CASCADE')
    await client.query('DROP TABLE IF EXISTS public.accounting_settings CASCADE')

    const functions = [
      'accounting_guard_invoice_tax_snapshot_mutation',
      'accounting_guard_tax_profile_mutation',
      'accounting_assert_posted_journal_balanced',
      'accounting_guard_journal_line_mutation',
      'accounting_guard_journal_entry_mutation',
      'accounting_guard_period_mutation',
      'accounting_prevent_overlapping_periods',
      'accounting_assert_posting_event_completed',
      'accounting_guard_posting_event_mutation',
      'accounting_guard_settings_mutation'
    ]
    for (const name of functions) {
      await client.query(`DROP FUNCTION IF EXISTS public.${name}() CASCADE`)
    }
    if (baselineCreated) {
      await client.query('DROP TABLE IF EXISTS public.tenants')
      baselineCreated = false
    }
  } catch {
    throw new Error('Disposable database cleanup failed. Do not reuse this database; create a fresh test database.')
  } finally {
    if (client) client.release()
  }
}

test.before(async () => {
  try {
    lockClient = await pool.connect()
    await lockClient.query(
      `SELECT pg_advisory_lock(hashtext(current_database()), hashtext('invoxa-accounting-integration'))`
    )
    await inspectEmptyTarget(lockClient)
    await createMinimalTenantFixture(lockClient)
    await applyMigration(lockClient)
    await applyInvoiceConfigurationMigration(lockClient)
    await seedSyntheticFixtures(lockClient)
  } catch (error) {
    if (lockClient) {
      try { await lockClient.query('ROLLBACK') } catch { /* ignore aborted setup transaction */ }
    }
    throw new Error(`Integration setup refused or failed: ${safeErrorDescription(error)}`)
  }
})

test.after(async () => {
  let cleanupError
  try {
    await cleanDisposableDatabase()
  } catch (error) {
    cleanupError = error
  } finally {
    if (lockClient) {
      try {
        await lockClient.query(
          `SELECT pg_advisory_unlock(hashtext(current_database()), hashtext('invoxa-accounting-integration'))`
        )
      } catch { /* pool shutdown releases the session lock */ }
      lockClient.release()
      lockClient = undefined
    }
    await pool.end()
  }
  if (cleanupError) throw cleanupError
})

function payload(overrides = {}) {
  return {
    tenant_id: ids.tenantB,
    accounting_period_id: ids.openPeriodA,
    entry_date: '2026-06-15',
    description: 'Integration journal',
    source_type: 'integration_test',
    source_id: null,
    source_reference: `it-${uuid()}`,
    event_type: 'post',
    lines: [
      { account_id: ids.accountDebitA, debit: '15.250000', credit: '0' },
      { account_id: ids.accountCreditA, debit: '0.000000', credit: '15.25' }
    ],
    ...overrides
  }
}

function idempotencyKey() {
  return `it-${uuid()}`
}

async function post(body, key = idempotencyKey()) {
  return postJournal(pool, { tenantId: ids.tenantA, userId: ids.user, idempotencyKey: key, body })
}

function observeCallerOwnedClient(rawClient) {
  const calls = { transactionCommands: [], releaseCalls: 0 }
  const client = new Proxy(rawClient, {
    get(target, property) {
      if (property === 'query') {
        return (...args) => {
          const statement = typeof args[0] === 'string' ? args[0] : args[0] && args[0].text
          const transactionCommand = typeof statement === 'string' &&
            /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.exec(statement)
          if (transactionCommand) {
            calls.transactionCommands.push(transactionCommand[1].toUpperCase())
            throw new Error(`Accounting service attempted caller-owned transaction control: ${transactionCommand[1].toUpperCase()}`)
          }
          return target.query(...args)
        }
      }
      if (property === 'release') {
        return () => { calls.releaseCalls += 1 }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  return { client, calls }
}

async function createBusinessChangeTable(client) {
  await client.query(
    `CREATE TEMP TABLE accounting_it_business_changes (
       id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
       marker text NOT NULL
     ) ON COMMIT PRESERVE ROWS`
  )
}

async function releaseClientAfterTemporaryCleanup(client, tableNames = []) {
  try {
    for (const tableName of tableNames) {
      await client.query(`DROP TABLE IF EXISTS pg_temp.${tableName}`)
    }
  } finally {
    client.release()
  }
}

async function insertDraft(client, { periodId = ids.openPeriodA, debitAccount = ids.accountDebitA,
  creditAccount = ids.accountCreditA, key = idempotencyKey() } = {}) {
  const eventId = uuid()
  const journalId = uuid()
  await client.query(
    `INSERT INTO public.accounting_posting_events
       (id, tenant_id, idempotency_key, payload_hash, source_type, event_type, created_by)
     VALUES ($1, $2, $3, $4, 'integration_direct', 'post', $5)`,
    [eventId, ids.tenantA, key, 'a'.repeat(64), ids.user]
  )
  await client.query(
    `INSERT INTO public.accounting_journal_entries
       (id, tenant_id, accounting_period_id, entry_date, description,
        functional_currency, source_type, event_type, posting_event_id, created_by)
     VALUES ($1, $2, $3, '2026-06-15', 'Direct integrity fixture',
             'KES', 'integration_direct', 'post', $4, $5)`,
    [journalId, ids.tenantA, periodId, eventId, ids.user]
  )
  return { eventId, journalId, debitAccount, creditAccount }
}

test('applies migration and creates expected accounting tables, constraints and triggers', async () => {
  assert.equal(migrationApplied, true)
  const result = await pool.query(
    `SELECT count(*)::integer AS count
     FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal
       AND t.tgname LIKE 'accounting_%'`
  )
  assert.ok(result.rows[0].count >= 7)
})

test('invoice accounting configuration migration enforces tenant links and immutable tax versions', async () => {
  const objectResult = await pool.query(
    `SELECT count(*)::integer AS count FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [['accounting_invoice_mappings', 'accounting_tax_profiles', 'accounting_invoice_tax_snapshots']]
  )
  assert.equal(objectResult.rows[0].count, 3)

  await pool.query(
    `INSERT INTO public.accounting_invoice_mappings
       (tenant_id, receivables_account_id, sales_revenue_account_id, updated_by)
     VALUES ($1, $2, $3, $4)`,
    [ids.tenantA, ids.invoiceReceivablesA, ids.invoiceRevenueA, ids.user]
  )
  await assert.rejects(
    pool.query(
      `INSERT INTO public.accounting_invoice_mappings
         (tenant_id, receivables_account_id, sales_revenue_account_id, updated_by)
       VALUES ($1, $2, $3, $4)`,
      [ids.tenantB, ids.invoiceReceivablesA, ids.invoiceRevenueA, ids.user]
    ),
    assertSqlState('23503')
  )
  await assert.rejects(
    pool.query(
      `INSERT INTO public.accounting_invoice_mappings
         (tenant_id, receivables_account_id, sales_revenue_account_id, updated_by)
       VALUES ($1, $2, $2, $3)`,
      [ids.tenantB, ids.accountDebitB, ids.user]
    ),
    assertSqlState('23514')
  )

  const profileId = uuid()
  await pool.query(
    `INSERT INTO public.accounting_tax_profiles
       (id, tenant_id, profile_key, name, version, tax_rate, calculation_method,
        rounding_method, effective_from, requires_tax_payable,
        tax_payable_account_id, created_by)
     VALUES ($1, $2, 'integration-synthetic', 'Synthetic integration profile', 1,
             12.50, 'exclusive', 'invoice_total', '2026-01-01', true, $3, $4)`,
    [profileId, ids.tenantA, ids.invoiceTaxPayableA, ids.user]
  )
  await assert.rejects(
    pool.query('UPDATE public.accounting_tax_profiles SET tax_rate = 12.51 WHERE tenant_id = $1 AND id = $2', [ids.tenantA, profileId]),
    assertSqlState('55000')
  )

  const snapshotId = uuid()
  await pool.query(
    `INSERT INTO public.accounting_invoice_tax_snapshots
       (tenant_id, source_type, source_id, tax_profile_id, profile_version,
        profile_key, profile_name, tax_rate, calculation_method, rounding_method,
        requires_tax_payable, tax_payable_account_id, subtotal, tax_amount,
        total, created_by)
     VALUES ($1, 'invoice', $2, $3, 1, 'integration-synthetic',
             'Synthetic integration profile', 12.50, 'exclusive', 'invoice_total',
             true, $4, 100.00, 12.50, 112.50, $5)`,
    [ids.tenantA, snapshotId, profileId, ids.invoiceTaxPayableA, ids.user]
  )
  const snapshot = await pool.query(
    `SELECT subtotal, tax_amount, total FROM public.accounting_invoice_tax_snapshots
     WHERE tenant_id = $1 AND source_type = 'invoice' AND source_id = $2`,
    [ids.tenantA, snapshotId]
  )
  assert.deepEqual(snapshot.rows[0], { subtotal: '100.00', tax_amount: '12.50', total: '112.50' })
})

test('posts balanced journals using tenant accounts and numeric amounts', async () => {
  const key = idempotencyKey()
  const result = await post(payload(), key)
  assert.equal(result.journal.status, 'posted')
  assert.equal(result.journal.functional_currency, 'KES')
  const totals = await pool.query(
    `SELECT sum(debit) AS debit_total, sum(credit) AS credit_total
     FROM public.accounting_journal_lines
     WHERE tenant_id = $1 AND journal_entry_id = $2`,
    [ids.tenantA, result.journal.id]
  )
  assert.equal(totals.rows[0].debit_total, '15.250000')
  assert.equal(totals.rows[0].credit_total, '15.250000')
})

test('database deferred trigger rolls back an unbalanced posted journal', async () => {
  const client = await pool.connect()
  let inTransaction = false
  try {
    await client.query('BEGIN')
    inTransaction = true
    const fixture = await insertDraft(client)
    await client.query(
      `INSERT INTO public.accounting_journal_lines
         (tenant_id, journal_entry_id, line_number, account_id, debit, credit)
       VALUES ($1, $2, 1, $3, 10, 0), ($1, $2, 2, $4, 0, 9)`,
      [ids.tenantA, fixture.journalId, fixture.debitAccount, fixture.creditAccount]
    )
    await client.query(
      `UPDATE public.accounting_journal_entries
       SET status = 'posted', posted_by = $1, posted_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $2 AND id = $3`,
      [ids.user, ids.tenantA, fixture.journalId]
    )
    await client.query(
      `UPDATE public.accounting_posting_events
       SET status = 'posted', journal_entry_id = $1, completed_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $2 AND id = $3`,
      [fixture.journalId, ids.tenantA, fixture.eventId]
    )
    await assert.rejects(client.query('COMMIT'), assertSqlState('23514'))
    await client.query('ROLLBACK')
    inTransaction = false
    const check = await pool.query(
      'SELECT 1 FROM public.accounting_journal_entries WHERE id = $1', [fixture.journalId]
    )
    assert.equal(check.rowCount, 0)
  } finally {
    if (inTransaction) await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
})

test('database deferred trigger rejects a completed event linked to a draft journal', async () => {
  const client = await pool.connect()
  let inTransaction = false
  let fixture
  try {
    await client.query('BEGIN')
    inTransaction = true
    fixture = await insertDraft(client)
    await client.query(
      `UPDATE public.accounting_posting_events
       SET status = 'posted', journal_entry_id = $1, completed_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $2 AND id = $3`,
      [fixture.journalId, ids.tenantA, fixture.eventId]
    )
    await assert.rejects(client.query('COMMIT'), assertSqlState('23514'))
    await client.query('ROLLBACK')
    inTransaction = false
    const check = await pool.query(
      'SELECT 1 FROM public.accounting_posting_events WHERE id = $1', [fixture.eventId]
    )
    assert.equal(check.rowCount, 0)
  } finally {
    if (inTransaction) await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
})

test('composite tenant foreign keys reject an account from another tenant', async () => {
  const client = await pool.connect()
  let inTransaction = false
  try {
    await client.query('BEGIN')
    inTransaction = true
    const fixture = await insertDraft(client)
    await assert.rejects(
      client.query(
        `INSERT INTO public.accounting_journal_lines
           (tenant_id, journal_entry_id, line_number, account_id, debit, credit)
         VALUES ($1, $2, 1, $3, 1, 0)`,
        [ids.tenantA, fixture.journalId, ids.accountDebitB]
      ),
      assertSqlState('23503')
    )
    await client.query('ROLLBACK')
    inTransaction = false
  } finally {
    if (inTransaction) await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
})

test('service refuses a closed period and leaves no posting event', async () => {
  const key = idempotencyKey()
  await assert.rejects(
    post(payload({ accounting_period_id: ids.closedPeriodA }), key),
    (error) => error.statusCode === 409
  )
  const rows = await pool.query(
    'SELECT 1 FROM public.accounting_posting_events WHERE tenant_id = $1 AND idempotency_key = $2',
    [ids.tenantA, key]
  )
  assert.equal(rows.rowCount, 0)
})

test('accounting period dates cannot change after a journal is posted', async () => {
  const periodId = uuid()
  await pool.query(
    `INSERT INTO public.accounting_periods
       (id, tenant_id, name, starts_on, ends_on, created_by)
     VALUES ($1, $2, 'Period date immutability test', '2010-01-01', '2010-12-31', $3)`,
    [periodId, ids.tenantA, ids.user]
  )

  await pool.query(
    `UPDATE public.accounting_periods
     SET starts_on = '2011-01-01', ends_on = '2011-12-31'
     WHERE tenant_id = $1 AND id = $2`,
    [ids.tenantA, periodId]
  )
  const changedBeforePosting = await pool.query(
    `SELECT starts_on::text, ends_on::text
     FROM public.accounting_periods WHERE tenant_id = $1 AND id = $2`,
    [ids.tenantA, periodId]
  )
  assert.deepEqual(changedBeforePosting.rows[0], {
    starts_on: '2011-01-01',
    ends_on: '2011-12-31'
  })

  const posted = await post(payload({
    accounting_period_id: periodId,
    entry_date: '2011-06-15'
  }))
  assert.equal(posted.journal.status, 'posted')
  const journalInPeriod = await pool.query(
    `SELECT status, accounting_period_id::text
     FROM public.accounting_journal_entries WHERE tenant_id = $1 AND id = $2`,
    [ids.tenantA, posted.journal.id]
  )
  assert.deepEqual(journalInPeriod.rows[0], {
    status: 'posted',
    accounting_period_id: periodId
  })

  await assert.rejects(
    pool.query(
      `UPDATE public.accounting_periods
       SET starts_on = '2011-02-01', ends_on = '2011-12-31'
       WHERE tenant_id = $1 AND id = $2`,
      [ids.tenantA, periodId]
    ),
    assertSqlState('55000')
  )

  const unchangedAfterRejection = await pool.query(
    `SELECT starts_on::text, ends_on::text
     FROM public.accounting_periods WHERE tenant_id = $1 AND id = $2`,
    [ids.tenantA, periodId]
  )
  assert.deepEqual(unchangedAfterRejection.rows[0], {
    starts_on: '2011-01-01',
    ends_on: '2011-12-31'
  })
})

test('posted journal headers and lines reject updates and deletes', async () => {
  const posted = await post(payload())
  await assert.rejects(
    pool.query('UPDATE public.accounting_journal_entries SET description = $1 WHERE id = $2', ['Changed', posted.journal.id]),
    assertSqlState('55000')
  )
  await assert.rejects(
    pool.query('UPDATE public.accounting_journal_lines SET description = $1 WHERE journal_entry_id = $2', ['Changed', posted.journal.id]),
    assertSqlState('55000')
  )
  await assert.rejects(
    pool.query('DELETE FROM public.accounting_journal_lines WHERE journal_entry_id = $1', [posted.journal.id]),
    assertSqlState('55000')
  )
})

test('reversal creates a linked opposite entry and prevents a second reversal', async () => {
  const original = await post(payload())
  const reversal = await reverseJournal(pool, {
    tenantId: ids.tenantA,
    userId: ids.user,
    journalId: original.journal.id,
    idempotencyKey: idempotencyKey(),
    reversalDate: '2026-06-20',
    periodId: ids.openPeriodA,
    reason: 'Integration correction'
  })
  assert.equal(reversal.journal.reversal_of_entry_id, original.journal.id)
  assert.equal(reversal.journal.reversal_reason, 'Integration correction')
  assert.equal(reversal.lines[0].debit, '0.000000')
  assert.equal(reversal.lines[0].credit, '15.250000')
  await assert.rejects(reverseJournal(pool, {
    tenantId: ids.tenantA,
    userId: ids.user,
    journalId: original.journal.id,
    idempotencyKey: idempotencyKey(),
    reversalDate: '2026-06-20',
    periodId: ids.openPeriodA,
    reason: 'Second correction'
  }), (error) => error.statusCode === 409)
})

test('concurrent identical posting requests create one journal and replay the result', async () => {
  const key = idempotencyKey()
  const body = payload()
  const [first, second] = await Promise.all([post(body, key), post(body, key)])
  assert.equal(first.journal.id, second.journal.id)
  assert.equal([first, second].filter((item) => item.replayed).length, 1)
  const count = await pool.query(
    `SELECT count(*)::integer AS count
     FROM public.accounting_posting_events WHERE tenant_id = $1 AND idempotency_key = $2`,
    [ids.tenantA, key]
  )
  assert.equal(count.rows[0].count, 1)
})

test('same-key retries return the journal and changed payloads conflict', async () => {
  const key = idempotencyKey()
  const originalBody = payload()
  const first = await post(originalBody, key)
  const retry = await post(originalBody, key)
  assert.equal(retry.journal.id, first.journal.id)
  assert.equal(retry.replayed, true)
  await assert.rejects(
    post(payload({ description: 'Different payload' }), key),
    (error) => error.statusCode === 409
  )
})

test('caller-owned transaction commits the journal, posting event and representative business change together', async () => {
  const key = idempotencyKey()
  const rawClient = await pool.connect()
  let inTransaction = false
  try {
    await createBusinessChangeTable(rawClient)
    await rawClient.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    inTransaction = true
    await rawClient.query(
      'INSERT INTO accounting_it_business_changes (marker) VALUES ($1)',
      [`business-${key}`]
    )

    const { client, calls } = observeCallerOwnedClient(rawClient)
    const result = await postJournal(pool, {
      tenantId: ids.tenantA, userId: ids.user, idempotencyKey: key, body: payload()
    }, { client })
    assert.equal(result.replayed, false)
    assert.deepEqual(calls, { transactionCommands: [], releaseCalls: 0 })

    await rawClient.query('COMMIT')
    inTransaction = false

    const business = await rawClient.query(
      'SELECT marker FROM accounting_it_business_changes WHERE marker = $1',
      [`business-${key}`]
    )
    assert.equal(business.rowCount, 1)
    const persisted = await pool.query(
      `SELECT e.status AS event_status, e.journal_entry_id,
              j.status AS journal_status
       FROM public.accounting_posting_events e
       JOIN public.accounting_journal_entries j
         ON j.tenant_id = e.tenant_id AND j.id = e.journal_entry_id
       WHERE e.tenant_id = $1 AND e.idempotency_key = $2`,
      [ids.tenantA, key]
    )
    assert.equal(persisted.rowCount, 1)
    assert.equal(persisted.rows[0].event_status, 'posted')
    assert.equal(persisted.rows[0].journal_status, 'posted')
    assert.equal(persisted.rows[0].journal_entry_id, result.journal.id)
  } finally {
    if (inTransaction) await rawClient.query('ROLLBACK').catch(() => {})
    await releaseClientAfterTemporaryCleanup(rawClient, ['accounting_it_business_changes'])
  }
})

test('caller-owned posting failure leaves business and accounting rollback to the caller', async () => {
  const key = idempotencyKey()
  const rawClient = await pool.connect()
  let inTransaction = false
  let functionCreated = false
  let triggerCreated = false
  try {
    await pool.query(
      `CREATE FUNCTION public.accounting_it_fail_second_line()
       RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.line_number = 2 THEN
           RAISE EXCEPTION 'injected caller-owned integration failure' USING ERRCODE = 'P0001';
         END IF;
         RETURN NEW;
       END;
       $$`
    )
    functionCreated = true
    await pool.query(
      `CREATE TRIGGER zz_accounting_it_fail_second_line
       BEFORE INSERT ON public.accounting_journal_lines
       FOR EACH ROW EXECUTE FUNCTION public.accounting_it_fail_second_line()`
    )
    triggerCreated = true

    await createBusinessChangeTable(rawClient)
    await rawClient.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    inTransaction = true
    await rawClient.query(
      'INSERT INTO accounting_it_business_changes (marker) VALUES ($1)',
      [`business-${key}`]
    )

    const { client, calls } = observeCallerOwnedClient(rawClient)
    await assert.rejects(postJournal(pool, {
      tenantId: ids.tenantA, userId: ids.user, idempotencyKey: key, body: payload()
    }, { client }), assertSqlState('P0001'))
    assert.deepEqual(calls, { transactionCommands: [], releaseCalls: 0 })

    await rawClient.query('ROLLBACK')
    inTransaction = false
    const business = await rawClient.query(
      'SELECT marker FROM accounting_it_business_changes WHERE marker = $1',
      [`business-${key}`]
    )
    assert.equal(business.rowCount, 0)
  } finally {
    if (inTransaction) await rawClient.query('ROLLBACK').catch(() => {})
    await releaseClientAfterTemporaryCleanup(rawClient, ['accounting_it_business_changes'])
    if (triggerCreated) {
      await pool.query('DROP TRIGGER IF EXISTS zz_accounting_it_fail_second_line ON public.accounting_journal_lines')
    }
    if (functionCreated) await pool.query('DROP FUNCTION IF EXISTS public.accounting_it_fail_second_line()')
  }

  const event = await pool.query(
    'SELECT 1 FROM public.accounting_posting_events WHERE tenant_id = $1 AND idempotency_key = $2',
    [ids.tenantA, key]
  )
  const journal = await pool.query(
    `SELECT 1 FROM public.accounting_journal_entries j
     JOIN public.accounting_posting_events e
       ON e.tenant_id = j.tenant_id AND e.id = j.posting_event_id
     WHERE e.tenant_id = $1 AND e.idempotency_key = $2`,
    [ids.tenantA, key]
  )
  assert.equal(event.rowCount, 0)
  assert.equal(journal.rowCount, 0)
})

test('caller-owned mode issues no transaction control and does not release the client', async () => {
  const key = idempotencyKey()
  const rawClient = await pool.connect()
  let inTransaction = false
  try {
    await rawClient.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    inTransaction = true
    const { client, calls } = observeCallerOwnedClient(rawClient)
    const result = await postJournal(pool, {
      tenantId: ids.tenantA, userId: ids.user, idempotencyKey: key, body: payload()
    }, { client })
    assert.equal(result.journal.status, 'posted')
    assert.deepEqual(calls, { transactionCommands: [], releaseCalls: 0 })

    const transaction = await rawClient.query('SELECT txid_current_if_assigned() IS NOT NULL AS active')
    assert.equal(transaction.rows[0].active, true)

    await rawClient.query('ROLLBACK')
    inTransaction = false
  } finally {
    if (inTransaction) await rawClient.query('ROLLBACK').catch(() => {})
    await rawClient.release()
  }

  const event = await pool.query(
    'SELECT 1 FROM public.accounting_posting_events WHERE tenant_id = $1 AND idempotency_key = $2',
    [ids.tenantA, key]
  )
  assert.equal(event.rowCount, 0, 'caller rollback should undo the successful but uncommitted posting')
})

test('deferred business constraint fails at caller commit and caller can roll back journal posting', async () => {
  const key = idempotencyKey()
  const rawClient = await pool.connect()
  let inTransaction = false
  try {
    await rawClient.query(
      `CREATE TEMP TABLE accounting_it_business_parent (
         id uuid PRIMARY KEY
       ) ON COMMIT PRESERVE ROWS`
    )
    await rawClient.query(
      `CREATE TEMP TABLE accounting_it_deferred_business_change (
         parent_id uuid NOT NULL,
         CONSTRAINT accounting_it_deferred_business_fk
           FOREIGN KEY (parent_id) REFERENCES accounting_it_business_parent(id)
           DEFERRABLE INITIALLY DEFERRED
       ) ON COMMIT PRESERVE ROWS`
    )
    await rawClient.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    inTransaction = true
    await rawClient.query(
      'INSERT INTO accounting_it_deferred_business_change (parent_id) VALUES ($1)',
      [uuid()]
    )

    const { client, calls } = observeCallerOwnedClient(rawClient)
    const result = await postJournal(pool, {
      tenantId: ids.tenantA, userId: ids.user, idempotencyKey: key, body: payload()
    }, { client })
    assert.equal(result.journal.status, 'posted')
    assert.deepEqual(calls, { transactionCommands: [], releaseCalls: 0 })

    await assert.rejects(rawClient.query('COMMIT'), assertSqlState('23503'))
    await rawClient.query('ROLLBACK')
    inTransaction = false
    const business = await rawClient.query('SELECT count(*)::integer AS count FROM accounting_it_deferred_business_change')
    assert.equal(business.rows[0].count, 0)
  } finally {
    if (inTransaction) await rawClient.query('ROLLBACK').catch(() => {})
    await releaseClientAfterTemporaryCleanup(rawClient, [
      'accounting_it_deferred_business_change',
      'accounting_it_business_parent'
    ])
  }

  const event = await pool.query(
    'SELECT 1 FROM public.accounting_posting_events WHERE tenant_id = $1 AND idempotency_key = $2',
    [ids.tenantA, key]
  )
  const journal = await pool.query(
    `SELECT 1 FROM public.accounting_journal_entries j
     JOIN public.accounting_posting_events e
       ON e.tenant_id = j.tenant_id AND e.id = j.posting_event_id
     WHERE e.tenant_id = $1 AND e.idempotency_key = $2`,
    [ids.tenantA, key]
  )
  assert.equal(event.rowCount, 0)
  assert.equal(journal.rowCount, 0)
})

test('a database failure after the first line rolls back event, journal and lines', async () => {
  const key = idempotencyKey()
  await pool.query(
    `CREATE FUNCTION public.accounting_it_fail_second_line()
     RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       IF NEW.line_number = 2 THEN
         RAISE EXCEPTION 'injected integration failure' USING ERRCODE = 'P0001';
       END IF;
       RETURN NEW;
     END;
     $$`
  )
  await pool.query(
    `CREATE TRIGGER zz_accounting_it_fail_second_line
     BEFORE INSERT ON public.accounting_journal_lines
     FOR EACH ROW EXECUTE FUNCTION public.accounting_it_fail_second_line()`
  )
  try {
    await assert.rejects(post(payload(), key), assertSqlState('P0001'))
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS zz_accounting_it_fail_second_line ON public.accounting_journal_lines')
    await pool.query('DROP FUNCTION IF EXISTS public.accounting_it_fail_second_line()')
  }

  const events = await pool.query(
    'SELECT 1 FROM public.accounting_posting_events WHERE tenant_id = $1 AND idempotency_key = $2',
    [ids.tenantA, key]
  )
  assert.equal(events.rowCount, 0)
  const journals = await pool.query(
    `SELECT 1 FROM public.accounting_journal_entries j
     JOIN public.accounting_posting_events e
       ON e.tenant_id = j.tenant_id AND e.id = j.posting_event_id
     WHERE e.tenant_id = $1 AND e.idempotency_key = $2`,
    [ids.tenantA, key]
  )
  assert.equal(journals.rowCount, 0)
})

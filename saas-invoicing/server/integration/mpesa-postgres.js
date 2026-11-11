// Explicitly invoked PostgreSQL integration suite. This file is outside test/
// so `npm test` never opens a database connection.
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { Pool } = require('pg')
const { createCustomerReceipt, verifyCustomerReceipt, allocateCustomerReceipt } = require('../src/services/customerReceipts')
const { initiateMpesaStkRequest } = require('../src/services/mpesaStkInitiation')
const { reconcileMpesaPayment } = require('../src/services/mpesaReconciliation')
const { reverseCustomerReceipt } = require('../src/services/customerReceipts')
const { postJournal } = require('../src/services/accounting')

const EXPECTED_DATABASE = 'invoxa_mpesa_test_local'
const EXPECTED_ROLE = 'invoxa_mpesa_test_role'
const DATABASE_COMMENT = 'INVOXA_DISPOSABLE_MPESA_TEST'
const CONFIRMATION = 'I_CONFIRM_THIS_IS_A_DISPOSABLE_MPESA_TEST_DATABASE'
const APPLICATION_NAME = 'invoxa-mpesa-postgres-integration-tests'
const RUN_OBJECT_MARKER = `INVOXA_MPESA_IT_RUN_${crypto.randomUUID().replaceAll('-', '')}`
const TEST_DATABASE_URL = process.env.MPESA_TEST_DATABASE_URL
const ACTIVE_RESERVATION_STATES = [
  'reserved', 'outcome_unknown', 'provider_accepted', 'reference_recovered',
  'payment_recorded', 'provider_succeeded'
]

function parseExplicitTarget() {
  if (typeof TEST_DATABASE_URL !== 'string' || TEST_DATABASE_URL.length === 0) {
    throw new Error('MPESA_TEST_DATABASE_URL is required; this harness never falls back to DATABASE_URL.')
  }
  if (process.env.MPESA_TEST_DATABASE_CONFIRMATION !== CONFIRMATION) {
    throw new Error(`Set MPESA_TEST_DATABASE_CONFIRMATION=${CONFIRMATION} only for the approved disposable test database.`)
  }

  const ambientDatabaseVariables = Object.keys(process.env)
    .filter((name) => name.toUpperCase() === 'DATABASE_URL' || /^PG[A-Z0-9_]*$/i.test(name))
  if (ambientDatabaseVariables.length > 0) {
    throw new Error(`Clear ambient database settings before running this harness: ${ambientDatabaseVariables.join(', ')}. No connection was attempted.`)
  }

  let parsed
  try {
    parsed = new URL(TEST_DATABASE_URL)
  } catch {
    throw new Error('MPESA_TEST_DATABASE_URL is invalid. The URL is never displayed.')
  }
  let databaseName
  let roleName
  try {
    databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))
    roleName = decodeURIComponent(parsed.username)
    decodeURIComponent(parsed.password)
  } catch {
    throw new Error('MPESA_TEST_DATABASE_URL has invalid URL encoding. The URL is never displayed.')
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) ||
      parsed.hostname !== '127.0.0.1' || parsed.port !== '5432' ||
      databaseName !== EXPECTED_DATABASE || roleName !== EXPECTED_ROLE ||
      !parsed.password || parsed.search || parsed.hash) {
    throw new Error(`The explicit URL must target ${EXPECTED_ROLE}@127.0.0.1:5432/${EXPECTED_DATABASE}, with no query or fragment. No connection was attempted.`)
  }
  return {
    host: '127.0.0.1',
    port: 5432,
    database: EXPECTED_DATABASE,
    user: EXPECTED_ROLE,
    password: decodeURIComponent(parsed.password)
  }
}

// This exact loopback URL contract prevents remote/Neon hosts, and this
// harness never loads dotenv or the application's database configuration.
const target = parseExplicitTarget()
const pool = new Pool({
  ...target,
  ssl: false,
  max: 12,
  connectionTimeoutMillis: 5000,
  application_name: APPLICATION_NAME,
  options: '-c statement_timeout=15000 -c lock_timeout=5000 -c search_path=public,pg_catalog'
})
const fixtureSql = fs.readFileSync(path.join(__dirname, 'invoice-fixture-schema.sql'), 'utf8')
const paymentFixtureSql = fs.readFileSync(path.join(__dirname, 'mpesa-payments-fixture.sql'), 'utf8')
const fixtureTables = ['tenants', 'users', 'clients', 'invoices', 'invoice_items', 'payments']
const migrationNames = [
  '20261021_001_accounting_foundation.sql',
  '20261022_001_invoice_accounting_configuration.sql',
  '20261023_001_customer_receipts.sql',
  '20261030_002_accounting_period_close_audit.sql',
  '20261030_003_mpesa_reconciliation_audit.sql',
  '20261031_002_mpesa_stk_initiation_idempotency.sql',
  '20261031_003_mpesa_stk_invoice_reservations.sql'
]
const migrationObjects = {
  '20261021_001_accounting_foundation.sql': {
    tables: ['accounting_settings', 'accounting_periods', 'accounting_accounts', 'accounting_posting_events', 'accounting_journal_entries', 'accounting_journal_lines'],
    functions: ['accounting_guard_posting_event_mutation', 'accounting_assert_posting_event_completed', 'accounting_guard_settings_mutation', 'accounting_prevent_overlapping_periods', 'accounting_guard_period_mutation', 'accounting_guard_journal_entry_mutation', 'accounting_guard_journal_line_mutation', 'accounting_assert_posted_journal_balanced']
  },
  '20261022_001_invoice_accounting_configuration.sql': {
    tables: ['accounting_invoice_mappings', 'accounting_tax_profiles', 'accounting_invoice_tax_snapshots'],
    functions: ['accounting_guard_tax_profile_mutation', 'accounting_guard_invoice_tax_snapshot_mutation']
  },
  '20261023_001_customer_receipts.sql': {
    tables: ['customer_receipts', 'customer_receipt_events', 'customer_receipt_allocation_batches', 'customer_receipt_allocations'],
    functions: ['customer_receipt_allocation_batches_immutable', 'customer_receipts_guard_mutation', 'customer_receipt_events_immutable', 'customer_receipt_allocations_guard_insert', 'customer_receipt_allocations_immutable']
  },
  '20261030_002_accounting_period_close_audit.sql': {
    tables: ['accounting_period_events'],
    functions: ['accounting_period_events_immutable']
  },
  '20261030_003_mpesa_reconciliation_audit.sql': {
    tables: ['mpesa_payment_reconciliation_audit'],
    functions: ['mpesa_payment_reconciliation_audit_guard_mutation']
  },
  '20261031_002_mpesa_stk_initiation_idempotency.sql': {
    tables: ['mpesa_stk_initiation_requests', 'mpesa_stk_initiation_events'],
    functions: ['mpesa_stk_initiation_events_guard_mutation']
  },
  '20261031_003_mpesa_stk_invoice_reservations.sql': { tables: [], functions: [] }
}
const migrations = migrationNames.map((name) => ({
  name,
  objects: migrationObjects[name],
  sql: fs.readFileSync(path.join(__dirname, '..', 'migrations', name), 'utf8')
}))

const cleanupTables = [
  'mpesa_payment_reconciliation_audit',
  'mpesa_stk_initiation_events',
  'mpesa_stk_initiation_requests',
  'customer_receipt_allocations',
  'customer_receipt_allocation_batches',
  'customer_receipt_events',
  'customer_receipts',
  'accounting_period_events',
  'accounting_invoice_tax_snapshots',
  'accounting_tax_profiles',
  'accounting_invoice_mappings',
  'accounting_journal_lines',
  'accounting_journal_entries',
  'accounting_posting_events',
  'accounting_accounts',
  'accounting_periods',
  'accounting_settings',
  'payments',
  'invoice_items',
  'invoices',
  'clients',
  'users',
  'tenants'
]
const cleanupFunctions = [
  'accounting_guard_posting_event_mutation',
  'accounting_guard_settings_mutation',
  'accounting_assert_posting_event_completed',
  'accounting_prevent_overlapping_periods',
  'accounting_guard_period_mutation',
  'accounting_guard_journal_entry_mutation',
  'accounting_guard_journal_line_mutation',
  'accounting_assert_posted_journal_balanced',
  'accounting_guard_tax_profile_mutation',
  'accounting_guard_invoice_tax_snapshot_mutation',
  'customer_receipt_allocation_batches_immutable',
  'customer_receipts_guard_mutation',
  'customer_receipt_events_immutable',
  'customer_receipt_allocations_guard_insert',
  'customer_receipt_allocations_immutable',
  'accounting_period_events_immutable',
  'mpesa_payment_reconciliation_audit_guard_mutation',
  'mpesa_stk_initiation_events_guard_mutation',
  'mpesa_it_fail_reserved_event'
]

let disposableTargetVerified = false
let objectsMayExist = false
let lockClient
let advisoryLockHeld = false
let fixtureIds

function assertSqlState(expected) {
  return (error) => {
    assert.equal(error && error.code, expected)
    return true
  }
}

function safeError(error) {
  let message = error && typeof error.message === 'string' ? error.message : 'Unknown failure'
  if (TEST_DATABASE_URL) message = message.split(TEST_DATABASE_URL).join('[test connection URL redacted]')
  message = message.replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[PostgreSQL connection URL redacted]')
  message = message.replace(/((?:password|passfile|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
  const code = error && typeof error.code === 'string' ? ` [${error.code}]` : ''
  return `${error && error.name ? error.name : 'Error'}${code}: ${message}`
}

function runMarkerStatements(objects) {
  const statements = []
  for (const tableName of objects.tables) {
    statements.push(`COMMENT ON TABLE public.${tableName} IS '${RUN_OBJECT_MARKER}';`)
  }
  for (const functionName of objects.functions) {
    statements.push(`COMMENT ON FUNCTION public.${functionName}() IS '${RUN_OBJECT_MARKER}';`)
  }
  return statements.join('\n')
}

function includeRunMarkersInMigration(sql, objects) {
  const statements = runMarkerStatements(objects)
  if (!statements) return sql
  if (!/\bCOMMIT;\s*$/i.test(sql)) {
    throw new Error('A migration with cleanup-owned objects must end in COMMIT; before it can be safely tagged.')
  }
  return sql.replace(/\bCOMMIT;\s*$/i, `${statements}\nCOMMIT;`)
}

async function commentFixtureTables(client) {
  for (const tableName of fixtureTables) {
    await client.query(`COMMENT ON TABLE public.${tableName} IS '${RUN_OBJECT_MARKER}'`)
  }
}

async function hasRunMarker(client, objectType, objectName) {
  if (objectType === 'table') {
    const result = await client.query(
      `SELECT obj_description(to_regclass($1), 'pg_class') = $2 AS marked`,
      [`public.${objectName}`, RUN_OBJECT_MARKER]
    )
    return result.rows[0]?.marked === true
  }
  const result = await client.query(
    `SELECT obj_description(to_regprocedure($1), 'pg_proc') = $2 AS marked`,
    [`public.${objectName}()`, RUN_OBJECT_MARKER]
  )
  return result.rows[0]?.marked === true
}

async function harnessObjectExists(client, objectType, objectName) {
  const lookup = objectType === 'table' ? 'to_regclass' : 'to_regprocedure'
  const signature = objectType === 'table' ? `public.${objectName}` : `public.${objectName}()`
  const result = await client.query(`SELECT ${lookup}($1) IS NOT NULL AS present`, [signature])
  return result.rows[0]?.present === true
}

async function verifyDatabaseIdentity(client) {
  const identity = await client.query(
    `SELECT d.datname AS database_name,
            shobj_description(d.oid, 'pg_database') AS database_comment,
            current_user AS role_name,
            inet_server_addr() = inet '127.0.0.1' AS server_is_approved_loopback,
            inet_server_port() = 5432 AS server_port_is_approved,
            current_setting('server_version_num')::integer >= 100000 AS has_required_pg_version,
            pg_is_in_recovery() AS in_recovery,
            current_setting('transaction_read_only') = 'on' AS read_only,
            d.datallowconn AS allows_connections,
            d.datdba = r.oid AS role_owns_database,
            r.rolsuper AS is_superuser,
            r.rolcreatedb AS can_create_database,
            r.rolcreaterole AS can_create_roles,
            r.rolreplication AS can_replicate,
            r.rolbypassrls AS bypasses_rls,
            has_database_privilege(current_user, current_database(), 'CONNECT') AS database_connect,
            has_database_privilege(current_user, current_database(), 'CREATE') AS database_create,
            has_database_privilege(current_user, current_database(), 'TEMP') AS database_temp,
            has_schema_privilege(current_user, 'public', 'USAGE') AS public_usage,
            has_schema_privilege(current_user, 'public', 'CREATE') AS public_create,
            (SELECT nspowner = r.oid FROM pg_namespace WHERE nspname = 'public') AS owns_public_schema,
            EXISTS (SELECT 1 FROM pg_extension e
                    JOIN pg_namespace n ON n.oid = e.extnamespace
                    WHERE e.extname = 'uuid-ossp' AND n.nspname = 'public') AS has_uuid_ossp,
            EXISTS (SELECT 1 FROM pg_extension e
                    WHERE e.extname = 'uuid-ossp' AND e.extowner = r.oid) AS owns_uuid_ossp,
            to_regprocedure('public.uuid_generate_v4()') IS NOT NULL AS has_uuid_generator,
            EXISTS (SELECT 1 FROM pg_proc p
                    WHERE p.oid = to_regprocedure('public.uuid_generate_v4()') AND p.proowner = r.oid) AS owns_uuid_generator,
            has_function_privilege(current_user, 'public.uuid_generate_v4()', 'EXECUTE') AS can_execute_uuid_generator,
            EXISTS (SELECT 1 FROM pg_language WHERE lanname = 'plpgsql' AND lanispl) AS has_plpgsql,
            EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) AS has_role_memberships
     FROM pg_database d JOIN pg_roles r ON r.rolname = current_user
     WHERE d.datname = current_database()`
  )
  const targetRow = identity.rows[0]
  const failures = []
  if (!targetRow) throw new Error('Database identity could not be verified.')
  if (targetRow.database_name !== EXPECTED_DATABASE) failures.push('database_name_mismatch')
  if (targetRow.role_name !== EXPECTED_ROLE) failures.push('role_name_mismatch')
  if (targetRow.server_is_approved_loopback !== true || targetRow.server_port_is_approved !== true) {
    failures.push('postgres_server_endpoint_mismatch')
  }
  if (targetRow.has_required_pg_version !== true) failures.push('postgres_10_or_newer_required')
  if (targetRow.database_comment !== DATABASE_COMMENT) failures.push('database_marker_mismatch')
  if (targetRow.in_recovery !== false) failures.push('database_is_in_recovery')
  if (targetRow.read_only !== false || targetRow.allows_connections !== true) failures.push('database_not_writable')
  if (targetRow.is_superuser || targetRow.can_create_database || targetRow.can_create_roles ||
      targetRow.can_replicate || targetRow.bypasses_rls || targetRow.role_owns_database ||
      targetRow.has_role_memberships || targetRow.database_create || targetRow.database_temp ||
      targetRow.owns_public_schema || targetRow.owns_uuid_ossp || targetRow.owns_uuid_generator) {
    failures.push('role_has_unneeded_privilege')
  }
  if (targetRow.database_connect !== true || targetRow.public_usage !== true || targetRow.public_create !== true) {
    failures.push('required_database_or_schema_privilege_missing')
  }
  if (targetRow.has_uuid_ossp !== true || targetRow.has_uuid_generator !== true ||
      targetRow.can_execute_uuid_generator !== true) failures.push('uuid_ossp_prerequisite_missing')
  if (targetRow.has_plpgsql !== true) failures.push('plpgsql_language_prerequisite_missing')
  if (failures.length > 0) throw new Error(`Database preflight failed: ${failures.join(', ')}. No test objects were created.`)
}

async function verifyEmptyTarget(client) {
  const schemas = await client.query(
    `SELECT count(*)::integer AS count
     FROM pg_namespace
     WHERE nspname <> 'public' AND nspname <> 'information_schema'
       AND nspname !~ '^pg_'`
  )
  const relations = await client.query(
    `SELECT count(*)::integer AS count
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_depend extension_member
       ON extension_member.classid = 'pg_class'::regclass
      AND extension_member.objid = c.oid
      AND extension_member.refclassid = 'pg_extension'::regclass
      AND extension_member.deptype = 'e'
     WHERE n.nspname = 'public' AND extension_member.objid IS NULL`
  )
  const routines = await client.query(
    `SELECT count(*)::integer AS count
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     LEFT JOIN pg_depend extension_member
       ON extension_member.classid = 'pg_proc'::regclass
      AND extension_member.objid = p.oid
      AND extension_member.refclassid = 'pg_extension'::regclass
      AND extension_member.deptype = 'e'
     WHERE n.nspname = 'public' AND extension_member.objid IS NULL`
  )
  const types = await client.query(
    `SELECT count(*)::integer AS count
     FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     LEFT JOIN pg_class relation_type ON relation_type.reltype = t.oid
     LEFT JOIN pg_depend extension_member
       ON extension_member.classid = 'pg_type'::regclass
      AND extension_member.objid = t.oid
      AND extension_member.refclassid = 'pg_extension'::regclass
      AND extension_member.deptype = 'e'
     WHERE n.nspname = 'public' AND relation_type.oid IS NULL
       AND NOT (t.typelem <> 0 AND t.typlen = -1 AND t.typcategory = 'A')
       AND extension_member.objid IS NULL`
  )
  const eventTriggers = await client.query(
    'SELECT count(*)::integer AS count FROM pg_event_trigger'
  )
  const unexpectedExtensions = await client.query(
    `SELECT count(*)::integer AS count FROM pg_extension
     WHERE extname NOT IN ('uuid-ossp', 'plpgsql')`
  )
  const counts = {
    extraSchemas: schemas.rows[0].count,
    relations: relations.rows[0].count,
    routines: routines.rows[0].count,
    types: types.rows[0].count,
    eventTriggers: eventTriggers.rows[0].count,
    unexpectedExtensions: unexpectedExtensions.rows[0].count
  }
  if (Object.values(counts).some((count) => count !== 0)) {
    throw new Error(`Disposable target must have an empty public schema and no extra user schemas (counts=${JSON.stringify(counts)}). No test objects were created.`)
  }
  disposableTargetVerified = true
}

async function preflightAndLock() {
  lockClient = await pool.connect()
  await verifyDatabaseIdentity(lockClient)
  await lockClient.query(
    `SELECT pg_advisory_lock(hashtextextended(current_database() || ':invoxa-mpesa-postgres-integration', 0))`
  )
  advisoryLockHeld = true
  // Check again only after serializing harness invocations; no DDL has run.
  await verifyEmptyTarget(lockClient)
}

async function applyFixtureAndMigrations() {
  objectsMayExist = true
  try {
    await lockClient.query('BEGIN')
    await lockClient.query(fixtureSql)
    await lockClient.query(paymentFixtureSql)
    await commentFixtureTables(lockClient)
    await lockClient.query('COMMIT')
  } catch (error) {
    await lockClient.query('ROLLBACK').catch(() => {})
    throw new Error(`Synthetic fixture creation failed: ${safeError(error)}`)
  }

  for (const migration of migrations) {
    try {
      await lockClient.query(includeRunMarkersInMigration(migration.sql, migration.objects))
    } catch (error) {
      await lockClient.query('ROLLBACK').catch(() => {})
      throw new Error(`${migration.name} application or run-marker setup failed: ${safeError(error)}`)
    }
  }
}

async function createTenantContext(name) {
  const tenantResult = await pool.query(
    'INSERT INTO public.tenants (name) VALUES ($1) RETURNING id', [name]
  )
  const tenantId = tenantResult.rows[0].id
  const userResult = await pool.query(
    `INSERT INTO public.users (tenant_id, name, email, password_hash, role)
     VALUES ($1, 'M-Pesa integration admin', $2, 'synthetic-only', 'admin') RETURNING id`,
    [tenantId, `mpesa-it-${crypto.randomUUID()}@example.invalid`]
  )
  const userId = userResult.rows[0].id
  await pool.query(
    'INSERT INTO public.accounting_settings (tenant_id, base_currency, created_by) VALUES ($1, $2, $3)',
    [tenantId, 'KES', userId]
  )
  const periodResult = await pool.query(
    `INSERT INTO public.accounting_periods
       (tenant_id, name, starts_on, ends_on, created_by)
     VALUES ($1, $2, '2020-01-01', '2099-12-31', $3) RETURNING id`,
    [tenantId, `M-Pesa IT ${crypto.randomUUID()}`, userId]
  )
  const periodId = periodResult.rows[0].id
  const accountIds = {}
  for (const [key, code, label, accountType, normalBalance] of [
    ['cash', '1000', 'Synthetic cash', 'asset', 'debit'],
    ['receivables', '1100', 'Synthetic receivables', 'asset', 'debit'],
    ['revenue', '4000', 'Synthetic revenue', 'revenue', 'credit']
  ]) {
    const result = await pool.query(
      `INSERT INTO public.accounting_accounts
         (tenant_id, account_code, name, account_type, normal_balance, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenantId, code, label, accountType, normalBalance, userId]
    )
    accountIds[key] = result.rows[0].id
  }
  await pool.query(
    `INSERT INTO public.accounting_invoice_mappings
       (tenant_id, receivables_account_id, sales_revenue_account_id, updated_by)
     VALUES ($1, $2, $3, $4)`,
    [tenantId, accountIds.receivables, accountIds.revenue, userId]
  )
  const profileResult = await pool.query(
    `INSERT INTO public.accounting_tax_profiles
       (tenant_id, profile_key, name, version, tax_rate, calculation_method,
        rounding_method, effective_from, requires_tax_payable, created_by)
     VALUES ($1, 'mpesa-it-zero-tax', 'Synthetic zero tax', 1, 0, 'exclusive',
             'invoice_total', '2020-01-01', false, $2)
     RETURNING id`,
    [tenantId, userId]
  )
  return {
    tenantId,
    userId,
    periodId,
    accountIds,
    taxProfileId: profileResult.rows[0].id
  }
}

async function createIssuedInvoice(context, label = 'invoice') {
  const clientResult = await pool.query(
    `INSERT INTO public.clients (tenant_id, name)
     VALUES ($1, $2) RETURNING id`,
    [context.tenantId, `Synthetic M-Pesa customer ${crypto.randomUUID()}`]
  )
  const invoiceNumber = `IT-${label}-${crypto.randomUUID().slice(0, 8)}`
  const invoiceResult = await pool.query(
    `INSERT INTO public.invoices
       (tenant_id, client_id, invoice_number, due_date, subtotal, tax_rate,
        tax_amount, total, status)
     VALUES ($1, $2, $3, '2099-12-31', 1000.00, 0, 0, 1000.00, 'sent')
     RETURNING id`,
    [context.tenantId, clientResult.rows[0].id, invoiceNumber]
  )
  const invoiceId = invoiceResult.rows[0].id
  const posting = await postJournal(pool, {
    tenantId: context.tenantId,
    userId: context.userId,
    idempotencyKey: `mpesa-it-invoice-${crypto.randomUUID()}`,
    body: {
      accounting_period_id: context.periodId,
      entry_date: '2026-10-15',
      description: `Synthetic issued invoice ${invoiceNumber}`,
      source_type: 'invoice',
      source_id: invoiceId,
      source_reference: invoiceNumber,
      event_type: 'issue',
      lines: [
        { account_id: context.accountIds.receivables, description: 'Synthetic receivable', debit: '1000.00', credit: '0.00' },
        { account_id: context.accountIds.revenue, description: 'Synthetic revenue', debit: '0.00', credit: '1000.00' }
      ]
    }
  })
  const snapshot = await pool.query(
    `INSERT INTO public.accounting_invoice_tax_snapshots
       (tenant_id, source_type, source_id, tax_profile_id, profile_version,
        profile_key, profile_name, tax_rate, calculation_method, rounding_method,
        requires_tax_payable, subtotal, tax_amount, total, created_by)
     VALUES ($1, 'invoice', $2, $3, 1, 'mpesa-it-zero-tax', 'Synthetic zero tax',
             0, 'exclusive', 'invoice_total', false, 1000.00, 0.00, 1000.00, $4)
     RETURNING id`,
    [context.tenantId, invoiceId, context.taxProfileId, context.userId]
  )
  await pool.query(
    `UPDATE public.accounting_invoice_tax_snapshots
     SET issued_on = '2026-10-15', issued_by = $1, issued_at = CURRENT_TIMESTAMP,
         journal_entry_id = $2
     WHERE tenant_id = $3 AND id = $4`,
    [context.userId, posting.journal.id, context.tenantId, snapshot.rows[0].id]
  )
  return {
    invoiceId,
    invoiceNumber,
    customerId: clientResult.rows[0].id,
    total: '1000.00'
  }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function testCheckoutId() {
  return `it_${crypto.randomUUID().replaceAll('-', '')}`
}

function acceptedProvider() {
  return async () => ({
    ResponseCode: '0',
    CheckoutRequestID: testCheckoutId(),
    MerchantRequestID: testCheckoutId()
  })
}

function initiate(context, invoice, {
  key = `mpesa-it-${crypto.randomUUID()}`,
  phoneNumber = '0712345678',
  provider = acceptedProvider()
} = {}) {
  return initiateMpesaStkRequest(pool, {
    tenantId: context.tenantId,
    userId: context.userId,
    idempotencyKey: key,
    invoiceId: invoice.invoiceId,
    phoneNumber,
    provider
  })
}

async function getRequest(tenantId, key) {
  const result = await pool.query(
    `SELECT * FROM public.mpesa_stk_initiation_requests
     WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenantId, key]
  )
  return result.rows[0] || null
}

async function waitForLockWaiters({ minimum, queryPattern }) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT count(*)::integer AS count
       FROM pg_stat_activity
       WHERE datname = current_database() AND usename = current_user
         AND application_name = $1 AND pid <> pg_backend_pid()
         AND wait_event_type = 'Lock' AND query ILIKE $2`,
      [APPLICATION_NAME, queryPattern]
    )
    if (result.rows[0].count >= minimum) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${minimum} PostgreSQL lock waiter(s) matching ${queryPattern}.`)
}

async function seedHarness() {
  await preflightAndLock()
  await applyFixtureAndMigrations()
  const tenantA = await createTenantContext('Synthetic M-Pesa tenant A')
  const tenantB = await createTenantContext('Synthetic M-Pesa tenant B')
  fixtureIds = { tenantA, tenantB }
}

async function cleanupOwnObjects() {
  if (!disposableTargetVerified || !objectsMayExist || !lockClient || !advisoryLockHeld) return
  await lockClient.query('BEGIN')
  try {
    if (await hasRunMarker(lockClient, 'table', 'accounting_posting_events') &&
        await hasRunMarker(lockClient, 'table', 'accounting_journal_entries')) {
      await lockClient.query(
        'ALTER TABLE public.accounting_posting_events DROP CONSTRAINT IF EXISTS accounting_posting_events_journal_fk'
      )
      await lockClient.query(
        'ALTER TABLE public.accounting_journal_entries DROP CONSTRAINT IF EXISTS accounting_journal_entries_event_fk'
      )
    }
    for (const tableName of cleanupTables) {
      if (await hasRunMarker(lockClient, 'table', tableName)) {
        await lockClient.query(`DROP TABLE public.${tableName}`)
      }
    }
    for (const functionName of cleanupFunctions) {
      if (await hasRunMarker(lockClient, 'function', functionName)) {
        await lockClient.query(`DROP FUNCTION public.${functionName}()`)
      }
    }
    const remainingObjects = []
    for (const tableName of cleanupTables) {
      if (await harnessObjectExists(lockClient, 'table', tableName)) remainingObjects.push(`table:${tableName}`)
    }
    for (const functionName of cleanupFunctions) {
      if (await harnessObjectExists(lockClient, 'function', functionName)) remainingObjects.push(`function:${functionName}`)
    }
    if (remainingObjects.length > 0) {
      throw new Error(`Refusing to clean unmarked or remaining objects: ${remainingObjects.join(', ')}`)
    }
    await lockClient.query('COMMIT')
    objectsMayExist = false
  } catch (error) {
    await lockClient.query('ROLLBACK').catch(() => {})
    throw new Error(`Explicit integration cleanup failed: ${safeError(error)}`)
  }
}

test.before(async () => {
  try {
    await seedHarness()
  } catch (error) {
    throw new Error(safeError(error))
  }
})

test.after(async () => {
  let cleanupFailure
  try {
    await cleanupOwnObjects()
  } catch (error) {
    cleanupFailure = error
  }
  if (lockClient) {
    if (advisoryLockHeld) {
      try {
        await lockClient.query(
          `SELECT pg_advisory_unlock(hashtextextended(current_database() || ':invoxa-mpesa-postgres-integration', 0))`
        )
      } catch (error) {
        if (!cleanupFailure) cleanupFailure = error
      }
    }
    lockClient.release()
  }
  await pool.end()
  if (cleanupFailure) throw cleanupFailure
})

test('two different keys racing one invoice call the provider once and retain one reservation', async () => {
  const context = fixtureIds.tenantA
  const invoice = await createIssuedInvoice(context, 'different-keys')
  const keyA = `mpesa-it-${crypto.randomUUID()}`
  const keyB = `mpesa-it-${crypto.randomUUID()}`
  const entered = deferred()
  const release = deferred()
  let providerCalls = 0
  const provider = async () => {
    providerCalls += 1
    if (providerCalls === 1) {
      const committed = await getRequest(context.tenantId, keyA)
      assert.equal(committed && committed.request_status, 'reserved', 'reservation must commit before the provider double runs')
      entered.resolve()
      await release.promise
    }
    return { ResponseCode: '0', CheckoutRequestID: testCheckoutId(), MerchantRequestID: testCheckoutId() }
  }
  const first = initiate(context, invoice, { key: keyA, provider })
  await entered.promise
  const second = initiate(context, invoice, { key: keyB, provider })
  let waiterFailure
  try {
    await waitForLockWaiters({ minimum: 1, queryPattern: '%pg_advisory_lock%' })
  } catch (error) {
    waiterFailure = error
  } finally {
    release.resolve()
  }
  const results = await Promise.allSettled([first, second])
  assert.ifError(waiterFailure)
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1)
  const rejected = results.find((item) => item.status === 'rejected')
  assert.equal(rejected.reason.statusCode, 409)
  assert.equal(providerCalls, 1)
  const active = await pool.query(
    `SELECT count(*)::integer AS count FROM public.mpesa_stk_initiation_requests
     WHERE tenant_id = $1 AND invoice_id = $2
       AND request_status = ANY($3::text[])`,
    [context.tenantId, invoice.invoiceId, ACTIVE_RESERVATION_STATES]
  )
  assert.equal(active.rows[0].count, 1)
})

test('same-key concurrent requests replay one payment; changed payload conflicts', async () => {
  const context = fixtureIds.tenantA
  const invoice = await createIssuedInvoice(context, 'same-key')
  const key = `mpesa-it-${crypto.randomUUID()}`
  const entered = deferred()
  const release = deferred()
  let providerCalls = 0
  const provider = async () => {
    providerCalls += 1
    if (providerCalls === 1) {
      entered.resolve()
      await release.promise
    }
    return { ResponseCode: '0', CheckoutRequestID: testCheckoutId(), MerchantRequestID: testCheckoutId() }
  }
  const first = initiate(context, invoice, { key, provider })
  await entered.promise
  const replay = initiate(context, invoice, { key, provider })
  let waiterFailure
  try {
    await waitForLockWaiters({ minimum: 1, queryPattern: '%pg_advisory_lock%' })
  } catch (error) {
    waiterFailure = error
  } finally {
    release.resolve()
  }
  const [original, repeated] = await Promise.all([first, replay])
  assert.ifError(waiterFailure)
  assert.equal(providerCalls, 1)
  assert.equal(original.payment.id, repeated.payment.id)
  const changed = initiate(context, invoice, { key, phoneNumber: '0711111111', provider })
  await assert.rejects(changed, (error) => error.statusCode === 409)
  assert.equal(providerCalls, 1)
  const request = await getRequest(context.tenantId, key)
  const eventCount = await pool.query(
    `SELECT count(*)::integer AS count FROM public.mpesa_stk_initiation_events
     WHERE tenant_id = $1 AND request_id = $2`,
    [context.tenantId, request.id]
  )
  assert.equal(eventCount.rows[0].count, 3, 'idempotent replay must not append a duplicate initiation event')
  const paymentCount = await pool.query(
    `SELECT count(*)::integer AS count FROM public.payments WHERE tenant_id = $1 AND id::text = $2`,
    [context.tenantId, request.payment_id]
  )
  assert.equal(paymentCount.rows[0].count, 1, 'idempotent replay must not create a second pending payment')
})

test('ambiguous provider outcome remains reserved and never triggers a retry prompt', async () => {
  const context = fixtureIds.tenantA
  const invoice = await createIssuedInvoice(context, 'ambiguous')
  const key = `mpesa-it-${crypto.randomUUID()}`
  let providerCalls = 0
  await assert.rejects(initiate(context, invoice, {
    key,
    provider: async () => {
      providerCalls += 1
      const committed = await getRequest(context.tenantId, key)
      assert.equal(committed && committed.request_status, 'reserved')
      throw new Error('synthetic timeout after request may have been accepted')
    }
  }), (error) => error.statusCode === 502)
  const request = await getRequest(context.tenantId, key)
  assert.equal(request.request_status, 'outcome_unknown')
  assert.equal(request.phone_number, null)
  await assert.rejects(initiate(context, invoice, {
    key: `mpesa-it-${crypto.randomUUID()}`,
    provider: async () => { providerCalls += 1; return acceptedProvider()() }
  }), (error) => error.statusCode === 409)
  assert.equal(providerCalls, 1)
})

test('a definite rejection releases the partial-index reservation for a reviewed new key', async () => {
  const context = fixtureIds.tenantA
  const invoice = await createIssuedInvoice(context, 'rejection')
  const rejectedKey = `mpesa-it-${crypto.randomUUID()}`
  await assert.rejects(initiate(context, invoice, {
    key: rejectedKey,
    provider: async () => ({ ResponseCode: '1', ResponseDescription: 'synthetic rejection' })
  }), (error) => error.statusCode === 502)
  const rejected = await getRequest(context.tenantId, rejectedKey)
  assert.equal(rejected.request_status, 'provider_rejected')
  assert.equal(rejected.provider_checkout_request_id, null)
  const accepted = await initiate(context, invoice, { key: `mpesa-it-${crypto.randomUUID()}` })
  assert.equal(accepted.request.status, 'payment_recorded')
})

test('receipt allocation racing initiation serializes on the customer and invoice rows', async () => {
  const context = fixtureIds.tenantA
  const invoice = await createIssuedInvoice(context, 'receipt-race')
  const receiptResult = await createCustomerReceipt(pool, {
    tenantId: context.tenantId,
    userId: context.userId,
    idempotencyKey: `mpesa-it-receipt-${crypto.randomUUID()}`,
    body: {
      customer_id: invoice.customerId,
      amount: invoice.total,
      currency: 'KES',
      payment_method: 'cash',
      receipt_reference: `synthetic-${crypto.randomUUID()}`,
      payment_date: '2026-10-15'
    }
  })
  const receiptId = receiptResult.receipt.id
  await verifyCustomerReceipt(pool, {
    tenantId: context.tenantId,
    userId: context.userId,
    receiptId,
    idempotencyKey: `mpesa-it-verify-${crypto.randomUUID()}`,
    body: {
      cash_account_id: context.accountIds.cash,
      accounting_period_id: context.periodId
    }
  })

  const blocker = await pool.connect()
  let transactionOpen = false
  let allocationPromise
  let initiationPromise
  try {
    await blocker.query('BEGIN')
    transactionOpen = true
    await blocker.query(
      'SELECT id FROM public.clients WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
      [context.tenantId, invoice.customerId]
    )
    allocationPromise = allocateCustomerReceipt(pool, {
      tenantId: context.tenantId,
      userId: context.userId,
      receiptId,
      idempotencyKey: `mpesa-it-allocate-${crypto.randomUUID()}`,
      body: { allocations: [{ invoice_id: invoice.invoiceId, amount: invoice.total }] }
    })
    let providerCalls = 0
    initiationPromise = initiate(context, invoice, {
      provider: async () => {
        providerCalls += 1
        return { ResponseCode: '0', CheckoutRequestID: testCheckoutId(), MerchantRequestID: testCheckoutId() }
      }
    })
    let waiterFailure
    try {
      await waitForLockWaiters({ minimum: 2, queryPattern: '%clients%FOR UPDATE%' })
    } catch (error) {
      waiterFailure = error
    } finally {
      await blocker.query('COMMIT')
      transactionOpen = false
    }
    const [allocation, initiation] = await Promise.allSettled([allocationPromise, initiationPromise])
    assert.ifError(waiterFailure)
    assert.equal(allocation.status, 'fulfilled')
    assert.equal(allocation.value.allocations.length, 1)
    assert.equal(initiation.status, 'rejected')
    assert.equal(initiation.reason.statusCode, 409)
    assert.equal(providerCalls, 0)
    const invoiceState = await pool.query(
      'SELECT status FROM public.invoices WHERE tenant_id = $1 AND id = $2',
      [context.tenantId, invoice.invoiceId]
    )
    assert.equal(invoiceState.rows[0].status, 'paid')
  } finally {
    if (transactionOpen) await blocker.query('ROLLBACK').catch(() => {})
    blocker.release()
    if (allocationPromise || initiationPromise) {
      await Promise.allSettled([allocationPromise, initiationPromise].filter(Boolean))
    }
  }
})

test('concurrent reconciliation creates one receipt and journal, and reversal retains the successful reservation', async () => {
  const context = fixtureIds.tenantA
  const invoice = await createIssuedInvoice(context, 'reconciliation-race')
  const initiationKey = `mpesa-it-init-reconcile-${crypto.randomUUID()}`
  const initiated = await initiate(context, invoice, { key: initiationKey })
  const payment = initiated.payment
  let providerQueries = 0
  const queryProvider = async ({ checkoutRequestId }) => {
    providerQueries += 1
    return {
      ResponseCode: '0',
      CheckoutRequestID: checkoutRequestId,
      ResultCode: '0',
      Amount: 1000
    }
  }

  const blocker = await pool.connect()
  let transactionOpen = false
  let pendingReconciliations = []
  try {
    await blocker.query('BEGIN')
    transactionOpen = true
    await blocker.query(
      'SELECT id FROM public.clients WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
      [context.tenantId, invoice.customerId]
    )
    const request = {
      tenantId: context.tenantId,
      userId: context.userId,
      paymentId: payment.id,
      idempotencyKey: `mpesa-it-reconcile-${crypto.randomUUID()}`,
      paymentDate: '2026-10-15',
      queryProvider
    }
    pendingReconciliations = [
      reconcileMpesaPayment(pool, request),
      reconcileMpesaPayment(pool, request)
    ]
    const settled = Promise.allSettled(pendingReconciliations)
    let waiterFailure
    try {
      await waitForLockWaiters({ minimum: 2, queryPattern: '%clients%FOR UPDATE%' })
    } catch (error) {
      waiterFailure = error
    } finally {
      await blocker.query('COMMIT')
      transactionOpen = false
    }
    const results = await settled
    assert.ifError(waiterFailure)
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 2)
    for (const result of results) assert.equal(result.value.reconciliation.outcome, 'provider_success')
    assert.equal(results.filter((result) => result.value.replayed === true).length, 1)
    assert.equal(providerQueries, 2, 'both independent callers may query the provider test double')

    const receiptIds = [...new Set(results.map((result) => result.value.receipt.id))]
    assert.equal(receiptIds.length, 1)
    const receiptId = receiptIds[0]
    const reconciliationRows = await pool.query(
      `SELECT count(*)::integer AS count
       FROM public.mpesa_payment_reconciliation_audit
       WHERE tenant_id = $1 AND payment_id = $2 AND outcome = 'provider_success'`,
      [context.tenantId, payment.id]
    )
    assert.equal(reconciliationRows.rows[0].count, 1)
    const requestRow = await getRequest(context.tenantId, initiationKey)
    assert.equal(requestRow.request_status, 'provider_succeeded')
    const successEvents = await pool.query(
      `SELECT count(*)::integer AS count FROM public.mpesa_stk_initiation_events
       WHERE tenant_id = $1 AND request_id = $2 AND event_type = 'provider_succeeded'`,
      [context.tenantId, initiated.request.id]
    )
    assert.equal(successEvents.rows[0].count, 1)

    const repeated = await reconcileMpesaPayment(pool, request)
    assert.equal(repeated.replayed, true)
    assert.equal(providerQueries, 2, 'same-key replay must return before another provider query')
    const receiptRows = await pool.query(
      `SELECT count(*)::integer AS count FROM public.customer_receipts
       WHERE tenant_id = $1 AND id = $2`,
      [context.tenantId, receiptId]
    )
    assert.equal(receiptRows.rows[0].count, 1)
    const unverifiedJournalRows = await pool.query(
      `SELECT count(*)::integer AS count FROM public.accounting_journal_entries
       WHERE tenant_id = $1 AND source_type = 'customer_receipt' AND source_id = $2`,
      [context.tenantId, receiptId]
    )
    assert.equal(unverifiedJournalRows.rows[0].count, 0, 'reconciliation records a pending receipt but does not post its journal')

    const verifyRequest = {
      tenantId: context.tenantId,
      userId: context.userId,
      receiptId,
      idempotencyKey: `mpesa-it-verify-${crypto.randomUUID()}`,
      body: { cash_account_id: context.accountIds.cash, accounting_period_id: context.periodId }
    }
    const verified = await verifyCustomerReceipt(pool, verifyRequest)
    const verifyReplay = await verifyCustomerReceipt(pool, verifyRequest)
    assert.equal(verifyReplay.replayed, true)
    assert.equal(verifyReplay.journal.id, verified.journal.id)
    const receiptJournals = await pool.query(
      `SELECT count(*)::integer AS count FROM public.accounting_journal_entries
       WHERE tenant_id = $1 AND source_type = 'customer_receipt' AND source_id = $2
         AND event_type = 'verify'`,
      [context.tenantId, receiptId]
    )
    assert.equal(receiptJournals.rows[0].count, 1)

    const allocationRequest = {
      tenantId: context.tenantId,
      userId: context.userId,
      receiptId,
      idempotencyKey: `mpesa-it-allocate-${crypto.randomUUID()}`,
      body: { allocations: [{ invoice_id: invoice.invoiceId, amount: invoice.total }] }
    }
    const allocation = await allocateCustomerReceipt(pool, allocationRequest)
    const allocationReplay = await allocateCustomerReceipt(pool, allocationRequest)
    assert.equal(allocation.allocations.length, 1)
    assert.equal(allocationReplay.replayed, true)
    const allocationRows = await pool.query(
      `SELECT count(*)::integer AS count FROM public.customer_receipt_allocations
       WHERE tenant_id = $1 AND receipt_id = $2`,
      [context.tenantId, receiptId]
    )
    assert.equal(allocationRows.rows[0].count, 1)

    const reversalRequest = {
      tenantId: context.tenantId,
      userId: context.userId,
      receiptId,
      idempotencyKey: `mpesa-it-reverse-${crypto.randomUUID()}`,
      body: {
        accounting_period_id: context.periodId,
        reversal_date: '2026-10-16',
        reason: 'Synthetic integration reversal review'
      }
    }
    const reversed = await reverseCustomerReceipt(pool, reversalRequest)
    const reversalReplay = await reverseCustomerReceipt(pool, reversalRequest)
    assert.equal(reversed.receipt.status, 'reversed')
    assert.equal(reversalReplay.replayed, true)
    const reversalJournals = await pool.query(
      `SELECT count(*)::integer AS count FROM public.accounting_journal_entries
       WHERE tenant_id = $1 AND reversal_of_entry_id = $2`,
      [context.tenantId, verified.journal.id]
    )
    assert.equal(reversalJournals.rows[0].count, 1)
    const afterReversal = await getRequest(context.tenantId, initiationKey)
    assert.equal(afterReversal.request_status, 'provider_succeeded')
    const activeAfterReversal = await pool.query(
      `SELECT count(*)::integer AS count FROM public.mpesa_stk_initiation_requests
       WHERE tenant_id = $1 AND invoice_id = $2
         AND request_status = ANY($3::text[])`,
      [context.tenantId, invoice.invoiceId, ACTIVE_RESERVATION_STATES]
    )
    assert.equal(activeAfterReversal.rows[0].count, 1)
  } finally {
    if (transactionOpen) await blocker.query('ROLLBACK').catch(() => {})
    blocker.release()
    await Promise.allSettled(pendingReconciliations)
  }
})

test('partial unique index enforces every active state and permits terminal release', async () => {
  const context = fixtureIds.tenantA
  const invoice = await createIssuedInvoice(context, 'index-states')
  for (const state of ACTIVE_RESERVATION_STATES) {
    const key = `mpesa-it-index-${state}-${crypto.randomUUID()}`
    const checkout = testCheckoutId()
    const paymentId = ['payment_recorded', 'provider_succeeded'].includes(state) ? `fixture-${crypto.randomUUID()}` : null
    await pool.query(
      `INSERT INTO public.mpesa_stk_initiation_requests
         (tenant_id, idempotency_key, payload_hash, invoice_id, invoice_number,
          amount, currency, request_status, provider_checkout_request_id, payment_id, created_by)
       VALUES ($1, $2, $3, $4, $5, 1000.00, 'KES', $6, $7, $8, $9)`,
      [context.tenantId, key, 'a'.repeat(64), invoice.invoiceId, invoice.invoiceNumber,
        state, state === 'reserved' || state === 'outcome_unknown' ? null : checkout, paymentId, context.userId]
    )
    await assert.rejects(pool.query(
      `INSERT INTO public.mpesa_stk_initiation_requests
         (tenant_id, idempotency_key, payload_hash, invoice_id, invoice_number,
          amount, currency, request_status, created_by)
       VALUES ($1, $2, $3, $4, $5, 1000.00, 'KES', 'reserved', $6)`,
      [context.tenantId, `mpesa-it-overlap-${crypto.randomUUID()}`, 'b'.repeat(64),
        invoice.invoiceId, invoice.invoiceNumber, context.userId]
    ), assertSqlState('23505'))
    await pool.query(
      `UPDATE public.mpesa_stk_initiation_requests
       SET request_status = 'provider_rejected', provider_checkout_request_id = NULL,
           payment_id = NULL, phone_number = NULL
       WHERE tenant_id = $1 AND idempotency_key = $2`,
      [context.tenantId, key]
    )
  }
  const terminalKey = `mpesa-it-terminal-${crypto.randomUUID()}`
  await pool.query(
    `INSERT INTO public.mpesa_stk_initiation_requests
       (tenant_id, idempotency_key, payload_hash, invoice_id, invoice_number,
        amount, currency, request_status, created_by)
     VALUES ($1, $2, $3, $4, $5, 1000.00, 'KES', 'resolved_no_collection', $6)`,
    [context.tenantId, terminalKey, 'c'.repeat(64), invoice.invoiceId, invoice.invoiceNumber, context.userId]
  )
  await pool.query(
    `INSERT INTO public.mpesa_stk_initiation_requests
       (tenant_id, idempotency_key, payload_hash, invoice_id, invoice_number,
        amount, currency, request_status, created_by)
     VALUES ($1, $2, $3, $4, $5, 1000.00, 'KES', 'reserved', $6)`,
    [context.tenantId, `mpesa-it-after-terminal-${crypto.randomUUID()}`, 'd'.repeat(64),
      invoice.invoiceId, invoice.invoiceNumber, context.userId]
  )
})

test('tenant-scoped keys remain independent and event foreign keys reject cross-tenant links', async () => {
  const contextA = fixtureIds.tenantA
  const contextB = fixtureIds.tenantB
  const invoiceA = await createIssuedInvoice(contextA, 'tenant-a')
  const invoiceB = await createIssuedInvoice(contextB, 'tenant-b')
  const sharedKey = `mpesa-it-shared-${crypto.randomUUID()}`
  const [resultA, resultB] = await Promise.all([
    initiate(contextA, invoiceA, { key: sharedKey }),
    initiate(contextB, invoiceB, { key: sharedKey })
  ])
  assert.notEqual(resultA.request.id, resultB.request.id)

  const event = await pool.query(
    `SELECT id FROM public.mpesa_stk_initiation_events
     WHERE tenant_id = $1 AND request_id = $2 AND event_type = 'reserved'`,
    [contextA.tenantId, resultA.request.id]
  )
  await assert.rejects(pool.query(
    `UPDATE public.mpesa_stk_initiation_events SET details = '{}'::jsonb
     WHERE tenant_id = $1 AND id = $2`,
    [contextA.tenantId, event.rows[0].id]
  ), assertSqlState('55000'))

  await assert.rejects(pool.query(
    `INSERT INTO public.mpesa_stk_initiation_events
       (tenant_id, request_id, event_type, to_status, actor_id)
     VALUES ($1, $2, 'reserved', 'reserved', $3)`,
    [contextB.tenantId, resultA.request.id, contextB.userId]
  ), assertSqlState('23503'))
})

test('reservation and event roll back together before any provider call', async () => {
  const context = fixtureIds.tenantA
  const invoice = await createIssuedInvoice(context, 'rollback')
  const key = `mpesa-it-rollback-${crypto.randomUUID()}`
  let providerCalls = 0
  const triggerClient = await pool.connect()
  let triggerTransactionOpen = false
  try {
    await triggerClient.query('BEGIN')
    triggerTransactionOpen = true
    await triggerClient.query(`
      CREATE FUNCTION public.mpesa_it_fail_reserved_event()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'reserved' THEN
          RAISE EXCEPTION 'synthetic transaction rollback' USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END;
      $$`)
    await triggerClient.query(`
      CREATE TRIGGER zz_mpesa_it_fail_reserved_event
      BEFORE INSERT ON public.mpesa_stk_initiation_events
      FOR EACH ROW EXECUTE FUNCTION public.mpesa_it_fail_reserved_event()`)
    await triggerClient.query(`COMMENT ON FUNCTION public.mpesa_it_fail_reserved_event() IS '${RUN_OBJECT_MARKER}'`)
    await triggerClient.query('COMMIT')
    triggerTransactionOpen = false

    try {
      await assert.rejects(initiate(context, invoice, {
        key,
        provider: async () => { providerCalls += 1; return acceptedProvider()() }
      }), assertSqlState('P0001'))
    } finally {
      await triggerClient.query('BEGIN')
      triggerTransactionOpen = true
      await triggerClient.query('DROP TRIGGER IF EXISTS zz_mpesa_it_fail_reserved_event ON public.mpesa_stk_initiation_events')
      await triggerClient.query('DROP FUNCTION public.mpesa_it_fail_reserved_event()')
      await triggerClient.query('COMMIT')
      triggerTransactionOpen = false
    }
  } finally {
    if (triggerTransactionOpen) await triggerClient.query('ROLLBACK').catch(() => {})
    triggerClient.release()
  }
  assert.equal(providerCalls, 0)
  assert.equal(await getRequest(context.tenantId, key), null)
  const event = await pool.query(
    `SELECT count(*)::integer AS count FROM public.mpesa_stk_initiation_events
     WHERE tenant_id = $1 AND request_id IN (
       SELECT id FROM public.mpesa_stk_initiation_requests WHERE idempotency_key = $2
     )`,
    [context.tenantId, key]
  )
  assert.equal(event.rows[0].count, 0)
})

test('reconciliation audit idempotency and provider-success checkout uniqueness are tenant scoped', async () => {
  const context = fixtureIds.tenantA
  const invoice = await createIssuedInvoice(context, 'audit')
  const receipt = await createCustomerReceipt(pool, {
    tenantId: context.tenantId,
    userId: context.userId,
    idempotencyKey: `mpesa-it-audit-receipt-${crypto.randomUUID()}`,
    body: {
      customer_id: invoice.customerId,
      amount: invoice.total,
      currency: 'KES',
      payment_method: 'mpesa',
      receipt_reference: `synthetic-audit-${crypto.randomUUID()}`,
      payment_date: '2026-10-15'
    }
  })
  const checkout = testCheckoutId()
  const auditKey = `mpesa-it-audit-${crypto.randomUUID()}`
  const insertAudit = ({ tenantId, actorId, receiptId, key, checkoutId }) => pool.query(
    `INSERT INTO public.mpesa_payment_reconciliation_audit
       (tenant_id, payment_id, checkout_request_id, payment_date, outcome,
        provider_result_code, receipt_id, idempotency_key, payload_hash, actor_id)
     VALUES ($1, $2, $3, '2026-10-15', 'provider_success', '0', $4, $5, $6, $7)
     RETURNING id`,
    [tenantId, `synthetic-${crypto.randomUUID()}`, checkoutId,
      receiptId, key, crypto.createHash('sha256').update(key).digest('hex'), actorId]
  )
  const audit = await insertAudit({
    tenantId: context.tenantId, actorId: context.userId,
    receiptId: receipt.receipt.id, key: auditKey, checkoutId: checkout
  })
  await assert.rejects(insertAudit({
    tenantId: context.tenantId, actorId: context.userId, receiptId: receipt.receipt.id,
    key: auditKey, checkoutId: testCheckoutId()
  }), assertSqlState('23505'))
  await assert.rejects(insertAudit({
    tenantId: context.tenantId, actorId: context.userId, receiptId: receipt.receipt.id,
    key: `mpesa-it-audit-${crypto.randomUUID()}`, checkoutId: checkout
  }), assertSqlState('23505'))
  await assert.rejects(pool.query(
    `UPDATE public.mpesa_payment_reconciliation_audit SET outcome = 'inconclusive'
     WHERE tenant_id = $1 AND id = $2`,
    [context.tenantId, audit.rows[0].id]
  ), assertSqlState('55000'))

  const otherTenant = fixtureIds.tenantB
  const otherInvoice = await createIssuedInvoice(otherTenant, 'audit-tenant-b')
  const otherReceipt = await createCustomerReceipt(pool, {
    tenantId: otherTenant.tenantId,
    userId: otherTenant.userId,
    idempotencyKey: `mpesa-it-audit-receipt-${crypto.randomUUID()}`,
    body: {
      customer_id: otherInvoice.customerId,
      amount: otherInvoice.total,
      currency: 'KES',
      payment_method: 'mpesa',
      receipt_reference: `synthetic-audit-${crypto.randomUUID()}`,
      payment_date: '2026-10-15'
    }
  })
  await insertAudit({
    tenantId: otherTenant.tenantId, actorId: otherTenant.userId,
    receiptId: otherReceipt.receipt.id, key: auditKey, checkoutId: checkout
  })
})

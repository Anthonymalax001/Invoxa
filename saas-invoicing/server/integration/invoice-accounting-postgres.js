'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const Module = require('node:module')
const path = require('node:path')
const test = require('node:test')
const jwt = require('jsonwebtoken')
const { Pool } = require('pg')
const { randomUUID } = require('node:crypto')

const DATABASE_NAME = 'invoxa_accounting_test_invoice_local'
const ROLE_NAME = 'invoxa_accounting_test_role'
const DATABASE_COMMENT = 'INVOXA_DISPOSABLE_ACCOUNTING_TEST'
const CONFIRMATION = 'I_CONFIRM_THIS_IS_DISPOSABLE'
const TEST_JWT_SECRET = 'invoice-accounting-integration-fixture-secret'
const TEST_URL = process.env.INVOICE_ACCOUNTING_TEST_DATABASE_URL
const TEST_CONFIRMATION = process.env.INVOICE_ACCOUNTING_TEST_DATABASE_CONFIRMATION

for (const name of [
  'DATABASE_URL', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE',
  'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS', 'PGSSLMODE', 'PGSSLROOTCERT',
  'PGSSLKEY', 'PGSSLCERT'
]) {
  delete process.env[name]
}

function validateExplicitTarget() {
  if (typeof TEST_URL !== 'string' || TEST_URL.length === 0) {
    throw new Error('INVOICE_ACCOUNTING_TEST_DATABASE_URL is required; DATABASE_URL is never used.')
  }
  if (TEST_CONFIRMATION !== CONFIRMATION) {
    throw new Error('Explicit disposable database confirmation is required.')
  }
  let parsed
  try {
    parsed = new URL(TEST_URL)
  } catch {
    throw new Error('The explicit invoice test connection URL is invalid.')
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('The invoice test connection must use PostgreSQL.')
  }
  let databaseName
  let roleName
  try {
    databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
    roleName = decodeURIComponent(parsed.username)
  } catch {
    throw new Error('The invoice test connection URL has invalid encoding.')
  }
  if (parsed.hostname !== '127.0.0.1' || parsed.port !== '5432' ||
      roleName !== ROLE_NAME || databaseName !== DATABASE_NAME ||
      !parsed.password || parsed.search || parsed.hash ||
      !/^invoxa_accounting_test_[a-z0-9_]+$/.test(databaseName)) {
    throw new Error('The invoice test URL must target the fixed local disposable database and role.')
  }
}

validateExplicitTarget()

const pool = new Pool({
  connectionString: TEST_URL,
  ssl: false,
  max: 6,
  connectionTimeoutMillis: 5000,
  application_name: 'invoxa-invoice-accounting-integration-tests'
})

const fixtureSql = fs.readFileSync(path.join(__dirname, 'invoice-fixture-schema.sql'), 'utf8')
const migrationFiles = [
  '20261018_001_products_and_stock_movements.sql',
  '20261018_003_sales_orders.sql',
  '20261021_001_accounting_foundation.sql',
  '20261022_001_invoice_accounting_configuration.sql'
]
const migrationSql = migrationFiles.map((name) => ({
  name,
  sql: fs.readFileSync(path.join(__dirname, '..', 'migrations', name), 'utf8')
}))

let databaseConfirmedDisposable = false
let lockClient
let server
let baseUrl

function sanitizedError(error) {
  let message = error && typeof error.message === 'string' ? error.message : 'Unknown failure'
  if (TEST_URL) message = message.split(TEST_URL).join('[test connection URL redacted]')
  message = message.replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[PostgreSQL connection URL redacted]')
  message = message.replace(/((?:password|passfile|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
  const code = error && typeof error.code === 'string' ? ' [' + error.code + ']' : ''
  return (error && error.name ? error.name : 'Error') + code + ': ' + message
}

function assertSqlState(expected) {
  return (error) => {
    assert.equal(error && error.code, expected)
    return true
  }
}

async function inspectEmptyTarget(client) {
  const identity = await client.query(
    "SELECT d.datname AS database_name, " +
    "shobj_description(d.oid, 'pg_database') AS database_comment, " +
    "current_user AS role_name, pg_is_in_recovery() AS in_recovery, " +
    "current_setting('transaction_read_only') = 'on' AS read_only, " +
    "r.rolsuper AS is_superuser, " +
    "has_schema_privilege(current_user, 'public', 'USAGE') AS public_schema_usage, " +
    "has_schema_privilege(current_user, 'public', 'CREATE') AS public_schema_create, " +
    "to_regprocedure('uuid_generate_v4()') IS NOT NULL AS has_uuid_generator " +
    "FROM pg_database d JOIN pg_roles r ON r.rolname = current_user " +
    "WHERE d.datname = current_database()"
  )
  const target = identity.rows[0]
  if (!target) throw new Error('Database identity could not be verified.')
  const failedChecks = []
  if (target.database_name !== DATABASE_NAME) failedChecks.push('database_name_mismatch')
  if (target.role_name !== ROLE_NAME) failedChecks.push('role_name_mismatch')
  if (target.database_comment !== DATABASE_COMMENT) failedChecks.push('database_comment_mismatch')
  if (target.in_recovery !== false) failedChecks.push('database_in_recovery')
  if (target.read_only !== false) failedChecks.push('transaction_read_only')
  if (target.is_superuser !== false) failedChecks.push('role_is_superuser')
  if (target.has_uuid_generator !== true) failedChecks.push('uuid_generate_v4_unavailable')
  if (failedChecks.length) {
    throw new Error('Database verification failed: ' + failedChecks.join(', ') + '. No test objects were created.')
  }
  if (!target.public_schema_usage || !target.public_schema_create) {
    throw new Error('Public-schema USAGE and CREATE privileges are required. No test objects were created.')
  }
  const relations = await client.query(
    "SELECT count(*)::integer AS relation_count " +
    "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
    "WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_' " +
    "AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')"
  )
  if (relations.rows[0].relation_count !== 0) {
    throw new Error('Disposable database must be empty: user_relation_count=' +
      relations.rows[0].relation_count + '. No test objects were created.')
  }
  databaseConfirmedDisposable = true
}

async function applyFixtureAndMigrations() {
  await pool.query(fixtureSql)
  for (const migration of migrationSql) {
    try {
      await pool.query(migration.sql)
    } catch (error) {
      throw new Error(migration.name + ' failed: ' + sanitizedError(error))
    }
  }
  const objects = await pool.query(
    "SELECT count(*)::integer AS object_count FROM information_schema.tables " +
    "WHERE table_schema = 'public' AND table_name = ANY($1::text[])",
    [[
      'tenants', 'users', 'clients', 'invoices', 'invoice_items', 'products',
      'stock_movements', 'sales_orders', 'sales_order_items',
      'sales_order_fulfillments', 'sales_order_fulfillment_items',
      'accounting_settings', 'accounting_periods', 'accounting_accounts',
      'accounting_posting_events', 'accounting_journal_entries',
      'accounting_journal_lines', 'accounting_invoice_mappings',
      'accounting_tax_profiles', 'accounting_invoice_tax_snapshots'
    ]]
  )
  if (objects.rows[0].object_count !== 20) {
    throw new Error('Invoice fixture and migrations did not create the expected table set.')
  }
}

async function createContext({ currency = 'KES' } = {}) {
  const tenant = await pool.query(
    'INSERT INTO public.tenants (name) VALUES ($1) RETURNING id',
    ['Invoice accounting integration ' + randomUUID()]
  )
  const tenantId = tenant.rows[0].id
  const admin = await pool.query(
    "INSERT INTO public.users (tenant_id, name, email, password_hash, role) " +
    "VALUES ($1, 'Integration Admin', $2, 'fixture-only', 'admin') RETURNING id",
    [tenantId, 'admin-' + randomUUID() + '@example.invalid']
  )
  const staff = await pool.query(
    "INSERT INTO public.users (tenant_id, name, email, password_hash, role) " +
    "VALUES ($1, 'Integration Staff', $2, 'fixture-only', 'staff') RETURNING id",
    [tenantId, 'staff-' + randomUUID() + '@example.invalid']
  )
  const client = await pool.query(
    "INSERT INTO public.clients (tenant_id, name, email) " +
    "VALUES ($1, 'Integration Client', $2) RETURNING id",
    [tenantId, 'client-' + randomUUID() + '@example.invalid']
  )
  const product = await pool.query(
    "INSERT INTO public.products (tenant_id, name, sku, selling_price, current_stock) " +
    "VALUES ($1, 'Integration Widget', $2, 100.00, 10.000) RETURNING id",
    [tenantId, 'SKU-' + randomUUID()]
  )

  await pool.query(
    'INSERT INTO public.accounting_settings (tenant_id, base_currency, created_by) VALUES ($1, $2, $3)',
    [tenantId, currency, admin.rows[0].id]
  )
  const periods = await pool.query(
    "INSERT INTO public.accounting_periods (tenant_id, name, starts_on, ends_on, created_by) " +
    "VALUES ($1, 'Open integration period', '2000-01-01', '2099-12-31', $2), " +
    "($1, 'Closed integration period', '1800-01-01', '1999-12-31', $2) RETURNING id, name",
    [tenantId, admin.rows[0].id]
  )
  const closedPeriod = periods.rows.find((period) => period.name === 'Closed integration period')
  await pool.query(
    "UPDATE public.accounting_periods " +
    "SET status = 'closed', closed_by = $1, closed_at = CURRENT_TIMESTAMP " +
    'WHERE tenant_id = $2 AND id = $3',
    [admin.rows[0].id, tenantId, closedPeriod.id]
  )

  const accountRows = [
    ['1100', 'Invoice receivables', 'asset', 'debit', true],
    ['4100', 'Invoice sales revenue', 'revenue', 'credit', true],
    ['2200', 'Invoice tax payable', 'liability', 'credit', true],
    ['1190', 'Inactive receivables fixture', 'asset', 'debit', false],
    ['2190', 'Wrong type mapping fixture', 'liability', 'credit', true]
  ]
  const accounts = {}
  for (const [code, name, type, balance, active] of accountRows) {
    const result = await pool.query(
      'INSERT INTO public.accounting_accounts ' +
      '(tenant_id, account_code, name, account_type, normal_balance, is_active, created_by) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [tenantId, code, name, type, balance, active, admin.rows[0].id]
    )
    accounts[code] = result.rows[0].id
  }
  const profile = await pool.query(
    "INSERT INTO public.accounting_tax_profiles " +
    "(tenant_id, profile_key, name, version, tax_rate, calculation_method, " +
    "rounding_method, effective_from, requires_tax_payable, tax_payable_account_id, created_by) " +
    "VALUES ($1, 'standard', 'Integration standard tax', 1, 16.00, " +
    "'exclusive', 'invoice_total', '1800-01-01', true, $2, $3) RETURNING id",
    [tenantId, accounts['2200'], admin.rows[0].id]
  )
  await pool.query(
    'INSERT INTO public.accounting_invoice_mappings ' +
    '(tenant_id, receivables_account_id, sales_revenue_account_id, updated_by) ' +
    'VALUES ($1, $2, $3, $4)',
    [tenantId, accounts['1100'], accounts['4100'], admin.rows[0].id]
  )

  return {
    tenantId,
    adminId: admin.rows[0].id,
    staffId: staff.rows[0].id,
    clientId: client.rows[0].id,
    productId: product.rows[0].id,
    profileId: profile.rows[0].id,
    accounts
  }
}

function tokenFor(context, role = 'admin') {
  const userId = role === 'staff' ? context.staffId : context.adminId
  return jwt.sign({
    userId,
    tenantId: context.tenantId,
    role,
    email: role + '-' + userId + '@example.invalid'
  }, TEST_JWT_SECRET, { expiresIn: '5m' })
}

async function api(context, endpoint, { method = 'GET', body, role = 'admin' } = {}) {
  const headers = { Authorization: 'Bearer ' + tokenFor(context, role) }
  const options = { method, headers }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    options.body = JSON.stringify(body)
  }
  const response = await fetch(baseUrl + endpoint, options)
  const text = await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return { status: response.status, data }
}

async function createDirectInvoice(context, {
  items = [{ description: 'Integration service', quantity: '1.00', unit_price: '100.00' }],
  dueDate = '2099-01-01'
} = {}) {
  const result = await api(context, '/api/invoices', {
    method: 'POST',
    body: {
      client_id: context.clientId,
      tax_profile_id: context.profileId,
      due_date: dueDate,
      items
    }
  })
  assert.equal(result.status, 201, JSON.stringify(result.data))
  return result.data
}

async function createSalesOrderInvoice(context) {
  const createdOrder = await api(context, '/api/sales-orders', {
    method: 'POST',
    body: {
      client_id: context.clientId,
      tax_profile_id: context.profileId,
      order_date: '2026-10-22',
      items: [{
        product_id: context.productId,
        quantity: '2.00',
        unit_price: '100.00',
        discount_rate: '10.00'
      }]
    }
  })
  assert.equal(createdOrder.status, 201, JSON.stringify(createdOrder.data))
  const order = createdOrder.data
  assert.equal(order.subtotal, '180.00')
  assert.equal(order.tax_amount, '28.80')
  assert.equal(order.total, '208.80')

  // This fixture starts at the already-fulfilled state. Stock movement and
  // fulfillment posting are outside this invoice-to-ledger integration scope.
  await pool.query(
    'UPDATE public.sales_orders SET status = $1 WHERE id = $2 AND tenant_id = $3',
    ['fulfilled', order.id, context.tenantId]
  )
  await pool.query(
    'UPDATE public.sales_order_items SET quantity_fulfilled = quantity_ordered ' +
    'WHERE tenant_id = $1 AND sales_order_id = $2',
    [context.tenantId, order.id]
  )
  const generated = await api(context, '/api/sales-orders/' + order.id + '/invoice', { method: 'POST' })
  assert.equal(generated.status, 201, JSON.stringify(generated.data))
  return { order, invoice: generated.data }
}

async function postingRows(tenantId, invoiceId) {
  const result = await pool.query(
    "SELECT e.id AS event_id, e.status AS event_status, e.journal_entry_id, " +
    "j.status AS journal_status, " +
    "(SELECT count(*)::integer FROM public.accounting_journal_lines l " +
    "WHERE l.tenant_id = e.tenant_id AND l.journal_entry_id = e.journal_entry_id) AS line_count, " +
    "(SELECT COALESCE(sum(l.debit), 0)::text FROM public.accounting_journal_lines l " +
    "WHERE l.tenant_id = e.tenant_id AND l.journal_entry_id = e.journal_entry_id) AS debit_total, " +
    "(SELECT COALESCE(sum(l.credit), 0)::text FROM public.accounting_journal_lines l " +
    "WHERE l.tenant_id = e.tenant_id AND l.journal_entry_id = e.journal_entry_id) AS credit_total " +
    "FROM public.accounting_posting_events e LEFT JOIN public.accounting_journal_entries j " +
    "ON j.tenant_id = e.tenant_id AND j.id = e.journal_entry_id " +
    "WHERE e.tenant_id = $1 AND e.source_type = 'invoice' AND e.source_id = $2 AND e.event_type = 'issue'",
    [tenantId, invoiceId]
  )
  return result.rows
}

async function assertNoPosting(context, invoiceId) {
  assert.deepEqual(await postingRows(context.tenantId, invoiceId), [])
  const journals = await pool.query(
    "SELECT count(*)::integer AS count FROM public.accounting_journal_entries " +
    "WHERE tenant_id = $1 AND source_type = 'invoice' AND source_id = $2",
    [context.tenantId, invoiceId]
  )
  assert.equal(journals.rows[0].count, 0)
}

async function assertSingleBalancedPosting(context, invoiceId, expectedTotal) {
  const rows = await postingRows(context.tenantId, invoiceId)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].event_status, 'posted')
  assert.equal(rows[0].journal_status, 'posted')
  assert.equal(rows[0].line_count, 3)
  assert.equal(rows[0].debit_total, rows[0].credit_total)
  assert.match(expectedTotal, /^\d+\.\d{6}$/)
  assert.equal(rows[0].debit_total, expectedTotal)
  return rows[0]
}

async function journalLines(tenantId, journalEntryId) {
  const result = await pool.query(
    'SELECT account_id, debit::text, credit::text ' +
    'FROM public.accounting_journal_lines ' +
    'WHERE tenant_id = $1 AND journal_entry_id = $2 ORDER BY line_number',
    [tenantId, journalEntryId]
  )
  return result.rows
}

async function assertInvoiceDraftAndUnposted(context, invoiceId) {
  const invoice = await pool.query(
    'SELECT status FROM public.invoices WHERE tenant_id = $1 AND id = $2',
    [context.tenantId, invoiceId]
  )
  assert.equal(invoice.rowCount, 1)
  assert.equal(invoice.rows[0].status, 'draft')
  const snapshot = await pool.query(
    'SELECT issued_on, issued_by, issued_at, journal_entry_id ' +
    'FROM public.accounting_invoice_tax_snapshots ' +
    "WHERE tenant_id = $1 AND source_type = 'invoice' AND source_id = $2",
    [context.tenantId, invoiceId]
  )
  if (snapshot.rowCount === 1) {
    assert.equal(snapshot.rows[0].issued_on, null)
    assert.equal(snapshot.rows[0].issued_by, null)
    assert.equal(snapshot.rows[0].issued_at, null)
    assert.equal(snapshot.rows[0].journal_entry_id, null)
  }
  await assertNoPosting(context, invoiceId)
}

async function listen(app) {
  server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  baseUrl = 'http://127.0.0.1:' + server.address().port
}

async function closeServer() {
  if (!server) return
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  server = null
}

async function installTestPoolForApplicationRoutes() {
  // Routes normally import config/db, which reads dotenv and DATABASE_URL.
  // Stub that module before route loading so every route uses only this
  // explicitly guarded local test pool.
  const dbPath = require.resolve('../src/config/db')
  const testDbModule = new Module(dbPath)
  testDbModule.filename = dbPath
  testDbModule.loaded = true
  testDbModule.exports = pool
  require.cache[dbPath] = testDbModule

  process.env.JWT_SECRET = TEST_JWT_SECRET
  const express = require('express')
  const app = express()
  app.use(express.json())
  app.use('/api/invoices', require('../src/routes/invoices'))
  app.use('/api/sales-orders', require('../src/routes/salesOrders'))
  app.use('/api/accounting', require('../src/routes/accounting'))
  await listen(app)
}

async function cleanDisposableDatabase() {
  if (!databaseConfirmedDisposable) return
  let client
  try {
    client = await pool.connect()
    await client.query('DROP TABLE IF EXISTS public.invoice_it_deferred_rows CASCADE')
    await client.query('DROP TABLE IF EXISTS public.accounting_invoice_tax_snapshots CASCADE')
    await client.query('DROP TABLE IF EXISTS public.accounting_tax_profiles CASCADE')
    await client.query('DROP TABLE IF EXISTS public.accounting_invoice_mappings CASCADE')
    await client.query('DROP TABLE IF EXISTS public.accounting_journal_lines CASCADE')
    await client.query('DROP TABLE IF EXISTS public.accounting_journal_entries CASCADE')
    await client.query('DROP TABLE IF EXISTS public.accounting_posting_events CASCADE')
    await client.query('DROP TABLE IF EXISTS public.accounting_accounts CASCADE')
    await client.query('DROP TABLE IF EXISTS public.accounting_periods CASCADE')
    await client.query('DROP TABLE IF EXISTS public.accounting_settings CASCADE')
    await client.query('DROP TABLE IF EXISTS public.sales_order_fulfillment_items CASCADE')
    await client.query('DROP TABLE IF EXISTS public.sales_order_fulfillments CASCADE')
    await client.query('DROP TABLE IF EXISTS public.sales_order_items CASCADE')
    await client.query('DROP TABLE IF EXISTS public.sales_orders CASCADE')
    await client.query('DROP TABLE IF EXISTS public.stock_movements CASCADE')
    await client.query('DROP TABLE IF EXISTS public.products CASCADE')
    await client.query('DROP TABLE IF EXISTS public.invoice_items CASCADE')
    await client.query('DROP TABLE IF EXISTS public.invoices CASCADE')
    await client.query('DROP TABLE IF EXISTS public.clients CASCADE')
    await client.query('DROP TABLE IF EXISTS public.users CASCADE')
    await client.query('DROP TABLE IF EXISTS public.tenants CASCADE')
    const functions = [
      'invoice_it_fail_after_invoice_update',
      'invoice_it_create_deferred_failure',
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
      await client.query('DROP FUNCTION IF EXISTS public.' + name + '() CASCADE')
    }
  } catch (error) {
    throw new Error('Disposable invoice database cleanup failed. Discard this test database and provision a fresh one. ' +
      sanitizedError(error))
  } finally {
    if (client) client.release()
  }
}

test.before(async () => {
  try {
    lockClient = await pool.connect()
    await lockClient.query(
      "SELECT pg_advisory_lock(hashtext(current_database()), hashtext('invoxa-invoice-accounting-integration'))"
    )
    await inspectEmptyTarget(lockClient)
    await applyFixtureAndMigrations()
    await installTestPoolForApplicationRoutes()
  } catch (error) {
    throw new Error(sanitizedError(error))
  }
})

test.after(async () => {
  let cleanupError
  try {
    await closeServer()
  } catch (error) {
    cleanupError = new Error('Local integration HTTP server cleanup failed: ' + sanitizedError(error))
  }
  try {
    await cleanDisposableDatabase()
  } catch (error) {
    cleanupError = error
  }
  if (lockClient) {
    try {
      await lockClient.query(
        "SELECT pg_advisory_unlock(hashtext(current_database()), hashtext('invoxa-invoice-accounting-integration'))"
      )
    } catch (error) {
      cleanupError = new Error('Disposable database advisory lock cleanup failed: ' + sanitizedError(error))
    } finally {
      lockClient.release()
      lockClient = null
    }
  }
  try {
    await pool.end()
  } catch (error) {
    cleanupError = new Error('Local integration connection cleanup failed: ' + sanitizedError(error))
  }
  if (cleanupError) throw cleanupError
})

test('direct invoice drafts create no journal before finalization', async () => {
  const context = await createContext()
  const invoice = await createDirectInvoice(context)
  assert.equal(invoice.status, 'draft')
  assert.equal(invoice.subtotal, '100.00')
  assert.equal(invoice.tax_amount, '16.00')
  assert.equal(invoice.total, '116.00')
  await assertNoPosting(context, invoice.id)
})

test('direct invoice finalization writes one balanced journal and issuance audit', async () => {
  const context = await createContext()
  const invoice = await createDirectInvoice(context)
  const issued = await api(context, '/api/invoices/' + invoice.id + '/finalize', { method: 'POST', body: {} })
  assert.equal(issued.status, 201, JSON.stringify(issued.data))
  assert.equal(issued.data.invoice.status, 'sent')
  assert.equal(issued.data.replayed, false)
  const posting = await assertSingleBalancedPosting(context, invoice.id, '116.000000')
  assert.equal(issued.data.journal.id, posting.journal_entry_id)

  const audit = await pool.query(
    'SELECT issued_on, issued_by, issued_at, journal_entry_id ' +
    'FROM public.accounting_invoice_tax_snapshots ' +
    "WHERE tenant_id = $1 AND source_type = 'invoice' AND source_id = $2",
    [context.tenantId, invoice.id]
  )
  assert.equal(audit.rowCount, 1)
  assert.equal(audit.rows[0].issued_by, context.adminId)
  assert.ok(audit.rows[0].issued_on)
  assert.ok(audit.rows[0].issued_at)
  assert.equal(audit.rows[0].journal_entry_id, posting.journal_entry_id)
})

test('identical finalization retry returns the same journal without duplicates', async () => {
  const context = await createContext()
  const invoice = await createDirectInvoice(context)
  const first = await api(context, '/api/invoices/' + invoice.id + '/finalize', { method: 'POST', body: {} })
  const retry = await api(context, '/api/invoices/' + invoice.id + '/finalize', { method: 'POST', body: {} })
  assert.equal(first.status, 201)
  assert.equal(retry.status, 200)
  assert.equal(retry.data.replayed, true)
  assert.equal(retry.data.journal.id, first.data.journal.id)
  await assertSingleBalancedPosting(context, invoice.id, '116.000000')
})

test('concurrent finalization attempts create exactly one invoice issuance journal', async () => {
  const context = await createContext()
  const invoice = await createDirectInvoice(context)
  const results = await Promise.all([
    api(context, '/api/invoices/' + invoice.id + '/finalize', { method: 'POST', body: {} }),
    api(context, '/api/invoices/' + invoice.id + '/finalize', { method: 'POST', body: {} })
  ])
  assert.deepEqual(results.map((item) => item.status).sort(), [200, 201])
  assert.equal(results.filter((item) => item.data.replayed === false).length, 1)
  assert.equal(results.filter((item) => item.data.replayed === true).length, 1)
  await assertSingleBalancedPosting(context, invoice.id, '116.000000')
})

test('Sales Order generated invoice keeps its tax snapshot and discounted total through posting', async () => {
  const context = await createContext()
  const { order, invoice } = await createSalesOrderInvoice(context)
  assert.equal(invoice.status, 'draft')
  assert.equal(invoice.subtotal, '180.00')
  assert.equal(invoice.tax_amount, '28.80')
  assert.equal(invoice.total, '208.80')
  assert.equal(invoice.items[0].amount, '180.00')
  assert.match(invoice.items[0].description, /discount 10\.00%/)

  const snapshot = await pool.query(
    'SELECT source_type, source_id, tax_profile_id, profile_version, subtotal, tax_rate, tax_amount, total, issued_at ' +
    'FROM public.accounting_invoice_tax_snapshots ' +
    "WHERE tenant_id = $1 AND source_type = 'invoice' AND source_id = $2",
    [context.tenantId, invoice.id]
  )
  assert.equal(snapshot.rowCount, 1)
  assert.equal(snapshot.rows[0].source_type, 'invoice')
  assert.equal(snapshot.rows[0].source_id, invoice.id)
  assert.equal(snapshot.rows[0].tax_profile_id, context.profileId)
  assert.equal(snapshot.rows[0].profile_version, 1)
  assert.equal(snapshot.rows[0].subtotal, order.subtotal)
  assert.equal(snapshot.rows[0].tax_rate, '16.00')
  assert.equal(snapshot.rows[0].tax_amount, order.tax_amount)
  assert.equal(snapshot.rows[0].total, order.total)
  assert.equal(snapshot.rows[0].issued_at, null)
  await assertNoPosting(context, invoice.id)

  const issued = await api(context, '/api/invoices/' + invoice.id + '/finalize', { method: 'POST', body: {} })
  assert.equal(issued.status, 201, JSON.stringify(issued.data))
  assert.equal(issued.data.invoice.status, 'sent')
  const posting = await assertSingleBalancedPosting(context, invoice.id, '208.800000')
  assert.deepEqual(await journalLines(context.tenantId, posting.journal_entry_id), [
    { account_id: context.accounts['1100'], debit: '208.800000', credit: '0.000000' },
    { account_id: context.accounts['4100'], debit: '0.000000', credit: '180.000000' },
    { account_id: context.accounts['2200'], debit: '0.000000', credit: '28.800000' }
  ])
})

test('cross-tenant invoice lookup is indistinguishable from an unknown invoice', async () => {
  const owner = await createContext()
  const other = await createContext()
  const invoice = await createDirectInvoice(owner)
  const foreign = await api(other, '/api/invoices/' + invoice.id + '/finalize', { method: 'POST', body: {} })
  const unknown = await api(other, '/api/invoices/' + randomUUID() + '/finalize', { method: 'POST', body: {} })
  assert.equal(foreign.status, 404)
  assert.deepEqual(foreign, unknown)
  await assertNoPosting(owner, invoice.id)
})

test('cross-tenant account mapping is rejected without exposing account existence', async () => {
  const owner = await createContext()
  const foreign = await createContext()
  const foreignMapping = await api(owner, '/api/accounting/invoice-mappings', {
    method: 'PUT',
    body: {
      receivables_account_id: foreign.accounts['1100'],
      sales_revenue_account_id: owner.accounts['4100']
    }
  })
  const missingMapping = await api(owner, '/api/accounting/invoice-mappings', {
    method: 'PUT',
    body: {
      receivables_account_id: randomUUID(),
      sales_revenue_account_id: owner.accounts['4100']
    }
  })
  assert.equal(foreignMapping.status, 409)
  assert.deepEqual(foreignMapping.data, missingMapping.data)
})

test('non-admin users cannot finalize invoices', async () => {
  const context = await createContext()
  const invoice = await createDirectInvoice(context)
  const denied = await api(context, '/api/invoices/' + invoice.id + '/finalize', {
    method: 'POST', body: {}, role: 'staff'
  })
  assert.equal(denied.status, 403)
  assert.deepEqual(denied.data, { error: 'Accounting administrator access required' })
  await assertInvoiceDraftAndUnposted(context, invoice.id)
})

test('non-KES accounting base currency prevents invoice posting', async () => {
  const context = await createContext({ currency: 'USD' })
  const invoice = await createDirectInvoice(context)
  const result = await api(context, '/api/invoices/' + invoice.id + '/finalize', { method: 'POST', body: {} })
  assert.equal(result.status, 409)
  assert.match(result.data.error, /base currency KES/)
  await assertInvoiceDraftAndUnposted(context, invoice.id)
})

test('missing invoice account mappings prevent posting', async () => {
  const context = await createContext()
  const invoice = await createDirectInvoice(context)
  await pool.query('DELETE FROM public.accounting_invoice_mappings WHERE tenant_id = $1', [context.tenantId])
  const result = await api(context, '/api/invoices/' + invoice.id + '/finalize', { method: 'POST', body: {} })
  assert.equal(result.status, 409)
  await assertInvoiceDraftAndUnposted(context, invoice.id)
})

test('inactive invoice account mappings prevent posting', async () => {
  const context = await createContext()
  const invoice = await createDirectInvoice(context)
  await pool.query(
    'UPDATE public.accounting_accounts SET is_active = false WHERE tenant_id = $1 AND id = $2',
    [context.tenantId, context.accounts['1100']]
  )
  const result = await api(context, '/api/invoices/' + invoice.id + '/finalize', { method: 'POST', body: {} })
  assert.equal(result.status, 409)
  assert.match(result.data.error, /active asset account/)
  await assertInvoiceDraftAndUnposted(context, invoice.id)
})

test('wrong-type invoice account mappings prevent posting', async () => {
  const context = await createContext()
  const invoice = await createDirectInvoice(context)
  await pool.query(
    'UPDATE public.accounting_invoice_mappings SET receivables_account_id = $1 WHERE tenant_id = $2',
    [context.accounts['2190'], context.tenantId]
  )
  const result = await api(context, '/api/invoices/' + invoice.id + '/finalize', { method: 'POST', body: {} })
  assert.equal(result.status, 409)
  assert.match(result.data.error, /active asset account/)
  await assertInvoiceDraftAndUnposted(context, invoice.id)
})

test('inactive saved tax configuration prevents posting', async () => {
  const context = await createContext()
  const invoice = await createDirectInvoice(context)
  await pool.query(
    'UPDATE public.accounting_tax_profiles SET is_active = false WHERE tenant_id = $1 AND id = $2',
    [context.tenantId, context.profileId]
  )
  const result = await api(context, '/api/invoices/' + invoice.id + '/finalize', { method: 'POST', body: {} })
  assert.equal(result.status, 409)
  assert.match(result.data.error, /tax profile is inactive/)
  await assertInvoiceDraftAndUnposted(context, invoice.id)
})

test('a saved tax snapshot that disagrees with invoice totals prevents posting', async () => {
  const context = await createContext()
  const invoice = await createDirectInvoice(context)
  await pool.query(
    'UPDATE public.accounting_invoice_tax_snapshots ' +
    'SET tax_amount = tax_amount + 0.01, total = total + 0.01 ' +
    "WHERE tenant_id = $1 AND source_type = 'invoice' AND source_id = $2",
    [context.tenantId, invoice.id]
  )
  const result = await api(context, '/api/invoices/' + invoice.id + '/finalize', { method: 'POST', body: {} })
  assert.equal(result.status, 409)
  assert.match(result.data.error, /financial fields do not match/)
  await assertInvoiceDraftAndUnposted(context, invoice.id)
})

test('missing open accounting period prevents posting', async () => {
  const context = await createContext()
  const invoice = await createDirectInvoice(context)
  const result = await api(context, '/api/invoices/' + invoice.id + '/finalize', {
    method: 'POST', body: { issue_date: '2200-01-01' }
  })
  assert.equal(result.status, 409)
  assert.match(result.data.error, /open accounting period/)
  await assertInvoiceDraftAndUnposted(context, invoice.id)
})

test('closed accounting period prevents posting', async () => {
  const context = await createContext()
  const invoice = await createDirectInvoice(context)
  const result = await api(context, '/api/invoices/' + invoice.id + '/finalize', {
    method: 'POST', body: { issue_date: '1950-01-01' }
  })
  assert.equal(result.status, 409)
  assert.match(result.data.error, /open accounting period/)
  await assertInvoiceDraftAndUnposted(context, invoice.id)
})

test('failure after the invoice status update rolls back the invoice and all posting records', async () => {
  const context = await createContext()
  const invoice = await createDirectInvoice(context)
  await pool.query(
    "CREATE FUNCTION public.invoice_it_fail_after_invoice_update() RETURNS trigger " +
    "LANGUAGE plpgsql AS $$ BEGIN " +
    "IF NEW.issued_at IS NOT NULL AND OLD.issued_at IS NULL THEN " +
    "RAISE EXCEPTION 'injected invoice finalization failure' USING ERRCODE = 'P0001'; " +
    "END IF; RETURN NEW; END; $$"
  )
  await pool.query(
    'CREATE TRIGGER invoice_it_fail_after_invoice_update ' +
    'BEFORE UPDATE ON public.accounting_invoice_tax_snapshots ' +
    'FOR EACH ROW EXECUTE FUNCTION public.invoice_it_fail_after_invoice_update()'
  )
  try {
    const result = await api(context, '/api/invoices/' + invoice.id + '/finalize', { method: 'POST', body: {} })
    assert.equal(result.status, 500)
    await assertInvoiceDraftAndUnposted(context, invoice.id)
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS invoice_it_fail_after_invoice_update ON public.accounting_invoice_tax_snapshots')
    await pool.query('DROP FUNCTION IF EXISTS public.invoice_it_fail_after_invoice_update()')
  }
})

test('deferred constraint failure at COMMIT leaves no finalized invoice or posting journal', async () => {
  const context = await createContext()
  const invoice = await createDirectInvoice(context)
  await pool.query(
    'CREATE TABLE public.invoice_it_deferred_rows (' +
    'invoice_id uuid NOT NULL REFERENCES public.invoices(id), ' +
    'actor_id uuid NOT NULL REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED)'
  )
  await pool.query(
    "CREATE FUNCTION public.invoice_it_create_deferred_failure() RETURNS trigger " +
    "LANGUAGE plpgsql AS $$ BEGIN " +
    "IF NEW.issued_at IS NOT NULL AND OLD.issued_at IS NULL THEN " +
    "INSERT INTO public.invoice_it_deferred_rows (invoice_id, actor_id) " +
    "VALUES (NEW.source_id, uuid_generate_v4()); " +
    "END IF; RETURN NEW; END; $$"
  )
  await pool.query(
    'CREATE TRIGGER invoice_it_deferred_failure AFTER UPDATE ON public.accounting_invoice_tax_snapshots ' +
    'FOR EACH ROW EXECUTE FUNCTION public.invoice_it_create_deferred_failure()'
  )
  try {
    const { finalizeInvoice } = require('../src/services/invoiceAccounting')
    await assert.rejects(
      finalizeInvoice(pool, {
        tenantId: context.tenantId,
        userId: context.adminId,
        invoiceId: invoice.id
      }),
      assertSqlState('23503')
    )
    await assertInvoiceDraftAndUnposted(context, invoice.id)
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS invoice_it_deferred_failure ON public.accounting_invoice_tax_snapshots')
    await pool.query('DROP FUNCTION IF EXISTS public.invoice_it_create_deferred_failure()')
    await pool.query('DROP TABLE IF EXISTS public.invoice_it_deferred_rows')
  }
})

test('legacy sent, overdue, and paid invoices are not automatically posted', async () => {
  const context = await createContext()
  const legacyIds = []
  for (const status of ['sent', 'overdue', 'paid']) {
    const inserted = await pool.query(
      "INSERT INTO public.invoices " +
      "(tenant_id, client_id, invoice_number, due_date, subtotal, tax_rate, tax_amount, total, notes, status) " +
      "VALUES ($1, $2, $3, '2000-01-01', 100.00, 16.00, 16.00, 116.00, NULL, $4) RETURNING id",
      [context.tenantId, context.clientId, 'LEGACY-' + status.toUpperCase(), status]
    )
    legacyIds.push(inserted.rows[0].id)
  }
  for (const invoiceId of legacyIds) {
    const result = await api(context, '/api/invoices/' + invoiceId + '/finalize', { method: 'POST', body: {} })
    assert.equal(result.status, 409)
    assert.match(result.data.error, /saved tax calculation/)
    await assertNoPosting(context, invoiceId)
  }
  const statuses = await pool.query(
    'SELECT status FROM public.invoices WHERE tenant_id = $1 AND id = ANY($2::uuid[]) ORDER BY status',
    [context.tenantId, legacyIds]
  )
  assert.deepEqual(statuses.rows.map((row) => row.status).sort(), ['overdue', 'paid', 'sent'])
})

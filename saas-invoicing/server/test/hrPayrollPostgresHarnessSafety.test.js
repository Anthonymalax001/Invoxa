const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  DATABASE, HOST, ROLE, CONFIRMATION, isAllowedExtensionObject, targetFromEnvironment
} = require('../integration/hr-payroll-target')
const POOLED_HOST = 'ep-wild-moon-bekf9r1a-pooler.c-9.us-east-2.aws.neon.tech'

const baseEnvironment = (url) => ({
  HR_PAYROLL_TEST_DATABASE_URL: url,
  HR_PAYROLL_TEST_DATABASE_CONFIRMATION: CONFIRMATION
})
const validUrl = `postgresql://${ROLE}:secret@${HOST}:5432/${DATABASE}?sslmode=require`

test('HR/payroll target accepts only the dedicated SSL Neon target', () => {
  const target = targetFromEnvironment(baseEnvironment(validUrl))
  assert.equal(target.host, HOST)
  assert.equal(target.database, DATABASE)
  assert.equal(target.user, ROLE)
  assert.equal(target.ssl, true)
  assert.equal(target.password, 'secret')
})

test('accepts the direct Neon hostname and rejects the pooled hostname', () => {
  const direct = targetFromEnvironment(baseEnvironment(validUrl))
  assert.equal(direct.host, 'ep-wild-moon-bekf9r1a.c-9.us-east-2.aws.neon.tech')
  assert.throws(
    () => targetFromEnvironment(baseEnvironment(validUrl.replace(HOST, POOLED_HOST))),
    /approved SSL Neon database/
  )
})

for (const [label, url] of [
  ['production host', validUrl.replace(HOST, 'prod.example.com')],
  ['wrong role', validUrl.replace(ROLE, 'postgres')],
  ['wrong database', validUrl.replace(DATABASE, 'production')],
  ['missing SSL', validUrl.replace('?sslmode=require', '')]
]) {
  test(`rejects ${label} before any connection can be created`, () => {
    assert.throws(() => targetFromEnvironment(baseEnvironment(url)), /approved SSL Neon database/)
  })
}

test('rejects missing dedicated environment variable without fallback', () => {
  assert.throws(() => targetFromEnvironment({ HR_PAYROLL_TEST_DATABASE_CONFIRMATION: CONFIRMATION }), /HR_PAYROLL_TEST_DATABASE_URL/)
})

test('permits uuid-ossp extension-owned objects but rejects unrelated public objects', () => {
  assert.equal(isAllowedExtensionObject({ extensionName: 'uuid-ossp', extensionOwned: true }), true)
  assert.equal(isAllowedExtensionObject({ extensionName: 'other-extension', extensionOwned: true }), false)
  assert.equal(isAllowedExtensionObject({ extensionName: null, extensionOwned: false }), false)
})

test('creates the core baseline before migrations and cleans only owned objects', () => {
  const harness = fs.readFileSync(path.join(__dirname, '..', 'integration', 'hr-payroll-postgres.js'), 'utf8')
  assert.match(harness, /async function createBaselineSchema/)
  assert.match(harness, /CREATE TABLE public\.tenants/)
  assert.match(harness, /CREATE TABLE public\.users/)
  assert.match(harness, /CONSTRAINT hr_payroll_it_users_tenant_id_unique UNIQUE \(tenant_id, id\)/)
  assert.ok(harness.indexOf('await createBaselineSchema(lockClient)') < harness.indexOf('await applyMigrations(lockClient)'))
  assert.match(harness, /DROP TABLE IF EXISTS \$\{OWNED_TABLE_CLEANUP\.map/)
  assert.doesNotMatch(harness, /cleanupOwnedObjects[\s\S]*?CASCADE/)
  assert.doesNotMatch(harness, /DROP FUNCTION IF EXISTS public\.\$\{name\}\(\) CASCADE/)
  assert.doesNotMatch(harness, /DROP DATABASE|DROP SCHEMA/)
})

test('statutory remittance FK has a matching tenant-scoped obligation key', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '20261103_005_payroll_statutory_remittances.sql'),
    'utf8'
  )
  assert.match(
    migration,
    /CONSTRAINT hr_payroll_statutory_obligation_tenant_id_unique UNIQUE \(tenant_id, id\)/
  )
  assert.match(
    migration,
    /FOREIGN KEY \(tenant_id, obligation_id\)\s+REFERENCES public\.hr_payroll_statutory_obligations \(tenant_id, id\)/
  )
})

test('connectivity probe is read-only, target-validated, and closes its pool', () => {
  const probe = fs.readFileSync(path.join(__dirname, '..', 'integration', 'hr-payroll-connectivity-probe.js'), 'utf8')
  const launcher = fs.readFileSync(path.join(__dirname, '..', 'integration', 'run-hr-payroll-connectivity-probe.ps1'), 'utf8')
  assert.match(probe, /targetFromEnvironment\(\)/)
  assert.match(probe, /connectionTimeoutMillis: 15000/)
  assert.equal((probe.match(/connectionTimeoutMillis: 15000/g) || []).length, 1)
  assert.match(probe, /SELECT current_database\(\) AS db, current_user AS role/)
  assert.match(probe, /client\.release\(\)/)
  assert.match(probe, /await pool\.end\(\)/)
  assert.doesNotMatch(probe, /INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|migration|test:hr-payroll:integration/i)
  assert.doesNotMatch(probe, /DATABASE_URL|dotenv|\.env/)
  assert.match(launcher, /Read-Host .* -AsSecureString/)
  assert.match(launcher, /\$encodedPassword/)
  assert.match(launcher, /probe:hr-payroll:connectivity/)
  assert.doesNotMatch(launcher, /DATABASE_URL=.*production|\.env/i)
})

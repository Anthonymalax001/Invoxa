const DATABASE = 'invoxa_hr_payroll_test_local'
const ROLE = 'invoxa_hr_payroll_test_role'
const HOST = 'ep-wild-moon-bekf9r1a.c-9.us-east-2.aws.neon.tech'
const CONFIRMATION = 'I_CONFIRM_THIS_IS_A_DISPOSABLE_HR_PAYROLL_TEST_DATABASE'

function isAllowedExtensionObject(object) {
  return object.extensionName === 'uuid-ossp' && object.extensionOwned === true
}

function targetFromEnvironment(environment = process.env) {
  const urlValue = environment.HR_PAYROLL_TEST_DATABASE_URL
  if (!urlValue) throw new Error('HR_PAYROLL_TEST_DATABASE_URL is required; no DATABASE_URL fallback is allowed.')
  if (environment.HR_PAYROLL_TEST_DATABASE_CONFIRMATION !== CONFIRMATION) {
    throw new Error(`Set HR_PAYROLL_TEST_DATABASE_CONFIRMATION=${CONFIRMATION} for the approved disposable database.`)
  }
  const ambient = Object.keys(environment).filter((name) =>
    name.toUpperCase() === 'DATABASE_URL' || /^PG[A-Z0-9_]*$/i.test(name)
  )
  if (ambient.length) throw new Error(`Clear ambient database settings before running this harness: ${ambient.join(', ')}`)
  let parsed
  try { parsed = new URL(urlValue) } catch { throw new Error('HR_PAYROLL_TEST_DATABASE_URL is invalid; it was not displayed.') }
  let database
  let user
  try {
    database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))
    user = decodeURIComponent(parsed.username)
    decodeURIComponent(parsed.password)
  } catch {
    throw new Error('HR_PAYROLL_TEST_DATABASE_URL has invalid URL encoding; it was not displayed.')
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) ||
      parsed.hostname !== HOST || parsed.port !== '5432' ||
      database !== DATABASE || user !== ROLE || !parsed.password || parsed.hash ||
      parsed.searchParams.get('sslmode') !== 'require') {
    throw new Error(`Target must be the approved SSL Neon database ${DATABASE}; no connection was attempted.`)
  }
  return {
    host: HOST, port: 5432, database: DATABASE, user: ROLE,
    password: decodeURIComponent(parsed.password), ssl: true
  }
}

module.exports = { CONFIRMATION, DATABASE, HOST, ROLE, isAllowedExtensionObject, targetFromEnvironment }

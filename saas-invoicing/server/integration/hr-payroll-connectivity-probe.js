const { Pool } = require('pg')
const { HOST, targetFromEnvironment } = require('./hr-payroll-target')

function sanitizedMessage(error, target) {
  let message = String(error && error.message ? error.message : error)
    .replace(/postgres(?:ql):\/\/\S+/gi, '[redacted]')
    .replaceAll(HOST, '[redacted-host]')
  for (const [value, replacement] of [
    [target && target.database, '[redacted-database]'],
    [target && target.user, '[redacted-role]'],
    [target && target.password, '[redacted-password]']
  ]) {
    if (value) message = message.replaceAll(value, replacement)
  }
  return message
}

async function main() {
  let target
  let pool
  try {
    target = targetFromEnvironment()
    pool = new Pool({
      ...target,
      connectionTimeoutMillis: 15000,
      application_name: 'invoxa-hr-payroll-connectivity-probe'
    })
    const client = await pool.connect()
    try {
      const result = await client.query('SELECT current_database() AS db, current_user AS role')
      console.log(`db=${result.rows[0].db} role=${result.rows[0].role}`)
    } finally {
      client.release()
    }
  } catch (error) {
    const name = error && error.name ? error.name : 'Error'
    const code = error && error.code ? error.code : 'UNKNOWN'
    console.error(`name=${name} code=${code} message=${sanitizedMessage(error, target)}`)
    process.exitCode = 1
  } finally {
    if (pool) await pool.end()
  }
}

main()

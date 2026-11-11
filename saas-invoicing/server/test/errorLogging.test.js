const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { logSafeError } = require('../src/utils/errorLogging')

test('safe error logs keep allowlisted diagnostics and omit messages and sensitive properties', () => {
  const logged = []
  const originalConsoleError = console.error
  console.error = (...args) => logged.push(args)
  try {
    const error = Object.assign(new Error('SQL password=DB_SECRET token=JWT_SECRET amount=9123.45'), {
      code: 'XX999',
      response: { data: 'PROVIDER_SECRET' },
      authorization: 'Bearer JWT_SECRET'
    })
    logSafeError('Database request failed', error, {
      method: 'POST',
      route: '/api/example/:id',
      status: 500
    })
  } finally {
    console.error = originalConsoleError
  }

  assert.equal(logged.length, 1)
  assert.equal(logged[0][0], 'Database request failed')
  assert.deepEqual(logged[0][1], {
    error: { name: 'Error', code: 'XX999' },
    status: 500,
    method: 'POST',
    route: '/api/example/:id'
  })
  const serialized = JSON.stringify(logged)
  for (const secret of ['DB_SECRET', 'JWT_SECRET', 'PROVIDER_SECRET', '9123.45', 'SQL password']) {
    assert.equal(serialized.includes(secret), false)
  }
})

test('unsafe error codes are omitted from structured logs', () => {
  const logged = []
  const originalConsoleError = console.error
  console.error = (...args) => logged.push(args)
  try {
    logSafeError('Database request failed', Object.assign(new Error('hidden'), {
      code: 'password=DO_NOT_LOG'
    }))
  } finally {
    console.error = originalConsoleError
  }

  assert.equal(logged[0][1].error.code, undefined)
  assert.equal(JSON.stringify(logged).includes('DO_NOT_LOG'), false)
})

test('unexpected errors retain filtered app-relative source frames', () => {
  const logged = []
  const originalConsoleError = console.error
  console.error = (...args) => logged.push(args)
  try {
    const error = new Error('do not include this message')
    const sourceFile = path.resolve(__dirname, '../src/index.js')
    const externalFile = path.resolve(__dirname, '../node_modules/driver/index.js')
    error.stack = `Error: SECRET_STACK_MESSAGE\n    at handler (${sourceFile}:42:9)\n    at driver (${externalFile}:10:3)`
    logSafeError('Unexpected request failure', error)
  } finally {
    console.error = originalConsoleError
  }

  assert.deepEqual(logged[0][1].error.frames, ['index.js:42:9'])
  assert.equal(JSON.stringify(logged).includes('SECRET_STACK_MESSAGE'), false)
  assert.equal(JSON.stringify(logged).includes('node_modules'), false)
})

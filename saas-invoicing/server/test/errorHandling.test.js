const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

const app = require('../src/index')

async function withServer(run) {
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  try {
    await run(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
}

test('global request failures return clear client errors and log sanitized diagnostics', async () => {
  const logs = []
  const originalConsoleError = console.error
  console.error = (...args) => logs.push(args)
  try {
    await withServer(async (baseUrl) => {
      const malformed = await fetch(`${baseUrl}/api/accounting/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Connection: 'close' },
        body: '{"password":"BODY_SECRET",'
      })
      const malformedText = await malformed.text()

      assert.equal(malformed.status, 400)
      assert.match(malformed.headers.get('content-type'), /application\/json/)
      assert.deepEqual(JSON.parse(malformedText), { error: 'Request body contains invalid JSON' })
      assert.equal(malformedText.includes('BODY_SECRET'), false)
      assert.equal(malformedText.includes('SyntaxError'), false)
      assert.equal(malformedText.includes('at position'), false)
      assert.equal(logs.length, 1)
      assert.equal(logs[0][0], 'HTTP request failed')
      assert.equal(logs[0][1].error.type, 'entity.parse.failed')
      assert.equal(logs[0][1].status, 400)
      assert.equal(JSON.stringify(logs).includes('BODY_SECRET'), false)
      assert.equal(JSON.stringify(logs).includes('Unexpected end'), false)

      logs.length = 0
      const corsFailure = await fetch(`${baseUrl}/api/health`, {
        headers: { Origin: 'https://not-allowed.invalid', Connection: 'close' }
      })
      const corsText = await corsFailure.text()

      assert.equal(corsFailure.status, 500)
      assert.deepEqual(JSON.parse(corsText), { error: 'Something went wrong' })
      assert.equal(corsText.includes('Not allowed by CORS'), false)
      assert.equal(corsText.includes('Error:'), false)
      assert.equal(logs.length, 1)
      assert.equal(logs[0][1].error.code, 'CORS_ORIGIN_DENIED')
      assert.equal(logs[0][1].error.frames, undefined)
      assert.equal(JSON.stringify(logs).includes('Not allowed by CORS'), false)
    })
  } finally {
    console.error = originalConsoleError
  }
})

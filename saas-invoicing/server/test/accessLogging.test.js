const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const express = require('express')
const morgan = require('morgan')

const accessLogFormat = require('../src/utils/accessLogging')

test('HTTP access log format omits query strings', async () => {
  let output = ''
  const app = express()
  app.use(morgan(accessLogFormat, { stream: { write: (line) => { output += line } } }))
  app.get('/health', (_req, res) => res.json({ status: 'ok' }))
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/health?token=QUERY_SECRET`, {
      headers: { Connection: 'close' }
    })
    assert.equal(response.status, 200)
    await response.arrayBuffer()
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }

  assert.match(output, /GET 200/)
  assert.equal(output.includes('QUERY_SECRET'), false)
  assert.equal(output.includes('?token='), false)
})

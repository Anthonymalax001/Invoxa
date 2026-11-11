const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

process.env.MPESA_CONSUMER_KEY = 'test-consumer-key'
process.env.MPESA_CONSUMER_SECRET = 'test-consumer-secret'
process.env.MPESA_SHORTCODE = '600000'
process.env.MPESA_PASSKEY = 'test-passkey'
process.env.MPESA_CALLBACK_URL = 'https://callback.example.test/payments/callback'

const calls = []
const axiosPath = require.resolve('axios')
const configPath = require.resolve('../src/config/mpesa')
const originalAxios = require.cache[axiosPath]
const originalConfig = require.cache[configPath]
const axiosMock = new Module(axiosPath)
axiosMock.filename = axiosPath
axiosMock.loaded = true
axiosMock.exports = {
  async get(url, options) {
    calls.push({ method: 'get', url, options })
    return { data: { access_token: 'test-access-token' } }
  },
  async post(url, body, options) {
    calls.push({ method: 'post', url, body, options })
    return { data: { ResponseCode: '0', CheckoutRequestID: body.CheckoutRequestID } }
  }
}
require.cache[axiosPath] = axiosMock
delete require.cache[configPath]
const mpesa = require('../src/config/mpesa')

test.after(() => {
  delete require.cache[configPath]
  if (originalConfig) require.cache[configPath] = originalConfig
  if (originalAxios) require.cache[axiosPath] = originalAxios
  else delete require.cache[axiosPath]
})

test('STK query uses the existing sandbox credentials and exact checkout ID without network access in the test', async () => {
  calls.length = 0
  const checkoutRequestId = 'ws_CO_test_query_123'
  const result = await mpesa.stkPushQuery({ checkoutRequestId })
  assert.equal(result.CheckoutRequestID, checkoutRequestId)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].method, 'get')
  assert.match(calls[0].url, /^https:\/\/sandbox\.safaricom\.co\.ke\/oauth\/v1\/generate/)
  assert.equal(calls[0].options.timeout, 15000)
  assert.equal(calls[0].options.maxRedirects, 0)
  assert.equal(calls[1].url, 'https://sandbox.safaricom.co.ke/mpesa/stkpushquery/v1/query')
  assert.equal(calls[1].body.CheckoutRequestID, checkoutRequestId)
  assert.equal(calls[1].body.BusinessShortCode, '600000')
  assert.equal(calls[1].options.headers.Authorization, 'Bearer test-access-token')
  assert.equal(Buffer.from(calls[1].body.Password, 'base64').toString(),
    `600000test-passkey${calls[1].body.Timestamp}`)
  assert.match(calls[1].body.Timestamp, /^\d{14}$/)
})

test('STK request sends the supplied integer amount unchanged', async () => {
  calls.length = 0
  await mpesa.stkPush({ phone: '0712345678', amount: 25, invoiceNumber: 'INV-TEST' })
  const request = calls.find((call) => call.method === 'post')
  assert.equal(request.body.Amount, 25)
  assert.equal(request.body.PartyA, '254712345678')
  assert.equal(request.options.timeout, 15000)
  assert.equal(request.options.maxRedirects, 0)
})

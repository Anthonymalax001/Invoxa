const axios = require('axios')

const getAccessToken = async () => {
  const url = 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
  const auth = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
  ).toString('base64')

  const res = await axios.get(url, {
    headers: { Authorization: `Basic ${auth}` }
  })

  return res.data.access_token
}

const stkPush = async ({ phone, amount, invoiceNumber }) => {
  const token = await getAccessToken()
  const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14)
  const password = Buffer.from(
    `${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`
  ).toString('base64')

  // Format phone — convert 07XXXXXXXX to 2547XXXXXXXX
  let formattedPhone = phone.toString().replace(/\s/g, '')
  if (formattedPhone.startsWith('0')) {
    formattedPhone = '254' + formattedPhone.slice(1)
  }
  if (formattedPhone.startsWith('+')) {
    formattedPhone = formattedPhone.slice(1)
  }

  const res = await axios.post(
    'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
    {
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.ceil(amount),
      PartyA: formattedPhone,
      PartyB: process.env.MPESA_SHORTCODE,
      PhoneNumber: formattedPhone,
      CallBackURL: process.env.MPESA_CALLBACK_URL,
      AccountReference: invoiceNumber,
      TransactionDesc: `Payment for ${invoiceNumber}`
    },
    {
      headers: { Authorization: `Bearer ${token}` }
    }
  )

  return res.data
}

module.exports = { getAccessToken, stkPush }
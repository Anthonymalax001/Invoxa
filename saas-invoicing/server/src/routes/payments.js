const express = require('express')
const pool = require('../config/db')
const auth = require('../middleware/auth')
const { stkPush } = require('../config/mpesa')

const router = express.Router()

// GET /api/payments
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, i.invoice_number
       FROM payments p
       JOIN invoices i ON p.invoice_id = i.id
       WHERE p.tenant_id = $1
       ORDER BY p.created_at DESC`,
      [req.user.tenantId]
    )
    res.json(result.rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch payments' })
  }
})

// POST /api/payments/request — STK Push
router.post('/request', auth, async (req, res) => {
  const { invoice_id, phone_number } = req.body

  if (!invoice_id || !phone_number) {
    return res.status(400).json({ error: 'invoice_id and phone_number are required' })
  }

  try {
    // Get invoice details
    const invoiceResult = await pool.query(
      `SELECT * FROM invoices WHERE id=$1 AND tenant_id=$2`,
      [invoice_id, req.user.tenantId]
    )
    if (invoiceResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' })
    }
    const invoice = invoiceResult.rows[0]

    // Initiate STK Push
    const mpesaRes = await stkPush({
      phone: phone_number,
      amount: invoice.total,
      invoiceNumber: invoice.invoice_number
    })

    // Save payment record
    const paymentResult = await pool.query(
      `INSERT INTO payments (tenant_id, invoice_id, amount, phone_number, mpesa_checkout_id, status)
       VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING *`,
      [
        req.user.tenantId,
        invoice_id,
        invoice.total,
        phone_number,
        mpesaRes.CheckoutRequestID
      ]
    )

    res.status(201).json({
      message: 'STK Push sent! Check your phone and enter your M-Pesa PIN.',
      checkoutRequestId: mpesaRes.CheckoutRequestID,
      payment: paymentResult.rows[0]
    })

  } catch (err) {
    console.error('M-Pesa error:', err.response?.data || err.message)
    res.status(500).json({
      error: 'M-Pesa request failed',
      details: err.response?.data || err.message
    })
  }
})

// POST /api/payments/callback — Safaricom calls this
router.post('/callback', async (req, res) => {
  const body = req.body?.Body?.stkCallback

  if (!body) {
    return res.json({ ResultCode: 0, ResultDesc: 'Accepted' })
  }

  const checkoutRequestId = body.CheckoutRequestID
  const resultCode = body.ResultCode

  try {
    if (resultCode === 0) {
      // Payment successful
      const metadata = body.CallbackMetadata?.Item || []
      const receipt = metadata.find(i => i.Name === 'MpesaReceiptNumber')?.Value

      await pool.query(
        `UPDATE payments SET status='success', mpesa_receipt=$1 WHERE mpesa_checkout_id=$2`,
        [receipt || null, checkoutRequestId]
      )

      // Mark invoice as paid
      await pool.query(
        `UPDATE invoices SET status='paid'
         WHERE id = (SELECT invoice_id FROM payments WHERE mpesa_checkout_id=$1)`,
        [checkoutRequestId]
      )
    } else {
      // Payment failed or cancelled
      await pool.query(
        `UPDATE payments SET status='failed' WHERE mpesa_checkout_id=$1`,
        [checkoutRequestId]
      )
    }
  } catch (err) {
    console.error('Callback error:', err)
  }

  res.json({ ResultCode: 0, ResultDesc: 'Accepted' })
})

module.exports = router
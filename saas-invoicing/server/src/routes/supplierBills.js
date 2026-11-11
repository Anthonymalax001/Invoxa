const express = require('express')
const auth = require('../middleware/auth')
const { requireAccountingPermission } = require('../middleware/accountingAuthorization')
const pool = require('../config/db')
const payables = require('../services/supplierPayables')
const { logSafeError } = require('../utils/errorLogging')

const router = express.Router()
const read = [auth, requireAccountingPermission('accounting:read')]
const manage = [auth, requireAccountingPermission('accounting:manage-payables')]

function sendError(res, error, fallback) {
  if (error.statusCode) return res.status(error.statusCode).json({ error: error.message })
  if (error.code === '23505' && error.constraint === 'supplier_bills_supplier_invoice_ci_unique_idx') {
    return res.status(409).json({ error: 'This supplier invoice number is already recorded for this supplier' })
  }
  if (error.code === '23505' && error.constraint === 'supplier_payments_tenant_idempotency_unique') {
    return res.status(409).json({ error: 'This supplier payment request conflicts with an existing request' })
  }
  if (['23503', '23514', '23P01'].includes(error.code)) {
    return res.status(409).json({ error: 'Supplier payable data violates a required financial or tenant constraint' })
  }
  logSafeError(fallback, error)
  return res.status(500).json({ error: fallback })
}

function idempotencyKey(req) {
  return typeof req.get('Idempotency-Key') === 'string' ? req.get('Idempotency-Key') : ''
}

router.get('/payments', ...read, async (req, res) => {
  try {
    const result = await payables.listSupplierPayments(pool, req.user.tenantId, {
      supplierId: req.query.supplier_id || null,
      status: req.query.status || null
    })
    res.json(result)
  } catch (error) {
    sendError(res, error, 'Failed to fetch supplier payments')
  }
})

router.get('/payments/:id', ...read, async (req, res) => {
  try {
    res.json(await payables.getSupplierPayment(pool, req.user.tenantId, req.params.id))
  } catch (error) {
    sendError(res, error, 'Failed to fetch supplier payment')
  }
})

router.post('/payments', ...manage, async (req, res) => {
  try {
    const result = await payables.createSupplierPayment(pool, {
      tenantId: req.user.tenantId, userId: req.user.userId,
      idempotencyKey: idempotencyKey(req), body: req.body
    })
    res.status(result.replayed ? 200 : 201).json(result)
  } catch (error) {
    sendError(res, error, 'Failed to record supplier payment')
  }
})

router.post('/payments/:id/verify', ...manage, async (req, res) => {
  try {
    res.json(await payables.verifySupplierPayment(pool, {
      tenantId: req.user.tenantId, userId: req.user.userId,
      paymentId: req.params.id, body: req.body
    }))
  } catch (error) {
    sendError(res, error, 'Failed to verify supplier payment')
  }
})

router.post('/payments/:id/fail', ...manage, async (req, res) => {
  try {
    res.json(await payables.failSupplierPayment(pool, {
      tenantId: req.user.tenantId, userId: req.user.userId,
      paymentId: req.params.id, body: req.body
    }))
  } catch (error) {
    sendError(res, error, 'Failed to mark supplier payment failed')
  }
})

router.post('/payments/:id/reverse', ...manage, async (req, res) => {
  try {
    res.json(await payables.reverseSupplierPayment(pool, {
      tenantId: req.user.tenantId, userId: req.user.userId,
      paymentId: req.params.id, idempotencyKey: idempotencyKey(req), body: req.body
    }))
  } catch (error) {
    sendError(res, error, 'Failed to reverse supplier payment')
  }
})

router.get('/', ...read, async (req, res) => {
  try {
    const result = await payables.listSupplierBills(pool, req.user.tenantId, {
      supplierId: req.query.supplier_id || null,
      status: req.query.status || null,
      search: typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : ''
    })
    res.json(result)
  } catch (error) {
    sendError(res, error, 'Failed to fetch supplier bills')
  }
})

router.post('/', ...manage, async (req, res) => {
  try {
    const result = await payables.createSupplierBill(pool, {
      tenantId: req.user.tenantId, userId: req.user.userId,
      idempotencyKey: idempotencyKey(req), body: req.body
    })
    res.status(result.replayed ? 200 : 201).json(result)
  } catch (error) {
    sendError(res, error, 'Failed to create supplier bill')
  }
})

router.get('/:id', ...read, async (req, res) => {
  try {
    res.json(await payables.getSupplierBill(pool, req.user.tenantId, req.params.id))
  } catch (error) {
    sendError(res, error, 'Failed to fetch supplier bill')
  }
})

router.put('/:id', ...manage, async (req, res) => {
  try {
    res.json(await payables.updateSupplierBill(pool, {
      tenantId: req.user.tenantId, userId: req.user.userId,
      billId: req.params.id, idempotencyKey: idempotencyKey(req), body: req.body
    }))
  } catch (error) {
    sendError(res, error, 'Failed to update supplier bill')
  }
})

router.post('/:id/submit', ...manage, async (req, res) => {
  try {
    res.json(await payables.submitSupplierBill(pool, {
      tenantId: req.user.tenantId, userId: req.user.userId, billId: req.params.id
    }))
  } catch (error) {
    sendError(res, error, 'Failed to submit supplier bill')
  }
})

router.post('/:id/approve', ...manage, async (req, res) => {
  try {
    res.json(await payables.approveSupplierBill(pool, {
      tenantId: req.user.tenantId, userId: req.user.userId,
      billId: req.params.id, body: req.body
    }))
  } catch (error) {
    sendError(res, error, 'Failed to approve supplier bill')
  }
})

router.post('/:id/cancel', ...manage, async (req, res) => {
  try {
    res.json(await payables.cancelSupplierBill(pool, {
      tenantId: req.user.tenantId, userId: req.user.userId,
      billId: req.params.id, body: req.body
    }))
  } catch (error) {
    sendError(res, error, 'Failed to cancel supplier bill')
  }
})

router.post('/:id/reverse', ...manage, async (req, res) => {
  try {
    res.json(await payables.reverseSupplierBill(pool, {
      tenantId: req.user.tenantId, userId: req.user.userId,
      billId: req.params.id, idempotencyKey: idempotencyKey(req), body: req.body
    }))
  } catch (error) {
    sendError(res, error, 'Failed to reverse supplier bill')
  }
})

module.exports = router

const express = require('express')
const auth = require('../middleware/auth')
const { requireAccountingPermission } = require('../middleware/accountingAuthorization')
const service = require('../services/bankReconciliation')
const { logSafeError } = require('../utils/errorLogging')

const router = express.Router()
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {}

function sendError(res, error, fallback) {
  if (error.statusCode) return res.status(error.statusCode).json({ error: error.message })
  if (error.code === '23505') return res.status(409).json({ error: 'A bank reconciliation record conflicts with an existing record' })
  if (['23503', '23514', '23P01'].includes(error.code)) return res.status(409).json({ error: 'The operation conflicts with a bank reconciliation or accounting integrity rule' })
  logSafeError(fallback, error)
  return res.status(500).json({ error: fallback })
}

router.get('/accounts', auth, requireAccountingPermission('accounting:read'), async (req, res) => {
  try { res.json(await service.listAccounts(req.user.tenantId)) }
  catch (error) { sendError(res, error, 'Failed to fetch reconciliation bank accounts') }
})

router.get('/account-candidates', auth, requireAccountingPermission('accounting:read'), async (req, res) => {
  try { res.json(await service.listAccountCandidates(req.user.tenantId)) }
  catch (error) { sendError(res, error, 'Failed to fetch eligible account candidates') }
})

router.post('/accounts', auth, requireAccountingPermission('accounting:manage-bank-reconciliation'), async (req, res) => {
  try {
    const created = await service.enableAccount(req.user.tenantId, req.user.userId, object(req.body))
    res.status(201).json(created)
  } catch (error) { sendError(res, error, 'Failed to enable the reconciliation bank account') }
})

router.post('/imports/preview', auth, requireAccountingPermission('accounting:read'), async (req, res) => {
  try { res.json(await service.previewImport(req.user.tenantId, object(req.body))) }
  catch (error) { sendError(res, error, 'Failed to validate bank statement CSV') }
})

router.post('/imports', auth, requireAccountingPermission('accounting:manage-bank-reconciliation'), async (req, res) => {
  try {
    const result = await service.importStatement(req.user.tenantId, req.user.userId, object(req.body), req.get('Idempotency-Key'))
    res.status(result.replayed ? 200 : 201).json(result)
  } catch (error) { sendError(res, error, 'Failed to import bank statement') }
})

router.get('/imports', auth, requireAccountingPermission('accounting:read'), async (req, res) => {
  try {
    res.json(await service.listImports(req.user.tenantId, {
      accountId: req.query.account_id, page: req.query.page, pageSize: req.query.page_size
    }))
  } catch (error) { sendError(res, error, 'Failed to fetch bank statement imports') }
})

router.get('/imports/:id', auth, requireAccountingPermission('accounting:read'), async (req, res) => {
  try {
    res.json(await service.getBatch(req.user.tenantId, req.params.id, {
      page: req.query.page, pageSize: req.query.page_size
    }))
  } catch (error) { sendError(res, error, 'Failed to fetch bank reconciliation details') }
})

router.post('/imports/:id/reconcile', auth, requireAccountingPermission('accounting:manage-bank-reconciliation'), async (req, res) => {
  try { res.json(await service.reconcileBatch(req.user.tenantId, req.user.userId, req.params.id, object(req.body))) }
  catch (error) { sendError(res, error, 'Failed to complete bank reconciliation') }
})

router.post('/imports/:id/reopen', auth, requireAccountingPermission('accounting:manage-bank-reconciliation'), async (req, res) => {
  try { res.json(await service.reopenBatch(req.user.tenantId, req.user.userId, req.params.id, object(req.body))) }
  catch (error) { sendError(res, error, 'Failed to reopen bank reconciliation') }
})

router.get('/transactions/:id/suggestions', auth, requireAccountingPermission('accounting:read'), async (req, res) => {
  try { res.json(await service.getSuggestions(req.user.tenantId, req.params.id, req.query.limit)) }
  catch (error) { sendError(res, error, 'Failed to find matching ledger transactions') }
})

router.post('/transactions/:id/match', auth, requireAccountingPermission('accounting:manage-bank-reconciliation'), async (req, res) => {
  try {
    const result = await service.matchTransaction(req.user.tenantId, req.user.userId, req.params.id, object(req.body))
    res.status(201).json(result)
  } catch (error) { sendError(res, error, 'Failed to match bank transaction') }
})

router.post('/transactions/:id/unmatch', auth, requireAccountingPermission('accounting:manage-bank-reconciliation'), async (req, res) => {
  try { res.json(await service.unmatchTransaction(req.user.tenantId, req.user.userId, req.params.id, object(req.body))) }
  catch (error) { sendError(res, error, 'Failed to release bank transaction match') }
})

router.post('/transactions/:id/adjustment', auth, requireAccountingPermission('accounting:manage-bank-reconciliation'), async (req, res) => {
  try {
    const result = await service.postAdjustment(
      req.user.tenantId, req.user.userId, req.params.id, object(req.body), req.get('Idempotency-Key')
    )
    res.status(result.replayed ? 200 : 201).json(result)
  } catch (error) { sendError(res, error, 'Failed to post bank transaction adjustment') }
})

module.exports = router

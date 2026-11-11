const express = require('express')
const { validate: isUuid } = require('uuid')
const pool = require('../config/db')
const auth = require('../middleware/auth')
const { requireAccountingPermission } = require('../middleware/accountingAuthorization')
const { postJournal, reverseJournal, withTransaction } = require('../services/accounting')
const { closeAccountingPeriod, getAccountingPeriodReadiness } = require('../services/accountingPeriodClose')
const {
  cancelOpeningBalanceDraft,
  createOpeningBalanceDraft,
  getAccountingCutoverPreview,
  getOpeningBalanceBatch,
  listOpeningBalanceBatches,
  postOpeningBalanceDraft,
  reverseOpeningBalance
} = require('../services/accountingCutover')
const {
  getBalanceSheet,
  getCashFlow,
  getGeneralLedger,
  getProfitAndLoss,
  getTrialBalance
} = require('../services/financialReports')
const {
  httpError,
  normalizeAccount,
  normalizeCurrency,
  normalizePeriod,
  text,
  validationError
} = require('../utils/accounting')
const { normalizeTaxProfileInput } = require('../utils/invoiceTax')
const { logSafeError } = require('../utils/errorLogging')
const { valueOpeningStock } = require('../services/inventoryAccounting')

const router = express.Router()

function sendError(res, error, fallback) {
  if (error.statusCode) return res.status(error.statusCode).json({ error: error.message })
  if (error.code === '23505') return res.status(409).json({ error: 'Accounting record conflicts with an existing record' })
  if (error.code === '23P01') return res.status(409).json({ error: 'Accounting periods may not overlap' })
  if (error.code === '23503' || error.code === '23514') {
    return res.status(409).json({ error: 'Accounting operation violates a required integrity rule' })
  }
  logSafeError(fallback, error)
  return res.status(500).json({ error: fallback })
}

function requestObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function optionalAccountSetting(source, field, label) {
  if (!Object.hasOwn(source, field)) return undefined
  const value = source[field]
  if (value == null || value === '') return null
  if (!isUuid(value)) throw validationError(`${label} must be a valid account or null`)
  return value.toLowerCase()
}

async function validateExpenseAccountSetting(client, tenantId, accountId, { accountType, normalBalance, label }) {
  if (!accountId) return
  const result = await client.query(
    `SELECT id, account_type, normal_balance, is_active
     FROM accounting_accounts WHERE tenant_id = $1 AND id = $2 FOR SHARE`,
    [tenantId, accountId]
  )
  if (result.rowCount !== 1) throw httpError(400, `${label} must belong to this tenant`)
  const account = result.rows[0]
  if (!account.is_active || account.account_type !== accountType || account.normal_balance !== normalBalance) {
    throw httpError(400, `${label} must be an active tenant ${accountType} ${normalBalance}-normal account`)
  }
}

function dateFilter(value, label) {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw validationError(`${label} must use YYYY-MM-DD`)
  }
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw validationError(`${label} is invalid`)
  }
  return value
}

router.get('/settings', auth, requireAccountingPermission('accounting:read'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT tenant_id, base_currency, expense_payable_account_id, input_vat_account_id,
              created_by, created_at, updated_at
       FROM accounting_settings WHERE tenant_id = $1`,
      [req.user.tenantId]
    )
    res.json(result.rows[0] || null)
  } catch (error) {
    sendError(res, error, 'Failed to fetch accounting settings')
  }
})

router.post('/inventory-opening-stock', auth, requireAccountingPermission('accounting:manage-opening-balances'), async (req, res) => {
  const source = requestObject(req.body)
  let quantity
  let unitCost
  let entryDate
  let sourceReference
  let notes
  try {
    if (!isUuid(source.product_id)) throw validationError('Product ID must be a valid UUID')
    if (typeof source.quantity !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(source.quantity)) {
      throw validationError('Opening quantity must be a non-negative decimal with at most three decimal places')
    }
    if (typeof source.unit_cost !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(source.unit_cost)) {
      throw validationError('Opening unit cost must be a non-negative decimal with at most six decimal places')
    }
    entryDate = dateFilter(source.entry_date, 'Opening date')
    if (!entryDate) throw validationError('Opening date is required')
    sourceReference = text(source.reference, 'Opening stock reference', 100, { required: true })
    notes = text(source.notes, 'Opening stock notes', 10000)
    if (!req.get('Idempotency-Key')) throw validationError('Idempotency-Key is required')
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message })
  }
  try {
    const result = await withTransaction(pool, (client) => valueOpeningStock(client, {
      tenantId: req.user.tenantId, userId: req.user.userId, productId: source.product_id,
      quantity: source.quantity, unitCost: source.unit_cost, entryDate,
      sourceReference, notes, idempotencyKey: req.get('Idempotency-Key')
    }))
    res.status(result.replayed ? 200 : 201).json(result)
  } catch (error) {
    sendError(res, error, 'Failed to value opening stock')
  }
})

router.put('/settings', auth, requireAccountingPermission('accounting:manage-settings'), async (req, res) => {
  let currency
  let expensePayableAccountId
  let inputVatAccountId
  try {
    const source = requestObject(req.body)
    currency = normalizeCurrency(source.base_currency, 'Base currency')
    expensePayableAccountId = optionalAccountSetting(source, 'expense_payable_account_id', 'Expense accounts-payable account')
    inputVatAccountId = optionalAccountSetting(source, 'input_vat_account_id', 'Input VAT account')
    if (!isUuid(req.user.userId)) throw httpError(401, 'Authenticated user identity is required')
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message })
  }
  try {
    const settings = await withTransaction(pool, async (client) => {
      const tenant = await client.query('SELECT id FROM tenants WHERE id = $1 FOR UPDATE', [req.user.tenantId])
      if (tenant.rowCount !== 1) throw httpError(404, 'Tenant not found')
      const current = await client.query(
        `SELECT tenant_id, base_currency, expense_payable_account_id, input_vat_account_id,
                created_by, created_at, updated_at
         FROM accounting_settings WHERE tenant_id = $1 FOR UPDATE`,
        [req.user.tenantId]
      )
      const payableAccountId = expensePayableAccountId === undefined
        ? current.rows[0]?.expense_payable_account_id || null : expensePayableAccountId
      const vatAccountId = inputVatAccountId === undefined
        ? current.rows[0]?.input_vat_account_id || null : inputVatAccountId
      await validateExpenseAccountSetting(client, req.user.tenantId, payableAccountId, {
        accountType: 'liability', normalBalance: 'credit', label: 'Expense accounts-payable account'
      })

      await validateExpenseAccountSetting(client, req.user.tenantId, vatAccountId, {
        accountType: 'asset', normalBalance: 'debit', label: 'Input VAT account'
      })
      if (current.rowCount === 0) {
        const inserted = await client.query(
          `INSERT INTO accounting_settings
             (tenant_id, base_currency, expense_payable_account_id, input_vat_account_id, created_by)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING tenant_id, base_currency, expense_payable_account_id, input_vat_account_id,
                     created_by, created_at, updated_at`,
          [req.user.tenantId, currency, payableAccountId, vatAccountId, req.user.userId]
        )
        return inserted.rows[0]
      }
      if (current.rows[0].base_currency === currency &&
          current.rows[0].expense_payable_account_id === payableAccountId &&
          current.rows[0].input_vat_account_id === vatAccountId) return current.rows[0]

      if (current.rows[0].base_currency !== currency) {
        const entries = await client.query(
          'SELECT 1 FROM accounting_journal_entries WHERE tenant_id = $1 LIMIT 1',
          [req.user.tenantId]
        )
        if (entries.rowCount > 0) throw httpError(409, 'Base currency cannot change after journal entries exist')
      }
      const updated = await client.query(
        `UPDATE accounting_settings SET base_currency = $1, expense_payable_account_id = $2,
             input_vat_account_id = $3, updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = $4
         RETURNING tenant_id, base_currency, expense_payable_account_id, input_vat_account_id,
                   created_by, created_at, updated_at`,
        [currency, payableAccountId, vatAccountId, req.user.tenantId]
      )
      return updated.rows[0]
    })
    res.json(settings)
  } catch (error) {
    sendError(res, error, 'Failed to save accounting settings')
  }
})

router.get('/inventory-settings', auth, requireAccountingPermission('accounting:read'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT tenant_id, inventory_asset_account_id, inventory_cogs_account_id,
              inventory_adjustment_account_id, inventory_clearing_account_id,
              inventory_opening_balance_account_id
       FROM accounting_settings WHERE tenant_id = $1`,
      [req.user.tenantId]
    )
    res.json(result.rows[0] || null)
  } catch (error) {
    sendError(res, error, 'Failed to fetch inventory accounting settings')
  }
})

router.put('/inventory-settings', auth, requireAccountingPermission('accounting:manage-settings'), async (req, res) => {
  const source = requestObject(req.body)
  let values
  try {
    values = {
      inventory_asset_account_id: optionalAccountSetting(source, 'inventory_asset_account_id', 'Inventory asset account'),
      inventory_cogs_account_id: optionalAccountSetting(source, 'inventory_cogs_account_id', 'Inventory COGS account'),
      inventory_adjustment_account_id: optionalAccountSetting(source, 'inventory_adjustment_account_id', 'Inventory adjustment account'),
      inventory_clearing_account_id: optionalAccountSetting(source, 'inventory_clearing_account_id', 'Inventory clearing account'),
      inventory_opening_balance_account_id: optionalAccountSetting(source, 'inventory_opening_balance_account_id', 'Inventory opening-balance account')
    }
    if (Object.values(values).some((value) => value === undefined)) {
      throw validationError('All inventory accounting account mappings are required')
    }
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message })
  }
  try {
    const result = await withTransaction(pool, async (client) => {
      const current = await client.query(
        `SELECT tenant_id FROM accounting_settings WHERE tenant_id = $1 FOR UPDATE`,
        [req.user.tenantId]
      )
      if (current.rowCount !== 1) throw httpError(404, 'Accounting settings not found')
      await validateExpenseAccountSetting(client, req.user.tenantId, values.inventory_asset_account_id, {
        accountType: 'asset', normalBalance: 'debit', label: 'Inventory asset account'
      })
      await validateExpenseAccountSetting(client, req.user.tenantId, values.inventory_cogs_account_id, {
        accountType: 'expense', normalBalance: 'debit', label: 'Inventory COGS account'
      })
      await validateExpenseAccountSetting(client, req.user.tenantId, values.inventory_adjustment_account_id, {
        accountType: 'expense', normalBalance: 'debit', label: 'Inventory adjustment account'
      })
      await validateExpenseAccountSetting(client, req.user.tenantId, values.inventory_clearing_account_id, {
        accountType: 'liability', normalBalance: 'credit', label: 'Inventory clearing account'
      })
      await validateExpenseAccountSetting(client, req.user.tenantId, values.inventory_opening_balance_account_id, {
        accountType: 'equity', normalBalance: 'credit', label: 'Inventory opening-balance account'
      })
      const updated = await client.query(
        `UPDATE accounting_settings SET inventory_asset_account_id = $1,
           inventory_cogs_account_id = $2, inventory_adjustment_account_id = $3,
           inventory_clearing_account_id = $4, inventory_opening_balance_account_id = $5,
           updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = $6
         RETURNING tenant_id, inventory_asset_account_id, inventory_cogs_account_id,
                   inventory_adjustment_account_id, inventory_clearing_account_id,
                   inventory_opening_balance_account_id`,
        [values.inventory_asset_account_id, values.inventory_cogs_account_id,
          values.inventory_adjustment_account_id, values.inventory_clearing_account_id,
          values.inventory_opening_balance_account_id, req.user.tenantId]
      )
      return updated.rows[0]
    })
    res.json(result)
  } catch (error) {
    sendError(res, error, 'Failed to save inventory accounting settings')
  }
})

router.get('/accounts', auth, requireAccountingPermission('accounting:read'), async (req, res) => {
  let active = null
  if (req.query.active === 'true') active = true
  else if (req.query.active === 'false') active = false
  else if (req.query.active != null && req.query.active !== 'all') {
    return res.status(400).json({ error: 'Invalid active filter' })
  }
  try {
    const result = await pool.query(
      `SELECT id, tenant_id, account_code, name, account_type, normal_balance,
              is_active, is_system, system_key, created_by, created_at, updated_at
       FROM accounting_accounts
       WHERE tenant_id = $1 AND ($2::boolean IS NULL OR is_active = $2)
       ORDER BY account_code, id`,
      [req.user.tenantId, active]
    )
    res.json(result.rows)
  } catch (error) {
    sendError(res, error, 'Failed to fetch chart of accounts')
  }
})

router.get('/invoice-mappings', auth, requireAccountingPermission('accounting:read'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.tenant_id, m.receivables_account_id, ar.account_code AS receivables_account_code,
              ar.name AS receivables_account_name, m.sales_revenue_account_id,
              revenue.account_code AS sales_revenue_account_code,
              revenue.name AS sales_revenue_account_name, m.updated_by, m.created_at, m.updated_at
       FROM accounting_invoice_mappings m
       JOIN accounting_accounts ar ON ar.tenant_id = m.tenant_id AND ar.id = m.receivables_account_id
       JOIN accounting_accounts revenue ON revenue.tenant_id = m.tenant_id AND revenue.id = m.sales_revenue_account_id
       WHERE m.tenant_id = $1`,
      [req.user.tenantId]
    )
    res.json(result.rows[0] || null)
  } catch (error) {
    sendError(res, error, 'Failed to fetch invoice account mappings')
  }
})

router.put('/invoice-mappings', auth, requireAccountingPermission('accounting:manage-invoice-tax'), async (req, res) => {
  const body = requestObject(req.body)
  const receivablesId = body.receivables_account_id
  const revenueId = body.sales_revenue_account_id
  if (!isUuid(req.user.userId)) return res.status(401).json({ error: 'Authenticated user identity is required' })
  if (!isUuid(receivablesId) || !isUuid(revenueId) || receivablesId === revenueId) {
    return res.status(400).json({ error: 'Valid distinct receivables and sales revenue accounts are required' })
  }
  try {
    const mappings = await withTransaction(pool, async (client) => {
      const tenant = await client.query('SELECT id FROM tenants WHERE id = $1 FOR UPDATE', [req.user.tenantId])
      if (tenant.rowCount !== 1) throw httpError(404, 'Tenant not found')
      const accounts = await client.query(
        `SELECT id, account_type, is_active FROM accounting_accounts
         WHERE tenant_id = $1 AND id = ANY($2::uuid[]) FOR SHARE`,
        [req.user.tenantId, [receivablesId, revenueId]]
      )
      const byId = new Map(accounts.rows.map((account) => [account.id, account]))
      if (byId.size !== 2 || !byId.get(receivablesId)?.is_active ||
          byId.get(receivablesId)?.account_type !== 'asset' || !byId.get(revenueId)?.is_active ||
          byId.get(revenueId)?.account_type !== 'revenue') {
        throw httpError(409, 'Mappings require active tenant-owned asset receivables and revenue accounts')
      }
      const result = await client.query(
        `INSERT INTO accounting_invoice_mappings
           (tenant_id, receivables_account_id, sales_revenue_account_id, updated_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id) DO UPDATE
           SET receivables_account_id = EXCLUDED.receivables_account_id,
               sales_revenue_account_id = EXCLUDED.sales_revenue_account_id,
               updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP
         RETURNING tenant_id, receivables_account_id, sales_revenue_account_id,
                   updated_by, created_at, updated_at`,
        [req.user.tenantId, receivablesId, revenueId, req.user.userId]
      )
      return result.rows[0]
    })
    res.json(mappings)
  } catch (error) {
    sendError(res, error, 'Failed to save invoice account mappings')
  }
})

router.get('/tax-profiles', auth, requireAccountingPermission('accounting:read'), async (req, res) => {
  let active = null
  if (req.query.active === 'true') active = true
  else if (req.query.active === 'false') active = false
  else if (req.query.active != null && req.query.active !== 'all') {
    return res.status(400).json({ error: 'Invalid active filter' })
  }
  try {
    const result = await pool.query(
      `SELECT id, tenant_id, profile_key, name, version, tax_rate, calculation_method,
              rounding_method, effective_from, effective_to, requires_tax_payable,
              tax_payable_account_id, is_active, created_by, created_at, updated_at
       FROM accounting_tax_profiles WHERE tenant_id = $1
         AND ($2::boolean IS NULL OR is_active = $2)
       ORDER BY profile_key, version DESC`,
      [req.user.tenantId, active]
    )
    res.json(result.rows)
  } catch (error) {
    sendError(res, error, 'Failed to fetch tax profiles')
  }
})

router.post('/tax-profiles', auth, requireAccountingPermission('accounting:manage-invoice-tax'), async (req, res) => {
  let profile
  try {
    profile = normalizeTaxProfileInput(req.body)
    if (!isUuid(req.user.userId)) throw httpError(401, 'Authenticated user identity is required')
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message })
  }
  try {
    const created = await withTransaction(pool, async (client) => {
      const tenant = await client.query('SELECT id FROM tenants WHERE id = $1 FOR UPDATE', [req.user.tenantId])
      if (tenant.rowCount !== 1) throw httpError(404, 'Tenant not found')
      if (profile.tax_payable_account_id) {
        const payable = await client.query(
          `SELECT account_type, is_active FROM accounting_accounts
           WHERE tenant_id = $1 AND id = $2 FOR SHARE`,
          [req.user.tenantId, profile.tax_payable_account_id]
        )
        if (payable.rowCount !== 1 || payable.rows[0].account_type !== 'liability' || !payable.rows[0].is_active) {
          throw httpError(409, 'Tax profiles require an active tenant-owned liability account')
        }
      }
      const existing = await client.query(
        `SELECT id, effective_from, effective_to, is_active FROM accounting_tax_profiles
         WHERE tenant_id = $1 AND profile_key = $2
         ORDER BY version DESC LIMIT 1 FOR UPDATE`,
        [req.user.tenantId, profile.profile_key]
      )
      let versionResult
      if (existing.rowCount === 1) {
        const current = existing.rows[0]
        const oldStart = String(current.effective_from).slice(0, 10)
        if (profile.effective_from <= oldStart) {
          throw httpError(409, 'A new tax profile version must start after the active version')
        }
        const priorEnd = new Date(`${profile.effective_from}T00:00:00.000Z`)
        priorEnd.setUTCDate(priorEnd.getUTCDate() - 1)
        const priorEndText = priorEnd.toISOString().slice(0, 10)
        await client.query(
          `UPDATE accounting_tax_profiles
           SET is_active = false,
               effective_to = CASE WHEN effective_to IS NULL OR effective_to >= $1::date
                                   THEN $1::date ELSE effective_to END,
               updated_at = CURRENT_TIMESTAMP
           WHERE tenant_id = $2 AND id = $3`,
          [priorEndText, req.user.tenantId, current.id]
        )
      }
      versionResult = await client.query(
        `SELECT COALESCE(MAX(version), 0)::integer + 1 AS next_version
         FROM accounting_tax_profiles WHERE tenant_id = $1 AND profile_key = $2`,
        [req.user.tenantId, profile.profile_key]
      )
      const result = await client.query(
        `INSERT INTO accounting_tax_profiles
           (tenant_id, profile_key, name, version, tax_rate, calculation_method,
            rounding_method, effective_from, effective_to, requires_tax_payable,
            tax_payable_account_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id, tenant_id, profile_key, name, version, tax_rate, calculation_method,
                   rounding_method, effective_from, effective_to, requires_tax_payable,
                   tax_payable_account_id, is_active, created_by, created_at, updated_at`,
        [req.user.tenantId, profile.profile_key, profile.name, versionResult.rows[0].next_version,
          profile.tax_rate, profile.calculation_method, profile.rounding_method,
          profile.effective_from, profile.effective_to, profile.requires_tax_payable,
          profile.tax_payable_account_id, req.user.userId]
      )
      return result.rows[0]
    })
    res.status(201).json(created)
  } catch (error) {
    sendError(res, error, 'Failed to create tax profile version')
  }
})

router.patch('/tax-profiles/:id/deactivate', auth, requireAccountingPermission('accounting:manage-invoice-tax'), async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Tax profile not found' })
  try {
    const result = await pool.query(
      `UPDATE accounting_tax_profiles SET is_active = false, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $1 AND id = $2 AND is_active = true
       RETURNING id, profile_key, name, version, is_active, updated_at`,
      [req.user.tenantId, req.params.id]
    )
    if (result.rowCount !== 1) return res.status(404).json({ error: 'Tax profile not found' })
    res.json(result.rows[0])
  } catch (error) {
    sendError(res, error, 'Failed to deactivate tax profile')
  }
})

router.post('/accounts', auth, requireAccountingPermission('accounting:manage-accounts'), async (req, res) => {
  let account
  try {
    account = normalizeAccount(req.body)
    if (!isUuid(req.user.userId)) throw httpError(401, 'Authenticated user identity is required')
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message })
  }
  try {
    const result = await pool.query(
      `INSERT INTO accounting_accounts
         (tenant_id, account_code, name, account_type, normal_balance, is_system, created_by)
       VALUES ($1, $2, $3, $4, $5, false, $6)
       RETURNING id, tenant_id, account_code, name, account_type, normal_balance,
                 is_active, is_system, system_key, created_by, created_at, updated_at`,
      [req.user.tenantId, account.account_code, account.name, account.account_type,
        account.normal_balance, req.user.userId]
    )
    res.status(201).json(result.rows[0])
  } catch (error) {
    sendError(res, error, 'Failed to create account')
  }
})

router.patch('/accounts/:id', auth, requireAccountingPermission('accounting:manage-accounts'), async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Account not found' })
  const body = requestObject(req.body)
  const hasName = Object.hasOwn(body, 'name')
  const hasActive = Object.hasOwn(body, 'is_active')
  if (!hasName && !hasActive) return res.status(400).json({ error: 'Provide a name or active status to update' })
  if (hasActive && typeof body.is_active !== 'boolean') {
    return res.status(400).json({ error: 'Active status must be true or false' })
  }
  let name
  try {
    if (hasName) name = text(body.name, 'Account name', 150, { required: true })
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message })
  }
  try {
    const updated = await withTransaction(pool, async (client) => {
      const current = await client.query(
        `SELECT a.id, a.is_system, a.name,
                EXISTS (SELECT 1 FROM accounting_journal_lines l
                        WHERE l.tenant_id = a.tenant_id AND l.account_id = a.id) AS is_used
         FROM accounting_accounts a
         WHERE a.id = $1 AND a.tenant_id = $2 FOR UPDATE`,
        [req.params.id, req.user.tenantId]
      )
      if (current.rowCount !== 1) throw httpError(404, 'Account not found')
      if (current.rows[0].is_system && hasActive && !body.is_active) {
        throw httpError(409, 'System accounts cannot be deactivated')
      }
      if (hasName && current.rows[0].is_used && name !== current.rows[0].name) {
        throw httpError(409, 'An account name cannot change after it is used in a journal')
      }
      const result = await client.query(
        `UPDATE accounting_accounts
         SET name = COALESCE($1, name), is_active = COALESCE($2, is_active),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3 AND tenant_id = $4
         RETURNING id, tenant_id, account_code, name, account_type, normal_balance,
                   is_active, is_system, system_key, created_by, created_at, updated_at`,
        [hasName ? name : null, hasActive ? body.is_active : null, req.params.id, req.user.tenantId]
      )
      return result.rows[0]
    })
    res.json(updated)
  } catch (error) {
    sendError(res, error, 'Failed to update account')
  }
})

router.get('/periods', auth, requireAccountingPermission('accounting:read'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, tenant_id, name, starts_on, ends_on, status,
              created_by, closed_by, created_at, closed_at
       FROM accounting_periods WHERE tenant_id = $1
       ORDER BY starts_on DESC, id DESC`,
      [req.user.tenantId]
    )
    res.json(result.rows)
  } catch (error) {
    sendError(res, error, 'Failed to fetch accounting periods')
  }
})

router.get('/periods/:id/readiness', auth, requireAccountingPermission('accounting:read'), async (req, res) => {
  try {
    const readiness = await getAccountingPeriodReadiness(pool, req.user.tenantId, req.params.id)
    res.json(readiness)
  } catch (error) {
    sendError(res, error, 'Failed to assess accounting period readiness')
  }
})

router.post('/periods', auth, requireAccountingPermission('accounting:manage-periods'), async (req, res) => {
  let period
  try {
    period = normalizePeriod(req.body)
    if (!isUuid(req.user.userId)) throw httpError(401, 'Authenticated user identity is required')
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message })
  }
  try {
    const created = await withTransaction(pool, async (client) => {
      const settings = await client.query(
        'SELECT tenant_id FROM accounting_settings WHERE tenant_id = $1 FOR UPDATE',
        [req.user.tenantId]
      )
      if (settings.rowCount !== 1) throw httpError(409, 'Configure accounting currency before creating periods')
      const overlap = await client.query(
        `SELECT id FROM accounting_periods
         WHERE tenant_id = $1 AND daterange(starts_on, ends_on, '[]') && daterange($2::date, $3::date, '[]')
         LIMIT 1`,
        [req.user.tenantId, period.starts_on, period.ends_on]
      )
      if (overlap.rowCount > 0) throw httpError(409, 'Accounting periods may not overlap')
      const result = await client.query(
        `INSERT INTO accounting_periods (tenant_id, name, starts_on, ends_on, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, tenant_id, name, starts_on, ends_on, status,
                   created_by, closed_by, created_at, closed_at`,
        [req.user.tenantId, period.name, period.starts_on, period.ends_on, req.user.userId]
      )
      return result.rows[0]
    })
    res.status(201).json(created)
  } catch (error) {
    sendError(res, error, 'Failed to create accounting period')
  }
})

router.patch('/periods/:id/close', auth, requireAccountingPermission('accounting:close-periods'), async (req, res) => {
  try {
    const result = await closeAccountingPeriod(pool, {
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      periodId: req.params.id,
      idempotencyKey: req.get('Idempotency-Key'),
      reason: requestObject(req.body).reason,
      confirm: requestObject(req.body).confirm
    })
    if (result.outcome === 'blocked') {
      return res.status(409).json({
        error: 'Accounting period is not ready to close',
        outcome: result.outcome,
        replayed: result.replayed,
        period: result.period,
        reason: result.reason,
        readiness: result.readiness
      })
    }
    return res.json(result)
  } catch (error) {
    sendError(res, error, 'Failed to close accounting period')
  }
})

router.get('/opening-balances/cutover-preview', auth, requireAccountingPermission('accounting:read'), async (req, res) => {
  try {
    res.json(await getAccountingCutoverPreview(pool, req.user.tenantId))
  } catch (error) {
    sendError(res, error, 'Failed to assess accounting cutover readiness')
  }
})

router.get('/opening-balances', auth, requireAccountingPermission('accounting:read'), async (req, res) => {
  try {
    res.json(await listOpeningBalanceBatches(pool, req.user.tenantId))
  } catch (error) {
    sendError(res, error, 'Failed to fetch opening-balance cutovers')
  }
})

router.get('/opening-balances/:id', auth, requireAccountingPermission('accounting:read'), async (req, res) => {
  try {
    res.json(await getOpeningBalanceBatch(pool, req.user.tenantId, req.params.id))
  } catch (error) {
    sendError(res, error, 'Failed to fetch opening-balance cutover')
  }
})

router.post('/opening-balances', auth, requireAccountingPermission('accounting:manage-opening-balances'), async (req, res) => {
  try {
    const result = await createOpeningBalanceDraft(pool, {
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      idempotencyKey: req.get('Idempotency-Key'),
      body: req.body
    })
    res.status(result.replayed ? 200 : 201).json(result)
  } catch (error) {
    sendError(res, error, 'Failed to create opening-balance draft')
  }
})

router.post('/opening-balances/:id/post', auth, requireAccountingPermission('accounting:manage-opening-balances'), async (req, res) => {
  try {
    const result = await postOpeningBalanceDraft(pool, {
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      batchId: req.params.id,
      idempotencyKey: req.get('Idempotency-Key'),
      body: req.body
    })
    res.status(result.replayed ? 200 : 201).json(result)
  } catch (error) {
    sendError(res, error, 'Failed to approve and post opening balances')
  }
})

router.post('/opening-balances/:id/cancel', auth, requireAccountingPermission('accounting:manage-opening-balances'), async (req, res) => {
  try {
    const result = await cancelOpeningBalanceDraft(pool, {
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      batchId: req.params.id,
      idempotencyKey: req.get('Idempotency-Key'),
      body: req.body
    })
    res.status(result.replayed ? 200 : 201).json(result)
  } catch (error) {
    sendError(res, error, 'Failed to cancel opening-balance draft')
  }
})

router.post('/opening-balances/:id/reverse', auth, requireAccountingPermission('accounting:manage-opening-balances'), async (req, res) => {
  try {
    const result = await reverseOpeningBalance(pool, {
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      batchId: req.params.id,
      idempotencyKey: req.get('Idempotency-Key'),
      body: req.body
    })
    res.status(result.replayed ? 200 : 201).json(result)
  } catch (error) {
    sendError(res, error, 'Failed to reverse opening-balance cutover')
  }
})

router.get('/journals', auth, requireAccountingPermission('accounting:read'), async (req, res) => {
  let fromDate
  let toDate
  try {
    fromDate = dateFilter(req.query.from, 'Start date')
    toDate = dateFilter(req.query.to, 'End date')
  } catch (error) {
    return res.status(400).json({ error: error.message })
  }
  if (fromDate && toDate && fromDate > toDate) return res.status(400).json({ error: 'Start date must not follow end date' })
  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : ''
  try {
    const result = await pool.query(
      `SELECT j.id, j.tenant_id, j.accounting_period_id, j.entry_date, j.description,
              j.status, j.functional_currency, j.source_type, j.source_id,
              j.source_reference, j.event_type, j.reversal_of_entry_id,
              j.reversal_reason, j.created_by, j.posted_by, j.created_at, j.posted_at,
              count(l.id)::integer AS line_count,
              sum(l.debit) AS debit_total, sum(l.credit) AS credit_total
       FROM accounting_journal_entries j
       JOIN accounting_journal_lines l
         ON l.tenant_id = j.tenant_id AND l.journal_entry_id = j.id
       WHERE j.tenant_id = $1 AND j.status = 'posted'
         AND ($2::date IS NULL OR j.entry_date >= $2::date)
         AND ($3::date IS NULL OR j.entry_date <= $3::date)
         AND ($4 = '' OR j.description ILIKE '%' || $4 || '%'
              OR COALESCE(j.source_reference, '') ILIKE '%' || $4 || '%'
              OR j.source_type ILIKE '%' || $4 || '%')
       GROUP BY j.id
       ORDER BY j.entry_date DESC, j.created_at DESC, j.id DESC LIMIT 500`,
      [req.user.tenantId, fromDate, toDate, search]
    )
    res.json(result.rows)
  } catch (error) {
    sendError(res, error, 'Failed to fetch journal entries')
  }
})

router.get('/journals/:id', auth, requireAccountingPermission('accounting:read'), async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Journal entry not found' })
  try {
    const entry = await pool.query(
      `SELECT * FROM accounting_journal_entries
       WHERE id = $1 AND tenant_id = $2 AND status = 'posted'`,
      [req.params.id, req.user.tenantId]
    )
    if (entry.rowCount !== 1) return res.status(404).json({ error: 'Journal entry not found' })
    const lines = await pool.query(
      `SELECT l.line_number, l.account_id, a.account_code, a.name AS account_name,
              a.account_type, l.description, l.debit, l.credit,
              l.transaction_currency, l.transaction_amount, l.exchange_rate,
              l.exchange_rate_source, l.exchange_rate_at
       FROM accounting_journal_lines l
       JOIN accounting_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
       JOIN accounting_journal_entries j
         ON j.tenant_id = l.tenant_id AND j.id = l.journal_entry_id
       WHERE l.tenant_id = $1 AND l.journal_entry_id = $2 AND j.status = 'posted'
       ORDER BY l.line_number`,
      [req.user.tenantId, req.params.id]
    )
    res.json({ ...entry.rows[0], lines: lines.rows })
  } catch (error) {
    sendError(res, error, 'Failed to fetch journal entry')
  }
})

router.get('/reports/trial-balance', auth, requireAccountingPermission('accounting:read'), async (req, res) => {
  try {
    const report = await getTrialBalance(pool, req.user.tenantId, {
      from: req.query.from,
      to: req.query.to,
      periodId: req.query.period_id
    })
    res.json(report)
  } catch (error) {
    sendError(res, error, 'Failed to generate trial balance')
  }
})

router.get('/reports/general-ledger', auth, requireAccountingPermission('accounting:read'), async (req, res) => {
  try {
    const report = await getGeneralLedger(pool, req.user.tenantId, {
      accountId: req.query.account_id,
      from: req.query.from,
      to: req.query.to,
      periodId: req.query.period_id,
      asOf: req.query.as_of,
      reference: req.query.reference,
      page: req.query.page,
      pageSize: req.query.page_size
    })
    res.json(report)
  } catch (error) {
    sendError(res, error, 'Failed to generate general ledger')
  }
})

router.get('/reports/profit-and-loss', auth, requireAccountingPermission('accounting:read'), async (req, res) => {
  try {
    const report = await getProfitAndLoss(pool, req.user.tenantId, {
      from: req.query.from,
      to: req.query.to,
      periodId: req.query.period_id
    })
    res.json(report)
  } catch (error) {
    sendError(res, error, 'Failed to generate profit and loss statement')
  }
})

router.get('/reports/balance-sheet', auth, requireAccountingPermission('accounting:read'), async (req, res) => {
  try {
    const report = await getBalanceSheet(pool, req.user.tenantId, {
      asOf: req.query.as_of,
      periodId: req.query.period_id
    })
    res.json(report)
  } catch (error) {
    sendError(res, error, 'Failed to generate balance sheet')
  }
})

router.get('/reports/cash-flow', auth, requireAccountingPermission('accounting:read'), async (req, res) => {
  try {
    const report = await getCashFlow(pool, req.user.tenantId, {
      from: req.query.from,
      to: req.query.to,
      periodId: req.query.period_id,
      asOf: req.query.as_of
    })
    res.json(report)
  } catch (error) {
    sendError(res, error, 'Failed to generate cash flow statement')
  }
})

router.post('/journals/:id/reverse', auth, requireAccountingPermission('accounting:reverse-journals'), async (req, res) => {
  try {
    const result = await reverseJournal(pool, {
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      journalId: req.params.id,
      idempotencyKey: req.get('Idempotency-Key'),
      reversalDate: requestObject(req.body).reversal_date,
      periodId: requestObject(req.body).period_id,
      reason: requestObject(req.body).reason
    })
    res.status(result.replayed ? 200 : 201).json(result.journal)
  } catch (error) {
    sendError(res, error, 'Failed to reverse journal entry')
  }
})

module.exports = router

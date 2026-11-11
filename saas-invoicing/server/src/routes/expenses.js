const express = require('express')
const { validate: isUuid } = require('uuid')
const pool = require('../config/db')
const auth = require('../middleware/auth')
const { requireAccountingPermission } = require('../middleware/accountingAuthorization')
const { assertDateNotInClosedPeriod, postJournal, reverseJournal } = require('../services/accounting')
const { logSafeError } = require('../utils/errorLogging')
const { decimalUnits } = require('../utils/accounting')
const {
  date,
  normalizeCategory,
  normalizeExpense,
  normalizeExpenseReversal,
  normalizePaymentTransition
} = require('../utils/expenses')

const router = express.Router()
const EXPENSE_STATUSES = ['draft', 'approved', 'paid', 'cancelled']
const ACCOUNTING_SCHEMA_CODES = new Set(['42P01', '42703', '42883'])

function httpError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function validIdOr404(id, res) {
  if (isUuid(id)) return true
  res.status(404).json({ error: 'Expense not found' })
  return false
}

function sendError(res, error, fallback) {
  if (error.statusCode) return res.status(error.statusCode).json({ error: error.message })
  if (error.code === '23505') return res.status(409).json({ error: 'This expense request conflicts with an existing record' })
  if (ACCOUNTING_SCHEMA_CODES.has(error.code)) {
    return res.status(503).json({ error: 'Expense date could not be checked against accounting periods because the required accounting schema is unavailable' })
  }
  logSafeError(fallback, error)
  return res.status(500).json({ error: fallback })
}

async function withTransaction(work) {
  let client
  let transactionOpen = false
  let releaseError
  try {
    client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      transactionOpen = true
    } catch (error) {
      releaseError = error
      throw error
    }
    const result = await work(client)
    await client.query('COMMIT')
    transactionOpen = false
    return result
  } catch (error) {
    if (client && transactionOpen) {
      try {
        await client.query('ROLLBACK')
        transactionOpen = false
      } catch (rollbackError) {
        releaseError = rollbackError
        logSafeError('Failed to roll back expense transaction', rollbackError)
      }
    }
    throw error
  } finally {
    if (client) client.release(releaseError)
  }
}

async function requireCategory(client, tenantId, categoryId) {
  const result = await client.query(
    `SELECT id FROM expense_categories
     WHERE id = $1 AND tenant_id = $2 AND is_active = true FOR SHARE`,
    [categoryId, tenantId]
  )
  if (result.rowCount !== 1) throw httpError(404, 'Expense category not found')
}

async function requireSupplier(client, tenantId, supplierId) {
  if (!supplierId) return
  const result = await client.query(
    `SELECT id FROM suppliers
     WHERE id = $1 AND tenant_id = $2 AND is_active = true FOR SHARE`,
    [supplierId, tenantId]
  )
  if (result.rowCount !== 1) throw httpError(404, 'Supplier not found')
}

async function defaultExpenseAccountForTenant(client, tenantId) {
  const result = await client.query(
    `SELECT id FROM accounting_accounts
     WHERE tenant_id = $1 AND is_active = true AND account_type = 'expense' AND normal_balance = 'debit'
     ORDER BY account_code, id FOR SHARE`,
    [tenantId]
  )
  // A unique eligible account is an unambiguous setup default. Never choose
  // arbitrarily when a tenant has more than one expense account.
  return result.rowCount === 1 ? result.rows[0].id : null
}

async function expenseDetails(queryable, tenantId, expenseId) {
  const result = await queryable.query(
    `SELECT e.*, c.name AS category_name, c.accounting_account_id,
            a.account_code AS expense_account_code, a.name AS expense_account_name,
            s.business_name AS supplier_name
     FROM expenses e
     JOIN expense_categories c ON c.id = e.category_id AND c.tenant_id = e.tenant_id
     LEFT JOIN accounting_accounts a ON a.tenant_id = c.tenant_id AND a.id = c.accounting_account_id
     LEFT JOIN suppliers s ON s.id = e.supplier_id AND s.tenant_id = e.tenant_id
     WHERE e.id = $1 AND e.tenant_id = $2`,
    [expenseId, tenantId]
  )
  if (result.rowCount !== 1) throw httpError(404, 'Expense not found')
  return result.rows[0]
}

function cents(value, label, { allowZero = false } = {}) {
  return decimalUnits(String(value), 2, label, { allowZero })
}

function journalAmount(centsValue) {
  return `${centsValue / 100n}.${String(centsValue % 100n).padStart(2, '0')}0000`
}

async function requireTenantAccount(client, tenantId, accountId, { types, normalBalance, label }) {
  const result = await client.query(
    `SELECT id, account_type, normal_balance, is_active
     FROM accounting_accounts WHERE tenant_id = $1 AND id = $2 FOR SHARE`,
    [tenantId, accountId]
  )
  if (result.rowCount !== 1) throw httpError(400, `${label} must belong to this tenant`)
  const account = result.rows[0]
  if (!account.is_active || !types.includes(account.account_type) || account.normal_balance !== normalBalance) {
    throw httpError(400, `${label} must be an active tenant ${types.join(' or ')} ${normalBalance}-normal account`)
  }
  return account
}

async function requireExpensePeriod(client, tenantId, entryDate, label) {
  const result = await client.query(
    `SELECT id, status FROM accounting_periods
     WHERE tenant_id = $1 AND $2::date BETWEEN starts_on AND ends_on FOR SHARE`,
    [tenantId, entryDate]
  )
  if (result.rowCount !== 1) throw httpError(409, `An open accounting period is required for the ${label.toLowerCase()}`)
  if (result.rows[0].status !== 'open') throw httpError(409, `${label} falls in a closed accounting period`)
  return result.rows[0].id
}

async function expensePostingSettings(client, tenantId) {
  const result = await client.query(
    `SELECT base_currency, expense_payable_account_id, input_vat_account_id
     FROM accounting_settings WHERE tenant_id = $1 FOR SHARE`,
    [tenantId]
  )
  if (result.rowCount !== 1) throw httpError(409, 'Configure accounting currency and expense accounts before posting expenses')
  return result.rows[0]
}

async function expensePayableAccount(client, tenantId, settings) {
  if (settings.expense_payable_account_id) {
    await requireTenantAccount(client, tenantId, settings.expense_payable_account_id, {
      types: ['liability'], normalBalance: 'credit', label: 'Expense accounts-payable mapping'
    })
    return settings.expense_payable_account_id
  }
  const candidates = await client.query(
    `SELECT id FROM accounting_accounts
     WHERE tenant_id = $1 AND is_active = true AND account_type = 'liability' AND normal_balance = 'credit'
     ORDER BY account_code, id FOR SHARE`,
    [tenantId]
  )
  if (candidates.rowCount !== 1) {
    throw httpError(409, 'Configure the tenant expense accounts-payable account before approving expenses')
  }
  return candidates.rows[0].id
}

async function expenseCategoryAccount(client, tenantId, categoryId) {
  const category = await client.query(
    `SELECT accounting_account_id, name FROM expense_categories
     WHERE tenant_id = $1 AND id = $2 AND is_active = true FOR SHARE`,
    [tenantId, categoryId]
  )
  if (category.rowCount !== 1) throw httpError(404, 'Expense category not found')
  if (!category.rows[0].accounting_account_id) {
    throw httpError(409, 'Map this expense category to an expense account before approval')
  }
  await requireTenantAccount(client, tenantId, category.rows[0].accounting_account_id, {
    types: ['expense'], normalBalance: 'debit', label: 'Expense category mapping'
  })
  return category.rows[0]
}

async function createExpenseRecognition(client, tenantId, userId, expense) {
  if (expense.approval_journal_entry_id) return expense
  const settings = await expensePostingSettings(client, tenantId)
  if (settings.base_currency !== expense.currency.trim()) {
    throw httpError(409, 'Expense currency must match the tenant accounting base currency')
  }
  const category = await expenseCategoryAccount(client, tenantId, expense.category_id)
  const payableAccountId = await expensePayableAccount(client, tenantId, settings)
  const grossCents = cents(expense.amount, 'Expense amount')
  const vatCents = cents(expense.input_vat_amount || '0.00', 'Input VAT amount', { allowZero: true })
  const recoverableVat = expense.input_vat_recoverable === true
  let inputVatAccountId = null
  if (recoverableVat) {
    if (!expense.input_vat_document_reference) {
      throw httpError(409, 'Recoverable input VAT requires a recorded tax document reference')
    }
    if (vatCents >= grossCents) throw httpError(400, 'Recoverable input VAT must be less than the total expense amount')
    if (!settings.input_vat_account_id) {
      throw httpError(409, 'Configure the tenant input VAT asset account before posting recoverable VAT')
    }
    inputVatAccountId = settings.input_vat_account_id
    await requireTenantAccount(client, tenantId, inputVatAccountId, {
      types: ['asset'], normalBalance: 'debit', label: 'Input VAT mapping'
    })
  }
  const periodId = await requireExpensePeriod(client, tenantId, String(expense.expense_date).slice(0, 10), 'Expense date')
  const expenseCents = recoverableVat ? grossCents - vatCents : grossCents
  const lineDescription = `Expense ${expense.expense_number} · ${category.name}`
  const lines = []
  if (expenseCents > 0n) {
    lines.push({ account_id: category.accounting_account_id, description: lineDescription,
      debit: journalAmount(expenseCents), credit: '0' })
  }
  if (recoverableVat) {
    lines.push({ account_id: inputVatAccountId, description: `Recoverable input VAT ${expense.expense_number}`,
      debit: journalAmount(vatCents), credit: '0' })
  }
  lines.push({ account_id: payableAccountId, description: `Accounts payable ${expense.expense_number}`,
    debit: '0', credit: journalAmount(grossCents) })

  const posting = await postJournal(pool, {
    tenantId, userId, idempotencyKey: `expense:${expense.id}:recognition:v1`,
    body: {
      accounting_period_id: periodId,
      entry_date: String(expense.expense_date).slice(0, 10),
      description: `Expense ${expense.expense_number}: ${expense.description}`,
      source_type: 'expense', source_id: expense.id,
      source_reference: expense.expense_number, event_type: 'recognition', lines
    }
  }, { client })
  const nextStatus = expense.status === 'draft' ? 'approved' : expense.status
  const updated = await client.query(
    `UPDATE expenses SET status = $1,
         approved_by = COALESCE(approved_by, $2), approved_at = COALESCE(approved_at, CURRENT_TIMESTAMP),
         approved_payable_account_id = $3, approved_input_vat_account_id = $4,
         approval_journal_entry_id = $5, updated_at = CURRENT_TIMESTAMP
     WHERE tenant_id = $6 AND id = $7 AND status IN ('draft', 'approved', 'paid')
       AND approval_journal_entry_id IS NULL
     RETURNING *`,
    [nextStatus, userId, payableAccountId, inputVatAccountId, posting.journal.id, tenantId, expense.id]
  )
  if (updated.rowCount !== 1) throw httpError(409, 'Expense recognition could not be linked to the expense')
  return updated.rows[0]
}

async function recordExpensePayment(client, tenantId, userId, expense, payment) {
  if (expense.payment_journal_entry_id) {
    if (expense.payment_method !== payment.payment_method ||
        (expense.payment_reference || null) !== payment.payment_reference ||
        expense.paid_cash_account_id !== payment.cash_account_id ||
        String(expense.payment_date).slice(0, 10) !== payment.payment_date) {
      throw httpError(409, 'Expense is already paid using different payment details')
    }
    return expenseDetails(client, tenantId, expense.id)
  }
  if (expense.status !== 'approved' && expense.status !== 'paid') {
    throw httpError(409, 'Only an approved expense can be paid')
  }
  if (!expense.approval_journal_entry_id) {
    expense = await createExpenseRecognition(client, tenantId, userId, expense)
  }
  if (!expense.approved_payable_account_id) throw httpError(409, 'Expense recognition has no accounts-payable account')
  const settings = await expensePostingSettings(client, tenantId)
  if (settings.base_currency !== expense.currency.trim()) {
    throw httpError(409, 'Expense currency must match the tenant accounting base currency')
  }
  await requireTenantAccount(client, tenantId, payment.cash_account_id, {
    types: ['asset'], normalBalance: 'debit', label: 'Payment cash or bank account'
  })
  await requireTenantAccount(client, tenantId, expense.approved_payable_account_id, {
    types: ['liability'], normalBalance: 'credit', label: 'Expense accounts-payable account'
  })
  const periodId = await requireExpensePeriod(client, tenantId, payment.payment_date, 'Payment date')
  const total = journalAmount(cents(expense.amount, 'Expense amount'))
  const posting = await postJournal(pool, {
    tenantId, userId, idempotencyKey: `expense:${expense.id}:payment:v1`,
    body: {
      accounting_period_id: periodId, entry_date: payment.payment_date,
      description: `Payment of expense ${expense.expense_number}`,
      source_type: 'expense', source_id: expense.id,
      source_reference: expense.expense_number, event_type: 'payment',
      lines: [
        { account_id: expense.approved_payable_account_id, description: `Accounts payable ${expense.expense_number}`,
          debit: total, credit: '0' },
        { account_id: payment.cash_account_id, description: `Payment for expense ${expense.expense_number}`,
          debit: '0', credit: total }
      ]
    }
  }, { client })
  const updated = await client.query(
    `UPDATE expenses SET status = 'paid', payment_method = $1, payment_reference = $2,
         payment_date = $3, paid_cash_account_id = $4, payment_journal_entry_id = $5,
         paid_by = COALESCE(paid_by, $6), paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
     WHERE tenant_id = $7 AND id = $8 AND status IN ('approved', 'paid')
       AND payment_journal_entry_id IS NULL
     RETURNING *`,
    [payment.payment_method, payment.payment_reference, payment.payment_date, payment.cash_account_id,
      posting.journal.id, userId, tenantId, expense.id]
  )
  if (updated.rowCount !== 1) throw httpError(409, 'Expense payment could not be linked to the expense')
  return expenseDetails(client, tenantId, expense.id)
}

function normalizeIdempotencyKey(req) {
  const key = req.get('Idempotency-Key')
  if (key == null || key === '') throw httpError(400, 'Idempotency-Key is required')
  const normalized = key.trim()
  if (normalized.length < 8 || normalized.length > 100 || /[\r\n]/.test(normalized)) {
    throw httpError(400, 'Idempotency-Key must contain 8 to 100 characters')
  }
  return normalized
}

function sameExpenseRequest(existing, expense) {
  return String(existing.expense_date).slice(0, 10) === expense.expense_date &&
    existing.category_id === expense.category_id &&
    (existing.supplier_id || null) === expense.supplier_id &&
    (existing.payee_name || null) === expense.payee_name &&
    existing.description === expense.description &&
    String(existing.amount) === expense.amount &&
    existing.currency.trim() === expense.currency &&
    String(existing.input_vat_amount || '0.00') === expense.input_vat_amount &&
    (existing.input_vat_document_reference || null) === expense.input_vat_document_reference &&
    (existing.input_vat_recoverable === true) === expense.input_vat_recoverable &&
    (existing.payment_method || null) === expense.payment_method &&
    (existing.payment_reference || null) === expense.payment_reference &&
    (existing.notes || null) === expense.notes
}

function nairobiToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) }
}

function summaryRange(period) {
  const today = nairobiToday()
  let year = today.year
  let month = today.month
  if (period === 'quarter') month = Math.floor((month - 1) / 3) * 3 + 1
  else if (period === 'year') month = 1
  else if (period !== 'month') throw httpError(400, 'Period must be month, quarter or year')

  const start = `${year}-${String(month).padStart(2, '0')}-01`
  const monthsToAdd = period === 'quarter' ? 3 : period === 'year' ? 12 : 1
  const endDate = new Date(Date.UTC(year, month - 1 + monthsToAdd, 1))
  const endExclusive = `${endDate.getUTCFullYear()}-${String(endDate.getUTCMonth() + 1).padStart(2, '0')}-01`
  const inclusiveEnd = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), 0))
    .toISOString().slice(0, 10)
  return { start, endExclusive, inclusiveEnd }
}

router.get('/categories', auth, async (req, res) => {
  let active = null
  if (req.query.active === 'true') active = true
  else if (req.query.active === 'false') active = false
  else if (req.query.active != null && req.query.active !== 'all') {
    return res.status(400).json({ error: 'Invalid active filter' })
  }
  try {
    const result = await pool.query(
      `SELECT c.*, a.account_code AS expense_account_code, a.name AS expense_account_name,
              (SELECT COUNT(*)::integer FROM expenses e
               WHERE e.tenant_id = c.tenant_id AND e.category_id = c.id) AS expense_count
       FROM expense_categories c
       LEFT JOIN accounting_accounts a ON a.tenant_id = c.tenant_id AND a.id = c.accounting_account_id
       WHERE c.tenant_id = $1 AND ($2::boolean IS NULL OR c.is_active = $2)
       ORDER BY c.is_active DESC, lower(c.name), c.id`,
      [req.user.tenantId, active]
    )
    res.json(result.rows)
  } catch (error) {
    logSafeError('Failed to fetch expense categories', error)
    res.status(500).json({ error: 'Failed to fetch expense categories' })
  }
})

router.post('/categories', auth, async (req, res) => {
  let category
  try {
    category = normalizeCategory(req.body)
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message })
  }
  try {
    if (category.accounting_account_id) return res.status(403).json({ error: 'Use the accounting category mapping control to assign an account' })
    const created = await withTransaction(async (client) => {
      const accountId = await defaultExpenseAccountForTenant(client, req.user.tenantId)
      const result = await client.query(
        `INSERT INTO expense_categories (tenant_id, name, description, accounting_account_id)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [req.user.tenantId, category.name, category.description, accountId]
      )
      return result.rows[0]
    })
    res.status(201).json(created)
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'An expense category with this name already exists' })
    logSafeError('Failed to create expense category', error)
    res.status(500).json({ error: 'Failed to create expense category' })
  }
})

router.patch('/categories/:id/mapping', auth, requireAccountingPermission('accounting:manage-accounts'), async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Expense category not found' })
  const accountId = req.body?.accounting_account_id == null || req.body.accounting_account_id === ''
    ? null : req.body.accounting_account_id
  if (accountId != null && !isUuid(accountId)) return res.status(400).json({ error: 'A valid tenant expense account is required' })
  try {
    const updated = await withTransaction(async (client) => {
      const category = await client.query(
        `SELECT id FROM expense_categories WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [req.user.tenantId, req.params.id]
      )
      if (category.rowCount !== 1) throw httpError(404, 'Expense category not found')
      if (accountId) {
        await requireTenantAccount(client, req.user.tenantId, accountId, {
          types: ['expense'], normalBalance: 'debit', label: 'Expense category mapping'
        })
      }
      const result = await client.query(
        `UPDATE expense_categories SET accounting_account_id = $1, updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = $2 AND id = $3 RETURNING *`,
        [accountId, req.user.tenantId, req.params.id]
      )
      return result.rows[0]
    })
    res.json(updated)
  } catch (error) {
    sendError(res, error, 'Failed to update expense category mapping')
  }
})

router.patch('/categories/:id/deactivate', auth, async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Expense category not found' })
  try {
    const result = await pool.query(
      `UPDATE expense_categories SET is_active = false, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [req.params.id, req.user.tenantId]
    )
    if (result.rowCount !== 1) return res.status(404).json({ error: 'Expense category not found' })
    res.json(result.rows[0])
  } catch (error) {
    logSafeError('Failed to deactivate expense category', error)
    res.status(500).json({ error: 'Failed to deactivate expense category' })
  }
})

router.get('/summary', auth, async (req, res) => {
  let range
  try {
    if (req.query.period != null && typeof req.query.period !== 'string') {
      throw httpError(400, 'Period must be month, quarter or year')
    }
    range = summaryRange(typeof req.query.period === 'string' ? req.query.period : 'month')
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message })
  }
  try {
    const [currencyTotals, statusTotals, categoryTotals] = await Promise.all([
      pool.query(
        `SELECT currency, SUM(amount) AS total,
                SUM(amount) FILTER (WHERE status = 'approved') AS approved_total,
                SUM(amount) FILTER (WHERE status = 'paid') AS paid_total,
                COUNT(*)::integer AS expense_count
         FROM expenses
         WHERE tenant_id = $1 AND expense_date >= $2::date AND expense_date < $3::date
           AND status IN ('approved', 'paid')
         GROUP BY currency ORDER BY currency`,
        [req.user.tenantId, range.start, range.endExclusive]
      ),
      pool.query(
        `SELECT status, currency, SUM(amount) AS total, COUNT(*)::integer AS expense_count
         FROM expenses
         WHERE tenant_id = $1 AND expense_date >= $2::date AND expense_date < $3::date
         GROUP BY status, currency ORDER BY status, currency`,
        [req.user.tenantId, range.start, range.endExclusive]
      ),
      pool.query(
        `SELECT e.category_id, c.name AS category_name, e.currency,
                SUM(e.amount) AS total, COUNT(*)::integer AS expense_count
         FROM expenses e
         JOIN expense_categories c ON c.id = e.category_id AND c.tenant_id = e.tenant_id
         WHERE e.tenant_id = $1 AND e.expense_date >= $2::date AND e.expense_date < $3::date
           AND e.status IN ('approved', 'paid')
         GROUP BY e.category_id, c.name, e.currency
         ORDER BY c.name, e.currency`,
        [req.user.tenantId, range.start, range.endExclusive]
      )
    ])
    res.json({
      period: req.query.period || 'month',
      from: range.start,
      to: range.inclusiveEnd,
      currency_totals: currencyTotals.rows,
      status_totals: statusTotals.rows,
      category_totals: categoryTotals.rows
    })
  } catch (error) {
    logSafeError('Failed to calculate expense summary', error)
    res.status(500).json({ error: 'Failed to calculate expense summary' })
  }
})

router.get('/', auth, async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : ''
  const payee = typeof req.query.payee === 'string' ? req.query.payee.trim().slice(0, 100) : ''
  const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : null
  if (status && !EXPENSE_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid expense status' })
  const categoryId = req.query.category_id || null
  if (categoryId && !isUuid(categoryId)) return res.status(400).json({ error: 'Invalid expense category filter' })
  let fromDate
  let toDate
  try {
    fromDate = req.query.from ? date(req.query.from, 'Start date') : null
    toDate = req.query.to ? date(req.query.to, 'End date') : null
  } catch (error) {
    return res.status(400).json({ error: error.message })
  }
  if (fromDate && toDate && fromDate > toDate) return res.status(400).json({ error: 'Start date must not be after end date' })
  try {
    const result = await pool.query(
      `SELECT e.*, c.name AS category_name, s.business_name AS supplier_name
       FROM expenses e
       JOIN expense_categories c ON c.id = e.category_id AND c.tenant_id = e.tenant_id
       LEFT JOIN suppliers s ON s.id = e.supplier_id AND s.tenant_id = e.tenant_id
       WHERE e.tenant_id = $1
         AND ($2 = '' OR e.expense_number ILIKE '%' || $2 || '%'
              OR e.description ILIKE '%' || $2 || '%'
              OR COALESCE(e.payee_name, '') ILIKE '%' || $2 || '%'
              OR COALESCE(s.business_name, '') ILIKE '%' || $2 || '%')
         AND ($3::text IS NULL OR e.status = $3)
         AND ($4::uuid IS NULL OR e.category_id = $4)
         AND ($5::date IS NULL OR e.expense_date >= $5::date)
         AND ($6::date IS NULL OR e.expense_date <= $6::date)
         AND ($7 = '' OR COALESCE(e.payee_name, '') ILIKE '%' || $7 || '%'
              OR COALESCE(s.business_name, '') ILIKE '%' || $7 || '%')
       ORDER BY e.expense_date DESC, e.created_at DESC, e.id DESC
       LIMIT 500`,
      [req.user.tenantId, search, status, categoryId, fromDate, toDate, payee]
    )
    res.json(result.rows)
  } catch (error) {
    logSafeError('Failed to fetch expenses', error)
    res.status(500).json({ error: 'Failed to fetch expenses' })
  }
})

router.post('/', auth, async (req, res) => {
  let expense
  let idempotencyKey
  try {
    expense = normalizeExpense(req.body)
    idempotencyKey = normalizeIdempotencyKey(req)
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message })
  }
  try {
    const created = await withTransaction(async (client) => {
      const tenantResult = await client.query(
        `SELECT id FROM tenants WHERE id = $1 FOR UPDATE`,
        [req.user.tenantId]
      )
      if (tenantResult.rowCount !== 1) throw httpError(404, 'Expense context not found')
      await assertDateNotInClosedPeriod(client, req.user.tenantId, expense.expense_date, 'Expense date')

      if (idempotencyKey) {
        const previous = await client.query(
          `SELECT * FROM expenses WHERE tenant_id = $1 AND idempotency_key = $2`,
          [req.user.tenantId, idempotencyKey]
        )
        if (previous.rowCount === 1) {
          if (!sameExpenseRequest(previous.rows[0], expense)) {
            throw httpError(409, 'Idempotency-Key was already used for a different expense')
          }
          return { statusCode: 200, body: await expenseDetails(client, req.user.tenantId, previous.rows[0].id) }
        }
      }

      await requireCategory(client, req.user.tenantId, expense.category_id)
      await requireSupplier(client, req.user.tenantId, expense.supplier_id)
      const numberResult = await client.query(
        `SELECT COALESCE(MAX(SUBSTRING(expense_number FROM '^EXP-([0-9]+)$')::numeric), 0) + 1 AS next_number
         FROM expenses WHERE tenant_id = $1 AND expense_number ~ '^EXP-[0-9]+$'`,
        [req.user.tenantId]
      )
      const expenseNumber = `EXP-${BigInt(String(numberResult.rows[0].next_number)).toString().padStart(4, '0')}`
      const inserted = await client.query(
        `INSERT INTO expenses
           (tenant_id, expense_number, expense_date, category_id, supplier_id, payee_name,
            description, amount, currency, input_vat_amount, input_vat_document_reference,
            input_vat_recoverable, payment_method, payment_reference, notes,
            created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         RETURNING id`,
        [req.user.tenantId, expenseNumber, expense.expense_date, expense.category_id,
          expense.supplier_id, expense.payee_name, expense.description, expense.amount,
          expense.currency, expense.input_vat_amount, expense.input_vat_document_reference,
          expense.input_vat_recoverable, expense.payment_method, expense.payment_reference,
          expense.notes, req.user.userId, idempotencyKey]
      )
      return { statusCode: 201, body: await expenseDetails(client, req.user.tenantId, inserted.rows[0].id) }
    })
    res.status(created.statusCode).json(created.body)
  } catch (error) {
    sendError(res, error, 'Failed to create expense')
  }
})

router.get('/:id', auth, async (req, res) => {
  if (!validIdOr404(req.params.id, res)) return
  try {
    res.json(await expenseDetails(pool, req.user.tenantId, req.params.id))
  } catch (error) {
    sendError(res, error, 'Failed to fetch expense')
  }
})

router.put('/:id', auth, async (req, res) => {
  if (!validIdOr404(req.params.id, res)) return
  let expense
  try {
    expense = normalizeExpense(req.body)
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message })
  }
  try {
    const updated = await withTransaction(async (client) => {
      const current = await client.query(
        `SELECT id, status FROM expenses WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [req.params.id, req.user.tenantId]
      )
      if (current.rowCount !== 1) throw httpError(404, 'Expense not found')
      if (current.rows[0].status !== 'draft') throw httpError(409, 'Only draft expenses can be edited')
      await assertDateNotInClosedPeriod(client, req.user.tenantId, expense.expense_date, 'Expense date')
      await requireCategory(client, req.user.tenantId, expense.category_id)
      await requireSupplier(client, req.user.tenantId, expense.supplier_id)
      await client.query(
        `UPDATE expenses SET expense_date = $1, category_id = $2, supplier_id = $3,
             payee_name = $4, description = $5, amount = $6, currency = $7,
             input_vat_amount = $8, input_vat_document_reference = $9, input_vat_recoverable = $10,
             payment_method = $11, payment_reference = $12, notes = $13,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $14 AND tenant_id = $15`,
        [expense.expense_date, expense.category_id, expense.supplier_id, expense.payee_name,
          expense.description, expense.amount, expense.currency, expense.input_vat_amount,
          expense.input_vat_document_reference, expense.input_vat_recoverable, expense.payment_method,
          expense.payment_reference, expense.notes, req.params.id, req.user.tenantId]
      )
      return expenseDetails(client, req.user.tenantId, req.params.id)
    })
    res.json(updated)
  } catch (error) {
    sendError(res, error, 'Failed to update expense')
  }
})

router.patch('/:id/status', auth, requireAccountingPermission('accounting:manage-payables'), async (req, res) => {
  if (!validIdOr404(req.params.id, res)) return
  const targetStatus = req.body && req.body.status
  if (!['approved', 'paid', 'cancelled'].includes(targetStatus)) {
    return res.status(400).json({ error: 'Status can only be changed to approved, paid or cancelled' })
  }
  let payment
  if (targetStatus === 'paid') {
    try {
      payment = normalizePaymentTransition(req.body)
    } catch (error) {
      return res.status(error.statusCode || 400).json({ error: error.message })
    }
  }
  try {
    const updated = await withTransaction(async (client) => {
      const current = await client.query(
        `SELECT * FROM expenses WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [req.params.id, req.user.tenantId]
      )
      if (current.rowCount !== 1) throw httpError(404, 'Expense not found')
      const expense = current.rows[0]

      if (targetStatus === 'approved' && ['draft', 'approved'].includes(expense.status)) {
        await assertDateNotInClosedPeriod(client, req.user.tenantId, expense.expense_date, 'Expense date')
        if (!expense.approval_journal_entry_id) {
          await createExpenseRecognition(client, req.user.tenantId, req.user.userId, expense)
        }
      } else if (targetStatus === 'paid' && ['approved', 'paid'].includes(expense.status)) {
        await recordExpensePayment(client, req.user.tenantId, req.user.userId, expense, payment)
      } else if (targetStatus === 'cancelled' && ['draft', 'approved', 'paid'].includes(expense.status)) {
        const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : ''
        if (!reason || reason.length > 1800) throw httpError(400, 'A cancellation reason of 1 to 1800 characters is required')
        if (expense.approval_journal_entry_id || expense.payment_journal_entry_id) {
          throw httpError(409, 'Posted expense accounting cannot be cancelled directly; use the audited reversal action')
        }
        await assertDateNotInClosedPeriod(client, req.user.tenantId, expense.expense_date, 'Expense date')
        const transition = await client.query(
          `UPDATE expenses SET status = 'cancelled', cancellation_reason = $1,
               cancelled_by = $2, cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = $3 AND tenant_id = $4 AND status = $5
             AND approval_journal_entry_id IS NULL AND payment_journal_entry_id IS NULL`,
          [reason, req.user.userId, expense.id, req.user.tenantId, expense.status]
        )
        if (transition.rowCount !== 1) throw httpError(409, 'Expense could not be cancelled')
      } else if (targetStatus === expense.status && targetStatus === 'cancelled') {
        const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : ''
        if (reason !== expense.cancellation_reason) throw httpError(409, 'Expense was cancelled using a different reason')
      } else {
        throw httpError(409, 'This expense status transition is not allowed')
      }
      return expenseDetails(client, req.user.tenantId, expense.id)
    })
    res.json(updated)
  } catch (error) {
    sendError(res, error, 'Failed to update expense status')
  }
})

router.post('/:id/reverse', auth, requireAccountingPermission('accounting:manage-payables'), async (req, res) => {
  if (!validIdOr404(req.params.id, res)) return
  let reversal
  try {
    reversal = normalizeExpenseReversal(req.body)
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message })
  }
  try {
    const reversed = await withTransaction(async (client) => {
      const current = await client.query(
        `SELECT * FROM expenses WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [req.params.id, req.user.tenantId]
      )
      if (current.rowCount !== 1) throw httpError(404, 'Expense not found')
      const expense = current.rows[0]
      if (expense.status === 'cancelled') {
        if (expense.cancellation_reason !== reversal.reason ||
            String(expense.reversal_date).slice(0, 10) !== reversal.reversal_date) {
          throw httpError(409, 'Expense was reversed using different correction details')
        }
        return expenseDetails(client, req.user.tenantId, expense.id)
      }
      if (!expense.approval_journal_entry_id && !expense.payment_journal_entry_id) {
        throw httpError(409, 'Expense has no posted journal to reverse; cancel an unposted expense with a reason')
      }
      if (expense.payment_journal_entry_id && !expense.approval_journal_entry_id) {
        throw httpError(409, 'Expense payment journal has no linked recognition journal; contact an accounting administrator')
      }
      const periodId = await requireExpensePeriod(client, req.user.tenantId, reversal.reversal_date, 'Reversal date')
      let paymentReversalId = null
      let approvalReversalId = null
      if (expense.payment_journal_entry_id) {
        const result = await reverseJournal(pool, {
          tenantId: req.user.tenantId, userId: req.user.userId,
          journalId: expense.payment_journal_entry_id,
          idempotencyKey: `expense:${expense.id}:payment-reversal:v1`,
          reversalDate: reversal.reversal_date, periodId, reason: reversal.reason
        }, { client, allowedSourceTypes: ['expense'] })
        paymentReversalId = result.journal.id
      }
      if (expense.approval_journal_entry_id) {
        const result = await reverseJournal(pool, {
          tenantId: req.user.tenantId, userId: req.user.userId,
          journalId: expense.approval_journal_entry_id,
          idempotencyKey: `expense:${expense.id}:recognition-reversal:v1`,
          reversalDate: reversal.reversal_date, periodId, reason: reversal.reason
        }, { client, allowedSourceTypes: ['expense'] })
        approvalReversalId = result.journal.id
      }
      const updated = await client.query(
        `UPDATE expenses SET status = 'cancelled', cancellation_reason = $1, reversal_date = $2,
             approval_reversal_journal_entry_id = $3, payment_reversal_journal_entry_id = $4,
             cancelled_by = $5, cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = $6 AND id = $7 AND status IN ('approved', 'paid')
           AND (approval_journal_entry_id IS NOT NULL OR payment_journal_entry_id IS NOT NULL)
         RETURNING id`,
        [reversal.reason, reversal.reversal_date, approvalReversalId, paymentReversalId,
          req.user.userId, req.user.tenantId, expense.id]
      )
      if (updated.rowCount !== 1) throw httpError(409, 'Expense reversal could not be linked to the source expense')
      return expenseDetails(client, req.user.tenantId, expense.id)
    })
    res.json(reversed)
  } catch (error) {
    sendError(res, error, 'Failed to reverse expense accounting')
  }
})

module.exports = router

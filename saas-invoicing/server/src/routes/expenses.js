const express = require('express')
const { validate: isUuid } = require('uuid')
const pool = require('../config/db')
const auth = require('../middleware/auth')
const {
  date,
  normalizeCategory,
  normalizeExpense,
  normalizePaymentTransition
} = require('../utils/expenses')

const router = express.Router()
const EXPENSE_STATUSES = ['draft', 'approved', 'paid', 'cancelled']

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
  console.error(error)
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
        console.error('Failed to roll back expense transaction', rollbackError)
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

async function expenseDetails(queryable, tenantId, expenseId) {
  const result = await queryable.query(
    `SELECT e.*, c.name AS category_name, s.business_name AS supplier_name
     FROM expenses e
     JOIN expense_categories c ON c.id = e.category_id AND c.tenant_id = e.tenant_id
     LEFT JOIN suppliers s ON s.id = e.supplier_id AND s.tenant_id = e.tenant_id
     WHERE e.id = $1 AND e.tenant_id = $2`,
    [expenseId, tenantId]
  )
  if (result.rowCount !== 1) throw httpError(404, 'Expense not found')
  return result.rows[0]
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
      `SELECT c.*,
              (SELECT COUNT(*)::integer FROM expenses e
               WHERE e.tenant_id = c.tenant_id AND e.category_id = c.id) AS expense_count
       FROM expense_categories c
       WHERE c.tenant_id = $1 AND ($2::boolean IS NULL OR c.is_active = $2)
       ORDER BY c.is_active DESC, lower(c.name), c.id`,
      [req.user.tenantId, active]
    )
    res.json(result.rows)
  } catch (error) {
    console.error(error)
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
    const result = await pool.query(
      `INSERT INTO expense_categories (tenant_id, name, description)
       VALUES ($1, $2, $3) RETURNING *`,
      [req.user.tenantId, category.name, category.description]
    )
    res.status(201).json(result.rows[0])
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'An expense category with this name already exists' })
    console.error(error)
    res.status(500).json({ error: 'Failed to create expense category' })
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
    console.error(error)
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
    console.error(error)
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
    console.error(error)
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
            description, amount, currency, payment_method, payment_reference, notes,
            created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING id`,
        [req.user.tenantId, expenseNumber, expense.expense_date, expense.category_id,
          expense.supplier_id, expense.payee_name, expense.description, expense.amount,
          expense.currency, expense.payment_method, expense.payment_reference, expense.notes,
          req.user.userId, idempotencyKey]
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
      await requireCategory(client, req.user.tenantId, expense.category_id)
      await requireSupplier(client, req.user.tenantId, expense.supplier_id)
      await client.query(
        `UPDATE expenses SET expense_date = $1, category_id = $2, supplier_id = $3,
             payee_name = $4, description = $5, amount = $6, currency = $7,
             payment_method = $8, payment_reference = $9, notes = $10,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $11 AND tenant_id = $12`,
        [expense.expense_date, expense.category_id, expense.supplier_id, expense.payee_name,
          expense.description, expense.amount, expense.currency, expense.payment_method,
          expense.payment_reference, expense.notes, req.params.id, req.user.tenantId]
      )
      return expenseDetails(client, req.user.tenantId, req.params.id)
    })
    res.json(updated)
  } catch (error) {
    sendError(res, error, 'Failed to update expense')
  }
})

router.patch('/:id/status', auth, async (req, res) => {
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

      if (targetStatus === expense.status) {
        if (targetStatus === 'paid' &&
            (expense.payment_method !== payment.payment_method ||
             (expense.payment_reference || null) !== payment.payment_reference)) {
          throw httpError(409, 'Expense is already paid using different payment details')
        }
        return expenseDetails(client, req.user.tenantId, expense.id)
      }

      if (targetStatus === 'approved' && expense.status === 'draft') {
        const transition = await client.query(
          `UPDATE expenses SET status = 'approved', approved_by = $1,
               approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = $2 AND tenant_id = $3 AND status = 'draft'`,
          [req.user.userId, expense.id, req.user.tenantId]
        )
        if (transition.rowCount !== 1) throw httpError(409, 'Expense could not be approved')
      } else if (targetStatus === 'paid' && expense.status === 'approved') {
        const transition = await client.query(
          `UPDATE expenses SET status = 'paid', payment_method = $1, payment_reference = $2,
               paid_by = $3, paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = $4 AND tenant_id = $5 AND status = 'approved'`,
          [payment.payment_method, payment.payment_reference, req.user.userId, expense.id, req.user.tenantId]
        )
        if (transition.rowCount !== 1) throw httpError(409, 'Expense payment was not recorded')
      } else if (targetStatus === 'cancelled' && ['draft', 'approved'].includes(expense.status)) {
        const transition = await client.query(
          `UPDATE expenses SET status = 'cancelled', cancelled_by = $1,
               cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = $2 AND tenant_id = $3 AND status = $4`,
          [req.user.userId, expense.id, req.user.tenantId, expense.status]
        )
        if (transition.rowCount !== 1) throw httpError(409, 'Expense could not be cancelled')
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

module.exports = router

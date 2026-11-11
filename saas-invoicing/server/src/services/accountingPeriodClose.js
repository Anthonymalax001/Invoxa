const crypto = require('node:crypto')
const { validate: isUuid } = require('uuid')
const { withTransaction } = require('./accounting')
const { httpError, normalizeIdempotencyKey, text } = require('../utils/accounting')

const DETAIL_LIMIT = 100
const MISSING_SCHEMA_CODES = new Set(['42P01', '42703', '42883'])
const SCHEMA_REQUIREMENTS = Object.freeze({
  accounting_journal_entries: ['id', 'tenant_id', 'accounting_period_id', 'status', 'entry_date', 'description', 'created_by'],
  accounting_journal_lines: ['tenant_id', 'journal_entry_id', 'debit', 'credit'],
  accounting_opening_balance_batches: ['id', 'tenant_id', 'accounting_period_id', 'effective_date', 'status'],
  customer_receipts: ['id', 'tenant_id', 'payment_date', 'amount', 'currency', 'receipt_reference', 'status', 'failed_at'],
  supplier_payments: ['id', 'tenant_id', 'payment_number', 'payment_date', 'amount', 'currency', 'payment_reference', 'status', 'failed_at'],
  supplier_bills: ['id', 'tenant_id', 'bill_number', 'bill_date', 'due_date', 'total', 'currency', 'status'],
  expenses: ['id', 'tenant_id', 'expense_number', 'expense_date', 'amount', 'currency', 'status',
    'approval_journal_entry_id', 'payment_journal_entry_id'],
  stock_movements: ['id', 'tenant_id', 'product_id', 'movement_type', 'quantity_delta', 'reference', 'created_at'],
  bank_reconciliation_import_batches: ['id', 'tenant_id', 'bank_account_id', 'file_name', 'statement_start_date', 'statement_end_date', 'reconciliation_status'],
  bank_reconciliation_accounts: ['tenant_id', 'account_id', 'bank_label'],
  mpesa_stk_initiation_requests: ['id', 'tenant_id', 'invoice_id', 'amount', 'currency', 'request_status', 'provider_checkout_request_id', 'payment_id', 'created_at'],
  mpesa_payment_reconciliation_audit: ['id', 'tenant_id', 'payment_id', 'outcome', 'created_at'],
  accounting_period_events: ['id', 'tenant_id', 'accounting_period_id', 'event_type', 'outcome', 'actor_id', 'reason', 'idempotency_key', 'payload_hash', 'details', 'created_at']
})

function checkFromRows(id, label, rows, message, severity = 'blocker') {
  const total = rows.length ? Number(rows[0].total_count) : 0
  const items = rows.map(({ total_count, ...row }) => row)
  return {
    id,
    label,
    status: total === 0 ? 'passed' : severity === 'warning' ? 'warning' : 'blocked',
    severity: total === 0 ? null : severity,
    count: total,
    truncated: total > items.length,
    message: total === 0 ? 'No outstanding records found.' : message,
    items
  }
}

async function inspectSchema(client) {
  const tables = Object.keys(SCHEMA_REQUIREMENTS)
  const result = await client.query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [tables]
  )
  const available = new Map(tables.map((table) => [table, new Set()]))
  for (const row of result.rows) available.get(row.table_name)?.add(row.column_name)
  return available
}

function hasSchema(schema, tables) {
  return tables.every((table) => {
    const available = schema.get(table)
    return available && SCHEMA_REQUIREMENTS[table].every((column) => available.has(column))
  })
}

function unavailableCheck(id, label) {
  return {
    id,
    label,
    status: 'unavailable',
    severity: 'blocker',
    count: null,
    truncated: false,
    message: 'The required accounting schema is unavailable; this condition could not be assessed.',
    items: []
  }
}

async function runCheck(client, tenantId, period, definition, schema) {
  if (!hasSchema(schema, definition.tables)) return unavailableCheck(definition.id, definition.label)
  const result = await client.query(definition.sql, [tenantId, period.id, period.starts_on, period.ends_on])
  return checkFromRows(definition.id, definition.label, result.rows, definition.message, definition.severity)
}

const CHECKS = [
  {
    id: 'draft_journals', label: 'Draft journals',
    tables: ['accounting_journal_entries'],
    message: 'Draft journals must be posted or otherwise resolved before closing.',
    sql: `SELECT j.id, j.entry_date, j.description, j.created_by, count(*) OVER()::integer AS total_count
          FROM accounting_journal_entries j
          WHERE j.tenant_id = $1 AND j.accounting_period_id = $2 AND j.status = 'draft'
          ORDER BY j.entry_date, j.id LIMIT ${DETAIL_LIMIT}`
  },
  {
    id: 'draft_opening_balances', label: 'Opening-balance cutover drafts',
    tables: ['accounting_opening_balance_batches'],
    message: 'Opening-balance drafts must be posted or cancelled before closing their accounting period.',
    sql: `SELECT id, effective_date, status, count(*) OVER()::integer AS total_count
          FROM accounting_opening_balance_batches
          WHERE tenant_id = $1 AND accounting_period_id = $2 AND status = 'draft'
          ORDER BY effective_date, id LIMIT ${DETAIL_LIMIT}`
  },
  {
    id: 'pending_receipts', label: 'Pending customer receipts',
    tables: ['customer_receipts'],
    message: 'Pending receipts dated in this period must be verified, failed or otherwise resolved.',
    sql: `SELECT id, payment_date, amount::text AS amount, currency, receipt_reference, status,
                 count(*) OVER()::integer AS total_count
          FROM customer_receipts
          WHERE tenant_id = $1 AND payment_date BETWEEN $3::date AND $4::date AND status = 'pending'
          ORDER BY payment_date, id LIMIT ${DETAIL_LIMIT}`
  },
  {
    id: 'failed_receipts', label: 'Failed customer receipts', severity: 'warning',
    tables: ['customer_receipts'],
    message: 'Failed receipts did not post; review the recorded failures if follow-up is needed.',
    sql: `SELECT id, payment_date, amount::text AS amount, currency, receipt_reference, failed_at,
                 count(*) OVER()::integer AS total_count
          FROM customer_receipts
          WHERE tenant_id = $1 AND payment_date BETWEEN $3::date AND $4::date AND status = 'failed'
          ORDER BY payment_date, id LIMIT ${DETAIL_LIMIT}`
  },
  {
    id: 'pending_supplier_payments', label: 'Pending supplier payments',
    tables: ['supplier_payments'],
    message: 'Pending supplier payments dated in this period must be verified, failed or otherwise resolved.',
    sql: `SELECT id, payment_number, payment_date, amount::text AS amount, currency, payment_reference, status,
                 count(*) OVER()::integer AS total_count
          FROM supplier_payments
          WHERE tenant_id = $1 AND payment_date BETWEEN $3::date AND $4::date AND status = 'pending'
          ORDER BY payment_date, id LIMIT ${DETAIL_LIMIT}`
  },
  {
    id: 'failed_supplier_payments', label: 'Failed supplier payments', severity: 'warning',
    tables: ['supplier_payments'],
    message: 'Failed payments did not post; review the recorded failures if follow-up is needed.',
    sql: `SELECT id, payment_number, payment_date, amount::text AS amount, currency, payment_reference, failed_at,
                 count(*) OVER()::integer AS total_count
          FROM supplier_payments
          WHERE tenant_id = $1 AND payment_date BETWEEN $3::date AND $4::date AND status = 'failed'
          ORDER BY payment_date, id LIMIT ${DETAIL_LIMIT}`
  },
  {
    id: 'unposted_supplier_bills', label: 'Draft or submitted supplier bills',
    tables: ['supplier_bills'],
    message: 'Draft and submitted bills dated in this period need to be completed or cancelled.',
    sql: `SELECT id, bill_number, bill_date, due_date, total::text AS total, currency, status,
                 count(*) OVER()::integer AS total_count
          FROM supplier_bills
          WHERE tenant_id = $1 AND bill_date BETWEEN $3::date AND $4::date AND status IN ('draft', 'submitted')
          ORDER BY bill_date, id LIMIT ${DETAIL_LIMIT}`
  },
  {
    id: 'unposted_expenses', label: 'Approved or paid expenses without ledger postings',
    tables: ['expenses'],
    message: 'Approved or paid expenses are missing a required posted recognition or payment journal and must be assessed before closing.',
    sql: `SELECT id, expense_number, expense_date, amount::text AS amount, currency, status,
                 count(*) OVER()::integer AS total_count
          FROM expenses expense
          WHERE expense.tenant_id = $1 AND expense.expense_date BETWEEN $3::date AND $4::date
            AND expense.status IN ('approved', 'paid')
            AND (
              NOT EXISTS (
                SELECT 1 FROM accounting_journal_entries recognition
                WHERE recognition.tenant_id = expense.tenant_id
                  AND recognition.id = expense.approval_journal_entry_id
                  AND recognition.status = 'posted' AND recognition.source_type = 'expense'
                  AND recognition.source_id = expense.id AND recognition.event_type = 'recognition'
              )
              OR (expense.status = 'paid' AND NOT EXISTS (
                SELECT 1 FROM accounting_journal_entries payment
                WHERE payment.tenant_id = expense.tenant_id
                  AND payment.id = expense.payment_journal_entry_id
                  AND payment.status = 'posted' AND payment.source_type = 'expense'
                  AND payment.source_id = expense.id AND payment.event_type = 'payment'
              ))
            )
          ORDER BY expense.expense_date, expense.id LIMIT ${DETAIL_LIMIT}`
  },
  {
    id: 'unaccounted_inventory_movements', label: 'Inventory movements without ledger valuation',
    tables: ['stock_movements'],
    message: 'Stock movements have no linked inventory valuation or journal posting and need an approved valuation workflow before this period can close.',
    sql: `SELECT id, product_id, movement_type, quantity_delta::text AS quantity_delta,
                 reference, created_at,
                 count(*) OVER()::integer AS total_count
          FROM stock_movements
          WHERE tenant_id = $1 AND created_at::date BETWEEN $3::date AND $4::date
          ORDER BY created_at, id LIMIT ${DETAIL_LIMIT}`
  },
  {
    id: 'unbalanced_posted_journals', label: 'Posted journal integrity',
    tables: ['accounting_journal_entries', 'accounting_journal_lines'],
    message: 'Posted journals with missing lines or unequal debits and credits must be investigated.',
    sql: `SELECT j.id, j.entry_date, j.description, count(l.id)::integer AS line_count,
                 COALESCE(sum(l.debit), 0)::text AS debit_total,
                 COALESCE(sum(l.credit), 0)::text AS credit_total,
                 count(*) OVER()::integer AS total_count
          FROM accounting_journal_entries j
          LEFT JOIN accounting_journal_lines l ON l.tenant_id = j.tenant_id AND l.journal_entry_id = j.id
          WHERE j.tenant_id = $1 AND j.accounting_period_id = $2 AND j.status = 'posted'
          GROUP BY j.id
          HAVING count(l.id) < 2 OR COALESCE(sum(l.debit), 0) <> COALESCE(sum(l.credit), 0)
          ORDER BY j.entry_date, j.id LIMIT ${DETAIL_LIMIT}`
  },
  {
    id: 'incomplete_bank_reconciliations', label: 'Bank reconciliations',
    tables: ['bank_reconciliation_import_batches', 'bank_reconciliation_accounts'],
    message: 'Open statement reconciliations overlapping this period must be completed or otherwise resolved.',
    sql: `SELECT i.id, i.bank_account_id, b.bank_label, i.file_name,
                 i.statement_start_date, i.statement_end_date, i.reconciliation_status AS status,
                 count(*) OVER()::integer AS total_count
          FROM bank_reconciliation_import_batches i
          JOIN bank_reconciliation_accounts b ON b.tenant_id = i.tenant_id AND b.account_id = i.bank_account_id
          WHERE i.tenant_id = $1 AND i.reconciliation_status = 'open'
            AND i.statement_start_date <= $4::date AND i.statement_end_date >= $3::date
          ORDER BY i.statement_start_date, i.id LIMIT ${DETAIL_LIMIT}`
  },
  {
    id: 'unresolved_mpesa_initiations', label: 'M-Pesa initiation and reconciliation',
    tables: ['mpesa_stk_initiation_requests', 'mpesa_payment_reconciliation_audit'],
    message: 'M-Pesa requests in this period have no conclusive provider reconciliation and must be investigated.',
    sql: `SELECT request.id, request.invoice_id, request.amount::text AS amount,
                 request.currency, request.request_status AS status,
                 request.provider_checkout_request_id AS checkout_request_id,
                 audit.outcome AS latest_provider_outcome,
                 count(*) OVER()::integer AS total_count
          FROM mpesa_stk_initiation_requests request
          LEFT JOIN LATERAL (
            SELECT event.outcome
            FROM mpesa_payment_reconciliation_audit event
            WHERE event.tenant_id = request.tenant_id AND event.payment_id = request.payment_id
            ORDER BY event.created_at DESC, event.id DESC LIMIT 1
          ) audit ON true
          WHERE request.tenant_id = $1
            AND request.created_at::date BETWEEN $3::date AND $4::date
            AND (request.request_status IN ('reserved', 'outcome_unknown', 'provider_accepted', 'reference_recovered')
              OR (request.request_status = 'payment_recorded'
                AND (audit.outcome IS NULL OR audit.outcome <> 'provider_success'))
              OR (request.request_status = 'provider_succeeded'
                AND (audit.outcome IS NULL OR audit.outcome <> 'provider_success')))
          ORDER BY request.created_at, request.id LIMIT ${DETAIL_LIMIT}`
  }
]

function legacyMpesaCoverageCheck() {
  return {
    id: 'legacy_mpesa_coverage',
    label: 'Legacy M-Pesa payment coverage',
    status: 'unavailable',
    severity: 'blocker',
    count: null,
    truncated: false,
    message: 'The legacy payments table has no repository-defined date or status contract. Its historical M-Pesa activity cannot be safely assessed; obtain an approved schema and reconcile its period activity before closing.',
    items: []
  }
}

function periodCheck(period) {
  const isOpen = period.status === 'open'
  return {
    id: 'period_status', label: 'Period status', status: isOpen ? 'passed' : 'blocked',
    severity: isOpen ? null : 'blocker', count: isOpen ? 0 : 1, truncated: false,
    message: isOpen ? 'Period is open.' : 'This accounting period is already closed.', items: []
  }
}

async function historyFor(client, tenantId, periodId, schema) {
  if (!hasSchema(schema, ['accounting_period_events'])) return { available: false, events: [] }
  const result = await client.query(
    `SELECT id, event_type, outcome, actor_id, reason, details, idempotency_key, created_at
     FROM accounting_period_events
     WHERE tenant_id = $1 AND accounting_period_id = $2
     ORDER BY created_at DESC, id DESC`,
    [tenantId, periodId]
  )
  return { available: true, events: result.rows }
}

async function assess(client, tenantId, period, { includeHistory = true } = {}) {
  const schema = await inspectSchema(client)
  const checks = [periodCheck(period)]
  for (const definition of CHECKS) checks.push(await runCheck(client, tenantId, period, definition, schema))
  // Do not query legacy payment columns whose deployed types/status domain are
  // unverified. Until that schema is reviewed, no period can be represented as
  // fully assessed for historical M-Pesa activity.
  checks.push(legacyMpesaCoverageCheck())

  let history = { available: true, events: [] }
  if (includeHistory) {
    history = await historyFor(client, tenantId, period.id, schema)
    checks.push(history.available
      ? { id: 'close_audit', label: 'Close audit history', status: 'passed', severity: null, count: 0, truncated: false,
          message: 'Close audit history is available.', items: [] }
      : { id: 'close_audit', label: 'Close audit history', status: 'unavailable', severity: 'blocker', count: null,
          truncated: false, message: 'Close audit schema is unavailable; a close cannot be safely recorded.', items: [] })
  }
  const blockers = checks.filter((check) => check.severity === 'blocker')
  const warnings = checks.filter((check) => check.severity === 'warning')
  return {
    period,
    can_close: blockers.length === 0,
    checks,
    blockers,
    warnings,
    history: history.available ? history.events : null
  }
}

async function getAccountingPeriodReadiness(pool, tenantId, periodId) {
  if (!isUuid(tenantId)) throw httpError(401, 'Authenticated tenant identity is required')
  if (!isUuid(periodId)) throw httpError(404, 'Accounting period not found')
  return withTransaction(pool, async (client) => {
    const result = await client.query(
      `SELECT id, tenant_id, name, starts_on, ends_on, status, created_by, closed_by, created_at, closed_at
       FROM accounting_periods WHERE tenant_id = $1 AND id = $2`,
      [tenantId, periodId]
    )
    if (result.rowCount !== 1) throw httpError(404, 'Accounting period not found')
    return assess(client, tenantId, result.rows[0])
  })
}

async function closeAccountingPeriod(pool, { tenantId, userId, periodId, idempotencyKey, reason, confirm }) {
  if (!isUuid(tenantId) || !isUuid(userId)) throw httpError(401, 'Authenticated tenant and user identities are required')
  if (!isUuid(periodId)) throw httpError(404, 'Accounting period not found')
  if (confirm !== true) throw httpError(400, 'Explicit confirmation is required to close an accounting period')
  const normalizedReason = text(reason, 'Close reason', 1800, { required: true })
  const key = normalizeIdempotencyKey(idempotencyKey)
  const payloadHash = crypto.createHash('sha256')
    .update(JSON.stringify({ tenantId, periodId, reason: normalizedReason, confirm: true }))
    .digest('hex')

  try {
    return await withTransaction(pool, async (client) => {
      const selected = await client.query(
        `SELECT id, tenant_id, name, starts_on, ends_on, status, created_by, closed_by, created_at, closed_at
         FROM accounting_periods WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [tenantId, periodId]
      )
      if (selected.rowCount !== 1) throw httpError(404, 'Accounting period not found')

      const schema = await inspectSchema(client)
      if (!hasSchema(schema, ['accounting_period_events'])) {
        throw httpError(503, 'Accounting period close audit schema is unavailable; apply the required additive migration before closing periods')
      }

      const prior = await client.query(
        `SELECT id, accounting_period_id, outcome, reason, details, payload_hash
         FROM accounting_period_events WHERE tenant_id = $1 AND idempotency_key = $2 FOR UPDATE`,
        [tenantId, key]
      )
      if (prior.rowCount === 1) {
        if (prior.rows[0].accounting_period_id !== periodId || prior.rows[0].payload_hash !== payloadHash) {
          throw httpError(409, 'Idempotency-Key was already used for a different period close request')
        }
        return {
          outcome: prior.rows[0].outcome,
          replayed: true,
          period: selected.rows[0],
          reason: prior.rows[0].reason,
          readiness: prior.rows[0].details?.readiness || null
        }
      }

      const readiness = await assess(client, tenantId, selected.rows[0], { includeHistory: false })
      const outcome = readiness.can_close ? 'closed' : 'blocked'
      let period = selected.rows[0]
      if (outcome === 'closed') {
        const updated = await client.query(
          `UPDATE accounting_periods SET status = 'closed', closed_by = $1, closed_at = CURRENT_TIMESTAMP
           WHERE tenant_id = $2 AND id = $3 AND status = 'open'
           RETURNING id, tenant_id, name, starts_on, ends_on, status, created_by, closed_by, created_at, closed_at`,
          [userId, tenantId, periodId]
        )
        if (updated.rowCount !== 1) throw httpError(409, 'Accounting period could not be closed')
        period = updated.rows[0]
      }
      await client.query(
        `INSERT INTO accounting_period_events
           (tenant_id, accounting_period_id, event_type, outcome, actor_id, reason, idempotency_key, payload_hash, details)
         VALUES ($1, $2, 'close', $3, $4, $5, $6, $7, $8::jsonb)`,
        [tenantId, periodId, outcome, userId, normalizedReason, key, payloadHash,
          JSON.stringify({ readiness })]
      )
      return { outcome, replayed: false, period, reason: normalizedReason, readiness }
    })
  } catch (error) {
    if (MISSING_SCHEMA_CODES.has(error.code)) {
      throw httpError(503, 'Accounting period close audit or readiness schema is unavailable; apply the required additive migration before closing periods')
    }
    throw error
  }
}

module.exports = { assess, closeAccountingPeriod, getAccountingPeriodReadiness, SCHEMA_REQUIREMENTS }

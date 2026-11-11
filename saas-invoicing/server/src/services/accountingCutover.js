const crypto = require('node:crypto')
const { validate: isUuid } = require('uuid')
const { normalizeJournal, normalizeIdempotencyKey, httpError, text, validationError } = require('../utils/accounting')
const { postJournal, reverseJournal, withTransaction } = require('./accounting')

const MAX_PREVIEW_ITEMS = 100
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const OPENING_SOURCE_TYPE = 'opening_balance_cutover'
const OPENING_EVENT_TYPE = 'opening_balance'

const PREVIEW_REQUIREMENTS = Object.freeze({
  invoices: {
    fields: { id: ['uuid'], tenant_id: ['uuid'], invoice_number: ['varchar', 'text', 'bpchar'], total: ['numeric'], status: ['varchar', 'text', 'bpchar'] },
    dependencies: ['accounting_settings', 'accounting_invoice_tax_snapshots', 'accounting_journal_entries'],
    cte: `SELECT i.id::text AS record_id, i.invoice_number AS reference, i.total::text AS amount,
                 settings.base_currency AS currency, i.status,
                 CASE
                   WHEN i.status = 'draft' THEN 'excluded'
                   WHEN EXISTS (
                     SELECT 1 FROM accounting_invoice_tax_snapshots snapshot
                     JOIN accounting_journal_entries journal
                       ON journal.tenant_id = snapshot.tenant_id AND journal.id = snapshot.journal_entry_id
                     WHERE snapshot.tenant_id = i.tenant_id AND snapshot.source_type = 'invoice'
                       AND snapshot.source_id = i.id AND snapshot.issued_at IS NOT NULL
                       AND snapshot.total = i.total AND journal.status = 'posted'
                       AND journal.functional_currency = settings.base_currency
                       AND journal.source_type = 'invoice' AND journal.source_id = i.id AND journal.event_type = 'issue'
                   ) THEN 'already_accounted_for'
                   ELSE 'ambiguous'
                 END AS classification,
                 CASE
                   WHEN i.status = 'draft' THEN 'Draft invoice was not issued and is excluded from opening-balance import.'
                   WHEN EXISTS (
                     SELECT 1 FROM accounting_invoice_tax_snapshots snapshot
                     JOIN accounting_journal_entries journal
                       ON journal.tenant_id = snapshot.tenant_id AND journal.id = snapshot.journal_entry_id
                     WHERE snapshot.tenant_id = i.tenant_id AND snapshot.source_type = 'invoice'
                       AND snapshot.source_id = i.id AND snapshot.issued_at IS NOT NULL
                       AND snapshot.total = i.total AND journal.status = 'posted'
                       AND journal.functional_currency = settings.base_currency
                       AND journal.source_type = 'invoice' AND journal.source_id = i.id AND journal.event_type = 'issue'
                   ) THEN 'Invoice has a matching issued snapshot and posted ledger journal.'
                   ELSE 'No matching issued snapshot and posted journal proves this invoice is already represented; automatic historical posting is unsupported.'
                 END AS reason
          FROM invoices i
          LEFT JOIN accounting_settings settings ON settings.tenant_id = i.tenant_id
          WHERE i.tenant_id = $1`
  },
  customer_receipts: {
    fields: {
      id: ['uuid'], tenant_id: ['uuid'], status: ['varchar'], amount: ['numeric'], currency: ['bpchar'],
      payment_date: ['date'], receipt_reference: ['varchar'], journal_entry_id: ['uuid'], reversal_journal_entry_id: ['uuid']
    },
    dependencies: ['accounting_journal_entries'],
    cte: `SELECT receipt.id::text AS record_id, receipt.receipt_reference AS reference,
                 receipt.amount::text AS amount, receipt.currency AS currency, receipt.status,
                 CASE
                   WHEN receipt.status = 'pending' OR receipt.status = 'failed' THEN 'excluded'
                   WHEN receipt.status = 'verified' AND original.status = 'posted'
                     AND original.source_type = 'customer_receipt' AND original.source_id = receipt.id
                     AND original.event_type = 'verify' THEN 'already_accounted_for'
                   WHEN receipt.status = 'reversed' AND original.status = 'posted' AND reversal.status = 'posted'
                     AND original.source_type = 'customer_receipt' AND original.source_id = receipt.id
                     AND original.event_type = 'verify' AND reversal.reversal_of_entry_id = original.id THEN 'already_accounted_for'
                   ELSE 'ambiguous'
                 END AS classification,
                 CASE
                   WHEN receipt.status IN ('pending', 'failed') THEN 'Receipt is not an active posted accounting receipt.'
                   WHEN receipt.status = 'verified' AND original.status = 'posted'
                     AND original.source_type = 'customer_receipt' AND original.source_id = receipt.id
                     AND original.event_type = 'verify' THEN 'Verified receipt has its linked posted journal.'
                   WHEN receipt.status = 'reversed' AND original.status = 'posted' AND reversal.status = 'posted'
                     AND original.source_type = 'customer_receipt' AND original.source_id = receipt.id
                     AND original.event_type = 'verify' AND reversal.reversal_of_entry_id = original.id THEN 'Reversed receipt has its original and linked reversal journals.'
                   ELSE 'Receipt status and linked posted journal do not prove a complete ledger representation.'
                 END AS reason
          FROM customer_receipts receipt
          LEFT JOIN accounting_journal_entries original
            ON original.tenant_id = receipt.tenant_id AND original.id = receipt.journal_entry_id
          LEFT JOIN accounting_journal_entries reversal
            ON reversal.tenant_id = receipt.tenant_id AND reversal.id = receipt.reversal_journal_entry_id
          WHERE receipt.tenant_id = $1`
  },
  supplier_bills: {
    fields: {
      id: ['uuid'], tenant_id: ['uuid'], bill_number: ['varchar'], bill_date: ['date'], total: ['numeric'],
      currency: ['bpchar'], status: ['varchar'], journal_entry_id: ['uuid'], reversal_journal_entry_id: ['uuid']
    },
    dependencies: ['accounting_journal_entries'],
    cte: `SELECT bill.id::text AS record_id, bill.bill_number AS reference,
                 bill.total::text AS amount, bill.currency AS currency, bill.status,
                 CASE
                   WHEN bill.status IN ('draft', 'submitted', 'cancelled') THEN 'excluded'
                   WHEN bill.status = 'approved' AND original.status = 'posted'
                     AND original.source_type = 'supplier_bill' AND original.source_id = bill.id AND original.event_type = 'approve' THEN 'already_accounted_for'
                   WHEN bill.status = 'reversed' AND original.status = 'posted' AND reversal.status = 'posted'
                     AND original.source_type = 'supplier_bill' AND original.source_id = bill.id
                     AND original.event_type = 'approve' AND reversal.reversal_of_entry_id = original.id THEN 'already_accounted_for'
                   ELSE 'ambiguous'
                 END AS classification,
                 CASE
                   WHEN bill.status IN ('draft', 'submitted', 'cancelled') THEN 'Bill is unposted or cancelled and is excluded from opening-balance import.'
                   WHEN bill.status = 'approved' AND original.status = 'posted'
                     AND original.source_type = 'supplier_bill' AND original.source_id = bill.id AND original.event_type = 'approve' THEN 'Approved bill has its linked posted journal.'
                   WHEN bill.status = 'reversed' AND original.status = 'posted' AND reversal.status = 'posted'
                     AND original.source_type = 'supplier_bill' AND original.source_id = bill.id
                     AND original.event_type = 'approve' AND reversal.reversal_of_entry_id = original.id THEN 'Reversed bill has its original and linked reversal journals.'
                   ELSE 'Bill status and linked posted journal do not prove a complete ledger representation.'
                 END AS reason
          FROM supplier_bills bill
          LEFT JOIN accounting_journal_entries original
            ON original.tenant_id = bill.tenant_id AND original.id = bill.journal_entry_id
          LEFT JOIN accounting_journal_entries reversal
            ON reversal.tenant_id = bill.tenant_id AND reversal.id = bill.reversal_journal_entry_id
          WHERE bill.tenant_id = $1`
  },
  supplier_payments: {
    fields: {
      id: ['uuid'], tenant_id: ['uuid'], payment_number: ['varchar'], payment_date: ['date'], amount: ['numeric'],
      currency: ['bpchar'], status: ['varchar'], journal_entry_id: ['uuid'], reversal_journal_entry_id: ['uuid']
    },
    dependencies: ['accounting_journal_entries'],
    cte: `SELECT payment.id::text AS record_id, payment.payment_number AS reference,
                 payment.amount::text AS amount, payment.currency AS currency, payment.status,
                 CASE
                   WHEN payment.status IN ('pending', 'failed') THEN 'excluded'
                   WHEN payment.status = 'verified' AND original.status = 'posted'
                     AND original.source_type = 'supplier_payment' AND original.source_id = payment.id AND original.event_type = 'verify' THEN 'already_accounted_for'
                   WHEN payment.status = 'reversed' AND original.status = 'posted' AND reversal.status = 'posted'
                     AND original.source_type = 'supplier_payment' AND original.source_id = payment.id
                     AND original.event_type = 'verify' AND reversal.reversal_of_entry_id = original.id THEN 'already_accounted_for'
                   ELSE 'ambiguous'
                 END AS classification,
                 CASE
                   WHEN payment.status IN ('pending', 'failed') THEN 'Supplier payment is not currently represented by an active posted journal.'
                   WHEN payment.status = 'verified' AND original.status = 'posted'
                     AND original.source_type = 'supplier_payment' AND original.source_id = payment.id AND original.event_type = 'verify' THEN 'Verified supplier payment has its linked posted journal.'
                   WHEN payment.status = 'reversed' AND original.status = 'posted' AND reversal.status = 'posted'
                     AND original.source_type = 'supplier_payment' AND original.source_id = payment.id
                     AND original.event_type = 'verify' AND reversal.reversal_of_entry_id = original.id THEN 'Reversed supplier payment has its original and linked reversal journals.'
                   ELSE 'Payment status and linked posted journal do not prove a complete ledger representation.'
                 END AS reason
          FROM supplier_payments payment
          LEFT JOIN accounting_journal_entries original
            ON original.tenant_id = payment.tenant_id AND original.id = payment.journal_entry_id
          LEFT JOIN accounting_journal_entries reversal
            ON reversal.tenant_id = payment.tenant_id AND reversal.id = payment.reversal_journal_entry_id
          WHERE payment.tenant_id = $1`
  },
  expenses: {
    fields: {
      id: ['uuid'], tenant_id: ['uuid'], expense_number: ['varchar'], expense_date: ['date'],
      amount: ['numeric'], currency: ['varchar'], status: ['varchar'],
      approval_journal_entry_id: ['uuid'], payment_journal_entry_id: ['uuid']
    },
    dependencies: [],
    cte: `SELECT expense.id::text AS record_id, expense.expense_number AS reference,
                 expense.amount::text AS amount, expense.currency AS currency, expense.status,
                 CASE WHEN expense.status IN ('draft', 'cancelled') THEN 'excluded'
                      WHEN recognition.id IS NOT NULL
                        AND (expense.status <> 'paid' OR payment.id IS NOT NULL) THEN 'excluded'
                      ELSE 'ambiguous' END AS classification,
                 CASE WHEN expense.status IN ('draft', 'cancelled')
                   THEN 'Draft or cancelled expense is excluded.'
                   WHEN recognition.id IS NOT NULL
                     AND (expense.status <> 'paid' OR payment.id IS NOT NULL)
                   THEN 'The expense is represented by its posted expense journals and must not be included again.'
                   ELSE 'Legacy expense accounting is incomplete or has no linked posted journal; it will not be imported automatically.'
                 END AS reason
          FROM expenses expense
          LEFT JOIN accounting_journal_entries recognition
            ON recognition.tenant_id = expense.tenant_id
           AND recognition.id = expense.approval_journal_entry_id
           AND recognition.status = 'posted' AND recognition.source_type = 'expense'
           AND recognition.source_id = expense.id AND recognition.event_type = 'recognition'
          LEFT JOIN accounting_journal_entries payment
            ON payment.tenant_id = expense.tenant_id
           AND payment.id = expense.payment_journal_entry_id
           AND payment.status = 'posted' AND payment.source_type = 'expense'
           AND payment.source_id = expense.id AND payment.event_type = 'payment'
          WHERE expense.tenant_id = $1`
  }
})

const PREVIEW_DEPENDENCIES = Object.freeze({
  accounting_settings: { tenant_id: ['uuid'], base_currency: ['varchar'] },
  accounting_invoice_tax_snapshots: {
    tenant_id: ['uuid'], source_type: ['varchar'], source_id: ['uuid'], total: ['numeric'],
    issued_at: ['timestamptz'], journal_entry_id: ['uuid']
  },
  accounting_journal_entries: {
    id: ['uuid'], tenant_id: ['uuid'], status: ['varchar'], functional_currency: ['varchar', 'bpchar'],
    source_type: ['varchar'], source_id: ['uuid'], event_type: ['varchar'], reversal_of_entry_id: ['uuid']
  }
})

function validDate(value, label) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) throw validationError(`${label} must use YYYY-MM-DD`)
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw validationError(`${label} is invalid`)
  }
  return value
}

function hashPayload(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function requireIdentity(tenantId, userId = null) {
  if (!isUuid(tenantId)) throw httpError(401, 'Authenticated tenant identity is required')
  if (userId != null && !isUuid(userId)) throw httpError(401, 'Authenticated user identity is required')
}

function normalizeDraft(body, idempotencyKey) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  const effectiveDate = validDate(source.effective_date, 'Opening balance effective date')
  const description = text(source.description, 'Opening balance description', 2000, { required: true })
  if (!isUuid(source.accounting_period_id)) throw validationError('A valid accounting period is required')
  if (!Array.isArray(source.lines) || source.lines.length < 2 || source.lines.length > 500) {
    throw validationError('Opening balances require between 2 and 500 account lines')
  }
  const accountIds = source.lines.map((line) => line && line.account_id)
  if (accountIds.some((id) => !isUuid(id))) throw validationError('Every opening balance line requires a valid account')
  if (new Set(accountIds).size !== accountIds.length) throw validationError('An account may appear only once in an opening balance')

  let journal
  try {
    journal = normalizeJournal({
      accounting_period_id: source.accounting_period_id,
      entry_date: effectiveDate,
      description,
      source_type: OPENING_SOURCE_TYPE,
      source_id: null,
      source_reference: 'Opening balance cutover',
      event_type: OPENING_EVENT_TYPE,
      lines: source.lines
    }, idempotencyKey)
  } catch (error) {
    if (error.message === 'Journal debits and credits must balance exactly') {
      throw validationError('Opening balance debits and credits must balance exactly. Add an explicitly reviewed equity or retained-earnings line if appropriate; no balancing account or amount is generated.')
    }
    throw error
  }
  if (journal.lines.some((line) => line.transaction_currency != null)) {
    throw validationError('Opening balances must be entered in the tenant functional currency; foreign-currency remeasurement is not supported here')
  }
  return {
    idempotencyKey: journal.idempotency_key,
    accountingPeriodId: journal.accounting_period_id,
    effectiveDate: journal.entry_date,
    description: journal.description,
    payloadHash: journal.payload_hash,
    lines: journal.lines
  }
}

async function loadBatch(client, tenantId, batchId, { lock = false } = {}) {
  const result = await client.query(
    `SELECT batch.id, batch.tenant_id, batch.accounting_period_id, period.name AS accounting_period_name,
            batch.effective_date, batch.description, batch.status, batch.payload_hash,
            batch.journal_entry_id, batch.reversal_journal_entry_id,
            batch.created_by, batch.created_at, batch.approved_by, batch.approved_at, batch.approval_reason,
            batch.cancelled_by, batch.cancelled_at, batch.cancellation_reason,
            batch.reversed_by, batch.reversed_at, batch.reversal_reason
     FROM accounting_opening_balance_batches batch
     JOIN accounting_periods period
       ON period.tenant_id = batch.tenant_id AND period.id = batch.accounting_period_id
     WHERE batch.tenant_id = $1 AND batch.id = $2
     ${lock ? 'FOR UPDATE OF batch' : ''}`,
    [tenantId, batchId]
  )
  if (result.rowCount !== 1) throw httpError(404, 'Opening balance cutover not found')
  const batch = result.rows[0]
  const [lines, events] = await Promise.all([
    client.query(
      `SELECT line.line_number, line.account_id, account.account_code, account.name AS account_name,
              account.account_type, account.normal_balance,
              line.description, line.debit::text AS debit, line.credit::text AS credit
       FROM accounting_opening_balance_lines line
       JOIN accounting_accounts account ON account.tenant_id = line.tenant_id AND account.id = line.account_id
       WHERE line.tenant_id = $1 AND line.batch_id = $2 ORDER BY line.line_number`,
      [tenantId, batchId]
    ),
    client.query(
      `SELECT id, event_type, actor_id, reason, idempotency_key, payload_hash, details, created_at
       FROM accounting_opening_balance_events
       WHERE tenant_id = $1 AND batch_id = $2 ORDER BY created_at, id`,
      [tenantId, batchId]
    )
  ])
  return { ...batch, lines: lines.rows, events: events.rows }
}

async function insertAudit(client, { tenantId, batchId, actorId, eventType, reason, idempotencyKey, payloadHash: hash, details }) {
  const result = await client.query(
    `INSERT INTO accounting_opening_balance_events
       (tenant_id, batch_id, event_type, actor_id, reason, idempotency_key, payload_hash, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     RETURNING id, event_type, actor_id, reason, idempotency_key, payload_hash, details, created_at`,
    [tenantId, batchId, eventType, actorId, reason, idempotencyKey, hash, JSON.stringify(details || {})]
  )
  return result.rows[0]
}

async function assertOpenPeriodAndAccounts(client, tenantId, draft, { lock = false } = {}) {
  const settings = await client.query(
    `SELECT base_currency FROM accounting_settings WHERE tenant_id = $1 ${lock ? 'FOR SHARE' : ''}`,
    [tenantId]
  )
  if (settings.rowCount !== 1) throw httpError(409, 'Configure the tenant accounting currency before creating opening balances')
  const period = await client.query(
    `SELECT id, status, starts_on, ends_on FROM accounting_periods
     WHERE tenant_id = $1 AND id = $2 ${lock ? 'FOR SHARE' : ''}`,
    [tenantId, draft.accountingPeriodId]
  )
  if (period.rowCount !== 1) throw httpError(404, 'Accounting period not found')
  const row = period.rows[0]
  if (row.status !== 'open') throw httpError(409, 'Cannot create or post opening balances into a closed accounting period')
  if (draft.effectiveDate < String(row.starts_on).slice(0, 10) || draft.effectiveDate > String(row.ends_on).slice(0, 10)) {
    throw validationError('Opening balance effective date must fall inside the selected accounting period')
  }

  const ids = draft.lines.map((line) => line.account_id)
  const accounts = await client.query(
    `SELECT id, account_type, normal_balance, is_active FROM accounting_accounts
     WHERE tenant_id = $1 AND id = ANY($2::uuid[]) ${lock ? 'FOR SHARE' : ''}`,
    [tenantId, ids]
  )
  if (accounts.rowCount !== ids.length) throw httpError(400, 'One or more opening balance accounts are unavailable for this tenant')
  if (accounts.rows.some((account) => !account.is_active)) throw httpError(409, 'Opening balance accounts must be active')
  if (accounts.rows.some((account) => !['asset', 'liability', 'equity'].includes(account.account_type))) {
    throw validationError('Opening balances may use balance-sheet accounts only; revenue and expense accounts are not allowed')
  }
  return { period: row, accounts: accounts.rows }
}

async function createOpeningBalanceDraft(pool, { tenantId, userId, idempotencyKey, body }) {
  requireIdentity(tenantId, userId)
  const draft = normalizeDraft(body, idempotencyKey)
  try {
    return await withTransaction(pool, async (client) => {
      const tenant = await client.query('SELECT id FROM tenants WHERE id = $1 FOR UPDATE', [tenantId])
      if (tenant.rowCount !== 1) throw httpError(404, 'Tenant not found')
      const existing = await client.query(
        `SELECT id, payload_hash FROM accounting_opening_balance_batches
         WHERE tenant_id = $1 AND idempotency_key = $2 FOR UPDATE`,
        [tenantId, draft.idempotencyKey]
      )
      if (existing.rowCount === 1) {
        if (existing.rows[0].payload_hash !== draft.payloadHash) {
          throw httpError(409, 'Idempotency-Key was already used for a different opening balance')
        }
        return { ...(await loadBatch(client, tenantId, existing.rows[0].id)), replayed: true }
      }

      await assertOpenPeriodAndAccounts(client, tenantId, draft, { lock: true })
      const priorReversal = await client.query(
        `SELECT effective_date FROM accounting_opening_balance_batches
         WHERE tenant_id = $1 AND status = 'reversed'
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [tenantId]
      )
      if (priorReversal.rowCount === 1 && String(priorReversal.rows[0].effective_date).slice(0, 10) !== draft.effectiveDate) {
        throw httpError(409, 'A replacement opening balance after reversal must use the same effective date as the original cutover')
      }
      const batchResult = await client.query(
        `INSERT INTO accounting_opening_balance_batches
           (tenant_id, accounting_period_id, effective_date, description, status, idempotency_key, payload_hash, created_by)
         VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7)
         RETURNING id`,
        [tenantId, draft.accountingPeriodId, draft.effectiveDate, draft.description,
          draft.idempotencyKey, draft.payloadHash, userId]
      )
      const batchId = batchResult.rows[0].id
      for (let index = 0; index < draft.lines.length; index += 1) {
        const line = draft.lines[index]
        await client.query(
          `INSERT INTO accounting_opening_balance_lines
             (tenant_id, batch_id, line_number, account_id, description, debit, credit)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [tenantId, batchId, index + 1, line.account_id, line.description, line.debit, line.credit]
        )
      }
      await insertAudit(client, {
        tenantId, batchId, actorId: userId, eventType: 'draft_created', reason: draft.description,
        idempotencyKey: draft.idempotencyKey, payloadHash: draft.payloadHash,
        details: { line_count: draft.lines.length, effective_date: draft.effectiveDate }
      })
      return { ...(await loadBatch(client, tenantId, batchId)), replayed: false }
    })
  } catch (error) {
    if (error.code === '23505') throw httpError(409, 'A cutover opening balance already exists or this request conflicts with an existing cutover')
    throw error
  }
}

async function listOpeningBalanceBatches(pool, tenantId) {
  requireIdentity(tenantId)
  const result = await pool.query(
    `SELECT id FROM accounting_opening_balance_batches
     WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100`,
    [tenantId]
  )
  const batches = []
  for (const row of result.rows) batches.push(await loadBatch(pool, tenantId, row.id))
  return batches
}

async function getOpeningBalanceBatch(pool, tenantId, batchId) {
  requireIdentity(tenantId)
  if (!isUuid(batchId)) throw httpError(404, 'Opening balance cutover not found')
  return loadBatch(pool, tenantId, batchId)
}

function confirmedBody(body, label) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  if (source.confirm !== true) throw validationError(`${label} requires explicit confirmation`)
  const reason = text(source.reason, `${label} reason`, 1800, { required: true })
  return { source, reason }
}

async function postOpeningBalanceDraft(pool, { tenantId, userId, batchId, idempotencyKey, body }) {
  requireIdentity(tenantId, userId)
  if (!isUuid(batchId)) throw httpError(404, 'Opening balance cutover not found')
  const key = normalizeIdempotencyKey(idempotencyKey)
  const { reason } = confirmedBody(body, 'Opening balance posting')
  const approvalHash = hashPayload({ batch_id: batchId, reason, confirm: true })
  return withTransaction(pool, async (client) => {
    const batch = await loadBatch(client, tenantId, batchId, { lock: true })
    if (batch.status === 'posted' || batch.status === 'reversed') {
      const event = await client.query(
        `SELECT payload_hash FROM accounting_opening_balance_events
         WHERE tenant_id = $1 AND batch_id = $2 AND idempotency_key = $3`,
        [tenantId, batchId, key]
      )
      if (event.rowCount === 1 && event.rows[0].payload_hash === approvalHash && batch.journal_entry_id) {
        return { batch, journal: await readJournal(client, tenantId, batch.journal_entry_id), replayed: true }
      }
      throw httpError(409, 'Opening balance cutover is no longer a draft')
    }
    if (batch.status !== 'draft') throw httpError(409, 'Only a draft opening balance can be posted')
    if (batch.created_by === userId) throw httpError(403, 'A different accounting administrator must approve and post this opening balance draft')
    const conflictingEvent = await client.query(
      'SELECT batch_id, payload_hash FROM accounting_opening_balance_events WHERE tenant_id = $1 AND idempotency_key = $2',
      [tenantId, key]
    )
    if (conflictingEvent.rowCount === 1) {
      if (conflictingEvent.rows[0].batch_id === batchId && conflictingEvent.rows[0].payload_hash === approvalHash) {
        return { batch, journal: await readJournal(client, tenantId, batch.journal_entry_id), replayed: true }
      }
      throw httpError(409, 'Idempotency-Key was already used for a different opening balance action')
    }
    const lines = batch.lines.map((line) => ({
      account_id: line.account_id, description: line.description, debit: line.debit, credit: line.credit
    }))
    await assertOpenPeriodAndAccounts(client, tenantId, {
      accountingPeriodId: batch.accounting_period_id,
      effectiveDate: String(batch.effective_date).slice(0, 10),
      lines
    }, { lock: true })
    const posting = await postJournal(pool, {
      tenantId,
      userId,
      idempotencyKey: `opening-balance:${batchId}:post:v1`,
      body: {
        accounting_period_id: batch.accounting_period_id,
        entry_date: String(batch.effective_date).slice(0, 10),
        description: batch.description,
        source_type: OPENING_SOURCE_TYPE,
        source_id: batchId,
        source_reference: `Opening balance cutover ${batchId}`,
        event_type: OPENING_EVENT_TYPE,
        lines
      }
    }, { client })
    const updated = await client.query(
      `UPDATE accounting_opening_balance_batches
       SET status = 'posted', journal_entry_id = $1, approved_by = $2,
           approved_at = CURRENT_TIMESTAMP, approval_reason = $3
       WHERE tenant_id = $4 AND id = $5 AND status = 'draft'
       RETURNING id, tenant_id, accounting_period_id, effective_date, description, status,
                 journal_entry_id, created_by, created_at, approved_by, approved_at, approval_reason`,
      [posting.journal.id, userId, reason, tenantId, batchId]
    )
    if (updated.rowCount !== 1) throw httpError(409, 'Opening balance cutover changed before posting completed')
    await insertAudit(client, {
      tenantId, batchId, actorId: userId, eventType: 'posted', reason,
      idempotencyKey: key, payloadHash: approvalHash,
      details: { journal_entry_id: posting.journal.id }
    })
    return { batch: updated.rows[0], journal: posting.journal, replayed: posting.replayed }
  })
}

async function cancelOpeningBalanceDraft(pool, { tenantId, userId, batchId, idempotencyKey, body }) {
  requireIdentity(tenantId, userId)
  if (!isUuid(batchId)) throw httpError(404, 'Opening balance cutover not found')
  const key = normalizeIdempotencyKey(idempotencyKey)
  const { reason } = confirmedBody(body, 'Opening balance cancellation')
  const hash = hashPayload({ batch_id: batchId, reason, confirm: true })
  return withTransaction(pool, async (client) => {
    const batch = await loadBatch(client, tenantId, batchId, { lock: true })
    if (batch.status === 'cancelled') {
      const event = await client.query(
        'SELECT payload_hash FROM accounting_opening_balance_events WHERE tenant_id = $1 AND batch_id = $2 AND idempotency_key = $3',
        [tenantId, batchId, key]
      )
      if (event.rowCount === 1 && event.rows[0].payload_hash === hash) return { batch, replayed: true }
      throw httpError(409, 'Opening balance draft was already cancelled')
    }
    if (batch.status !== 'draft') throw httpError(409, 'Only a draft opening balance can be cancelled; posted balances must be reversed')
    const conflicting = await client.query(
      'SELECT batch_id, payload_hash FROM accounting_opening_balance_events WHERE tenant_id = $1 AND idempotency_key = $2',
      [tenantId, key]
    )
    if (conflicting.rowCount === 1) throw httpError(409, 'Idempotency-Key was already used for a different opening balance action')
    await client.query(
      `UPDATE accounting_opening_balance_batches
       SET status = 'cancelled', cancelled_by = $1, cancelled_at = CURRENT_TIMESTAMP, cancellation_reason = $2
       WHERE tenant_id = $3 AND id = $4 AND status = 'draft'`,
      [userId, reason, tenantId, batchId]
    )
    await insertAudit(client, {
      tenantId, batchId, actorId: userId, eventType: 'cancelled', reason,
      idempotencyKey: key, payloadHash: hash, details: {}
    })
    return { batch: await loadBatch(client, tenantId, batchId), replayed: false }
  })
}

async function readJournal(client, tenantId, journalId) {
  if (!journalId) throw httpError(409, 'Opening balance journal is not available')
  const entry = await client.query(
    `SELECT id, accounting_period_id, entry_date, description, status, functional_currency,
            source_type, source_id, source_reference, event_type, reversal_of_entry_id,
            reversal_reason, created_by, posted_by, created_at, posted_at
     FROM accounting_journal_entries WHERE tenant_id = $1 AND id = $2`,
    [tenantId, journalId]
  )
  if (entry.rowCount !== 1) throw httpError(409, 'Opening balance journal is not available')
  const lines = await client.query(
    `SELECT line_number, account_id, description, debit::text AS debit, credit::text AS credit
     FROM accounting_journal_lines WHERE tenant_id = $1 AND journal_entry_id = $2 ORDER BY line_number`,
    [tenantId, journalId]
  )
  return { ...entry.rows[0], lines: lines.rows }
}

async function reverseOpeningBalance(pool, { tenantId, userId, batchId, idempotencyKey, body }) {
  requireIdentity(tenantId, userId)
  if (!isUuid(batchId)) throw httpError(404, 'Opening balance cutover not found')
  const key = normalizeIdempotencyKey(idempotencyKey)
  const { source, reason } = confirmedBody(body, 'Opening balance reversal')
  const reversalDate = validDate(source.reversal_date, 'Reversal date')
  if (!isUuid(source.accounting_period_id)) throw validationError('A valid reversal accounting period is required')
  const hash = hashPayload({ batch_id: batchId, reversal_date: reversalDate, period_id: source.accounting_period_id, reason, confirm: true })
  return withTransaction(pool, async (client) => {
    const batch = await loadBatch(client, tenantId, batchId, { lock: true })
    if (batch.status === 'reversed') {
      const event = await client.query(
        'SELECT payload_hash FROM accounting_opening_balance_events WHERE tenant_id = $1 AND batch_id = $2 AND idempotency_key = $3',
        [tenantId, batchId, key]
      )
      if (event.rowCount === 1 && event.rows[0].payload_hash === hash && batch.reversal_journal_entry_id) {
        return { batch, journal: await readJournal(client, tenantId, batch.reversal_journal_entry_id), replayed: true }
      }
      throw httpError(409, 'Opening balance cutover was already reversed')
    }
    if (batch.status !== 'posted' || !batch.journal_entry_id) throw httpError(409, 'Only a posted opening balance can be reversed')
    const conflicting = await client.query(
      'SELECT batch_id, payload_hash FROM accounting_opening_balance_events WHERE tenant_id = $1 AND idempotency_key = $2',
      [tenantId, key]
    )
    if (conflicting.rowCount === 1) throw httpError(409, 'Idempotency-Key was already used for a different opening balance action')
    await assertOpenPeriodAndAccounts(client, tenantId, {
      accountingPeriodId: source.accounting_period_id,
      effectiveDate: reversalDate,
      lines: batch.lines.map((line) => ({ account_id: line.account_id }))
    }, { lock: true })
    const posting = await reverseJournal(pool, {
      tenantId, userId, journalId: batch.journal_entry_id,
      idempotencyKey: `opening-balance:${batchId}:reverse:v1`,
      reversalDate, periodId: source.accounting_period_id, reason
    }, { client, allowedSourceTypes: ['opening_balance'] })
    const updated = await client.query(
      `UPDATE accounting_opening_balance_batches
       SET status = 'reversed', reversal_journal_entry_id = $1, reversed_by = $2,
           reversed_at = CURRENT_TIMESTAMP, reversal_reason = $3
       WHERE tenant_id = $4 AND id = $5 AND status = 'posted'
       RETURNING id, tenant_id, accounting_period_id, effective_date, description, status,
                 journal_entry_id, reversal_journal_entry_id, created_by, created_at,
                 approved_by, approved_at, approval_reason, reversed_by, reversed_at, reversal_reason`,
      [posting.journal.id, userId, reason, tenantId, batchId]
    )
    if (updated.rowCount !== 1) throw httpError(409, 'Opening balance changed before reversal completed')
    await insertAudit(client, {
      tenantId, batchId, actorId: userId, eventType: 'reversed', reason,
      idempotencyKey: key, payloadHash: hash,
      details: { reversal_journal_entry_id: posting.journal.id, reversal_date: reversalDate }
    })
    return { batch: updated.rows[0], journal: posting.journal, replayed: posting.replayed }
  })
}

async function inspectPreviewSchema(client) {
  const requestedTables = [...new Set([
    ...Object.keys(PREVIEW_REQUIREMENTS),
    ...Object.keys(PREVIEW_DEPENDENCIES)
  ])]
  const result = await client.query(
    `SELECT table_name, column_name, udt_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [requestedTables]
  )
  const schema = new Map()
  for (const row of result.rows) {
    if (!schema.has(row.table_name)) schema.set(row.table_name, new Map())
    schema.get(row.table_name).set(row.column_name, row.udt_name)
  }
  return schema
}

function sourceSchemaAvailable(schema, definition) {
  const columns = schema.get(definition.table)
  if (!columns) return false
  return Object.entries(definition.fields).every(([column, allowed]) => allowed.includes(columns.get(column)))
}

function unavailableSource(source, message) {
  return {
    source,
    available: false,
    eligible: { count: '0', totals_by_currency: [] },
    already_accounted_for: { count: null, totals_by_currency: [] },
    excluded: { count: null, totals_by_currency: [] },
    ambiguous: { count: null, totals_by_currency: [] },
    examples: [],
    truncated: false,
    message
  }
}

async function classifyPreviewSource(client, tenantId, source, definition, schema) {
  if (!sourceSchemaAvailable(schema, definition)) {
    return unavailableSource(source, 'Required table or column types are unavailable or differ from the reviewed contract; records were not queried.')
  }
  for (const dependency of definition.dependencies) {
    const columns = schema.get(dependency)
    const requirements = PREVIEW_DEPENDENCIES[dependency]
    if (!columns || !requirements || !Object.entries(requirements).every(([column, allowed]) => allowed.includes(columns.get(column)))) {
      return unavailableSource(source, `Required accounting table ${dependency} is unavailable or differs from the reviewed contract; classification is ambiguous.`)
    }
  }
  const summary = await client.query(
    `WITH classified AS (${definition.cte})
     SELECT classification, currency, count(*)::text AS record_count,
            COALESCE(sum(amount::numeric), 0)::text AS amount_total
     FROM classified GROUP BY classification, currency ORDER BY classification, currency`,
    [tenantId]
  )
  const details = await client.query(
    `WITH classified AS (${definition.cte})
     SELECT record_id, reference, amount, currency, status, classification, reason
     FROM classified ORDER BY classification, record_id LIMIT ${MAX_PREVIEW_ITEMS}`,
    [tenantId]
  )
  const grouped = {
    eligible: { count: '0', totals_by_currency: [] },
    already_accounted_for: { count: '0', totals_by_currency: [] },
    excluded: { count: '0', totals_by_currency: [] },
    ambiguous: { count: '0', totals_by_currency: [] }
  }
  for (const row of summary.rows) {
    if (!grouped[row.classification]) continue
    const target = grouped[row.classification]
    target.count = (BigInt(target.count) + BigInt(row.record_count)).toString()
    target.totals_by_currency.push({ currency: row.currency || null, amount: row.amount_total })
  }
  const itemCount = BigInt(summary.rows.reduce((total, row) => total + BigInt(row.record_count), 0n))
  return {
    source,
    available: true,
    ...grouped,
    examples: details.rows,
    truncated: itemCount > BigInt(details.rowCount),
    message: 'No legacy record is eligible for automatic posting. Review ambiguous items and use a verified ledger workflow; already represented entries must not be copied into opening balances.'
  }
}

async function withReadOnlySnapshot(pool, work) {
  const client = await pool.connect()
  let open = false
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    open = true
    const result = await work(client)
    await client.query('COMMIT')
    open = false
    return result
  } catch (error) {
    if (open) {
      try { await client.query('ROLLBACK') } catch (rollbackError) { error.rollbackError = rollbackError }
    }
    throw error
  } finally {
    client.release()
  }
}

async function getAccountingCutoverPreview(pool, tenantId) {
  requireIdentity(tenantId)
  return withReadOnlySnapshot(pool, async (client) => {
    const schema = await inspectPreviewSchema(client)
    const definitions = [
      ['invoices', { ...PREVIEW_REQUIREMENTS.invoices, table: 'invoices' }],
      ['customer_receipts', { ...PREVIEW_REQUIREMENTS.customer_receipts, table: 'customer_receipts' }],
      ['supplier_bills', { ...PREVIEW_REQUIREMENTS.supplier_bills, table: 'supplier_bills' }],
      ['supplier_payments', { ...PREVIEW_REQUIREMENTS.supplier_payments, table: 'supplier_payments' }],
      ['expenses', { ...PREVIEW_REQUIREMENTS.expenses, table: 'expenses' }]
    ]
    const sources = []
    for (const [name, definition] of definitions) {
      sources.push(await classifyPreviewSource(client, tenantId, name, definition, schema))
    }
    sources.push(unavailableSource(
      'legacy_payments',
      'The repository does not define the legacy payments schema or status domain. Payment rows were not queried or treated as settled; reconcile eligible requests individually through the verified M-Pesa workflow.'
    ))
    const cutovers = await client.query(
      `SELECT id, status, effective_date, accounting_period_id, journal_entry_id, reversal_journal_entry_id
       FROM accounting_opening_balance_batches WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC`,
      [tenantId]
    )
    return {
      generated_at: new Date().toISOString(),
      historical_posting_supported: false,
      policy: 'This report is read-only. Historical business records are not bulk-posted. Enter the approved, reconciled balance-sheet trial balance as an opening-balance draft; source records already represented by posted journals must not be included again.',
      sources,
      opening_balance_cutovers: cutovers.rows
    }
  })
}

module.exports = {
  cancelOpeningBalanceDraft,
  createOpeningBalanceDraft,
  getAccountingCutoverPreview,
  getOpeningBalanceBatch,
  listOpeningBalanceBatches,
  normalizeDraft,
  postOpeningBalanceDraft,
  reverseOpeningBalance
}

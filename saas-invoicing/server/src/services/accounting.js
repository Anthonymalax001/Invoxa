const { validate: isUuid } = require('uuid')
const {
  decimal,
  hashJournalPayload,
  httpError,
  normalizeCurrency,
  normalizeJournal,
  normalizeIdempotencyKey,
  validationError
} = require('../utils/accounting')
const { logSafeError } = require('../utils/errorLogging')

async function withTransaction(pool, work) {
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
        logSafeError('Failed to roll back accounting transaction', rollbackError)
      }
    }
    throw error
  } finally {
    if (client) client.release(releaseError)
  }
}

// Pending source records can be dated before they are posted. Lock a matching
// period row so their creation cannot race a period close and allow a new
// unresolved record to appear after readiness was assessed.
async function assertDateNotInClosedPeriod(client, tenantId, entryDate, label = 'Transaction date') {
  const result = await client.query(
    `SELECT id, status FROM accounting_periods
     WHERE tenant_id = $1 AND $2::date BETWEEN starts_on AND ends_on
     FOR SHARE`,
    [tenantId, entryDate]
  )
  if (result.rowCount > 0 && result.rows[0].status !== 'open') {
    throw httpError(409, `${label} falls in a closed accounting period`)
  }
}

function requireIdentity(tenantId, userId) {
  if (!isUuid(tenantId) || !isUuid(userId)) {
    throw httpError(401, 'Authenticated tenant and user identities are required')
  }
}

function postingConflict(error) {
  if (error && error.statusCode) return error
  if (error && error.code === '23505') return httpError(409, 'A journal already exists for this posting key or source event')
  if (error && ['23503', '23514', '23P01'].includes(error.code)) {
    return httpError(error.code === '23P01' ? 409 : 400, 'Accounting data violates a required constraint')
  }
  return error
}

async function existingPosting(client, tenantId, idempotencyKey, payloadHash) {
  const result = await client.query(
    `SELECT id, payload_hash, status, journal_entry_id
     FROM accounting_posting_events
     WHERE tenant_id = $1 AND idempotency_key = $2
     FOR UPDATE`,
    [tenantId, idempotencyKey]
  )
  if (result.rowCount !== 1) return null
  const event = result.rows[0]
  if (event.payload_hash !== payloadHash) {
    throw httpError(409, 'Idempotency-Key was already used for a different journal payload')
  }
  if (event.status !== 'posted' || !event.journal_entry_id) {
    throw httpError(409, 'The previous journal request has not completed')
  }
  const journal = await client.query(
    `SELECT id, accounting_period_id, entry_date, description, status,
            functional_currency, source_type, source_id, source_reference,
            event_type, reversal_of_entry_id, reversal_reason, created_by,
            posted_by, created_at, posted_at
     FROM accounting_journal_entries
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, event.journal_entry_id]
  )
  if (journal.rowCount !== 1) throw httpError(409, 'The previous posting record is incomplete')
  const lines = await client.query(
    `SELECT line_number, account_id, description, debit, credit,
            transaction_currency, transaction_amount, exchange_rate,
            exchange_rate_source, exchange_rate_at
     FROM accounting_journal_lines
     WHERE tenant_id = $1 AND journal_entry_id = $2
     ORDER BY line_number`,
    [tenantId, event.journal_entry_id]
  )
  return { journal: journal.rows[0], lines: lines.rows, replayed: true }
}

async function createPosting(client, tenantId, userId, payload, reversalOfEntryId = null) {
  const eventInsert = await client.query(
    `INSERT INTO accounting_posting_events
       (tenant_id, idempotency_key, payload_hash, source_type, source_id,
        source_reference, event_type, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
     RETURNING id`,
    [tenantId, payload.idempotency_key, payload.payload_hash, payload.source_type,
      payload.source_id, payload.source_reference, payload.event_type, userId]
  )
  if (eventInsert.rowCount === 0) {
    const replay = await existingPosting(client, tenantId, payload.idempotency_key, payload.payload_hash)
    if (!replay) throw httpError(409, 'Posting event could not be resolved')
    return replay
  }
  const eventId = eventInsert.rows[0].id

  const settings = await client.query(
    `SELECT base_currency FROM accounting_settings WHERE tenant_id = $1 FOR SHARE`,
    [tenantId]
  )
  if (settings.rowCount !== 1) throw httpError(409, 'Configure the tenant accounting currency before posting journals')
  const baseCurrency = normalizeCurrency(settings.rows[0].base_currency, 'Configured base currency')

  const periodResult = await client.query(
    `SELECT id, status,
            ($3::date BETWEEN starts_on AND ends_on) AS entry_date_in_period
     FROM accounting_periods
     WHERE tenant_id = $1 AND id = $2 FOR SHARE`,
    [tenantId, payload.accounting_period_id, payload.entry_date]
  )
  if (periodResult.rowCount !== 1) throw httpError(404, 'Accounting period not found')
  const period = periodResult.rows[0]
  if (period.status !== 'open') throw httpError(409, 'Cannot post into a closed accounting period')
  if (!period.entry_date_in_period) {
    throw httpError(400, 'Journal date is outside the selected accounting period')
  }

  const accountIds = [...new Set(payload.lines.map((line) => line.account_id))]
  const accountResult = await client.query(
    `SELECT id, account_type, normal_balance, is_active
     FROM accounting_accounts
     WHERE tenant_id = $1 AND id = ANY($2::uuid[])
     FOR SHARE`,
    [tenantId, accountIds]
  )
  if (accountResult.rowCount !== accountIds.length) {
    throw httpError(400, 'One or more journal accounts are unavailable for this tenant')
  }
  if (accountResult.rows.some((account) => !account.is_active)) {
    throw httpError(409, 'All journal accounts must be active')
  }

  for (const line of payload.lines) {
    if (line.transaction_currency === baseCurrency && line.exchange_rate !== '1.0000000000') {
      throw validationError('Base-currency journal lines must use an exchange rate of one')
    }
  }

  const entryResult = await client.query(
    `INSERT INTO accounting_journal_entries
       (tenant_id, accounting_period_id, entry_date, description, status,
        functional_currency, source_type, source_id, source_reference, event_type,
        posting_event_id, reversal_of_entry_id, reversal_reason, created_by)
     VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [tenantId, payload.accounting_period_id, payload.entry_date, payload.description,
      baseCurrency, payload.source_type, payload.source_id, payload.source_reference,
      payload.event_type, eventId, reversalOfEntryId, payload.reversal_reason, userId]
  )
  const journalId = entryResult.rows[0].id

  for (let index = 0; index < payload.lines.length; index += 1) {
    const line = payload.lines[index]
    await client.query(
      `INSERT INTO accounting_journal_lines
         (tenant_id, journal_entry_id, line_number, account_id, description,
          debit, credit, transaction_currency, transaction_amount, exchange_rate,
          exchange_rate_source, exchange_rate_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [tenantId, journalId, index + 1, line.account_id, line.description,
        line.debit, line.credit, line.transaction_currency, line.transaction_amount,
        line.exchange_rate, line.exchange_rate_source, line.exchange_rate_at]
    )
  }

  const posted = await client.query(
    `UPDATE accounting_journal_entries
     SET status = 'posted', posted_by = $1, posted_at = CURRENT_TIMESTAMP
     WHERE tenant_id = $2 AND id = $3 AND status = 'draft'
     RETURNING id, accounting_period_id, entry_date, description, status,
               functional_currency, source_type, source_id, source_reference,
               event_type, reversal_of_entry_id, reversal_reason, created_by,
               posted_by, created_at, posted_at`,
    [userId, tenantId, journalId]
  )
  if (posted.rowCount !== 1) throw httpError(409, 'Journal could not be posted')

  const completed = await client.query(
    `UPDATE accounting_posting_events
     SET status = 'posted', journal_entry_id = $1, completed_at = CURRENT_TIMESTAMP
     WHERE tenant_id = $2 AND id = $3 AND status = 'processing'`,
    [journalId, tenantId, eventId]
  )
  if (completed.rowCount !== 1) throw httpError(409, 'Posting event could not be completed')

  return {
    journal: posted.rows[0],
    lines: payload.lines.map((line, index) => ({ line_number: index + 1, ...line })),
    replayed: false
  }
}

async function postJournal(pool, { tenantId, userId, idempotencyKey, body }, { client: callerClient } = {}) {
  requireIdentity(tenantId, userId)
  const payload = normalizeJournal(body, idempotencyKey)
  if (callerClient != null && typeof callerClient.query !== 'function') {
    throw new TypeError('Caller-owned accounting transaction client must provide query()')
  }
  try {
    if (callerClient) {
      return await createPosting(callerClient, tenantId, userId, payload)
    }
    return await withTransaction(pool, (client) => createPosting(client, tenantId, userId, payload))
  } catch (error) {
    throw postingConflict(error)
  }
}

function reversalPayload(original, lines, { idempotencyKey, reversalDate, periodId, reason }) {
  const normalizedReason = typeof reason === 'string' ? reason.trim() : ''
  if (!normalizedReason || normalizedReason.length > 1800) {
    throw validationError('A reversal reason of 1 to 1800 characters is required')
  }
  const body = {
    accounting_period_id: periodId,
    entry_date: reversalDate,
    description: `Reversal of journal ${original.id}: ${normalizedReason}`,
    source_type: 'journal_reversal',
    source_id: original.id,
    source_reference: original.source_reference || original.id,
    event_type: 'reversal',
    lines: lines.map((line) => ({
      account_id: line.account_id,
      description: line.description,
      debit: line.credit,
      credit: line.debit,
      transaction_currency: line.transaction_currency,
      transaction_amount: line.transaction_amount,
      exchange_rate: line.exchange_rate,
      exchange_rate_source: line.exchange_rate_source,
      exchange_rate_at: line.exchange_rate_at
    }))
  }
  const normalized = normalizeJournal(body, idempotencyKey)
  normalized.reversal_of_entry_id = original.id
  normalized.reversal_reason = normalizedReason
  normalized.payload_hash = hashJournalPayload(normalized)
  return normalized
}

async function reverseJournal(pool, { tenantId, userId, journalId, idempotencyKey, reversalDate, periodId, reason }, {
  client: callerClient,
  allowedSourceTypes = ['manual_adjustment']
} = {}) {
  requireIdentity(tenantId, userId)
  if (!isUuid(journalId)) throw httpError(404, 'Journal entry not found')
  const normalizedKey = normalizeIdempotencyKey(idempotencyKey)
  if (!isUuid(periodId)) throw validationError('A valid accounting period is required')
  if (callerClient != null && typeof callerClient.query !== 'function') {
    throw new TypeError('Caller-owned accounting transaction client must provide query()')
  }

  try {
    const work = async (client) => {
      const originalResult = await client.query(
        `SELECT id, status, source_type, source_reference, reversal_of_entry_id
         FROM accounting_journal_entries
         WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [tenantId, journalId]
      )
      if (originalResult.rowCount !== 1) throw httpError(404, 'Journal entry not found')
      const original = originalResult.rows[0]
      if (original.status !== 'posted') throw httpError(409, 'Only posted journals can be reversed')
      if (original.reversal_of_entry_id) throw httpError(409, 'A reversal entry cannot itself be reversed')
      if (!Array.isArray(allowedSourceTypes) || !allowedSourceTypes.includes(original.source_type)) {
        throw httpError(409, 'This journal must be reversed through its owning business workflow')
      }

      const lineResult = await client.query(
        `SELECT line_number, account_id, description, debit, credit,
                transaction_currency, transaction_amount, exchange_rate,
                exchange_rate_source, exchange_rate_at
         FROM accounting_journal_lines
         WHERE tenant_id = $1 AND journal_entry_id = $2 ORDER BY line_number`,
        [tenantId, journalId]
      )
      const payload = reversalPayload(original, lineResult.rows, {
        idempotencyKey: normalizedKey, reversalDate, periodId, reason
      })
      return createPosting(client, tenantId, userId, payload, journalId)
    }
    if (callerClient) return await work(callerClient)
    return await withTransaction(pool, work)
  } catch (error) {
    throw postingConflict(error)
  }
}

module.exports = { assertDateNotInClosedPeriod, postJournal, reverseJournal, withTransaction }

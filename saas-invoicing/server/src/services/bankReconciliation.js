const crypto = require('node:crypto')
const { validate: isUuid } = require('uuid')
const pool = require('../config/db')
const { postJournal, withTransaction } = require('./accounting')
const { decimalUnits, httpError, normalizeIdempotencyKey, text, validationError } = require('../utils/accounting')

const MAX_FILE_BYTES = 1024 * 1024
const MAX_ROWS = 5000
const MAX_PAGE_SIZE = 100
const SCALE = 6
const HEADER_REQUIRED = ['transaction_date', 'description', 'debit', 'credit']
const HEADER_ALLOWED = new Set([...HEADER_REQUIRED, 'bank_reference', 'running_balance'])

function formatUnits(units, scale = SCALE) {
  const negative = units < 0n
  const absolute = negative ? -units : units
  const factor = 10n ** BigInt(scale)
  return `${negative ? '-' : ''}${absolute / factor}.${(absolute % factor).toString().padStart(scale, '0')}`
}

function moneyUnits(value, label, { allowZero = true, allowNegative = false } = {}) {
  if (typeof value !== 'string') value = String(value ?? '')
  const normalized = value.trim()
  const amount = allowNegative ? normalized.replace(/^-/, '') : normalized
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(amount) || amount.split('.')[0].length > 14 || (!allowNegative && normalized.startsWith('-'))) {
    throw validationError(`${label} must be ${allowNegative ? 'a signed' : 'a non-negative'} amount with at most 6 decimal places`)
  }
  const units = decimalUnits(amount.includes('.') ? amount : `${amount}.0`, SCALE, label, { allowZero: true })
  if (!allowZero && units === 0n) throw validationError(`${label} must be greater than zero`)
  return normalized.startsWith('-') ? -units : units
}

function normalizeMoney(value, label, options) {
  return formatUnits(moneyUnits(value, label, options), SCALE)
}

function parseCsv(textValue) {
  if (typeof textValue !== 'string') throw validationError('CSV content must be text')
  if (Buffer.byteLength(textValue, 'utf8') > MAX_FILE_BYTES) throw validationError('CSV file must be 1 MiB or smaller')
  if (textValue.includes('\u0000')) throw validationError('CSV file contains an invalid NUL character')
  const input = textValue.replace(/^\uFEFF/, '')
  const records = []
  let row = []
  let field = ''
  let quoted = false
  let afterQuote = false
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') { field += '"'; index += 1 }
        else { quoted = false; afterQuote = true }
      } else field += char
      continue
    }
    if (afterQuote && char !== ',' && char !== '\r' && char !== '\n' && !/[ \t]/.test(char)) {
      throw validationError(`CSV has unexpected text after a closing quote near record ${records.length + 1}`)
    }
    if (char === '"') {
      if (field.length !== 0 || afterQuote) throw validationError(`CSV has an unexpected quote near record ${records.length + 1}`)
      quoted = true
    } else if (char === ',') {
      row.push(field); field = ''; afterQuote = false
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && input[index + 1] === '\n') index += 1
      row.push(field); field = ''; afterQuote = false
      if (row.some((cell) => cell.trim() !== '')) records.push(row)
      row = []
      if (records.length > MAX_ROWS + 1) throw validationError(`CSV cannot contain more than ${MAX_ROWS} data rows`)
    } else {
      if (afterQuote && /[ \t]/.test(char)) continue
      field += char
    }
  }
  if (quoted) throw validationError('CSV contains an unterminated quoted field')
  if (field.length || row.length || afterQuote) {
    row.push(field)
    if (row.some((cell) => cell.trim() !== '')) records.push(row)
  }
  if (records.length < 2) throw validationError('CSV must contain a header and at least one transaction')
  if (records.length - 1 > MAX_ROWS) throw validationError(`CSV cannot contain more than ${MAX_ROWS} data rows`)
  return records
}

function strictDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw validationError(`${label} must use YYYY-MM-DD`)
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw validationError(`${label} is invalid`)
  return value
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function fingerprintFor(accountId, transaction) {
  const identity = transaction.bank_reference
    ? { reference: transaction.bank_reference.trim().toLocaleLowerCase('en-US') }
    : { description: transaction.description.trim().toLocaleLowerCase('en-US') }
  return digest(JSON.stringify({
    accountId,
    transaction_date: transaction.transaction_date,
    ...identity,
    debit: transaction.debit,
    credit: transaction.credit
  }))
}

function parseStatementCsv(csvText, accountId, suppliedBalances = {}) {
  if (!isUuid(accountId)) throw validationError('A valid bank account is required')
  accountId = accountId.toLowerCase()
  const records = parseCsv(csvText)
  const headers = records[0].map((header) => header.trim().toLowerCase())
  const errors = []
  const seenHeaders = new Set()
  for (const header of headers) {
    if (!HEADER_ALLOWED.has(header)) errors.push({ row_number: 1, field: header || 'header', message: `Unsupported CSV column: ${header || '(blank)'}` })
    if (seenHeaders.has(header)) errors.push({ row_number: 1, field: header, message: 'CSV headers must be unique' })
    seenHeaders.add(header)
  }
  for (const header of HEADER_REQUIRED) {
    if (!seenHeaders.has(header)) errors.push({ row_number: 1, field: header, message: `Required CSV column is missing: ${header}` })
  }
  if (errors.length) return { transactions: [], errors, file_sha256: digest(csvText), valid: false }

  const positions = new Map(headers.map((header, index) => [header, index]))
  if (records.some((record) => record.length !== headers.length)) {
    records.slice(1).forEach((record, index) => {
      if (record.length !== headers.length) errors.push({ row_number: index + 2, field: 'row', message: 'Every CSV row must have the same number of columns as the header' })
    })
  }

  const hasRunningBalance = positions.has('running_balance')
  const transactions = []
  for (let index = 1; index < records.length; index += 1) {
    const record = records[index]
    if (record.length !== headers.length) continue
    const rowNumber = index + 1
    const cell = (name) => record[positions.get(name)] ?? ''
    const rowErrors = []
    let transactionDate
    let debit = 0n
    let credit = 0n
    let runningBalance = null
    try { transactionDate = strictDate(cell('transaction_date').trim(), `Row ${rowNumber} transaction date`) }
    catch (error) { rowErrors.push({ row_number: rowNumber, field: 'transaction_date', message: error.message }) }
    try { debit = moneyUnits(cell('debit').trim() || '0', `Row ${rowNumber} debit`) }
    catch (error) { rowErrors.push({ row_number: rowNumber, field: 'debit', message: error.message }) }
    try { credit = moneyUnits(cell('credit').trim() || '0', `Row ${rowNumber} credit`) }
    catch (error) { rowErrors.push({ row_number: rowNumber, field: 'credit', message: error.message }) }
    if ((debit > 0n) === (credit > 0n)) rowErrors.push({ row_number: rowNumber, field: 'amount', message: 'Enter a positive debit or a positive credit, but not both' })
    if (!cell('description').trim()) rowErrors.push({ row_number: rowNumber, field: 'description', message: 'Description is required' })
    if (cell('description').length > 500) rowErrors.push({ row_number: rowNumber, field: 'description', message: 'Description must be 500 characters or fewer' })
    if (positions.has('bank_reference') && cell('bank_reference').length > 255) rowErrors.push({ row_number: rowNumber, field: 'bank_reference', message: 'Bank reference must be 255 characters or fewer' })
    if (hasRunningBalance) {
      try { runningBalance = moneyUnits(cell('running_balance').trim(), `Row ${rowNumber} running balance`, { allowNegative: true }) }
      catch (error) { rowErrors.push({ row_number: rowNumber, field: 'running_balance', message: error.message }) }
    }
    if (!rowErrors.length) {
      const transaction = {
        row_number: rowNumber,
        transaction_date: transactionDate,
        bank_reference: positions.has('bank_reference') ? (cell('bank_reference').trim() || null) : null,
        description: cell('description').trim(),
        debit: formatUnits(debit, SCALE),
        credit: formatUnits(credit, SCALE),
        running_balance: runningBalance == null ? null : formatUnits(runningBalance, SCALE)
      }
      transactions.push(transaction)
    } else errors.push(...rowErrors)
  }

  let openingBalance = null
  let closingBalance = null
  if (hasRunningBalance && transactions.length === records.length - 1) {
    let previousDate = null
    let previousBalance = null
    for (const transaction of transactions) {
      if (previousDate && transaction.transaction_date < previousDate) {
        errors.push({ row_number: transaction.row_number, field: 'transaction_date', message: 'Transactions must be in chronological date order when running balances are supplied' })
      }
      const currentBalance = moneyUnits(transaction.running_balance, 'Running balance', { allowNegative: true })
      const movement = moneyUnits(transaction.credit, 'Credit') - moneyUnits(transaction.debit, 'Debit')
      if (previousBalance != null && currentBalance !== previousBalance + movement) {
        errors.push({ row_number: transaction.row_number, field: 'running_balance', message: 'Running balance does not equal the previous balance plus this transaction' })
      }
      if (previousBalance == null) openingBalance = formatUnits(currentBalance - movement, SCALE)
      previousDate = transaction.transaction_date
      previousBalance = currentBalance
    }
    closingBalance = previousBalance == null ? null : formatUnits(previousBalance, SCALE)
  } else if (!hasRunningBalance) {
    try { openingBalance = formatUnits(moneyUnits(String(suppliedBalances.opening_balance ?? ''), 'Statement opening balance', { allowNegative: true }), SCALE) }
    catch (error) { errors.push({ row_number: null, field: 'opening_balance', message: error.message }) }
    try { closingBalance = formatUnits(moneyUnits(String(suppliedBalances.closing_balance ?? ''), 'Statement closing balance', { allowNegative: true }), SCALE) }
    catch (error) { errors.push({ row_number: null, field: 'closing_balance', message: error.message }) }
    if (openingBalance != null && closingBalance != null && transactions.length === records.length - 1) {
      const expectedClosing = moneyUnits(openingBalance, 'Statement opening balance', { allowNegative: true }) +
        transactions.reduce((sum, transaction) => sum + moneyUnits(transaction.credit, 'Credit') - moneyUnits(transaction.debit, 'Debit'), 0n)
      if (expectedClosing !== moneyUnits(closingBalance, 'Statement closing balance', { allowNegative: true })) {
        errors.push({ row_number: null, field: 'closing_balance', message: 'Statement closing balance must equal its opening balance plus credits less debits' })
      }
    }
  }

  for (const transaction of transactions) transaction.fingerprint = fingerprintFor(accountId, transaction)
  const fingerprints = new Set()
  for (const transaction of transactions) {
    if (fingerprints.has(transaction.fingerprint)) {
      errors.push({ row_number: transaction.row_number, field: 'duplicate', message: 'This transaction duplicates an earlier row in the CSV' })
    }
    fingerprints.add(transaction.fingerprint)
  }
  const dates = transactions.map((transaction) => transaction.transaction_date).sort()
  const fileSha = digest(csvText)
  const contentForPreview = JSON.stringify({
    account_id: accountId, file_sha256: fileSha, opening_balance: openingBalance,
    closing_balance: closingBalance, transactions: transactions.map(({ row_number, ...tx }) => tx)
  })
  return {
    transactions, errors, valid: errors.length === 0 && transactions.length > 0,
    file_sha256: fileSha, preview_token: digest(contentForPreview),
    opening_balance: openingBalance, closing_balance: closingBalance,
    statement_start_date: dates[0] || null, statement_end_date: dates[dates.length - 1] || null,
    row_count: transactions.length, has_running_balance: hasRunningBalance
  }
}

function requireTenant(tenantId) {
  if (!isUuid(tenantId)) throw httpError(401, 'Authenticated tenant identity is required')
}

function requireActor(tenantId, userId) {
  requireTenant(tenantId)
  if (!isUuid(userId)) throw httpError(401, 'Authenticated user identity is required')
}

function pageOptions(page, pageSize) {
  const parsedPage = page == null ? 1 : Number(page)
  const parsedSize = pageSize == null ? 25 : Number(pageSize)
  if (!Number.isInteger(parsedPage) || parsedPage < 1 || parsedPage > 1000000) throw validationError('Page must be a positive integer')
  if (!Number.isInteger(parsedSize) || parsedSize < 1 || parsedSize > MAX_PAGE_SIZE) throw validationError(`Page size must be between 1 and ${MAX_PAGE_SIZE}`)
  return { page: parsedPage, pageSize: parsedSize, offset: (parsedPage - 1) * parsedSize }
}

async function assertBankAccount(client, tenantId, accountId, lock = false) {
  if (!isUuid(accountId)) throw validationError('A valid bank account is required')
  const result = await client.query(
    `SELECT b.account_id, b.bank_label, a.account_code, a.name, a.account_type,
            a.normal_balance, a.is_active, s.base_currency
     FROM bank_reconciliation_accounts b
     JOIN accounting_accounts a ON a.tenant_id = b.tenant_id AND a.id = b.account_id
     JOIN accounting_settings s ON s.tenant_id = b.tenant_id
     WHERE b.tenant_id = $1 AND b.account_id = $2${lock ? ' FOR UPDATE OF b, a' : ''}`,
    [tenantId, accountId]
  )
  if (result.rowCount !== 1) throw httpError(404, 'Reconciliation bank account not found')
  const account = result.rows[0]
  if (!account.is_active || account.account_type !== 'asset' || account.normal_balance !== 'debit') {
    throw httpError(409, 'The designated bank account must remain an active debit-normal asset account')
  }
  return account
}

async function checkDuplicateFingerprints(client, tenantId, accountId, transactions) {
  const fingerprints = transactions.map((transaction) => transaction.fingerprint)
  if (!fingerprints.length) return []
  const result = await client.query(
    `SELECT fingerprint FROM bank_reconciliation_statement_transactions
     WHERE tenant_id = $1 AND bank_account_id = $2 AND fingerprint = ANY($3::text[])`,
    [tenantId, accountId, fingerprints]
  )
  return result.rows.map((row) => row.fingerprint)
}

async function prepareImport(client, tenantId, body, lockAccount = false) {
  const accountId = body.account_id
  const account = await assertBankAccount(client, tenantId, accountId, lockAccount)
  const parsed = parseStatementCsv(body.csv_text, accountId, body)
  const errors = [...parsed.errors]
  if (parsed.valid) {
    const duplicates = new Set(await checkDuplicateFingerprints(client, tenantId, accountId, parsed.transactions))
    parsed.transactions.forEach((transaction) => {
      if (duplicates.has(transaction.fingerprint)) errors.push({
        row_number: transaction.row_number, field: 'duplicate',
        message: 'This transaction was already imported for this bank account'
      })
    })
  }
  const filename = text(body.file_name, 'File name', 180, { required: true })
  if (filename.includes('/') || filename.includes('\\') || filename === '.' || filename === '..') {
    errors.push({ row_number: null, field: 'file_name', message: 'File name must not contain a path' })
  }
  return {
    ...parsed,
    errors,
    valid: errors.length === 0,
    account: { account_id: account.account_id, bank_label: account.bank_label, currency: account.base_currency },
    file_name: filename
  }
}

async function previewImport(tenantId, body) {
  requireTenant(tenantId)
  const preview = await prepareImport(pool, tenantId, body)
  return {
    valid: preview.valid,
    account: preview.account,
    file_name: preview.file_name,
    currency: preview.account.currency,
    row_count: preview.row_count,
    statement_start_date: preview.statement_start_date,
    statement_end_date: preview.statement_end_date,
    opening_balance: preview.opening_balance,
    closing_balance: preview.closing_balance,
    file_sha256: preview.file_sha256,
    preview_token: preview.preview_token,
    transactions: preview.transactions.map(({ fingerprint, ...transaction }) => transaction),
    errors: preview.errors
  }
}

async function listAccounts(tenantId) {
  requireTenant(tenantId)
  const result = await pool.query(
    `SELECT b.account_id, b.bank_label, a.account_code, a.name AS account_name,
            a.is_active, s.base_currency AS currency,
            (SELECT count(*)::integer FROM bank_reconciliation_import_batches i
             WHERE i.tenant_id = b.tenant_id AND i.bank_account_id = b.account_id) AS import_count
     FROM bank_reconciliation_accounts b
     JOIN accounting_accounts a ON a.tenant_id = b.tenant_id AND a.id = b.account_id
     JOIN accounting_settings s ON s.tenant_id = b.tenant_id
     WHERE b.tenant_id = $1 ORDER BY a.account_code, b.bank_label`,
    [tenantId]
  )
  return result.rows
}

async function listAccountCandidates(tenantId) {
  requireTenant(tenantId)
  const result = await pool.query(
    `SELECT a.id AS account_id, a.account_code, a.name AS account_name,
            a.is_active, (b.account_id IS NOT NULL) AS already_designated
     FROM accounting_accounts a
     LEFT JOIN bank_reconciliation_accounts b ON b.tenant_id = a.tenant_id AND b.account_id = a.id
     WHERE a.tenant_id = $1 AND a.account_type = 'asset' AND a.normal_balance = 'debit'
     ORDER BY a.is_active DESC, a.account_code, a.id`,
    [tenantId]
  )
  return result.rows
}

async function enableAccount(tenantId, userId, body) {
  requireActor(tenantId, userId)
  const accountId = body.account_id
  if (!isUuid(accountId)) throw validationError('A valid accounting account is required')
  const bankLabel = text(body.bank_label, 'Bank label', 150, { required: true })
  return withTransaction(pool, async (client) => {
    const result = await client.query(
      `INSERT INTO bank_reconciliation_accounts (tenant_id, account_id, bank_label, created_by)
       VALUES ($1, $2, $3, $4) RETURNING tenant_id, account_id, bank_label, created_by, created_at`,
      [tenantId, accountId, bankLabel, userId]
    )
    await recordEvent(client, { tenantId, accountId, actorId: userId, type: 'account_enabled', details: { bank_label: bankLabel } })
    return result.rows[0]
  })
}

async function importStatement(tenantId, userId, body, idempotencyKey) {
  requireActor(tenantId, userId)
  if (body.confirm !== true) throw validationError('Explicit confirmation is required to import the previewed statement')
  const key = normalizeIdempotencyKey(idempotencyKey)
  return withTransaction(pool, async (client) => {
    const findReplay = async () => {
      const existing = await client.query(
        `SELECT id, file_sha256, bank_account_id, reconciliation_status, imported_at
         FROM bank_reconciliation_import_batches WHERE tenant_id = $1 AND idempotency_key = $2 FOR UPDATE`,
        [tenantId, key]
      )
      if (existing.rowCount !== 1) return null
      const prior = existing.rows[0]
      const fileHash = digest(String(body.csv_text ?? ''))
      if (prior.file_sha256 !== fileHash || prior.bank_account_id !== body.account_id) {
        throw httpError(409, 'Idempotency-Key was already used for a different bank statement import')
      }
      return { ...prior, replayed: true }
    }
    const existingReplay = await findReplay()
    if (existingReplay) return existingReplay

    // Serialize imports for this bank account before the final idempotency and
    // duplicate-statement checks. A same-key request can have observed no row
    // above while another transaction was still importing and then waited here.
    await assertBankAccount(client, tenantId, body.account_id, true)
    const replayAfterAccountLock = await findReplay()
    if (replayAfterAccountLock) return replayAfterAccountLock

    const prepared = await prepareImport(client, tenantId, body)
    if (!prepared.valid) throw validationError(`Import is invalid: ${prepared.errors[0]?.message || 'correct the validation errors and preview again'}`)
    if (body.preview_token !== prepared.preview_token) throw httpError(409, 'CSV changed since preview; preview the statement again before importing')
    const inserted = await client.query(
      `INSERT INTO bank_reconciliation_import_batches
         (tenant_id, bank_account_id, file_name, file_sha256, idempotency_key, currency,
          statement_start_date, statement_end_date, statement_opening_balance,
          statement_closing_balance, row_count, imported_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id, tenant_id, bank_account_id, file_name, file_sha256, currency,
                 statement_start_date, statement_end_date, statement_opening_balance,
                 statement_closing_balance, row_count, reconciliation_status, imported_by, imported_at`,
      [tenantId, body.account_id, prepared.file_name, prepared.file_sha256, key,
        prepared.account.currency, prepared.statement_start_date, prepared.statement_end_date,
        prepared.opening_balance, prepared.closing_balance, prepared.row_count, userId]
    )
    const batch = inserted.rows[0]
    for (const transaction of prepared.transactions) {
      await client.query(
        `INSERT INTO bank_reconciliation_statement_transactions
           (tenant_id, import_batch_id, bank_account_id, row_number, transaction_date,
            bank_reference, description, debit, credit, running_balance, fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [tenantId, batch.id, body.account_id, transaction.row_number, transaction.transaction_date,
          transaction.bank_reference, transaction.description, transaction.debit, transaction.credit,
          transaction.running_balance, transaction.fingerprint]
      )
    }
    await recordEvent(client, {
      tenantId, accountId: body.account_id, batchId: batch.id, actorId: userId, type: 'imported',
      details: { file_sha256: prepared.file_sha256, row_count: prepared.row_count, file_name: prepared.file_name }
    })
    return { ...batch, replayed: false }
  }).catch((error) => {
    if (error.code === '23505') throw httpError(409, 'This bank statement file or one of its transactions was already imported')
    throw error
  })
}

async function recordEvent(client, { tenantId, accountId, batchId = null, transactionId = null, actorId, type, details = {} }) {
  await client.query(
    `INSERT INTO bank_reconciliation_events
       (tenant_id, bank_account_id, import_batch_id, statement_transaction_id, event_type, actor_id, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [tenantId, accountId, batchId, transactionId, type, actorId, JSON.stringify(details)]
  )
}

async function listImports(tenantId, { accountId, page, pageSize } = {}) {
  requireTenant(tenantId)
  const pagination = pageOptions(page, pageSize)
  if (accountId && !isUuid(accountId)) throw validationError('Bank account filter must be a UUID')
  const result = await pool.query(
    `SELECT i.id, i.bank_account_id, b.bank_label, i.file_name, i.currency,
            i.statement_start_date, i.statement_end_date, i.statement_opening_balance,
            i.statement_closing_balance, i.row_count, i.reconciliation_status,
            i.imported_by, i.imported_at, i.reconciled_by, i.reconciled_at,
            (SELECT count(*)::integer FROM bank_reconciliation_statement_transactions t
             WHERE t.tenant_id = i.tenant_id AND t.import_batch_id = i.id) AS transaction_count,
            (SELECT count(*)::integer FROM bank_reconciliation_matches m
             WHERE m.tenant_id = i.tenant_id AND m.import_batch_id = i.id AND m.status = 'matched') AS matched_count
     FROM bank_reconciliation_import_batches i
     JOIN bank_reconciliation_accounts b ON b.tenant_id = i.tenant_id AND b.account_id = i.bank_account_id
     WHERE i.tenant_id = $1 AND ($2::uuid IS NULL OR i.bank_account_id = $2)
     ORDER BY i.imported_at DESC, i.id DESC LIMIT $3 OFFSET $4`,
    [tenantId, accountId || null, pagination.pageSize, pagination.offset]
  )
  const total = await pool.query(
    'SELECT count(*)::integer AS total FROM bank_reconciliation_import_batches WHERE tenant_id = $1 AND ($2::uuid IS NULL OR bank_account_id = $2)',
    [tenantId, accountId || null]
  )
  return { page: pagination.page, page_size: pagination.pageSize, total: total.rows[0].total, imports: result.rows }
}

async function getBatch(tenantId, batchId, { page, pageSize } = {}) {
  requireTenant(tenantId)
  if (!isUuid(batchId)) throw httpError(404, 'Bank reconciliation import not found')
  const pagination = pageOptions(page, pageSize)
  const batchResult = await pool.query(
    `SELECT i.*, b.bank_label, a.account_code, a.name AS account_name
     FROM bank_reconciliation_import_batches i
     JOIN bank_reconciliation_accounts b ON b.tenant_id = i.tenant_id AND b.account_id = i.bank_account_id
     JOIN accounting_accounts a ON a.tenant_id = i.tenant_id AND a.id = i.bank_account_id
     WHERE i.tenant_id = $1 AND i.id = $2`,
    [tenantId, batchId]
  )
  if (batchResult.rowCount !== 1) throw httpError(404, 'Bank reconciliation import not found')
  const batch = batchResult.rows[0]
  const statementRows = await pool.query(
    `SELECT t.id, t.row_number, t.transaction_date, t.bank_reference, t.description,
            t.debit, t.credit, t.running_balance,
            m.id AS match_id, m.status AS match_status, m.matched_at,
            j.id AS journal_entry_id, j.entry_date AS journal_date, j.description AS journal_description,
            j.source_type, j.source_id, j.source_reference, j.event_type, j.reversal_of_entry_id,
            l.id AS journal_line_id, l.debit AS journal_debit, l.credit AS journal_credit
     FROM bank_reconciliation_statement_transactions t
     LEFT JOIN bank_reconciliation_matches m ON m.tenant_id = t.tenant_id
       AND m.statement_transaction_id = t.id AND m.status = 'matched'
     LEFT JOIN accounting_journal_entries j ON j.tenant_id = m.tenant_id AND j.id = m.journal_entry_id
     LEFT JOIN accounting_journal_lines l ON l.tenant_id = m.tenant_id AND l.id = m.journal_line_id
     WHERE t.tenant_id = $1 AND t.import_batch_id = $2
     ORDER BY t.transaction_date, t.row_number LIMIT $3 OFFSET $4`,
    [tenantId, batchId, pagination.pageSize, pagination.offset]
  )
  const statementCount = await pool.query(
    'SELECT count(*)::integer AS total FROM bank_reconciliation_statement_transactions WHERE tenant_id = $1 AND import_batch_id = $2',
    [tenantId, batchId]
  )
  const summary = await getSummaryForClient(pool, tenantId, batchId)
  const ledger = await pool.query(
    `SELECT j.id AS journal_entry_id, j.entry_date, j.description AS journal_description,
            j.source_type, j.source_id, j.source_reference, j.event_type, j.reversal_of_entry_id,
            l.id AS journal_line_id, l.line_number, l.debit, l.credit
     FROM accounting_journal_entries j
     JOIN accounting_journal_lines l ON l.tenant_id = j.tenant_id AND l.journal_entry_id = j.id
     WHERE j.tenant_id = $1 AND j.status = 'posted' AND l.account_id = $2
       AND j.entry_date >= $3::date AND j.entry_date <= $4::date
       AND NOT EXISTS (SELECT 1 FROM bank_reconciliation_matches m
                       WHERE m.tenant_id = l.tenant_id AND m.journal_line_id = l.id AND m.status = 'matched')
     ORDER BY j.entry_date, j.created_at, l.line_number, l.id LIMIT $5 OFFSET $6`,
    [tenantId, batch.bank_account_id, batch.statement_start_date, batch.statement_end_date,
      pagination.pageSize, pagination.offset]
  )
  const ledgerCount = await pool.query(
    `SELECT count(*)::integer AS total FROM accounting_journal_entries j
     JOIN accounting_journal_lines l ON l.tenant_id = j.tenant_id AND l.journal_entry_id = j.id
     WHERE j.tenant_id = $1 AND j.status = 'posted' AND l.account_id = $2
       AND j.entry_date >= $3::date AND j.entry_date <= $4::date
       AND NOT EXISTS (SELECT 1 FROM bank_reconciliation_matches m
                       WHERE m.tenant_id = l.tenant_id AND m.journal_line_id = l.id AND m.status = 'matched')`,
    [tenantId, batch.bank_account_id, batch.statement_start_date, batch.statement_end_date]
  )
  const events = await pool.query(
    `SELECT id, statement_transaction_id, event_type, actor_id, details, created_at
     FROM bank_reconciliation_events WHERE tenant_id = $1 AND import_batch_id = $2
     ORDER BY created_at, id`,
    [tenantId, batchId]
  )
  return {
    batch, summary,
    page: pagination.page, page_size: pagination.pageSize,
    statement_transactions: { total: statementCount.rows[0].total, rows: statementRows.rows },
    unmatched_ledger_transactions: { total: ledgerCount.rows[0].total, rows: ledger.rows },
    audit_history: events.rows
  }
}

async function getSuggestions(tenantId, statementTransactionId, limit = 25) {
  requireTenant(tenantId)
  if (!isUuid(statementTransactionId)) throw httpError(404, 'Statement transaction not found')
  const max = Number(limit)
  if (!Number.isInteger(max) || max < 1 || max > 50) throw validationError('Suggestion limit must be between 1 and 50')
  const txResult = await pool.query(
    `SELECT t.*, b.currency, b.bank_account_id, b.reconciliation_status,
            EXISTS (SELECT 1 FROM bank_reconciliation_matches m
                    WHERE m.tenant_id = t.tenant_id AND m.statement_transaction_id = t.id AND m.status = 'matched') AS is_matched
     FROM bank_reconciliation_statement_transactions t
     JOIN bank_reconciliation_import_batches b ON b.tenant_id = t.tenant_id AND b.id = t.import_batch_id
     WHERE t.tenant_id = $1 AND t.id = $2`,
    [tenantId, statementTransactionId]
  )
  if (txResult.rowCount !== 1) throw httpError(404, 'Statement transaction not found')
  const tx = txResult.rows[0]
  if (tx.reconciliation_status !== 'open') throw httpError(409, 'Reopen this reconciliation before matching transactions')
  if (tx.is_matched) throw httpError(409, 'This bank transaction is already matched')
  const account = await assertBankAccount(pool, tenantId, tx.bank_account_id)
  const requiredDebit = tx.credit > 0 ? tx.credit : '0'
  const requiredCredit = tx.debit > 0 ? tx.debit : '0'
  const result = await pool.query(
    `SELECT j.id AS journal_entry_id, l.id AS journal_line_id, j.entry_date,
            j.description, j.source_type, j.source_id, j.source_reference, j.event_type,
            j.reversal_of_entry_id, l.debit, l.credit, l.description AS line_description,
            abs(j.entry_date - $4::date) AS date_distance
     FROM accounting_journal_entries j
     JOIN accounting_journal_lines l ON l.tenant_id = j.tenant_id AND l.journal_entry_id = j.id
     WHERE j.tenant_id = $1 AND j.status = 'posted' AND j.functional_currency = $2
       AND l.account_id = $3 AND l.debit = $5::numeric AND l.credit = $6::numeric
       AND abs(j.entry_date - $4::date) <= 7
       AND NOT EXISTS (SELECT 1 FROM bank_reconciliation_matches m
                       WHERE m.tenant_id = l.tenant_id AND m.journal_line_id = l.id AND m.status = 'matched')
     ORDER BY (lower(coalesce(j.source_reference, '')) = lower(coalesce($7, ''))) DESC,
              abs(j.entry_date - $4::date), j.entry_date, j.created_at, l.line_number
     LIMIT $8`,
    [tenantId, account.base_currency, tx.bank_account_id, tx.transaction_date,
      requiredDebit, requiredCredit, tx.bank_reference, max]
  )
  return result.rows.map((candidate) => ({
    ...candidate,
    score: (tx.bank_reference && candidate.source_reference && tx.bank_reference.toLocaleLowerCase('en-US') === candidate.source_reference.toLocaleLowerCase('en-US') ? 100 : 0) +
      (Math.max(0, 50 - candidate.date_distance * 5))
  })).sort((a, b) => b.score - a.score)
}

async function lockStatementTransaction(client, tenantId, statementTransactionId) {
  if (!isUuid(statementTransactionId)) throw httpError(404, 'Statement transaction not found')
  const result = await client.query(
    `SELECT t.*, b.currency, b.bank_account_id AS batch_account_id,
            b.reconciliation_status, b.id AS batch_id
     FROM bank_reconciliation_statement_transactions t
     JOIN bank_reconciliation_import_batches b ON b.tenant_id = t.tenant_id AND b.id = t.import_batch_id
     WHERE t.tenant_id = $1 AND t.id = $2 FOR UPDATE OF b, t`,
    [tenantId, statementTransactionId]
  )
  if (result.rowCount !== 1) throw httpError(404, 'Statement transaction not found')
  const transaction = result.rows[0]
  if (transaction.reconciliation_status !== 'open') throw httpError(409, 'Reopen this reconciliation before changing matches')
  await assertBankAccount(client, tenantId, transaction.bank_account_id, true)
  return transaction
}

async function matchTransaction(tenantId, userId, statementTransactionId, body) {
  requireActor(tenantId, userId)
  if (body.confirm !== true) throw validationError('Explicit confirmation is required to match this transaction')
  if (!isUuid(body.journal_line_id)) throw validationError('A valid posted journal line is required')
  return withTransaction(pool, async (client) => {
    const transaction = await lockStatementTransaction(client, tenantId, statementTransactionId)
    const existing = await client.query(
      `SELECT id FROM bank_reconciliation_matches
       WHERE tenant_id = $1 AND statement_transaction_id = $2 AND status = 'matched' FOR UPDATE`,
      [tenantId, statementTransactionId]
    )
    if (existing.rowCount) throw httpError(409, 'This bank transaction is already matched')
    const lineResult = await client.query(
      `SELECT j.id AS journal_entry_id, j.status, j.functional_currency, j.entry_date,
              j.description AS journal_description, j.source_type, j.source_id,
              j.source_reference, j.event_type, j.reversal_of_entry_id,
              l.id AS journal_line_id, l.account_id, l.debit, l.credit
       FROM accounting_journal_entries j
       JOIN accounting_journal_lines l ON l.tenant_id = j.tenant_id AND l.journal_entry_id = j.id
       WHERE j.tenant_id = $1 AND l.id = $2 FOR SHARE OF j, l`,
      [tenantId, body.journal_line_id]
    )
    if (lineResult.rowCount !== 1) throw httpError(404, 'Posted journal line not found')
    const line = lineResult.rows[0]
    if (line.status !== 'posted' || line.account_id !== transaction.bank_account_id || line.functional_currency !== transaction.currency) {
      throw httpError(409, 'Match requires a posted journal line for this tenant bank account and statement currency')
    }
    const isCredit = moneyUnits(String(transaction.credit), 'Statement credit') > 0n
    if ((isCredit && (moneyUnits(String(line.debit), 'Journal debit') !== moneyUnits(String(transaction.credit), 'Statement credit') || moneyUnits(String(line.credit), 'Journal credit') !== 0n)) ||
        (!isCredit && (moneyUnits(String(line.credit), 'Journal credit') !== moneyUnits(String(transaction.debit), 'Statement debit') || moneyUnits(String(line.debit), 'Journal debit') !== 0n))) {
      throw httpError(409, 'Statement and journal amounts or transaction directions do not match exactly')
    }
    const matched = await client.query(
      `INSERT INTO bank_reconciliation_matches
         (tenant_id, import_batch_id, statement_transaction_id, bank_account_id,
          journal_entry_id, journal_line_id, matched_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, status, matched_at, journal_entry_id, journal_line_id`,
      [tenantId, transaction.batch_id, statementTransactionId, transaction.bank_account_id,
        line.journal_entry_id, line.journal_line_id, userId]
    )
    await recordEvent(client, {
      tenantId, accountId: transaction.bank_account_id, batchId: transaction.batch_id,
      transactionId: statementTransactionId, actorId: userId, type: 'matched',
      details: { match_id: matched.rows[0].id, journal_entry_id: line.journal_entry_id, journal_line_id: line.journal_line_id }
    })
    return { match: matched.rows[0], journal: line }
  }).catch((error) => {
    if (error.code === '23505') throw httpError(409, 'The statement transaction or journal line has already been matched')
    throw error
  })
}

async function unmatchTransaction(tenantId, userId, statementTransactionId, body) {
  requireActor(tenantId, userId)
  const reason = text(body.reason, 'Unmatch reason', 1000, { required: true })
  return withTransaction(pool, async (client) => {
    const transaction = await lockStatementTransaction(client, tenantId, statementTransactionId)
    const result = await client.query(
      `UPDATE bank_reconciliation_matches SET status = 'unmatched', unmatched_by = $1,
         unmatched_at = CURRENT_TIMESTAMP, unmatch_reason = $2
       WHERE tenant_id = $3 AND statement_transaction_id = $4 AND status = 'matched'
       RETURNING id, journal_entry_id, journal_line_id, unmatched_at`,
      [userId, reason, tenantId, statementTransactionId]
    )
    if (result.rowCount !== 1) throw httpError(409, 'This bank transaction does not have an active match')
    await recordEvent(client, {
      tenantId, accountId: transaction.bank_account_id, batchId: transaction.batch_id,
      transactionId: statementTransactionId, actorId: userId, type: 'unmatched',
      details: { match_id: result.rows[0].id, journal_entry_id: result.rows[0].journal_entry_id,
        journal_line_id: result.rows[0].journal_line_id, reason }
    })
    return result.rows[0]
  })
}

async function reconcileBatch(tenantId, userId, batchId, body) {
  requireActor(tenantId, userId)
  if (body.confirm !== true) throw validationError('Explicit confirmation is required to complete this reconciliation')
  if (!isUuid(batchId)) throw httpError(404, 'Bank reconciliation import not found')
  return withTransaction(pool, async (client) => {
    const result = await client.query(
      `SELECT id, bank_account_id, reconciliation_status FROM bank_reconciliation_import_batches
       WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId, batchId]
    )
    if (result.rowCount !== 1) throw httpError(404, 'Bank reconciliation import not found')
    if (result.rows[0].reconciliation_status !== 'open') throw httpError(409, 'This reconciliation has already been completed')
    const batch = result.rows[0]
    await assertBankAccount(client, tenantId, batch.bank_account_id, true)
    const summary = await getSummaryForClient(client, tenantId, batchId)
    if (!summary.can_reconcile) throw httpError(409, 'Reconciliation cannot be completed while bank transactions are unmatched or the difference is non-zero')
    await client.query(
      `UPDATE bank_reconciliation_import_batches
       SET reconciliation_status = 'reconciled', reconciled_by = $1, reconciled_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $2 AND id = $3 AND reconciliation_status = 'open'`,
      [userId, tenantId, batchId]
    )
    await recordEvent(client, {
      tenantId, accountId: batch.bank_account_id, batchId, actorId: userId, type: 'reconciled',
      details: { difference: summary.difference, matched_count: summary.matched_count }
    })
    return { status: 'reconciled', summary }
  })
}

async function getSummaryForClient(client, tenantId, batchId) {
  const result = await client.query(
    `SELECT * FROM bank_reconciliation_import_batches WHERE tenant_id = $1 AND id = $2`,
    [tenantId, batchId]
  )
  if (result.rowCount !== 1) throw httpError(404, 'Bank reconciliation import not found')
  const batch = result.rows[0]
  const [statement, book] = await Promise.all([
    client.query(
      `SELECT count(*)::integer AS transaction_count,
              count(*) FILTER (WHERE m.status = 'matched')::integer AS matched_count,
              count(*) FILTER (WHERE m.id IS NULL)::integer AS unmatched_count,
              COALESCE(sum(t.debit), 0)::text AS statement_debits,
              COALESCE(sum(t.credit), 0)::text AS statement_credits
       FROM bank_reconciliation_statement_transactions t
       LEFT JOIN bank_reconciliation_matches m ON m.tenant_id = t.tenant_id
         AND m.statement_transaction_id = t.id AND m.status = 'matched'
       WHERE t.tenant_id = $1 AND t.import_batch_id = $2`, [tenantId, batchId]
    ),
    client.query(
      `SELECT COALESCE(sum(l.debit - l.credit) FILTER (WHERE j.entry_date < $3::date), 0)::text AS book_opening_balance,
              COALESCE(sum(l.debit - l.credit) FILTER (WHERE j.entry_date <= $4::date), 0)::text AS book_closing_balance,
              COALESCE(sum(l.debit - l.credit) FILTER (WHERE j.entry_date BETWEEN $3::date AND $4::date
                AND NOT EXISTS (SELECT 1 FROM bank_reconciliation_matches m
                                WHERE m.tenant_id = l.tenant_id AND m.journal_line_id = l.id AND m.status = 'matched')), 0)::text AS outstanding_ledger_net
       FROM accounting_journal_entries j
       JOIN accounting_journal_lines l ON l.tenant_id = j.tenant_id AND l.journal_entry_id = j.id
       WHERE j.tenant_id = $1 AND j.status = 'posted' AND l.account_id = $2`,
      [tenantId, batch.bank_account_id, batch.statement_start_date, batch.statement_end_date]
    )
  ])
  const s = statement.rows[0]
  const b = book.rows[0]
  const toUnits = (value, label) => moneyUnits(String(value), label)
  const statementDebits = toUnits(s.statement_debits, 'Statement debits')
  const statementCredits = toUnits(s.statement_credits, 'Statement credits')
  const statementOpening = moneyUnits(String(batch.statement_opening_balance), 'Statement opening balance', { allowNegative: true })
  const statementClosing = moneyUnits(String(batch.statement_closing_balance), 'Statement closing balance', { allowNegative: true })
  const bookOpening = moneyUnits(String(b.book_opening_balance), 'Book opening balance', { allowNegative: true })
  const bookClosing = moneyUnits(String(b.book_closing_balance), 'Book closing balance', { allowNegative: true })
  const outstanding = moneyUnits(String(b.outstanding_ledger_net), 'Outstanding ledger transactions', { allowNegative: true })
  const difference = statementClosing + outstanding - bookClosing
  return {
    currency: batch.currency, transaction_count: s.transaction_count,
    matched_count: s.matched_count, unmatched_bank_count: s.unmatched_count,
    statement_debits: formatUnits(statementDebits, SCALE), statement_credits: formatUnits(statementCredits, SCALE),
    statement_movement: formatUnits(statementCredits - statementDebits, SCALE),
    statement_opening_balance: formatUnits(statementOpening, SCALE), statement_closing_balance: formatUnits(statementClosing, SCALE),
    book_opening_balance: formatUnits(bookOpening, SCALE), book_closing_balance: formatUnits(bookClosing, SCALE),
    opening_difference: formatUnits(statementOpening - bookOpening, SCALE),
    outstanding_ledger_net: formatUnits(outstanding, SCALE),
    adjusted_statement_closing_balance: formatUnits(statementClosing + outstanding, SCALE),
    difference: formatUnits(difference, SCALE), can_reconcile: s.unmatched_count === 0 && difference === 0n
  }
}

async function reopenBatch(tenantId, userId, batchId, body) {
  requireActor(tenantId, userId)
  const reason = text(body.reason, 'Reopen reason', 1000, { required: true })
  if (!isUuid(batchId)) throw httpError(404, 'Bank reconciliation import not found')
  return withTransaction(pool, async (client) => {
    const result = await client.query(
      `SELECT id, bank_account_id, reconciliation_status FROM bank_reconciliation_import_batches
       WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId, batchId]
    )
    if (result.rowCount !== 1) throw httpError(404, 'Bank reconciliation import not found')
    if (result.rows[0].reconciliation_status !== 'reconciled') throw httpError(409, 'Only a completed reconciliation can be reopened')
    await assertBankAccount(client, tenantId, result.rows[0].bank_account_id, true)
    await client.query(
      `UPDATE bank_reconciliation_import_batches SET reconciliation_status = 'open',
         reopened_by = $1, reopened_at = CURRENT_TIMESTAMP WHERE tenant_id = $2 AND id = $3`,
      [userId, tenantId, batchId]
    )
    await recordEvent(client, {
      tenantId, accountId: result.rows[0].bank_account_id, batchId, actorId: userId, type: 'reopened', details: { reason }
    })
    return { status: 'open', reason }
  })
}

async function postAdjustment(tenantId, userId, statementTransactionId, body, idempotencyKey) {
  requireActor(tenantId, userId)
  if (body.confirm !== true) throw validationError('Explicit confirmation is required before creating an accounting adjustment')
  if (!isUuid(body.offset_account_id) || !isUuid(body.accounting_period_id)) throw validationError('Select an offset account and accounting period')
  const description = text(body.description, 'Adjustment description', 500, { required: true })
  const key = idempotencyKey || `bank-reconciliation-adjustment:${statementTransactionId}:v1`
  return withTransaction(pool, async (client) => {
    const transaction = await lockStatementTransaction(client, tenantId, statementTransactionId)
    const activeMatch = await client.query(
      `SELECT m.id, m.journal_entry_id, m.journal_line_id, j.source_type
       FROM bank_reconciliation_matches m
       JOIN accounting_journal_entries j ON j.tenant_id = m.tenant_id AND j.id = m.journal_entry_id
       WHERE m.tenant_id = $1 AND m.statement_transaction_id = $2 AND m.status = 'matched' FOR UPDATE OF m`,
      [tenantId, statementTransactionId]
    )
    if (transaction.bank_account_id === body.offset_account_id) {
      throw validationError('Choose a different offset account from the selected bank account')
    }
    const amount = moneyUnits(transaction.credit > 0 ? String(transaction.credit) : String(transaction.debit), 'Statement amount')
    const bankLine = transaction.credit > 0
      ? { account_id: transaction.bank_account_id, description, debit: formatUnits(amount, SCALE), credit: '0.000000' }
      : { account_id: transaction.bank_account_id, description, debit: '0.000000', credit: formatUnits(amount, SCALE) }
    const offsetLine = transaction.credit > 0
      ? { account_id: body.offset_account_id, description, debit: '0.000000', credit: formatUnits(amount, SCALE) }
      : { account_id: body.offset_account_id, description, debit: formatUnits(amount, SCALE), credit: '0.000000' }
    const sourceReference = transaction.bank_reference || `statement-row-${transaction.row_number}`
    const journalBody = {
      accounting_period_id: body.accounting_period_id,
      entry_date: String(transaction.transaction_date).slice(0, 10),
      description,
      source_type: 'bank_reconciliation_adjustment', source_id: statementTransactionId,
      source_reference: sourceReference, event_type: 'adjustment',
      lines: [bankLine, offsetLine]
    }
    if (activeMatch.rowCount && activeMatch.rows[0].source_type !== 'bank_reconciliation_adjustment') {
      throw httpError(409, 'Only an unmatched bank transaction can receive an adjustment')
    }
    const posted = await postJournal(pool, {
      tenantId, userId, idempotencyKey: key,
      body: journalBody
    }, { client })
    if (activeMatch.rowCount) {
      if (!posted.replayed || posted.journal.id !== activeMatch.rows[0].journal_entry_id) {
        throw httpError(409, 'This bank transaction already has a different active adjustment')
      }
      return { journal: posted.journal, match: activeMatch.rows[0], replayed: true }
    }
    const bankJournalResult = await client.query(
      `SELECT id FROM accounting_journal_lines
       WHERE tenant_id = $1 AND journal_entry_id = $2 AND account_id = $3`,
      [tenantId, posted.journal.id, transaction.bank_account_id]
    )
    if (bankJournalResult.rowCount !== 1) throw httpError(409, 'Posted adjustment is missing its bank-account journal line')
    const bankJournalLine = bankJournalResult.rows[0]
    const inserted = await client.query(
      `INSERT INTO bank_reconciliation_matches
         (tenant_id, import_batch_id, statement_transaction_id, bank_account_id,
          journal_entry_id, journal_line_id, matched_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, matched_at, journal_entry_id, journal_line_id`,
      [tenantId, transaction.batch_id, statementTransactionId, transaction.bank_account_id,
        posted.journal.id, bankJournalLine.id, userId]
    )
    await recordEvent(client, {
      tenantId, accountId: transaction.bank_account_id, batchId: transaction.batch_id,
      transactionId: statementTransactionId, actorId: userId, type: 'adjustment_posted',
      details: { journal_entry_id: posted.journal.id, journal_line_id: bankJournalLine.id,
        offset_account_id: body.offset_account_id, accounting_period_id: body.accounting_period_id,
        description, amount: formatUnits(amount, SCALE) }
    })
    return { journal: posted.journal, match: inserted.rows[0], replayed: posted.replayed }
  }).catch((error) => {
    if (error.code === '23505') throw httpError(409, 'An accounting adjustment already exists for this bank transaction')
    throw error
  })
}

module.exports = {
  MAX_FILE_BYTES, MAX_ROWS, parseCsv, parseStatementCsv,
  listAccounts, listAccountCandidates, enableAccount, previewImport, importStatement,
  listImports, getBatch, getSuggestions, matchTransaction, unmatchTransaction,
  reconcileBatch, reopenBatch, postAdjustment, getSummaryForClient
}

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

const IDS = {
  tenantA: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  tenantB: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  user: '11111111-1111-4111-8111-111111111111',
  account: '22222222-2222-4222-8222-222222222222',
  batch: '33333333-3333-4333-8333-333333333333',
  transaction: '44444444-4444-4444-8444-444444444444',
  journal: '55555555-5555-4555-8555-555555555555',
  line: '66666666-6666-4666-8666-666666666666'
}

let state = {
  account: {
    account_id: IDS.account, bank_label: 'Operating bank', account_code: '1000', name: 'Bank',
    account_type: 'asset', normal_balance: 'debit', is_active: true, base_currency: 'KES'
  },
  batches: [],
  fingerprints: new Set(),
  transaction: {
    id: IDS.transaction, tenant_id: IDS.tenantA, import_batch_id: IDS.batch,
    bank_account_id: IDS.account, batch_account_id: IDS.account, batch_id: IDS.batch,
    currency: 'KES', reconciliation_status: 'open', row_number: 2,
    transaction_date: '2026-05-10', bank_reference: 'REF-1', description: 'Deposit',
    debit: '0.000000', credit: '10.000001'
  },
  line: {
    journal_entry_id: IDS.journal, journal_line_id: IDS.line, account_id: IDS.account,
    tenant_id: IDS.tenantA, status: 'posted', functional_currency: 'KES', entry_date: '2026-05-10',
    journal_description: 'Receipt', source_type: 'customer_receipt', source_id: null,
    source_reference: 'REF-1', event_type: 'verify', reversal_of_entry_id: null,
    debit: '10.000001', credit: '0.000000'
  },
  activeMatch: null,
  activeLines: new Set(),
  events: [],
  accountingPostings: [],
  nextMatchId: 1
}

const rows = (items = []) => ({ rows: items, rowCount: items.length })
const dbPath = require.resolve('../src/config/db')
const accountingPath = require.resolve('../src/services/accounting')
const originalDb = require.cache[dbPath]
const originalAccounting = require.cache[accountingPath]
const actualAccounting = require(accountingPath)
let failOnQuery = null
let importRaceWinner = null
const transactionStats = { begun: 0, committed: 0, rolledBack: 0 }

function transactionError(code, message) { return Object.assign(new Error(message), { code }) }

async function databaseQuery(sql, params = []) {
  const query = sql.replace(/\s+/g, ' ').trim().toLowerCase()
  if (failOnQuery && query.startsWith(failOnQuery.prefix)) {
    const failure = failOnQuery.error
    failOnQuery = null
    throw failure
  }
  if (query.startsWith('insert into accounting_posting_events')) {
    const existing = state.accountingPostings.find((event) => event.tenant_id === params[0] && event.idempotency_key === params[1])
    if (existing) return rows()
    const event = {
      id: `posting-event-${state.accountingPostings.length + 1}`, tenant_id: params[0],
      idempotency_key: params[1], payload_hash: params[2], source_type: params[3], source_id: params[4],
      source_reference: params[5], event_type: params[6], created_by: params[7], status: 'processing',
      journal_entry_id: null, journal: null, lines: []
    }
    state.accountingPostings.push(event)
    return rows([{ id: event.id }])
  }
  if (query.startsWith('select id, payload_hash, status, journal_entry_id from accounting_posting_events')) {
    const event = state.accountingPostings.find((item) => item.tenant_id === params[0] && item.idempotency_key === params[1])
    return event ? rows([event]) : rows()
  }
  if (query.startsWith('select base_currency from accounting_settings')) {
    return params[0] === IDS.tenantA ? rows([{ base_currency: 'KES' }]) : rows()
  }
  if (query.startsWith('select id, status, ($3::date between starts_on and ends_on) as entry_date_in_period from accounting_periods')) {
    return params[0] === IDS.tenantA ? rows([{
      id: params[1], status: 'open', entry_date_in_period: true
    }]) : rows()
  }
  if (query.startsWith('select id, account_type, normal_balance, is_active from accounting_accounts')) {
    const accountIds = params[1] || []
    return params[0] === IDS.tenantA ? rows(accountIds.map((id) => ({
      id, account_type: id === IDS.account ? 'asset' : 'expense', normal_balance: 'debit', is_active: true
    }))) : rows()
  }
  if (query.startsWith('insert into accounting_journal_entries')) {
    const event = state.accountingPostings.find((item) => item.id === params[9] && item.tenant_id === params[0])
    if (!event) throw new Error('Posting event must exist before the journal header')
    event.journal = {
      id: IDS.journal, tenant_id: params[0], accounting_period_id: params[1], entry_date: String(params[2]).slice(0, 10),
      description: params[3], status: 'draft', functional_currency: params[4], source_type: params[5],
      source_id: params[6], source_reference: params[7], event_type: params[8], posting_event_id: params[9],
      reversal_of_entry_id: params[10], reversal_reason: params[11], created_by: params[12]
    }
    return rows([{ id: event.journal.id }])
  }
  if (query.startsWith('insert into accounting_journal_lines')) {
    const event = state.accountingPostings.find((item) => item.journal?.id === params[1] && item.tenant_id === params[0])
    if (!event) throw new Error('Journal header must exist before its lines')
    event.lines.push({
      id: `${params[1]}-line-${params[2]}`, tenant_id: params[0], journal_entry_id: params[1],
      line_number: params[2], account_id: params[3], description: params[4], debit: params[5], credit: params[6],
      transaction_currency: params[7], transaction_amount: params[8], exchange_rate: params[9],
      exchange_rate_source: params[10], exchange_rate_at: params[11]
    })
    return rows()
  }
  if (query.startsWith("update accounting_journal_entries set status = 'posted'")) {
    const event = state.accountingPostings.find((item) => item.tenant_id === params[1] && item.journal?.id === params[2])
    if (!event || event.journal.status !== 'draft') return rows()
    event.journal.status = 'posted'
    event.journal.posted_by = params[0]
    event.journal.posted_at = '2026-05-11T00:00:00.000Z'
    return rows([event.journal])
  }
  if (query.startsWith("update accounting_posting_events set status = 'posted'")) {
    const event = state.accountingPostings.find((item) => item.tenant_id === params[1] && item.id === params[2])
    if (!event || event.status !== 'processing') return rows()
    event.status = 'posted'
    event.journal_entry_id = params[0]
    return rows([{ id: event.id }])
  }
  if (query.startsWith('select id, accounting_period_id, entry_date, description, status, functional_currency, source_type, source_id, source_reference, event_type, reversal_of_entry_id, reversal_reason, created_by, posted_by, created_at, posted_at from accounting_journal_entries')) {
    const event = state.accountingPostings.find((item) => item.tenant_id === params[0] && item.journal_entry_id === params[1])
    return event?.journal ? rows([event.journal]) : rows()
  }
  if (query.startsWith('select line_number, account_id, description, debit, credit, transaction_currency, transaction_amount, exchange_rate, exchange_rate_source, exchange_rate_at from accounting_journal_lines')) {
    const event = state.accountingPostings.find((item) => item.tenant_id === params[0] && item.journal_entry_id === params[1])
    return event ? rows(event.lines) : rows()
  }
  if (query.startsWith('select id from accounting_journal_lines where tenant_id = $1 and journal_entry_id')) {
    const event = state.accountingPostings.find((item) => item.tenant_id === params[0] && item.journal_entry_id === params[1])
    const lines = event?.lines.filter((line) => line.account_id === params[2]) || []
    return rows(lines.map((line) => ({ id: line.id })))
  }
  if (query.startsWith('select b.account_id, b.bank_label')) {
    if (importRaceWinner) {
      state.batches.push(importRaceWinner.batch)
      importRaceWinner.fingerprints.forEach((fingerprint) => {
        state.fingerprints.add(`${importRaceWinner.batch.tenant_id}:${importRaceWinner.batch.bank_account_id}:${fingerprint}`)
      })
      importRaceWinner = null
    }
    return params[0] === IDS.tenantA && params[1] === IDS.account ? rows([state.account]) : rows()
  }
  if (query.startsWith('select fingerprint from bank_reconciliation_statement_transactions')) {
    const found = (params[2] || []).filter((fingerprint) => state.fingerprints.has(`${params[0]}:${params[1]}:${fingerprint}`))
    return rows(found.map((fingerprint) => ({ fingerprint })))
  }
  if (query.startsWith('select id, file_sha256, bank_account_id, reconciliation_status, imported_at')) {
    const prior = state.batches.find((batch) => batch.tenant_id === params[0] && batch.idempotency_key === params[1])
    return prior ? rows([prior]) : rows()
  }
  if (query.startsWith('select id, bank_account_id, reconciliation_status from bank_reconciliation_import_batches')) {
    const batch = state.batches.find((item) => item.tenant_id === params[0] && item.id === params[1])
    return batch ? rows([batch]) : rows()
  }
  if (query.startsWith("update bank_reconciliation_import_batches set reconciliation_status = 'reconciled'")) {
    const batch = state.batches.find((item) => item.tenant_id === params[1] && item.id === params[2])
    if (!batch) return rows()
    batch.reconciliation_status = 'reconciled'
    batch.reconciled_by = params[0]
    state.transaction.reconciliation_status = 'reconciled'
    return rows([batch])
  }
  if (query.startsWith("update bank_reconciliation_import_batches set reconciliation_status = 'open'")) {
    const batch = state.batches.find((item) => item.tenant_id === params[1] && item.id === params[2])
    if (!batch) return rows()
    batch.reconciliation_status = 'open'
    batch.reopened_by = params[0]
    state.transaction.reconciliation_status = 'open'
    return rows([batch])
  }
  if (query.startsWith('insert into bank_reconciliation_import_batches')) {
    const [tenant_id, bank_account_id, file_name, file_sha256, idempotency_key, currency,
      statement_start_date, statement_end_date, statement_opening_balance, statement_closing_balance, row_count, imported_by] = params
    if (state.batches.some((batch) => batch.tenant_id === tenant_id && batch.bank_account_id === bank_account_id && batch.file_sha256 === file_sha256)) {
      throw transactionError('23505', 'duplicate file')
    }
    const batch = {
      id: IDS.batch, tenant_id, bank_account_id, file_name, file_sha256, idempotency_key,
      currency, statement_start_date, statement_end_date, statement_opening_balance,
      statement_closing_balance, row_count, reconciliation_status: 'open', imported_by,
      imported_at: '2026-05-11T00:00:00.000Z'
    }
    state.batches.push(batch)
    return rows([batch])
  }
  if (query.startsWith('insert into bank_reconciliation_statement_transactions')) {
    state.fingerprints.add(`${params[0]}:${params[2]}:${params[10]}`)
    return rows([{ id: IDS.transaction }])
  }
  if (query.startsWith('insert into bank_reconciliation_events')) {
    state.events.push({ tenant_id: params[0], bank_account_id: params[1], import_batch_id: params[2],
      statement_transaction_id: params[3], event_type: params[4], actor_id: params[5], details: JSON.parse(params[6]) })
    return rows([{ id: `event-${state.events.length}` }])
  }
  if (query.startsWith('select t.*, b.currency, b.bank_account_id as batch_account_id')) {
    return params[0] === IDS.tenantA && params[1] === state.transaction.id ? rows([state.transaction]) : rows()
  }
  if (query.startsWith('select id from bank_reconciliation_matches where tenant_id')) {
    return state.activeMatch && params[0] === IDS.tenantA && params[1] === state.transaction.id &&
      state.activeMatch.statement_transaction_id === params[1]
      ? rows([state.activeMatch]) : rows()
  }
  if (query.startsWith('select j.id as journal_entry_id, j.status')) {
    return params[0] === IDS.tenantA && params[1] === state.line.journal_line_id ? rows([state.line]) : rows()
  }
  if (query.startsWith('select m.id, m.journal_entry_id, m.journal_line_id, j.source_type')) {
    return state.activeMatch && params[0] === IDS.tenantA && params[1] === state.transaction.id
      ? rows([{ ...state.activeMatch, source_type: state.activeMatch.source_type || 'customer_receipt' }]) : rows()
  }
  if (query.startsWith('insert into bank_reconciliation_matches')) {
    const [tenant_id, import_batch_id, statement_transaction_id, bank_account_id, journal_entry_id, journal_line_id, matched_by] = params
    if (state.activeMatch || state.activeLines.has(journal_line_id)) throw transactionError('23505', 'duplicate active match')
    const posting = state.accountingPostings.find((item) => item.journal?.id === journal_entry_id)
    state.activeMatch = { id: `match-${state.nextMatchId++}`, status: 'matched', tenant_id,
      import_batch_id, statement_transaction_id, bank_account_id, journal_entry_id, journal_line_id, matched_by,
      source_type: posting?.journal.source_type || 'customer_receipt' }
    state.activeLines.add(journal_line_id)
    return rows([state.activeMatch])
  }
  if (query.startsWith("update bank_reconciliation_matches set status = 'unmatched'")) {
    if (!state.activeMatch || params[2] !== IDS.tenantA || params[3] !== state.transaction.id) return rows()
    const match = state.activeMatch
    state.activeMatch = null
    state.activeLines.delete(match.journal_line_id)
    return rows([{ id: match.id, journal_entry_id: match.journal_entry_id,
      journal_line_id: match.journal_line_id, unmatched_at: '2026-05-11T01:00:00.000Z' }])
  }
  if (query.startsWith('select * from bank_reconciliation_import_batches')) {
    const batch = state.batches.find((item) => item.tenant_id === params[0] && item.id === params[1])
    return batch ? rows([batch]) : rows()
  }
  if (query.startsWith('select count(*)::integer as transaction_count')) {
    return rows([{ transaction_count: 1, matched_count: state.activeMatch ? 1 : 0,
      unmatched_count: state.activeMatch ? 0 : 1, statement_debits: '0.000000', statement_credits: '10.000001' }])
  }
  if (query.startsWith('select coalesce(sum(l.debit - l.credit) filter')) {
    return rows([{ book_opening_balance: '-2.000001', book_closing_balance: '10.000001', outstanding_ledger_net: '0.000000' }])
  }
  throw new Error(`Unmocked query: ${query}`)
}

const fakePool = {
  query: databaseQuery,
  async connect() {
    // The fake database serializes transactions and snapshots committed state. This
    // exercises the production withTransaction wrapper and rollback boundaries, but
    // does not model PostgreSQL row locks or isolation semantics.
    const previous = transactionTail
    let unlock
    transactionTail = new Promise((resolve) => { unlock = resolve })
    await previous
    let before
    return {
      async query(sql, params) {
        const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
        if (normalized.startsWith('begin')) {
          before = cloneState(state)
          transactionStats.begun += 1
          return rows()
        }
        if (normalized === 'commit') {
          transactionStats.committed += 1
          return rows()
        }
        if (normalized === 'rollback') {
          if (before) state = before
          transactionStats.rolledBack += 1
          return rows()
        }
        return databaseQuery(sql, params)
      },
      release() { unlock() }
    }
  }
}
let transactionTail = Promise.resolve()
function cloneState(source) {
  return {
    ...source,
    account: { ...source.account },
    batches: source.batches.map((batch) => ({ ...batch })),
    fingerprints: new Set(source.fingerprints),
    transaction: { ...source.transaction },
    line: { ...source.line },
    activeMatch: source.activeMatch ? { ...source.activeMatch } : null,
    activeLines: new Set(source.activeLines),
    events: source.events.map((event) => ({ ...event, details: { ...event.details } })),
    accountingPostings: source.accountingPostings.map((posting) => ({
      ...posting, journal: posting.journal ? { ...posting.journal } : null,
      lines: posting.lines.map((line) => ({ ...line }))
    }))
  }
}

function installMock(modulePath, exports) {
  const mock = new Module(modulePath)
  mock.filename = modulePath
  mock.loaded = true
  mock.exports = exports
  require.cache[modulePath] = mock
}

installMock(dbPath, fakePool)
const service = require('../src/services/bankReconciliation')

test.beforeEach(() => {
  state.batches.length = 0
  state.fingerprints.clear()
  state.events.length = 0
  state.accountingPostings.length = 0
  failOnQuery = null
  importRaceWinner = null
  transactionStats.begun = 0
  transactionStats.committed = 0
  transactionStats.rolledBack = 0
  state.activeMatch = null
  state.activeLines.clear()
  state.nextMatchId = 1
  state.transaction.id = IDS.transaction
  state.transaction.debit = '0.000000'
  state.transaction.credit = '10.000001'
  state.transaction.reconciliation_status = 'open'
  state.line.status = 'posted'
  state.line.functional_currency = 'KES'
  state.line.debit = '10.000001'
  state.line.credit = '0.000000'
})
test.after(() => {
  if (originalDb) require.cache[dbPath] = originalDb
  else delete require.cache[dbPath]
  if (originalAccounting) require.cache[accountingPath] = originalAccounting
  else delete require.cache[accountingPath]
})

test('CSV parser accepts UTF-8 BOM, quoted commas, and exact six-place amounts', () => {
  const csv = '\uFEFFtransaction_date,bank_reference,description,debit,credit\r\n2026-05-10,REF-1,"Deposit, customer",0,10.000001\r\n'
  const parsed = service.parseStatementCsv(csv, IDS.account, { opening_balance: '0', closing_balance: '10.000001' })
  assert.equal(parsed.valid, true)
  assert.equal(parsed.transactions[0].description, 'Deposit, customer')
  assert.equal(parsed.transactions[0].credit, '10.000001')
  assert.equal(parsed.opening_balance, '0.000000')
  assert.equal(parsed.closing_balance, '10.000001')
})

test('CSV preview validates dates, direction, precision, opening-to-closing movement, and in-file duplicates', () => {
  const invalidDate = service.parseStatementCsv(
    'transaction_date,description,debit,credit\n2026-02-30,Deposit,0,1', IDS.account,
    { opening_balance: '0', closing_balance: '1' }
  )
  assert.equal(invalidDate.valid, false)
  assert.ok(invalidDate.errors.some((error) => error.field === 'transaction_date'))

  const badDirection = service.parseStatementCsv(
    'transaction_date,description,debit,credit\n2026-05-10,Invalid,1,1', IDS.account,
    { opening_balance: '0', closing_balance: '0' }
  )
  assert.ok(badDirection.errors.some((error) => error.field === 'amount'))

  const badPrecision = service.parseStatementCsv(
    'transaction_date,description,debit,credit\n2026-05-10,Invalid,0,0.0000001', IDS.account,
    { opening_balance: '0', closing_balance: '0' }
  )
  assert.ok(badPrecision.errors.some((error) => error.field === 'credit'))

  const badBalance = service.parseStatementCsv(
    'transaction_date,description,debit,credit\n2026-05-10,Deposit,0,1', IDS.account,
    { opening_balance: '0', closing_balance: '2' }
  )
  assert.ok(badBalance.errors.some((error) => error.field === 'closing_balance'))

  const duplicate = service.parseStatementCsv(
    'transaction_date,bank_reference,description,debit,credit\n2026-05-10,REF-X,Deposit,0,1\n2026-05-10,ref-x,Other,0,1',
    IDS.account, { opening_balance: '0', closing_balance: '2' }
  )
  assert.ok(duplicate.errors.some((error) => error.field === 'duplicate'))
})

test('CSV running balances are checked using exact arithmetic and negative balances are supported', () => {
  const valid = service.parseStatementCsv(
    'transaction_date,description,debit,credit,running_balance\n2026-05-10,Fee,0.000001,0,-0.000001\n2026-05-11,Deposit,0,0.000002,0.000001',
    IDS.account
  )
  assert.equal(valid.valid, true)
  assert.equal(valid.opening_balance, '0.000000')
  assert.equal(valid.closing_balance, '0.000001')

  const invalid = service.parseStatementCsv(
    'transaction_date,description,debit,credit,running_balance\n2026-05-10,Deposit,0,0.1,0.100001\n2026-05-11,Fee,0.000001,0,0.100001', IDS.account
  )
  assert.equal(invalid.valid, false)
  assert.ok(invalid.errors.some((error) => error.field === 'running_balance'))
})

test('CSV limits reject oversized files and more than 5000 statement rows', () => {
  assert.throws(() => service.parseCsv(`transaction_date,description,debit,credit\n${'x'.repeat(1024 * 1024)}`), /1 MiB/)
  const manyRows = `transaction_date,description,debit,credit\n${'2026-01-01,x,0,1\n'.repeat(5001)}`
  assert.throws(() => service.parseCsv(manyRows), /5000 data rows/)
})

test('preview catches a previously imported transaction and always scopes account lookup by JWT tenant', async () => {
  const csv = 'transaction_date,bank_reference,description,debit,credit\n2026-05-10,UNIQUE-1,Deposit,0,1'
  const first = await service.previewImport(IDS.tenantA, {
    account_id: IDS.account, file_name: 'may.csv', csv_text: csv, opening_balance: '0', closing_balance: '1'
  })
  assert.equal(first.valid, true)
  const fingerprint = service.parseStatementCsv(csv, IDS.account, { opening_balance: '0', closing_balance: '1' }).transactions[0].fingerprint
  state.fingerprints.add(`${IDS.tenantA}:${IDS.account}:${fingerprint}`)
  const duplicate = await service.previewImport(IDS.tenantA, {
    account_id: IDS.account, file_name: 'may-copy.csv', csv_text: csv, opening_balance: '0', closing_balance: '1'
  })
  assert.equal(duplicate.valid, false)
  assert.ok(duplicate.errors.some((error) => error.field === 'duplicate' && /already imported/.test(error.message)))
  await assert.rejects(
    service.previewImport(IDS.tenantB, { account_id: IDS.account, file_name: 'foreign.csv', csv_text: csv, opening_balance: '0', closing_balance: '1' }),
    (error) => error.statusCode === 404
  )
})

test('import batch stores immutable statement records and replays the same idempotency key', async () => {
  const csv = 'transaction_date,bank_reference,description,debit,credit\n2026-05-10,IMPORT-1,Deposit,0,10.000001'
  const body = { account_id: IDS.account, file_name: 'one.csv', csv_text: csv, opening_balance: '0', closing_balance: '10.000001' }
  const preview = await service.previewImport(IDS.tenantA, body)
  await assert.rejects(
    service.importStatement(IDS.tenantA, IDS.user, { ...body, preview_token: preview.preview_token }, 'bank-import-key-0001'),
    (error) => error.statusCode === 400 && /confirmation/.test(error.message)
  )
  const first = await service.importStatement(IDS.tenantA, IDS.user, { ...body, preview_token: preview.preview_token, confirm: true }, 'bank-import-key-0001')
  const replay = await service.importStatement(IDS.tenantA, IDS.user, { ...body, preview_token: preview.preview_token, confirm: true }, 'bank-import-key-0001')
  assert.equal(first.replayed, false)
  assert.equal(replay.replayed, true)
  assert.equal(state.batches.length, 1)
  assert.equal(state.fingerprints.size, 1)
  assert.equal(state.events.filter((event) => event.event_type === 'imported').length, 1)
  await assert.rejects(
    service.importStatement(IDS.tenantA, IDS.user, {
      ...body, csv_text: csv.replace('10.000001', '9.000001'), preview_token: preview.preview_token, confirm: true
    }, 'bank-import-key-0001'),
    (error) => error.statusCode === 409 && /different bank statement/.test(error.message)
  )
  await assert.rejects(
    service.importStatement(IDS.tenantA, IDS.user, { ...body, preview_token: preview.preview_token, confirm: true }, 'bank-import-key-0002'),
    (error) => error.statusCode === 400 && /already imported/.test(error.message)
  )
  await assert.rejects(
    service.importStatement(IDS.tenantB, IDS.user, { ...body, preview_token: preview.preview_token, confirm: true }, 'bank-import-key-0003'),
    (error) => error.statusCode === 404
  )
  assert.equal(state.batches.length, 1)
})

test('same-key import retry rechecks idempotency after waiting for the bank-account lock', async () => {
  const csv = 'transaction_date,bank_reference,description,debit,credit\n2026-05-10,LOCK-RACE-1,Deposit,0,7'
  const body = { account_id: IDS.account, file_name: 'lock-race.csv', csv_text: csv, opening_balance: '0', closing_balance: '7' }
  const preview = await service.previewImport(IDS.tenantA, body)
  const parsed = service.parseStatementCsv(csv, IDS.account, body)
  const winner = {
    id: '77777777-7777-4777-8777-777777777777', tenant_id: IDS.tenantA,
    idempotency_key: 'bank-import-lock-race-1', file_sha256: preview.file_sha256,
    bank_account_id: IDS.account, reconciliation_status: 'open', imported_at: '2026-05-11T00:00:00.000Z'
  }
  // Simulate a concurrently committed winner becoming visible after this
  // request's first idempotency lookup and while it acquires the account lock.
  // The fixture is serialized and does not emulate PostgreSQL lock behavior.
  importRaceWinner = { batch: winner, fingerprints: parsed.transactions.map((transaction) => transaction.fingerprint) }

  const replay = await service.importStatement(IDS.tenantA, IDS.user, {
    ...body, preview_token: preview.preview_token, confirm: true
  }, winner.idempotency_key)

  assert.equal(replay.id, winner.id)
  assert.equal(replay.replayed, true)
  assert.equal(state.batches.length, 1)
  assert.equal(state.batches[0].id, winner.id)
  assert.equal(state.fingerprints.size, 1)
  assert.equal(state.events.length, 0)
})

test('failed statement import rolls back its batch, transaction rows, and audit event', async () => {
  const csv = 'transaction_date,bank_reference,description,debit,credit\n2026-05-10,ROLLBACK-1,Deposit,0,1'
  const body = { account_id: IDS.account, file_name: 'rollback.csv', csv_text: csv, opening_balance: '0', closing_balance: '1' }
  const preview = await service.previewImport(IDS.tenantA, body)
  failOnQuery = { prefix: 'insert into bank_reconciliation_events', error: new Error('simulated audit insert failure') }
  await assert.rejects(service.importStatement(IDS.tenantA, IDS.user, {
    ...body, preview_token: preview.preview_token, confirm: true
  }, 'bank-import-rollback-1'), /simulated audit insert failure/)
  assert.equal(state.batches.length, 0)
  assert.equal(state.fingerprints.size, 0)
  assert.equal(state.events.length, 0)
  assert.equal(transactionStats.rolledBack, 1)
})

test('matching requires explicit confirmation, opposite direction, exact amount, and same currency', async () => {
  await assert.rejects(
    service.matchTransaction(IDS.tenantB, IDS.user, IDS.transaction, { journal_line_id: IDS.line, confirm: true }),
    (error) => error.statusCode === 404
  )
  await assert.rejects(
    service.matchTransaction(IDS.tenantA, IDS.user, IDS.transaction, { journal_line_id: IDS.line, confirm: false }),
    (error) => error.statusCode === 400 && /confirmation/.test(error.message)
  )

  const originalDebit = state.line.debit
  state.line.debit = '10.000000'
  await assert.rejects(
    service.matchTransaction(IDS.tenantA, IDS.user, IDS.transaction, { journal_line_id: IDS.line, confirm: true }),
    (error) => error.statusCode === 409 && /amounts or transaction directions/.test(error.message)
  )
  state.line.debit = originalDebit

  state.line.functional_currency = 'USD'
  await assert.rejects(
    service.matchTransaction(IDS.tenantA, IDS.user, IDS.transaction, { journal_line_id: IDS.line, confirm: true }),
    (error) => error.statusCode === 409 && /statement currency/.test(error.message)
  )
  state.line.functional_currency = 'KES'

  const matched = await service.matchTransaction(IDS.tenantA, IDS.user, IDS.transaction, { journal_line_id: IDS.line, confirm: true })
  assert.equal(matched.match.status, 'matched')
  assert.equal(state.events.at(-1).event_type, 'matched')
})

test('concurrent duplicate matches serialize to one active match and one audited conflict', async () => {
  const txId = state.transaction.id
  const matchId = state.line.journal_line_id
  const attempts = await Promise.allSettled([
    service.matchTransaction(IDS.tenantA, IDS.user, txId, { journal_line_id: matchId, confirm: true }),
    service.matchTransaction(IDS.tenantA, IDS.user, txId, { journal_line_id: matchId, confirm: true })
  ])
  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1)
  assert.equal(attempts.filter((attempt) => attempt.status === 'rejected' && attempt.reason.statusCode === 409).length, 1)
  assert.equal(state.events.filter((event) => event.event_type === 'matched').length, 1)
})

test('a failed match audit insert rolls back the match and active-line reservation', async () => {
  failOnQuery = { prefix: 'insert into bank_reconciliation_events', error: new Error('simulated match audit failure') }
  await assert.rejects(
    service.matchTransaction(IDS.tenantA, IDS.user, IDS.transaction, { journal_line_id: IDS.line, confirm: true }),
    /simulated match audit failure/
  )
  assert.equal(state.activeMatch, null)
  assert.equal(state.activeLines.size, 0)
  assert.equal(state.events.length, 0)
  assert.equal(transactionStats.rolledBack, 1)
})

test('a journal line cannot be reused for a second statement transaction', async () => {
  await service.matchTransaction(IDS.tenantA, IDS.user, IDS.transaction, { journal_line_id: IDS.line, confirm: true })
  state.transaction.id = '77777777-7777-4777-8777-777777777777'
  await assert.rejects(
    service.matchTransaction(IDS.tenantA, IDS.user, state.transaction.id, { journal_line_id: IDS.line, confirm: true }),
    (error) => error.statusCode === 409 && /already been matched/.test(error.message)
  )
})

test('releasing a match requires a reason and adds an append-only audit event', async () => {
  await assert.rejects(service.unmatchTransaction(IDS.tenantA, IDS.user, IDS.transaction, { reason: '' }), (error) => error.statusCode === 400)
  await service.matchTransaction(IDS.tenantA, IDS.user, IDS.transaction, { journal_line_id: IDS.line, confirm: true })
  const result = await service.unmatchTransaction(IDS.tenantA, IDS.user, IDS.transaction, { reason: 'Wrong reference selected' })
  assert.equal(result.id, 'match-1')
  assert.equal(state.events.at(-1).event_type, 'unmatched')
  assert.equal(state.events.at(-1).details.reason, 'Wrong reference selected')
})

test('adjustment requires administrator confirmation and posts balanced journal through the caller transaction', async () => {
  state.transaction.debit = '4.500001'
  state.transaction.credit = '0.000000'
  const body = {
    offset_account_id: '77777777-7777-4777-8777-777777777777',
    accounting_period_id: '88888888-8888-4888-8888-888888888888',
    description: 'Monthly bank fee', confirm: true
  }
  await assert.rejects(
    service.postAdjustment(IDS.tenantA, IDS.user, IDS.transaction, { ...body, confirm: false }),
    (error) => error.statusCode === 400 && /confirmation/.test(error.message)
  )
  assert.equal(state.accountingPostings.length, 0)
  const result = await service.postAdjustment(IDS.tenantA, IDS.user, IDS.transaction, body)
  assert.equal(result.journal.id, IDS.journal)
  assert.equal(state.accountingPostings.length, 1)
  assert.equal(state.accountingPostings[0].idempotency_key, `bank-reconciliation-adjustment:${IDS.transaction}:v1`)
  assert.deepEqual(state.accountingPostings[0].lines.map((line) => [line.debit, line.credit]), [
    ['0.000000', '4.500001'], ['4.500001', '0.000000']
  ])
  const debitUnits = state.accountingPostings[0].lines.reduce((sum, line) => sum + BigInt(line.debit.replace('.', '')), 0n)
  const creditUnits = state.accountingPostings[0].lines.reduce((sum, line) => sum + BigInt(line.credit.replace('.', '')), 0n)
  assert.equal(debitUnits, creditUnits)
  assert.equal(state.accountingPostings[0].status, 'posted')
  assert.equal(state.accountingPostings[0].journal.status, 'posted')
  assert.equal(transactionStats.begun, 1)
  assert.equal(transactionStats.committed, 1)
  assert.equal(state.activeMatch.status, 'matched')
  assert.equal(state.events.at(-1).event_type, 'adjustment_posted')
  const replay = await service.postAdjustment(IDS.tenantA, IDS.user, IDS.transaction, body)
  assert.equal(replay.replayed, true)
  assert.equal(state.accountingPostings.length, 1)
  assert.equal(state.events.filter((event) => event.event_type === 'adjustment_posted').length, 1)
})

test('adjustment audit failure rolls back the posting, match, and reconciliation event together', async () => {
  state.transaction.debit = '4.500001'
  state.transaction.credit = '0.000000'
  failOnQuery = { prefix: 'insert into bank_reconciliation_events', error: new Error('simulated adjustment audit failure') }
  await assert.rejects(service.postAdjustment(IDS.tenantA, IDS.user, IDS.transaction, {
    offset_account_id: '77777777-7777-4777-8777-777777777777',
    accounting_period_id: '88888888-8888-4888-8888-888888888888',
    description: 'Monthly bank fee', confirm: true
  }), /simulated adjustment audit failure/)
  assert.equal(state.accountingPostings.length, 0)
  assert.equal(state.activeMatch, null)
  assert.equal(state.events.length, 0)
  assert.equal(transactionStats.rolledBack, 1)
})

test('accounting posting failure rolls back its staged posting event and leaves no reconciliation match', async () => {
  state.transaction.debit = '4.500001'
  state.transaction.credit = '0.000000'
  failOnQuery = { prefix: 'insert into accounting_journal_lines', error: new Error('simulated journal line insert failure') }
  await assert.rejects(service.postAdjustment(IDS.tenantA, IDS.user, IDS.transaction, {
    offset_account_id: '77777777-7777-4777-8777-777777777777',
    accounting_period_id: '88888888-8888-4888-8888-888888888888',
    description: 'Monthly bank fee', confirm: true
  }), /simulated journal line insert failure/)
  assert.equal(state.accountingPostings.length, 0)
  assert.equal(state.activeMatch, null)
  assert.equal(state.events.length, 0)
  assert.equal(transactionStats.rolledBack, 1)
})

test('reconciliation completion and reopening require controlled audit actions', async () => {
  state.batches.push({
    id: IDS.batch, tenant_id: IDS.tenantA, bank_account_id: IDS.account, currency: 'KES',
    statement_start_date: '2026-05-01', statement_end_date: '2026-05-31',
    statement_opening_balance: '9.000000', statement_closing_balance: '10.000001',
    reconciliation_status: 'open'
  })
  await service.matchTransaction(IDS.tenantA, IDS.user, IDS.transaction, { journal_line_id: IDS.line, confirm: true })
  await assert.rejects(
    service.reconcileBatch(IDS.tenantA, IDS.user, IDS.batch, { confirm: false }),
    (error) => error.statusCode === 400
  )
  const completed = await service.reconcileBatch(IDS.tenantA, IDS.user, IDS.batch, { confirm: true })
  assert.equal(completed.status, 'reconciled')
  assert.equal(state.transaction.reconciliation_status, 'reconciled')
  assert.equal(state.events.at(-1).event_type, 'reconciled')
  await assert.rejects(
    service.matchTransaction(IDS.tenantA, IDS.user, IDS.transaction, { journal_line_id: IDS.line, confirm: true }),
    (error) => error.statusCode === 409 && /Reopen/.test(error.message)
  )
  await assert.rejects(service.reopenBatch(IDS.tenantA, IDS.user, IDS.batch, { reason: '' }), (error) => error.statusCode === 400)
  const reopened = await service.reopenBatch(IDS.tenantA, IDS.user, IDS.batch, { reason: 'Correcting a selected entry' })
  assert.equal(reopened.status, 'open')
  assert.equal(state.transaction.reconciliation_status, 'open')
  assert.equal(state.events.at(-1).event_type, 'reopened')
  assert.equal(state.events.at(-1).details.reason, 'Correcting a selected entry')
  assert.deepEqual(state.events.map((event) => event.event_type), ['matched', 'reconciled', 'reopened'])
})

test('an incomplete reconciliation cannot close and close/reopen audit failures roll back status changes', async () => {
  state.batches.push({
    id: IDS.batch, tenant_id: IDS.tenantA, bank_account_id: IDS.account, currency: 'KES',
    statement_start_date: '2026-05-01', statement_end_date: '2026-05-31',
    statement_opening_balance: '9.000000', statement_closing_balance: '10.000001',
    reconciliation_status: 'open'
  })
  await assert.rejects(service.reconcileBatch(IDS.tenantA, IDS.user, IDS.batch, { confirm: true }),
    (error) => error.statusCode === 409 && /unmatched/.test(error.message))
  assert.equal(state.batches[0].reconciliation_status, 'open')

  await service.matchTransaction(IDS.tenantA, IDS.user, IDS.transaction, { journal_line_id: IDS.line, confirm: true })
  failOnQuery = { prefix: 'insert into bank_reconciliation_events', error: new Error('simulated close audit failure') }
  await assert.rejects(service.reconcileBatch(IDS.tenantA, IDS.user, IDS.batch, { confirm: true }), /simulated close audit failure/)
  assert.equal(state.batches[0].reconciliation_status, 'open')

  await service.reconcileBatch(IDS.tenantA, IDS.user, IDS.batch, { confirm: true })
  const history = state.events.map((event) => event.event_type)
  failOnQuery = { prefix: 'insert into bank_reconciliation_events', error: new Error('simulated reopen audit failure') }
  await assert.rejects(service.reopenBatch(IDS.tenantA, IDS.user, IDS.batch, { reason: 'Correction' }), /simulated reopen audit failure/)
  assert.equal(state.batches[0].reconciliation_status, 'reconciled')
  assert.deepEqual(state.events.map((event) => event.event_type), history)
})

test('reconciliation difference uses exact six-place arithmetic and includes unmatched ledger movements', async () => {
  const batch = {
    tenant_id: IDS.tenantA, id: IDS.batch, bank_account_id: IDS.account, currency: 'KES',
    statement_start_date: '2026-05-01', statement_end_date: '2026-05-31',
    statement_opening_balance: '9.000000', statement_closing_balance: '10.000001'
  }
  let bookClosing = '10.000002'
  let outstanding = '0.000001'
  const client = { query: async (sql, params) => {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
    if (normalized.startsWith('select * from bank_reconciliation_import_batches')) return rows([batch])
    if (normalized.startsWith('select count(*)::integer as transaction_count')) return rows([{ transaction_count: 1, matched_count: 1, unmatched_count: 0, statement_debits: '0.000000', statement_credits: '1.000001' }])
    if (normalized.startsWith('select coalesce(sum(l.debit - l.credit) filter')) return rows([{ book_opening_balance: '9.000000', book_closing_balance: bookClosing, outstanding_ledger_net: outstanding }])
    throw new Error(`Unexpected summary SQL with tenant ${params?.[0]}`)
  } }
  const summary = await service.getSummaryForClient(client, IDS.tenantA, IDS.batch)
  assert.equal(summary.opening_difference, '0.000000')
  assert.equal(summary.difference, '0.000000')
  assert.equal(summary.can_reconcile, true)
  assert.equal(summary.statement_movement, '1.000001')
  bookClosing = '10.000003'
  const mismatch = await service.getSummaryForClient(client, IDS.tenantA, IDS.batch)
  assert.equal(mismatch.difference, '-0.000001')
  assert.equal(mismatch.can_reconcile, false)
})

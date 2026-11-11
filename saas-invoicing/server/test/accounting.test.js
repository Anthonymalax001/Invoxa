const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const Module = require('node:module')
const express = require('express')
const jwt = require('jsonwebtoken')

const JWT_TEST_SECRET = 'invoxa-accounting-tests-only'
process.env.JWT_SECRET = JWT_TEST_SECRET

const IDS = {
  tenantA: '10000000-0000-4000-8000-000000000001',
  tenantB: '10000000-0000-4000-8000-000000000002',
  userA: '20000000-0000-4000-8000-000000000001',
  userB: '20000000-0000-4000-8000-000000000002',
  userReader: '20000000-0000-4000-8000-000000000003',
  periodA: '30000000-0000-4000-8000-000000000001',
  periodB: '30000000-0000-4000-8000-000000000002',
  accountA: '40000000-0000-4000-8000-000000000001',
  accountB: '40000000-0000-4000-8000-000000000002',
  accountForeign: '40000000-0000-4000-8000-000000000003',
  accountRevenue: '40000000-0000-4000-8000-000000000004',
  accountForeignRevenue: '40000000-0000-4000-8000-000000000005',
  taxProfileA: '60000000-0000-4000-8000-000000000001',
  taxProfileB: '60000000-0000-4000-8000-000000000002'
}

let state
let nextId
let lockTail
let clientLifecycle
let postingReadGate
const makeId = () => `50000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`
const normalizeSql = (sql) => sql.replace(/\s+/g, ' ').trim()
const result = (rows = []) => ({ rows, rowCount: rows.length })
const pgError = (code, message) => Object.assign(new Error(message), { code })

function makeState() {
  const account = (id, tenant_id, account_code, is_active = true) => ({
    id, tenant_id, account_code, name: `Account ${account_code}`,
    account_type: 'asset', normal_balance: 'debit', is_active,
    is_system: false, system_key: null, created_by: IDS.userA
  })
  return {
    tenants: new Set([IDS.tenantA, IDS.tenantB]),
    // `test-reader` is a synthetic role row for middleware tests; it is not a claimed production role.
    users: new Map([
      [IDS.userA, { id: IDS.userA, tenant_id: IDS.tenantA, role: 'admin' }],
      [IDS.userB, { id: IDS.userB, tenant_id: IDS.tenantB, role: 'admin' }],
      [IDS.userReader, { id: IDS.userReader, tenant_id: IDS.tenantA, role: 'test-reader' }]
    ]),
    settings: new Map([
      [IDS.tenantA, { tenant_id: IDS.tenantA, base_currency: 'KES', created_by: IDS.userA }],
      [IDS.tenantB, { tenant_id: IDS.tenantB, base_currency: 'KES', created_by: IDS.userB }]
    ]),
    periods: new Map([
      [IDS.periodA, { id: IDS.periodA, tenant_id: IDS.tenantA, name: '2026', starts_on: '2026-01-01', ends_on: '2026-12-31', status: 'open', created_by: IDS.userA }],
      [IDS.periodB, { id: IDS.periodB, tenant_id: IDS.tenantB, name: '2026', starts_on: '2026-01-01', ends_on: '2026-12-31', status: 'open', created_by: IDS.userB }]
    ]),
    accounts: new Map([
      [IDS.accountA, account(IDS.accountA, IDS.tenantA, '1000')],
      [IDS.accountB, account(IDS.accountB, IDS.tenantA, '2000')],
      [IDS.accountForeign, account(IDS.accountForeign, IDS.tenantB, '9000')],
      [IDS.accountRevenue, { ...account(IDS.accountRevenue, IDS.tenantA, '4000'), account_type: 'revenue', normal_balance: 'credit' }],
      [IDS.accountForeignRevenue, { ...account(IDS.accountForeignRevenue, IDS.tenantB, '4900'), account_type: 'revenue', normal_balance: 'credit' }]
    ]),
    events: new Map(),
    periodEvents: [],
    journals: new Map(),
    lines: [],
    businessChanges: [],
    invoiceMappings: new Map([
      [IDS.tenantA, {
        tenant_id: IDS.tenantA, receivables_account_id: IDS.accountA,
        sales_revenue_account_id: IDS.accountRevenue, updated_by: IDS.userA,
        created_at: '2026-10-21T00:00:00.000Z', updated_at: '2026-10-21T00:00:00.000Z'
      }],
      [IDS.tenantB, {
        tenant_id: IDS.tenantB, receivables_account_id: IDS.accountForeign,
        sales_revenue_account_id: IDS.accountForeignRevenue, updated_by: IDS.userB,
        created_at: '2026-10-21T00:00:00.000Z', updated_at: '2026-10-21T00:00:00.000Z'
      }]
    ]),
    taxProfiles: new Map([
      [IDS.taxProfileA, {
        id: IDS.taxProfileA, tenant_id: IDS.tenantA, profile_key: 'standard', name: 'Tenant A standard',
        version: 1, tax_rate: '16.000', calculation_method: 'exclusive', rounding_method: 'invoice_total',
        effective_from: '2026-01-01', effective_to: null, requires_tax_payable: true,
        tax_payable_account_id: null, is_active: true, created_by: IDS.userA,
        created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z'
      }],
      [IDS.taxProfileB, {
        id: IDS.taxProfileB, tenant_id: IDS.tenantB, profile_key: 'private', name: 'Tenant B private tax',
        version: 1, tax_rate: '5.000', calculation_method: 'exclusive', rounding_method: 'invoice_total',
        effective_from: '2026-01-01', effective_to: null, requires_tax_payable: true,
        tax_payable_account_id: IDS.accountForeign, is_active: true, created_by: IDS.userB,
        created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z'
      }]
    ]),
    commits: 0,
    rollbacks: 0,
    failSettingsRead: false,
    failIdentityLookup: false,
    failLineInsertAt: null,
    lineInsertCount: 0
  }
}

function ensureBalanced(db) {
  for (const journal of db.journals.values()) {
    if (journal.status !== 'posted') continue
    const lines = db.lines.filter((line) => line.tenant_id === journal.tenant_id && line.journal_entry_id === journal.id)
    const debit = lines.reduce((sum, line) => sum + BigInt(line.debit.replace('.', '')), 0n)
    const credit = lines.reduce((sum, line) => sum + BigInt(line.credit.replace('.', '')), 0n)
    if (lines.length < 2 || debit !== credit) throw pgError('23514', 'unbalanced fake journal')
    const event = db.events.get(journal.posting_event_id)
    if (!event || event.status !== 'posted' || event.journal_entry_id !== journal.id) {
      throw pgError('23514', 'missing fake posting event')
    }
  }
}

async function dbQuery(db, sql, params = []) {
  const q = normalizeSql(sql)
  if (q.startsWith('SELECT table_name, column_name FROM information_schema.columns')) {
    const rows = []
    for (const table of params[0]) {
      for (const column of SCHEMA_REQUIREMENTS[table] || []) rows.push({ table_name: table, column_name: column })
    }
    return result(rows)
  }
  if (q.startsWith('SELECT role FROM users WHERE id = $1 AND tenant_id = $2')) {
    if (db.failIdentityLookup) throw pgError('XX999', 'INTERNAL_SQL_SENTINEL')
    const user = db.users.get(params[0])
    return result(user?.tenant_id === params[1] ? [{ role: user.role }] : [])
  }
  if (q.startsWith('INSERT INTO test_business_changes')) {
    db.businessChanges.push(params[0])
    return result([{ value: params[0] }])
  }
  if (q.startsWith('SELECT tenant_id, base_currency, expense_payable_account_id, input_vat_account_id, created_by, created_at, updated_at FROM accounting_settings') ||
      q.startsWith('SELECT tenant_id, base_currency, created_by, created_at, updated_at FROM accounting_settings')) {
    if (db.failSettingsRead) throw pgError('XX999', 'INTERNAL_SQL_SENTINEL')
    const setting = db.settings.get(params[0])
    return result(setting ? [{ ...setting }] : [])
  }
  if (q.startsWith('SELECT m.tenant_id, m.receivables_account_id')) {
    const mapping = db.invoiceMappings.get(params[0])
    if (!mapping) return result([])
    const receivables = db.accounts.get(mapping.receivables_account_id)
    const revenue = db.accounts.get(mapping.sales_revenue_account_id)
    if (receivables?.tenant_id !== mapping.tenant_id || revenue?.tenant_id !== mapping.tenant_id) return result([])
    return result([{
      ...mapping,
      receivables_account_code: receivables.account_code,
      receivables_account_name: receivables.name,
      sales_revenue_account_code: revenue.account_code,
      sales_revenue_account_name: revenue.name
    }])
  }
  if (q.startsWith('SELECT id, tenant_id, profile_key, name, version, tax_rate, calculation_method')) {
    const profiles = [...db.taxProfiles.values()].filter((profile) => profile.tenant_id === params[0] &&
      (params[1] == null || profile.is_active === params[1]))
    return result(profiles.map((profile) => ({ ...profile })))
  }
  if (q.startsWith('SELECT tenant_id FROM accounting_settings WHERE tenant_id = $1 FOR UPDATE')) {
    const setting = db.settings.get(params[0])
    return result(setting ? [{ tenant_id: setting.tenant_id }] : [])
  }
  if (q.startsWith('UPDATE accounting_settings SET base_currency =')) {
    const setting = db.settings.get(params[3] || params[1])
    if (!setting) return result([])
    setting.base_currency = params[0]
    setting.expense_payable_account_id = params[1]
    setting.input_vat_account_id = params[2]
    return result([{ ...setting }])
  }
  if (q.startsWith('SELECT id, tenant_id, name, starts_on, ends_on, status, created_by, closed_by, created_at, closed_at FROM accounting_periods WHERE tenant_id = $1 ORDER BY')) {
    return result([...db.periods.values()].filter((period) => period.tenant_id === params[0]).map((period) => ({ ...period })))
  }
  if (q.startsWith('SELECT id, tenant_id, name, starts_on, ends_on, status, created_by, closed_by, created_at, closed_at FROM accounting_periods WHERE tenant_id = $1 AND id = $2')) {
    const period = db.periods.get(params[1])
    return result(period?.tenant_id === params[0] ? [{ ...period }] : [])
  }
  if (q.startsWith('SELECT id, event_type, outcome, actor_id, reason, details, idempotency_key, created_at FROM accounting_period_events')) {
    const rows = db.periodEvents.filter((event) => event.tenant_id === params[0] && event.accounting_period_id === params[1])
    return result(rows)
  }
  if (q.startsWith('SELECT id, accounting_period_id, outcome, reason, details, payload_hash FROM accounting_period_events')) {
    const event = db.periodEvents.find((item) => item.tenant_id === params[0] && item.idempotency_key === params[1])
    return result(event ? [{ ...event }] : [])
  }
  if (q.startsWith('SELECT j.id, j.entry_date, j.description, j.created_by, count(*) OVER()')) return result([])
  if (q.startsWith("SELECT id, effective_date, status, count(*) OVER()::integer AS total_count FROM accounting_opening_balance_batches")) return result([])
  if (q.startsWith('SELECT id, payment_date, amount::text AS amount, currency, receipt_reference, status,')) return result([])
  if (q.startsWith('SELECT id, payment_date, amount::text AS amount, currency, receipt_reference, failed_at,')) return result([])
  if (q.startsWith('SELECT id, payment_number, payment_date, amount::text AS amount, currency, payment_reference, status,')) return result([])
  if (q.startsWith('SELECT id, payment_number, payment_date, amount::text AS amount, currency, payment_reference, failed_at,')) return result([])
  if (q.startsWith('SELECT id, bill_number, bill_date, due_date, total::text AS total, currency, status,')) return result([])
  if (q.startsWith('SELECT id, expense_number, expense_date, amount::text AS amount, currency, status,')) return result([])
  if (q.startsWith('SELECT j.id, j.entry_date, j.description, count(l.id)::integer AS line_count,')) return result([])
  if (q.startsWith('SELECT i.id, i.bank_account_id, b.bank_label, i.file_name,')) return result([])
  if (q.startsWith('SELECT request.id, request.invoice_id, request.amount::text AS amount,')) return result([])
  if (q.startsWith('SELECT id, product_id, movement_type, quantity_delta::text AS quantity_delta,')) return result([])
  if (q.startsWith('SELECT id FROM accounting_periods WHERE tenant_id = $1 AND daterange(')) {
    const overlap = [...db.periods.values()].some((period) => period.tenant_id === params[0] &&
      params[1] <= period.ends_on && params[2] >= period.starts_on)
    return result(overlap ? [{ id: 'overlap' }] : [])
  }
  if (q.startsWith('INSERT INTO accounting_periods')) {
    const period = {
      id: makeId(), tenant_id: params[0], name: params[1], starts_on: params[2], ends_on: params[3],
      status: 'open', created_by: params[4], closed_by: null, closed_at: null
    }
    db.periods.set(period.id, period)
    return result([{ ...period }])
  }
  if (q.startsWith("UPDATE accounting_periods SET status = 'closed'")) {
    const period = db.periods.get(params[2])
    if (!period || period.tenant_id !== params[1] || period.status !== 'open') return result([])
    Object.assign(period, { status: 'closed', closed_by: params[0], closed_at: '2026-10-21T00:00:00.000Z' })
    return result([{ ...period }])
  }
  if (q.startsWith('INSERT INTO accounting_period_events')) {
    const event = {
      id: makeId(), tenant_id: params[0], accounting_period_id: params[1], event_type: 'close',
      outcome: params[2], actor_id: params[3], reason: params[4], idempotency_key: params[5],
      payload_hash: params[6], details: JSON.parse(params[7]), created_at: '2026-10-21T00:00:00.000Z'
    }
    db.periodEvents.push(event)
    return result([event])
  }
  if (q.startsWith('SELECT * FROM accounting_journal_entries WHERE id = $1 AND tenant_id = $2 AND status =')) {
    const journal = db.journals.get(params[0])
    return result(journal?.tenant_id === params[1] && journal.status === 'posted' ? [{ ...journal }] : [])
  }
  if (q.startsWith('SELECT l.line_number, l.account_id, a.account_code, a.name AS account_name')) {
    const lines = db.lines.filter((line) => line.tenant_id === params[0] && line.journal_entry_id === params[1])
      .sort((a, b) => a.line_number - b.line_number)
      .map((line) => {
        const account = db.accounts.get(line.account_id)
        return { ...line, account_code: account.account_code, account_name: account.name, account_type: account.account_type }
      })
    return result(lines)
  }
  if (q.startsWith('SELECT j.id, j.tenant_id, j.accounting_period_id, j.entry_date, j.description,')) {
    const journals = [...db.journals.values()].filter((journal) => journal.tenant_id === params[0] && journal.status === 'posted')
    return result(journals.slice(0, 500).map((journal) => {
      const lines = db.lines.filter((line) => line.tenant_id === journal.tenant_id && line.journal_entry_id === journal.id)
      const debitTotal = lines.reduce((sum, line) => sum + BigInt(line.debit.replace('.', '')), 0n)
      const creditTotal = lines.reduce((sum, line) => sum + BigInt(line.credit.replace('.', '')), 0n)
      return { ...journal, line_count: lines.length, debit_total: (debitTotal / 1000000n).toString(), credit_total: (creditTotal / 1000000n).toString() }
    }))
  }
  if (q.startsWith('SELECT id, payload_hash, status, journal_entry_id FROM accounting_posting_events')) {
    const event = [...db.events.values()].find((row) => row.tenant_id === params[0] && row.idempotency_key === params[1])
    return result(event ? [{ ...event }] : [])
  }
  if (q.startsWith('SELECT id, accounting_period_id, entry_date, description, status, functional_currency')) {
    const journal = db.journals.get(params[1])
    return result(journal?.tenant_id === params[0] ? [{ ...journal }] : [])
  }
  if (q.startsWith('SELECT line_number, account_id, description, debit, credit, transaction_currency')) {
    return result(db.lines.filter((line) => line.tenant_id === params[0] && line.journal_entry_id === params[1])
      .sort((a, b) => a.line_number - b.line_number).map((line) => ({ ...line })))
  }
  if (q.startsWith('SELECT id, status, source_type, source_reference, reversal_of_entry_id FROM accounting_journal_entries')) {
    const journal = db.journals.get(params[1])
    return result(journal?.tenant_id === params[0] ? [{
      id: journal.id, status: journal.status, source_type: journal.source_type, source_reference: journal.source_reference,
      reversal_of_entry_id: journal.reversal_of_entry_id
    }] : [])
  }
  if (q.startsWith('SELECT base_currency FROM accounting_settings')) {
    const setting = db.settings.get(params[0])
    return result(setting ? [{ base_currency: setting.base_currency }] : [])
  }
  if (q.startsWith('SELECT id, status, ($3::date BETWEEN starts_on AND ends_on) AS entry_date_in_period FROM accounting_periods')) {
    if (postingReadGate) {
      postingReadGate.started()
      await postingReadGate.hold
    }
    const period = db.periods.get(params[1])
    return result(period?.tenant_id === params[0] ? [{
      id: period.id,
      status: period.status,
      entry_date_in_period: params[2] >= period.starts_on && params[2] <= period.ends_on
    }] : [])
  }
  if (q.startsWith('SELECT id, account_type, normal_balance, is_active FROM accounting_accounts')) {
    const ids = new Set(params[1])
    return result([...db.accounts.values()].filter((account) =>
      account.tenant_id === params[0] && ids.has(account.id)
    ).map((account) => ({ id: account.id, account_type: account.account_type,
      normal_balance: account.normal_balance, is_active: account.is_active })))
  }
  if (q.startsWith('INSERT INTO accounting_posting_events')) {
    const sameKey = [...db.events.values()].find((event) => event.tenant_id === params[0] && event.idempotency_key === params[1])
    if (sameKey) return result([])
    const sameSource = params[4] == null ? null : [...db.events.values()].find((event) =>
      event.tenant_id === params[0] && event.source_type === params[3] &&
      event.source_id === params[4] && event.event_type === params[6]
    )
    if (sameSource) throw pgError('23505', 'duplicate source event')
    const event = {
      id: makeId(), tenant_id: params[0], idempotency_key: params[1], payload_hash: params[2],
      source_type: params[3], source_id: params[4], source_reference: params[5], event_type: params[6],
      status: 'processing', journal_entry_id: null, created_by: params[7]
    }
    db.events.set(event.id, event)
    return result([{ id: event.id }])
  }
  if (q.startsWith('INSERT INTO accounting_journal_entries')) {
    const journal = {
      id: makeId(), tenant_id: params[0], accounting_period_id: params[1], entry_date: params[2],
      description: params[3], status: 'draft', functional_currency: params[4], source_type: params[5],
      source_id: params[6], source_reference: params[7], event_type: params[8], posting_event_id: params[9],
      reversal_of_entry_id: params[10] || null, reversal_reason: params[11] || null, created_by: params[12],
      posted_by: null, created_at: '2026-10-21T00:00:00.000Z', posted_at: null
    }
    db.journals.set(journal.id, journal)
    return result([{ id: journal.id }])
  }
  if (q.startsWith('INSERT INTO accounting_journal_lines')) {
    db.lineInsertCount += 1
    if (db.failLineInsertAt === db.lineInsertCount) throw pgError('P0001', 'simulated line insert failure')
    const line = {
      tenant_id: params[0], journal_entry_id: params[1], line_number: params[2], account_id: params[3],
      description: params[4], debit: params[5], credit: params[6], transaction_currency: params[7],
      transaction_amount: params[8], exchange_rate: params[9], exchange_rate_source: params[10],
      exchange_rate_at: params[11]
    }
    db.lines.push(line)
    return result([line])
  }
  if (q.startsWith('UPDATE accounting_journal_entries SET status =')) {
    const journal = db.journals.get(params[2])
    if (!journal || journal.tenant_id !== params[1] || journal.status !== 'draft') return result([])
    Object.assign(journal, { status: 'posted', posted_by: params[0], posted_at: '2026-10-21T00:00:01.000Z' })
    return result([{ ...journal }])
  }
  if (q.startsWith('UPDATE accounting_posting_events SET status =')) {
    const event = db.events.get(params[2])
    if (!event || event.tenant_id !== params[1] || event.status !== 'processing') return result([])
    Object.assign(event, { status: 'posted', journal_entry_id: params[0], completed_at: '2026-10-21T00:00:01.000Z' })
    return result([{ ...event }])
  }
  if (q.startsWith('SELECT id FROM tenants WHERE id = $1 FOR UPDATE')) {
    return result(db.tenants.has(params[0]) ? [{ id: params[0] }] : [])
  }
  if (q.startsWith('SELECT id, account_type, is_active FROM accounting_accounts')) {
    const ids = new Set(params[1])
    return result([...db.accounts.values()].filter((account) => account.tenant_id === params[0] && ids.has(account.id))
      .map((account) => ({ id: account.id, account_type: account.account_type, is_active: account.is_active })))
  }
  if (q.startsWith('SELECT account_type, is_active FROM accounting_accounts WHERE tenant_id = $1 AND id = $2')) {
    const account = db.accounts.get(params[1])
    return result(account?.tenant_id === params[0]
      ? [{ account_type: account.account_type, is_active: account.is_active }]
      : [])
  }
  if (q.startsWith('INSERT INTO accounting_invoice_mappings')) {
    const mapping = db.invoiceMappings.get(params[0]) || {
      tenant_id: params[0], created_at: '2026-10-21T00:00:00.000Z'
    }
    Object.assign(mapping, {
      receivables_account_id: params[1], sales_revenue_account_id: params[2],
      updated_by: params[3], updated_at: '2026-10-24T00:00:00.000Z'
    })
    db.invoiceMappings.set(params[0], mapping)
    return result([{ ...mapping }])
  }
  if (q.startsWith('SELECT id, effective_from, effective_to, is_active FROM accounting_tax_profiles')) {
    const profiles = [...db.taxProfiles.values()].filter((profile) =>
      profile.tenant_id === params[0] && profile.profile_key === params[1]
    ).sort((a, b) => b.version - a.version)
    return result(profiles.slice(0, 1).map(({ id, effective_from, effective_to, is_active }) => ({
      id, effective_from, effective_to, is_active
    })))
  }
  if (q.startsWith('SELECT COALESCE(MAX(version), 0)::integer + 1 AS next_version FROM accounting_tax_profiles')) {
    const version = Math.max(0, ...[...db.taxProfiles.values()]
      .filter((profile) => profile.tenant_id === params[0] && profile.profile_key === params[1])
      .map((profile) => profile.version)) + 1
    return result([{ next_version: version }])
  }
  if (q.startsWith('INSERT INTO accounting_tax_profiles')) {
    const profile = {
      id: makeId(), tenant_id: params[0], profile_key: params[1], name: params[2], version: params[3],
      tax_rate: params[4], calculation_method: params[5], rounding_method: params[6],
      effective_from: params[7], effective_to: params[8], requires_tax_payable: params[9],
      tax_payable_account_id: params[10], created_by: params[11], is_active: true,
      created_at: '2026-10-24T00:00:00.000Z', updated_at: '2026-10-24T00:00:00.000Z'
    }
    db.taxProfiles.set(profile.id, profile)
    return result([{ ...profile }])
  }
  if (q.startsWith('UPDATE accounting_tax_profiles SET is_active = false, updated_at = CURRENT_TIMESTAMP')) {
    const profile = db.taxProfiles.get(params[1])
    if (!profile || profile.tenant_id !== params[0] || !profile.is_active) return result([])
    profile.is_active = false
    profile.updated_at = '2026-10-24T00:00:00.000Z'
    return result([{
      id: profile.id, profile_key: profile.profile_key, name: profile.name,
      version: profile.version, is_active: profile.is_active, updated_at: profile.updated_at
    }])
  }
  if (q.startsWith('SELECT 1 FROM accounting_journal_entries')) {
    return result([...db.journals.values()].some((journal) => journal.tenant_id === params[0]) ? [{ '?column?': 1 }] : [])
  }
  if (q.startsWith('INSERT INTO accounting_accounts')) {
    const tenantId = params[0]
    if ([...db.accounts.values()].some((account) => account.tenant_id === tenantId && account.account_code === params[1])) {
      throw pgError('23505', 'duplicate account code')
    }
    const account = {
      id: makeId(), tenant_id: tenantId, account_code: params[1], name: params[2], account_type: params[3],
      normal_balance: params[4], is_active: true, is_system: false, system_key: null, created_by: params[5]
    }
    db.accounts.set(account.id, account)
    return result([{ ...account }])
  }
  if (q.startsWith('SELECT id, tenant_id, account_code, name, account_type, normal_balance')) {
    let accounts = [...db.accounts.values()].filter((account) => account.tenant_id === params[0])
    if (params[1] !== null) accounts = accounts.filter((account) => account.is_active === params[1])
    return result(accounts.map((account) => ({ ...account })))
  }
  if (q.startsWith('SELECT id FROM accounting_accounts')) {
    const account = db.accounts.get(params[0])
    return result(account?.tenant_id === params[1] ? [{ id: account.id }] : [])
  }
  if (q.startsWith('SELECT a.id, a.is_system, a.name, EXISTS (SELECT 1 FROM accounting_journal_lines')) {
    const account = db.accounts.get(params[0])
    if (!account || account.tenant_id !== params[1]) return result([])
    const isUsed = db.lines.some((line) => line.tenant_id === params[1] && line.account_id === params[0])
    return result([{ id: account.id, is_system: account.is_system, name: account.name, is_used: isUsed }])
  }
  if (q.startsWith('UPDATE accounting_accounts SET name = COALESCE(')) {
    const account = db.accounts.get(params[2])
    if (!account || account.tenant_id !== params[3]) return result([])
    if (params[0] != null) account.name = params[0]
    if (params[1] != null) account.is_active = params[1]
    return result([{ ...account }])
  }
  throw new Error(`Unexpected accounting test query: ${q}`)
}

const fakePool = {
  async query(sql, params = []) { return dbQuery(state, sql, params) },
  async connect() {
    clientLifecycle.connections += 1
    let working
    let unlock
    let hasLock = false
    return {
      async query(sql, params = []) {
        const q = normalizeSql(sql)
        if (q.startsWith('BEGIN ')) {
          clientLifecycle.begins += 1
          const previous = lockTail
          lockTail = new Promise((resolve) => { unlock = resolve })
          await previous
          hasLock = true
          working = structuredClone(state)
          return result([])
        }
        if (q === 'COMMIT') {
          clientLifecycle.commits += 1
          ensureBalanced(working)
          working.commits += 1
          state = working
          if (hasLock) { hasLock = false; unlock() }
          return result([])
        }
        if (q === 'ROLLBACK') {
          clientLifecycle.rollbacks += 1
          state.rollbacks += 1
          if (hasLock) { hasLock = false; unlock() }
          return result([])
        }
        return dbQuery(working, sql, params)
      },
      release() {
        clientLifecycle.releases += 1
        if (hasLock) { hasLock = false; unlock() }
      }
    }
  }
}

const installMockModule = (modulePath, exports) => {
  const mock = new Module(modulePath)
  mock.filename = modulePath
  mock.loaded = true
  mock.exports = exports
  require.cache[modulePath] = mock
}
installMockModule(require.resolve('../src/config/db'), fakePool)

const { postJournal, reverseJournal, withTransaction } = require('../src/services/accounting')
const { closeAccountingPeriod, SCHEMA_REQUIREMENTS } = require('../src/services/accountingPeriodClose')
const { normalizeAccount, normalizeJournal } = require('../src/utils/accounting')
const { requireAccountingPermission } = require('../src/middleware/accountingAuthorization')
const accountingRouter = require('../src/routes/accounting')
const MIGRATION_PATH = path.join(__dirname, '..', 'migrations', '20261021_001_accounting_foundation.sql')
const MIGRATION = fs.readFileSync(MIGRATION_PATH, 'utf8')

const tokenFor = ({ tenantId = IDS.tenantA, userId, role } = {}) => jwt.sign({
  userId: userId || (tenantId === IDS.tenantB ? IDS.userB : IDS.userA),
  tenantId,
  ...(role === undefined ? { role: 'admin' } : { role })
}, JWT_TEST_SECRET)
const journalBody = (overrides = {}) => ({
  tenant_id: IDS.tenantB,
  accounting_period_id: IDS.periodA,
  entry_date: '2026-08-10',
  description: 'Opening test adjustment',
  source_type: 'manual_adjustment',
  source_id: null,
  source_reference: 'TEST-1',
  event_type: 'post',
  lines: [
    { account_id: IDS.accountA, debit: '125.500000', credit: '0' },
    { account_id: IDS.accountB, debit: '0.000000', credit: '125.5' }
  ],
  ...overrides
})

test.beforeEach(() => {
  state = makeState()
  nextId = 1
  lockTail = Promise.resolve()
  postingReadGate = null
  clientLifecycle = { connections: 0, begins: 0, commits: 0, rollbacks: 0, releases: 0 }
})

test('posts a balanced journal with tenant-scoped accounts and an atomic completed event', async () => {
  const posted = await postJournal(fakePool, {
    tenantId: IDS.tenantA, userId: IDS.userA, idempotencyKey: 'journal-create-001', body: journalBody()
  })
  assert.equal(posted.replayed, false)
  assert.equal(posted.journal.status, 'posted')
  assert.equal(posted.journal.functional_currency, 'KES')
  assert.equal(state.journals.size, 1)
  assert.equal(state.lines.length, 2)
  assert.equal(state.events.size, 1)
  assert.equal([...state.events.values()][0].status, 'posted')
  assert.equal(state.commits, 1)
  assert.deepEqual(clientLifecycle, { connections: 1, begins: 1, commits: 1, rollbacks: 0, releases: 1 })
})

test('normalizes six-place journal amounts exactly near zero and across floating-point boundaries', () => {
  const journal = normalizeJournal(journalBody({
    lines: [
      { account_id: IDS.accountA, debit: '0.100000', credit: '0' },
      { account_id: IDS.accountA, debit: '0.200000', credit: '0' },
      { account_id: IDS.accountA, debit: '0.000001', credit: '0' },
      { account_id: IDS.accountB, debit: '0', credit: '0.300000' },
      { account_id: IDS.accountB, debit: '0', credit: '0.000001' }
    ]
  }), 'journal-precision-001')

  assert.deepEqual(journal.lines.map(({ debit, credit }) => ({ debit, credit })), [
    { debit: '0.100000', credit: '0.000000' },
    { debit: '0.200000', credit: '0.000000' },
    { debit: '0.000001', credit: '0.000000' },
    { debit: '0.000000', credit: '0.300000' },
    { debit: '0.000000', credit: '0.000001' }
  ])

  assert.throws(() => normalizeJournal(journalBody({
    lines: [
      { account_id: IDS.accountA, debit: '0.0000001', credit: '0' },
      { account_id: IDS.accountB, debit: '0', credit: '0.0000001' }
    ]
  }), 'journal-precision-002'), /at most 6 decimal places/)
})

test('posts in a caller-owned transaction without controlling its connection lifecycle', async () => {
  const client = await fakePool.connect()
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
  await client.query('INSERT INTO test_business_changes (value) VALUES ($1)', ['invoice-123'])
  const beforePosting = { ...clientLifecycle }

  const posted = await postJournal(fakePool, {
    tenantId: IDS.tenantA,
    userId: IDS.userA,
    idempotencyKey: 'journal-caller-owned-001',
    body: journalBody()
  }, { client })

  assert.equal(posted.replayed, false)
  assert.equal(clientLifecycle.connections, beforePosting.connections)
  assert.equal(clientLifecycle.begins, beforePosting.begins)
  assert.equal(clientLifecycle.commits, beforePosting.commits)
  assert.equal(clientLifecycle.rollbacks, beforePosting.rollbacks)
  assert.equal(clientLifecycle.releases, beforePosting.releases)
  assert.equal(state.journals.size, 0, 'uncommitted journal must remain invisible outside the caller transaction')

  await client.query('COMMIT')
  client.release()
  assert.deepEqual(state.businessChanges, ['invoice-123'])
  assert.equal(state.journals.size, 1)
  assert.equal(state.events.size, 1)
  assert.equal(clientLifecycle.commits, 1)
  assert.equal(clientLifecycle.releases, 1)
})

test('caller can roll back business changes and journal changes together after posting fails', async () => {
  state.failLineInsertAt = 2
  const client = await fakePool.connect()
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
  await client.query('INSERT INTO test_business_changes (value) VALUES ($1)', ['invoice-to-rollback'])
  const beforePosting = { ...clientLifecycle }

  await assert.rejects(postJournal(fakePool, {
    tenantId: IDS.tenantA,
    userId: IDS.userA,
    idempotencyKey: 'journal-caller-failure-001',
    body: journalBody()
  }, { client }), (error) => error.code === 'P0001' && /simulated line insert failure/.test(error.message))

  assert.deepEqual(clientLifecycle, beforePosting, 'posting service must leave commit, rollback, and release decisions to caller')
  await client.query('ROLLBACK')
  client.release()

  assert.deepEqual(state.businessChanges, [])
  assert.equal(state.events.size, 0)
  assert.equal(state.journals.size, 0)
  assert.equal(state.lines.length, 0)
  assert.equal(clientLifecycle.commits, 0)
  assert.equal(clientLifecycle.rollbacks, 1)
  assert.equal(clientLifecycle.releases, 1)
})

test('accounting transaction rollback failures log a safe code and preserve the original error', async () => {
  const originalFailure = new Error('ORIGINAL_BUSINESS_FAILURE')
  const rollbackFailure = pgError('XX999', 'ROLLBACK_SQL_SECRET')
  const statements = []
  const releaseErrors = []
  const client = {
    async query(sql) {
      statements.push(sql)
      if (sql === 'ROLLBACK') throw rollbackFailure
      return result()
    },
    release(error) {
      releaseErrors.push(error)
    }
  }
  const logged = []
  const originalConsoleError = console.error
  console.error = (...args) => logged.push(args)
  try {
    await assert.rejects(
      withTransaction({ connect: async () => client }, async () => { throw originalFailure }),
      (error) => error === originalFailure
    )
  } finally {
    console.error = originalConsoleError
  }

  assert.deepEqual(statements, ['BEGIN ISOLATION LEVEL READ COMMITTED', 'ROLLBACK'])
  assert.deepEqual(releaseErrors, [rollbackFailure])
  assert.equal(logged.length, 1)
  assert.equal(logged[0][0], 'Failed to roll back accounting transaction')
  assert.equal(logged[0][1].error.code, 'XX999')
  assert.equal(JSON.stringify(logged).includes('ROLLBACK_SQL_SECRET'), false)
  assert.equal(JSON.stringify(logged).includes('ORIGINAL_BUSINESS_FAILURE'), false)
})

test('rejects unbalanced, empty, zero, negative, and debit-plus-credit line inputs', async () => {
  const attempts = [
    journalBody({ lines: [] }),
    journalBody({ lines: [{ account_id: IDS.accountA, debit: '1', credit: '0' }, { account_id: IDS.accountB, debit: '0', credit: '2' }] }),
    journalBody({ lines: [{ account_id: IDS.accountA, debit: '0', credit: '0' }, { account_id: IDS.accountB, debit: '1', credit: '0' }] }),
    journalBody({ lines: [{ account_id: IDS.accountA, debit: '-1', credit: '0' }, { account_id: IDS.accountB, debit: '0', credit: '1' }] }),
    journalBody({ lines: [{ account_id: IDS.accountA, debit: '1', credit: '1' }, { account_id: IDS.accountB, debit: '0', credit: '2' }] })
  ]
  for (const body of attempts) {
    await assert.rejects(postJournal(fakePool, {
      tenantId: IDS.tenantA, userId: IDS.userA, idempotencyKey: `journal-invalid-${attempts.indexOf(body)}`, body
    }), { statusCode: 400 })
  }
  assert.equal(state.events.size, 0)
  assert.equal(state.journals.size, 0)
})

test('rejects cross-tenant and inactive accounts before committing a journal', async () => {
  await assert.rejects(postJournal(fakePool, {
    tenantId: IDS.tenantA, userId: IDS.userA, idempotencyKey: 'journal-cross-tenant',
    body: journalBody({ lines: [
      { account_id: IDS.accountA, debit: '1', credit: '0' },
      { account_id: IDS.accountForeign, debit: '0', credit: '1' }
    ] })
  }), { statusCode: 400 })
  state.accounts.get(IDS.accountB).is_active = false
  await assert.rejects(postJournal(fakePool, {
    tenantId: IDS.tenantA, userId: IDS.userA, idempotencyKey: 'journal-inactive-001', body: journalBody()
  }), { statusCode: 409 })
  assert.equal(state.journals.size, 0)
})

test('validates account types and normal balances for chart creation', () => {
  assert.throws(() => normalizeAccount({ account_code: '3000', name: 'Bad', account_type: 'cash', normal_balance: 'debit' }), { statusCode: 400 })
  assert.throws(() => normalizeAccount({ account_code: '3000', name: 'Bad', account_type: 'asset', normal_balance: 'both' }), { statusCode: 400 })
  assert.equal(normalizeAccount({ account_code: '3100', name: 'Cash', account_type: 'asset', normal_balance: 'debit' }).account_code, '3100')
})

test('rejects postings into a closed or mismatched accounting period', async () => {
  state.periods.get(IDS.periodA).status = 'closed'
  await assert.rejects(postJournal(fakePool, {
    tenantId: IDS.tenantA, userId: IDS.userA, idempotencyKey: 'journal-closed-001', body: journalBody()
  }), { statusCode: 409 })
  state.periods.get(IDS.periodA).status = 'open'
  await assert.rejects(postJournal(fakePool, {
    tenantId: IDS.tenantA, userId: IDS.userA, idempotencyKey: 'journal-date-001',
    body: journalBody({ entry_date: '2027-01-01' })
  }), { statusCode: 400 })
  assert.equal(state.journals.size, 0)
})

test('accepts journal dates on either inclusive accounting-period boundary', async () => {
  for (const [index, entry_date] of ['2026-01-01', '2026-12-31'].entries()) {
    const posted = await postJournal(fakePool, {
      tenantId: IDS.tenantA,
      userId: IDS.userA,
      idempotencyKey: `journal-period-boundary-${index}`,
      body: journalBody({ entry_date })
    })
    assert.equal(posted.journal.status, 'posted')
  }
  assert.equal(state.journals.size, 2)
})

test('preserves explicit foreign-currency amounts and conversion details exactly', async () => {
  const body = journalBody({ lines: [
    { account_id: IDS.accountA, debit: '13050', credit: '0', transaction_currency: 'usd',
      transaction_amount: '100.00', exchange_rate: '130.5', exchange_rate_source: 'Approved rate sheet',
      exchange_rate_at: '2026-08-10T08:00:00.000Z' },
    { account_id: IDS.accountB, debit: '0', credit: '13050' }
  ] })
  const posted = await postJournal(fakePool, {
    tenantId: IDS.tenantA, userId: IDS.userA, idempotencyKey: 'journal-fx-001', body
  })
  assert.equal(posted.lines[0].transaction_currency, 'USD')
  assert.equal(posted.lines[0].transaction_amount, '100.000000')
  assert.equal(posted.lines[0].exchange_rate, '130.5000000000')
  await assert.rejects(postJournal(fakePool, {
    tenantId: IDS.tenantA, userId: IDS.userA, idempotencyKey: 'journal-fx-bad-001',
    body: journalBody({ lines: [
      { account_id: IDS.accountA, debit: '13000', credit: '0', transaction_currency: 'USD',
        transaction_amount: '100', exchange_rate: '130.5', exchange_rate_source: 'Source',
        exchange_rate_at: '2026-08-10T08:00:00.000Z' },
      { account_id: IDS.accountB, debit: '0', credit: '13000' }
    ] })
  }), { statusCode: 400 })
})

test('returns the original journal for same-key retries and conflicts on changed payloads', async () => {
  const first = await postJournal(fakePool, {
    tenantId: IDS.tenantA, userId: IDS.userA, idempotencyKey: 'journal-retry-001', body: journalBody()
  })
  const replay = await postJournal(fakePool, {
    tenantId: IDS.tenantA, userId: IDS.userA, idempotencyKey: 'journal-retry-001', body: journalBody()
  })
  assert.equal(replay.replayed, true)
  assert.equal(replay.journal.id, first.journal.id)
  assert.equal(state.journals.size, 1)
  await assert.rejects(postJournal(fakePool, {
    tenantId: IDS.tenantA, userId: IDS.userA, idempotencyKey: 'journal-retry-001',
    body: journalBody({ description: 'Changed payload' })
  }), { statusCode: 409 })
  assert.equal(state.journals.size, 1)

  const callerClient = await fakePool.connect()
  await callerClient.query('BEGIN ISOLATION LEVEL READ COMMITTED')
  const beforeReplay = { ...clientLifecycle }
  const callerReplay = await postJournal(fakePool, {
    tenantId: IDS.tenantA, userId: IDS.userA, idempotencyKey: 'journal-retry-001', body: journalBody()
  }, { client: callerClient })
  assert.equal(callerReplay.replayed, true)
  assert.equal(callerReplay.journal.id, first.journal.id)
  await assert.rejects(postJournal(fakePool, {
    tenantId: IDS.tenantA, userId: IDS.userA, idempotencyKey: 'journal-retry-001',
    body: journalBody({ description: 'Changed payload in caller transaction' })
  }, { client: callerClient }), { statusCode: 409 })
  assert.deepEqual(clientLifecycle, beforeReplay)
  await callerClient.query('ROLLBACK')
  callerClient.release()
  assert.equal(state.journals.size, 1)
})

test('serializes concurrent duplicate idempotency keys to one committed journal', async () => {
  const input = { tenantId: IDS.tenantA, userId: IDS.userA, idempotencyKey: 'journal-concurrent-001', body: journalBody() }
  const [first, second] = await Promise.all([postJournal(fakePool, input), postJournal(fakePool, input)])
  assert.equal(state.journals.size, 1)
  assert.equal(state.events.size, 1)
  assert.equal([first, second].filter((row) => row.replayed).length, 1)
})

test('concurrent posting and close readiness serialize, then fail closed on unreviewed legacy M-Pesa evidence', async () => {
  let signalStarted
  let releasePosting
  const started = new Promise((resolve) => { signalStarted = resolve })
  const hold = new Promise((resolve) => { releasePosting = resolve })
  postingReadGate = { started: signalStarted, hold }
  const posting = postJournal(fakePool, {
    tenantId: IDS.tenantA, userId: IDS.userA, idempotencyKey: 'journal-before-close-1', body: journalBody()
  })
  await started
  const closing = closeAccountingPeriod(fakePool, {
    tenantId: IDS.tenantA, userId: IDS.userA, periodId: IDS.periodA,
    idempotencyKey: 'period-close-after-post', reason: 'Concurrent posting and closure test', confirm: true
  })
  releasePosting()
  const [posted, closed] = await Promise.all([posting, closing])
  postingReadGate = null
  assert.equal(posted.journal.status, 'posted')
  assert.equal(closed.outcome, 'blocked')
  assert.equal(closed.readiness.blockers.some((check) => check.id === 'legacy_mpesa_coverage'), true)
  assert.equal(state.periods.get(IDS.periodA).status, 'open')
  assert.equal(state.journals.size, 1)
})

test('rolls back event, header and prior lines when a line insert fails', async () => {
  state.failLineInsertAt = 2
  await assert.rejects(postJournal(fakePool, {
    tenantId: IDS.tenantA, userId: IDS.userA, idempotencyKey: 'journal-rollback-001', body: journalBody()
  }), (error) => error.code === 'P0001' && /simulated line insert failure/.test(error.message))
  assert.equal(state.events.size, 0)
  assert.equal(state.journals.size, 0)
  assert.equal(state.lines.length, 0)
  assert.equal(state.commits, 0)
  assert.equal(state.rollbacks, 1)
  assert.deepEqual(clientLifecycle, { connections: 1, begins: 1, commits: 0, rollbacks: 1, releases: 1 })
})

test('creates linked reversal entries without modifying the posted journal', async () => {
  const original = await postJournal(fakePool, {
    tenantId: IDS.tenantA, userId: IDS.userA, idempotencyKey: 'journal-to-reverse-001', body: journalBody()
  })
  const reversal = await reverseJournal(fakePool, {
    tenantId: IDS.tenantA, userId: IDS.userA, journalId: original.journal.id,
    idempotencyKey: 'journal-reversal-001', reversalDate: '2026-09-01', periodId: IDS.periodA,
    reason: 'Correction'
  })
  assert.equal(reversal.journal.reversal_of_entry_id, original.journal.id)
  assert.equal(reversal.journal.reversal_reason, 'Correction')
  assert.equal(reversal.lines[0].debit, '0.000000')
  assert.equal(reversal.lines[0].credit, '125.500000')
  assert.equal(state.journals.get(original.journal.id).status, 'posted')
  assert.equal(state.journals.get(original.journal.id).reversal_of_entry_id, null)
  await assert.rejects(reverseJournal(fakePool, {
    tenantId: IDS.tenantA, userId: IDS.userA, journalId: original.journal.id,
    idempotencyKey: 'journal-reversal-002', reversalDate: '2026-09-01', periodId: IDS.periodA,
    reason: 'Another reversal'
  }), { statusCode: 409 })
})

test('generic journal reversal refuses invoice journals so invoice state cannot remain collectible after its ledger entry is reversed', async () => {
  const original = await postJournal(fakePool, {
    tenantId: IDS.tenantA, userId: IDS.userA, idempotencyKey: 'invoice-journal-reverse-guard',
    body: journalBody({ source_type: 'invoice', source_id: IDS.periodA, event_type: 'issue' })
  })
  const response = await requestServer('POST', `/api/accounting/journals/${original.journal.id}/reverse`, {
    period_id: IDS.periodA, reversal_date: '2026-09-01', reason: 'Test a source-owned reversal'
  }, { headers: { 'Idempotency-Key': 'invoice-journal-reverse-guard-key' } })
  assert.equal(response.status, 409)
  assert.match(response.data.error, /owning business workflow/)
  assert.equal(state.journals.get(original.journal.id).status, 'posted')
  assert.equal(state.journals.size, 1)
})

test('reverses a journal inside a caller-owned transaction without committing it', async () => {
  const original = await postJournal(fakePool, {
    tenantId: IDS.tenantA, userId: IDS.userA, idempotencyKey: 'journal-caller-reversal-source-001', body: journalBody()
  })
  const client = await fakePool.connect()
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
  await client.query('INSERT INTO test_business_changes (value) VALUES ($1)', ['receipt-reversed'])
  const beforeReverse = { ...clientLifecycle }

  const reversal = await reverseJournal(fakePool, {
    tenantId: IDS.tenantA, userId: IDS.userA, journalId: original.journal.id,
    idempotencyKey: 'journal-caller-reversal-001', reversalDate: '2026-09-01',
    periodId: IDS.periodA, reason: 'Receipt correction'
  }, { client })

  assert.equal(reversal.journal.reversal_of_entry_id, original.journal.id)
  assert.deepEqual(clientLifecycle, beforeReverse)
  assert.equal(state.journals.size, 1)
  await client.query('COMMIT')
  client.release()
  assert.equal(state.journals.size, 2)
  assert.deepEqual(state.businessChanges, ['receipt-reversed'])
})

test('posted journals have no edit or delete route and remain unchanged after both attempts', async () => {
  const posted = await postJournal(fakePool, {
    tenantId: IDS.tenantA, userId: IDS.userA, idempotencyKey: 'journal-immutable-route', body: journalBody()
  })
  const beforeJournal = structuredClone(state.journals.get(posted.journal.id))
  const beforeLines = structuredClone(state.lines.filter((line) => line.journal_entry_id === posted.journal.id))

  assert.match(MIGRATION, /Posted journal entries are immutable; create a reversal/)
  assert.match(MIGRATION, /Lines of posted journals are immutable; create a reversal/)
  const patchResponse = await requestServer('PATCH', `/api/accounting/journals/${posted.journal.id}`, { description: 'Changed' })
  const deleteResponse = await requestServer('DELETE', `/api/accounting/journals/${posted.journal.id}`)

  assert.equal(patchResponse.status, 404)
  assert.equal(deleteResponse.status, 404)
  assert.deepEqual(state.journals.get(posted.journal.id), beforeJournal)
  assert.deepEqual(state.lines.filter((line) => line.journal_entry_id === posted.journal.id), beforeLines)
})

test('authenticated account creation derives tenant from JWT, not the request body', async () => {
  const response = await requestServer('POST', '/api/accounting/accounts', {
    tenant_id: IDS.tenantB, account_code: '1010', name: 'Cash', account_type: 'asset', normal_balance: 'debit'
  }, { tenantId: IDS.tenantA })
  assert.equal(response.status, 201)
  assert.equal(response.data.tenant_id, IDS.tenantA)
})

test('account listing does not expose another tenant accounts', async () => {
  const ownAccounts = await requestServer('GET', '/api/accounting/accounts', undefined, { tenantId: IDS.tenantA })
  const response = await requestServer('GET', '/api/accounting/accounts', undefined, { tenantId: IDS.tenantB })
  assert.deepEqual(ownAccounts.data.map((account) => account.id).sort(), [IDS.accountA, IDS.accountB, IDS.accountRevenue].sort())
  assert.equal(response.status, 200)
  assert.deepEqual(response.data.map((account) => account.id).sort(), [IDS.accountForeign, IDS.accountForeignRevenue].sort())
})

test('invoice-mapping and tax-profile lists ignore a hostile tenant_id query parameter', async () => {
  const mappings = await requestServer('GET', `/api/accounting/invoice-mappings?tenant_id=${IDS.tenantB}`)
  const profiles = await requestServer('GET', `/api/accounting/tax-profiles?tenant_id=${IDS.tenantB}`)

  assert.equal(mappings.status, 200)
  assert.equal(mappings.data.tenant_id, IDS.tenantA)
  assert.equal(mappings.data.receivables_account_id, IDS.accountA)
  assert.equal(mappings.data.sales_revenue_account_id, IDS.accountRevenue)
  assert.equal(mappings.data.receivables_account_name, 'Account 1000')
  assert.equal(mappings.data.sales_revenue_account_name, 'Account 4000')
  assert.equal(JSON.stringify(mappings.data).includes(IDS.tenantB), false)
  assert.equal(JSON.stringify(mappings.data).includes(IDS.accountForeign), false)
  assert.equal(JSON.stringify(mappings.data).includes(IDS.accountForeignRevenue), false)
  assert.equal(JSON.stringify(mappings.data).includes('Account 9000'), false)

  assert.equal(profiles.status, 200)
  assert.deepEqual(profiles.data.map((profile) => profile.id), [IDS.taxProfileA])
  assert.equal(profiles.data[0].tenant_id, IDS.tenantA)
  assert.equal(JSON.stringify(profiles.data).includes(IDS.taxProfileB), false)
  assert.equal(JSON.stringify(profiles.data).includes('Tenant B private tax'), false)
  assert.equal(JSON.stringify(profiles.data).includes(IDS.accountForeign), false)
})

test('admin cross-tenant invoice and tax account assignments are rejected without mutation or foreign detail', async () => {
  const before = structuredClone(state.invoiceMappings)
  const profilesBefore = structuredClone(state.taxProfiles)
  const response = await requestServer('PUT', '/api/accounting/invoice-mappings', {
    receivables_account_id: IDS.accountForeign,
    sales_revenue_account_id: IDS.accountRevenue
  })

  assert.equal(response.status, 409)
  assert.deepEqual(response.data, {
    error: 'Mappings require active tenant-owned asset receivables and revenue accounts'
  })
  assert.deepEqual(state.invoiceMappings, before)
  assert.equal(JSON.stringify(response.data).includes(IDS.accountForeign), false)

  const foreignTaxAccount = await requestServer('POST', '/api/accounting/tax-profiles', {
    profile_key: 'foreign-tax-account', name: 'Foreign payable account', tax_rate: '16.00',
    calculation_method: 'exclusive', rounding_method: 'invoice_total',
    effective_from: '2026-01-01', requires_tax_payable: true,
    tax_payable_account_id: IDS.accountForeign
  })
  assert.equal(foreignTaxAccount.status, 409)
  assert.deepEqual(foreignTaxAccount.data, {
    error: 'Tax profiles require an active tenant-owned liability account'
  })
  assert.equal(JSON.stringify(foreignTaxAccount.data).includes(IDS.accountForeign), false)
  assert.deepEqual(state.taxProfiles, profilesBefore)

  const foreignProfile = await requestServer('PATCH', `/api/accounting/tax-profiles/${IDS.taxProfileB}/deactivate`, {})
  assert.equal(foreignProfile.status, 404)
  assert.deepEqual(foreignProfile.data, { error: 'Tax profile not found' })
  assert.equal(JSON.stringify(foreignProfile.data).includes('Tenant B private tax'), false)
  assert.equal(state.taxProfiles.get(IDS.taxProfileB).is_active, true)
})

test('admin can save invoice mappings and create and deactivate a tenant tax profile', async () => {
  const mapping = await requestServer('PUT', '/api/accounting/invoice-mappings', {
    tenant_id: IDS.tenantB,
    receivables_account_id: IDS.accountA,
    sales_revenue_account_id: IDS.accountRevenue
  })
  assert.equal(mapping.status, 200)
  assert.equal(mapping.data.tenant_id, IDS.tenantA)
  assert.equal(mapping.data.receivables_account_id, IDS.accountA)
  assert.equal(mapping.data.sales_revenue_account_id, IDS.accountRevenue)

  const listedMapping = await requestServer('GET', '/api/accounting/invoice-mappings')
  assert.equal(listedMapping.status, 200)
  assert.equal(listedMapping.data.sales_revenue_account_name, 'Account 4000')

  const created = await requestServer('POST', '/api/accounting/tax-profiles', {
    tenant_id: IDS.tenantB,
    profile_key: 'exempt', name: 'Exempt supply', tax_rate: '0.00',
    calculation_method: 'exclusive', rounding_method: 'invoice_total',
    effective_from: '2027-01-01', requires_tax_payable: false
  })
  assert.equal(created.status, 201)
  assert.equal(created.data.tenant_id, IDS.tenantA)
  assert.equal(created.data.profile_key, 'exempt')
  assert.equal(created.data.version, 1)
  assert.equal(created.data.is_active, true)
  assert.equal(state.taxProfiles.get(created.data.id).created_by, IDS.userA)

  const deactivated = await requestServer('PATCH', `/api/accounting/tax-profiles/${created.data.id}/deactivate`, {})
  assert.equal(deactivated.status, 200)
  assert.equal(deactivated.data.id, created.data.id)
  assert.equal(deactivated.data.is_active, false)
  assert.equal(state.taxProfiles.get(created.data.id).is_active, false)
})

test('ordinary authenticated users can read accounting data but cannot use any accounting mutation permission', async () => {
  const posted = await postJournal(fakePool, {
    tenantId: IDS.tenantA, userId: IDS.userA, idempotencyKey: 'journal-read-permissions', body: journalBody()
  })
  const readRoutes = [
    '/api/accounting/settings',
    '/api/accounting/accounts',
    '/api/accounting/invoice-mappings',
    '/api/accounting/tax-profiles',
    '/api/accounting/periods',
    `/api/accounting/periods/${IDS.periodA}/readiness`,
    '/api/accounting/journals',
    `/api/accounting/journals/${posted.journal.id}`
  ]
  for (const route of readRoutes) {
    const response = await requestServer('GET', route, undefined, { userId: IDS.userReader, role: 'test-reader' })
    assert.equal(response.status, 200, `${route} should allow an authenticated non-admin reader`)
  }

  const mutations = [
    ['PUT', '/api/accounting/settings', { base_currency: 'KES' }],
    ['POST', '/api/accounting/accounts', { account_code: '3010', name: 'Equity', account_type: 'equity', normal_balance: 'credit' }],
    ['PATCH', `/api/accounting/accounts/${IDS.accountA}`, { name: 'Renamed account' }],
    ['PATCH', `/api/accounting/accounts/${IDS.accountA}`, { is_active: false }],
    ['PUT', '/api/accounting/invoice-mappings', { receivables_account_id: IDS.accountA, sales_revenue_account_id: IDS.accountB }],
    ['POST', '/api/accounting/tax-profiles', {
      profile_key: 'no-tax', name: 'No tax', tax_rate: '0.00', calculation_method: 'exclusive',
      rounding_method: 'invoice_total', effective_from: '2026-01-01', requires_tax_payable: false
    }],
    ['PATCH', `/api/accounting/tax-profiles/${IDS.accountA}/deactivate`, {}],
    ['POST', '/api/accounting/periods', { name: '2027', starts_on: '2027-01-01', ends_on: '2027-12-31' }],
    ['PATCH', `/api/accounting/periods/${IDS.periodA}/close`, {}],
    ['POST', '/api/accounting/opening-balances', {}],
    ['POST', `/api/accounting/opening-balances/${IDS.periodA}/post`, {}],
    ['POST', `/api/accounting/journals/${posted.journal.id}/reverse`, {
      period_id: IDS.periodA, reversal_date: '2026-08-11', reason: 'Permission test'
    }]
  ]
  for (const [method, route, body] of mutations) {
    const response = await requestServer(method, route, body, {
      userId: IDS.userReader,
      role: 'test-reader',
      headers: { 'Idempotency-Key': 'permission-test-key' }
    })
    assert.equal(response.status, 403, `${method} ${route} should require accounting administration`)
  }
})

test('receipt and supplier payable mutations require an admin accounting role', async () => {
  const runPermission = async (permission, userId, role) => {
    const response = {
      statusCode: null,
      status(code) { this.statusCode = code; return this },
      json(body) { this.body = body; return this }
    }
    let nextCalled = false
    await requireAccountingPermission(permission)(
      { user: { userId, tenantId: IDS.tenantA, role } }, response, () => { nextCalled = true }
    )
    return { response, nextCalled }
  }

  for (const permission of [
    'accounting:manage-receipts', 'accounting:manage-payables', 'accounting:manage-bank-reconciliation',
    'accounting:manage-opening-balances'
  ]) {
    const reader = await runPermission(permission, IDS.userReader, 'test-reader')
    assert.equal(reader.response.statusCode, 403)
    assert.equal(reader.nextCalled, false)
    const admin = await runPermission(permission, IDS.userA, 'admin')
    assert.equal(admin.response.statusCode, null)
    assert.equal(admin.nextCalled, true)
  }
})

test('missing, malformed, mismatched and unrecognized role claims fail closed', async () => {
  const validIdentity = { userId: IDS.userA, tenantId: IDS.tenantA }
  const invalidRoleTokens = [
    jwt.sign(validIdentity, JWT_TEST_SECRET),
    jwt.sign({ ...validIdentity, role: '' }, JWT_TEST_SECRET),
    jwt.sign({ ...validIdentity, role: ' admin ' }, JWT_TEST_SECRET),
    jwt.sign({ ...validIdentity, role: ['admin'] }, JWT_TEST_SECRET),
    tokenFor({ userId: IDS.userA, role: 'root' }),
    // The signed claim must match the role on this user and tenant in the current database row.
    tokenFor({ userId: IDS.userA, role: 'test-reader' }),
    tokenFor({ userId: IDS.userA, tenantId: IDS.tenantB, role: 'admin' })
  ]
  for (const token of invalidRoleTokens) {
    const response = await requestServer('GET', '/api/accounting/settings', undefined, { token })
    assert.equal(response.status, 401)
  }

  const unrecognizedMutationRole = await requestServer('POST', '/api/accounting/accounts', {
    account_code: '3010', name: 'Equity', account_type: 'equity', normal_balance: 'credit'
  }, { userId: IDS.userReader, role: 'test-reader' })
  assert.equal(unrecognizedMutationRole.status, 403)
})

test('unknown accounting permissions fail closed', async () => {
  let nextCalled = false
  const response = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this }
  }
  await requireAccountingPermission('accounting:unknown')(
    { user: { userId: IDS.userA, tenantId: IDS.tenantA, role: 'admin' } },
    response,
    () => { nextCalled = true }
  )
  assert.equal(response.statusCode, 403)
  assert.equal(nextCalled, false)
})

test('unauthenticated requests receive 401 on every accounting mutation permission class', async () => {
  const reads = [
    '/api/accounting/settings',
    '/api/accounting/accounts',
    '/api/accounting/invoice-mappings',
    '/api/accounting/tax-profiles',
    '/api/accounting/periods',
    `/api/accounting/periods/${IDS.periodA}/readiness`,
    '/api/accounting/opening-balances/cutover-preview',
    '/api/accounting/opening-balances',
    '/api/accounting/journals',
    `/api/accounting/journals/${IDS.accountA}`
  ]
  for (const route of reads) {
    const response = await requestServer('GET', route, undefined, { authenticated: false })
    assert.equal(response.status, 401, `GET ${route} should require a valid bearer token`)
  }

  const mutations = [
    ['PUT', '/api/accounting/settings', { base_currency: 'KES' }],
    ['POST', '/api/accounting/accounts', { account_code: '3010', name: 'Equity', account_type: 'equity', normal_balance: 'credit' }],
    ['PATCH', `/api/accounting/accounts/${IDS.accountA}`, { name: 'Renamed account' }],
    ['PUT', '/api/accounting/invoice-mappings', { receivables_account_id: IDS.accountA, sales_revenue_account_id: IDS.accountB }],
    ['POST', '/api/accounting/tax-profiles', {
      profile_key: 'no-tax', name: 'No tax', tax_rate: '0.00', calculation_method: 'exclusive',
      rounding_method: 'invoice_total', effective_from: '2026-01-01', requires_tax_payable: false
    }],
    ['PATCH', `/api/accounting/tax-profiles/${IDS.taxProfileA}/deactivate`, {}],
    ['POST', '/api/accounting/periods', { name: '2027', starts_on: '2027-01-01', ends_on: '2027-12-31' }],
    ['PATCH', `/api/accounting/periods/${IDS.periodA}/close`, {}],
    ['POST', '/api/accounting/opening-balances', {}],
    ['POST', `/api/accounting/opening-balances/${IDS.periodA}/post`, {}],
    ['POST', `/api/accounting/journals/${IDS.accountA}/reverse`, {
      period_id: IDS.periodA, reversal_date: '2026-08-11', reason: 'Permission test'
    }]
  ]
  for (const [method, route, body] of mutations) {
    const response = await requestServer(method, route, body, { authenticated: false })
    assert.equal(response.status, 401, `${method} ${route} should require a valid bearer token`)
  }
  const invalidIdentityToken = jwt.sign({ role: 'admin' }, JWT_TEST_SECRET)
  const missingIdentity = await requestServer('GET', '/api/accounting/settings', undefined, { token: invalidIdentityToken })
  assert.equal(missingIdentity.status, 401)
})

test('invalid accounting route inputs return documented client errors without writes', async () => {
  const before = {
    settings: structuredClone(state.settings),
    accounts: structuredClone(state.accounts),
    invoiceMappings: structuredClone(state.invoiceMappings),
    taxProfiles: structuredClone(state.taxProfiles),
    periods: structuredClone(state.periods),
    journals: structuredClone(state.journals),
    events: structuredClone(state.events),
    lines: structuredClone(state.lines)
  }
  const invalidRequests = [
    ['GET', '/api/accounting/accounts?active=maybe', undefined, 400],
    ['GET', '/api/accounting/tax-profiles?active=maybe', undefined, 400],
    ['PUT', '/api/accounting/settings', { base_currency: 'KESK' }, 400],
    ['PUT', '/api/accounting/invoice-mappings', {
      receivables_account_id: 'bad-id', sales_revenue_account_id: IDS.accountRevenue
    }, 400],
    ['POST', '/api/accounting/accounts', {
      account_code: '3010', name: 'Invalid type', account_type: 'cash', normal_balance: 'debit'
    }, 400],
    ['PATCH', '/api/accounting/accounts/not-a-uuid', { name: 'Changed' }, 404],
    ['PATCH', `/api/accounting/accounts/${IDS.accountA}`, {}, 400],
    ['POST', '/api/accounting/tax-profiles', {}, 400],
    ['PATCH', '/api/accounting/tax-profiles/not-a-uuid/deactivate', {}, 404],
    ['POST', '/api/accounting/periods', {
      name: 'Bad date', starts_on: '2026-02-30', ends_on: '2026-12-31'
    }, 400],
    ['PATCH', '/api/accounting/periods/not-a-uuid/close', {}, 404],
    ['GET', '/api/accounting/journals?from=2026-02-30', undefined, 400],
    ['GET', '/api/accounting/journals?from=2026-10-01&to=2026-09-30', undefined, 400],
    ['GET', '/api/accounting/journals/not-a-uuid', undefined, 404],
    ['POST', '/api/accounting/journals/not-a-uuid/reverse', {}, 404],
    ['POST', `/api/accounting/journals/${IDS.accountA}/reverse`, {
      period_id: IDS.periodA, reversal_date: '2026-08-11', reason: 'Missing idempotency key'
    }, 400]
  ]

  for (const [method, route, body, status] of invalidRequests) {
    const response = await requestServer(method, route, body)
    assert.equal(response.status, status, `${method} ${route} should return ${status}`)
    assert.equal(typeof response.data?.error, 'string', `${method} ${route} should return a client error body`)
  }

  assert.deepEqual(state.settings, before.settings)
  assert.deepEqual(state.accounts, before.accounts)
  assert.deepEqual(state.invoiceMappings, before.invoiceMappings)
  assert.deepEqual(state.taxProfiles, before.taxProfiles)
  assert.deepEqual(state.periods, before.periods)
  assert.deepEqual(state.journals, before.journals)
  assert.deepEqual(state.events, before.events)
  assert.deepEqual(state.lines, before.lines)
  assert.deepEqual(clientLifecycle, { connections: 0, begins: 0, commits: 0, rollbacks: 0, releases: 0 })
})

test('accounting route database errors return a generic response without internal details', async () => {
  state.failSettingsRead = true
  const logged = []
  const originalConsoleError = console.error
  console.error = (...args) => logged.push(args)
  let response
  try {
    response = await requestServer('GET', '/api/accounting/settings')
  } finally {
    console.error = originalConsoleError
  }

  assert.equal(response.status, 500)
  assert.deepEqual(response.data, { error: 'Failed to fetch accounting settings' })
  assert.equal(JSON.stringify(response.data).includes('INTERNAL_SQL_SENTINEL'), false)
  assert.equal(logged.length, 1)
  assert.equal(logged[0][0], 'Failed to fetch accounting settings')
  assert.equal(logged[0][1].error.code, 'XX999')
  assert.equal(JSON.stringify(logged).includes('INTERNAL_SQL_SENTINEL'), false)
})

test('accounting authorization lookup failures log safe diagnostics without database details', async () => {
  state.failIdentityLookup = true
  const logged = []
  const originalConsoleError = console.error
  console.error = (...args) => logged.push(args)
  let response
  try {
    response = await requestServer('GET', '/api/accounting/settings')
  } finally {
    console.error = originalConsoleError
    state.failIdentityLookup = false
  }

  assert.equal(response.status, 500)
  assert.deepEqual(response.data, { error: 'Failed to verify accounting access' })
  assert.equal(logged.length, 1)
  assert.equal(logged[0][0], 'Accounting authorization lookup failed')
  assert.equal(logged[0][1].error.code, 'XX999')
  assert.equal(JSON.stringify(logged).includes('INTERNAL_SQL_SENTINEL'), false)
})

test('administrator can exercise settings, account, period and reversal permission classes', async () => {
  const settings = await requestServer('PUT', '/api/accounting/settings', { base_currency: 'KES' })
  assert.equal(settings.status, 200)

  const account = await requestServer('POST', '/api/accounting/accounts', {
    account_code: '3010', name: 'Equity', account_type: 'equity', normal_balance: 'credit'
  })
  assert.equal(account.status, 201)
  const updatedAccount = await requestServer('PATCH', `/api/accounting/accounts/${account.data.id}`, { name: 'Owner equity' })
  assert.equal(updatedAccount.status, 200)

  const period = await requestServer('POST', '/api/accounting/periods', {
    name: 'Prior year', starts_on: '2010-01-01', ends_on: '2010-12-31'
  })
  assert.equal(period.status, 201)
  const closed = await requestServer('PATCH', `/api/accounting/periods/${period.data.id}/close`, {
    confirm: true, reason: 'Automated accounting period close test'
  }, { headers: { 'Idempotency-Key': 'period-close-admin-001' } })
  assert.equal(closed.status, 409)
  assert.equal(closed.data.outcome, 'blocked')

  const original = await postJournal(fakePool, {
    tenantId: IDS.tenantA, userId: IDS.userA, idempotencyKey: 'journal-route-reversal', body: journalBody()
  })
  const reversal = await requestServer('POST', `/api/accounting/journals/${original.journal.id}/reverse`, {
    period_id: IDS.periodA, reversal_date: '2026-08-11', reason: 'Administrator correction'
  }, { headers: { 'Idempotency-Key': 'accounting-reversal-route-key' } })
  assert.equal(reversal.status, 201)
  assert.equal(reversal.data.reversal_of_entry_id, original.journal.id)
})

test('accounting detail, period and reversal access hides another tenant records', async () => {
  const foreignJournal = await postJournal(fakePool, {
    tenantId: IDS.tenantB,
    userId: IDS.userB,
    idempotencyKey: 'journal-tenant-b',
    body: journalBody({
      tenant_id: IDS.tenantB,
      accounting_period_id: IDS.periodB,
      source_reference: 'Tenant B only',
      lines: [
        { account_id: IDS.accountForeign, debit: '1', credit: '0' },
        { account_id: IDS.accountForeign, debit: '0', credit: '1' }
      ]
    })
  })
  const foreignAccountBefore = structuredClone(state.accounts.get(IDS.accountForeign))
  const foreignPeriodBefore = structuredClone(state.periods.get(IDS.periodB))
  const foreignJournalBefore = structuredClone(state.journals.get(foreignJournal.journal.id))

  const account = await requestServer('PATCH', `/api/accounting/accounts/${IDS.accountForeign}`, { name: 'Cross-tenant edit' })
  const period = await requestServer('PATCH', `/api/accounting/periods/${IDS.periodB}/close`, {
    confirm: true, reason: 'Cross-tenant close test'
  }, { headers: { 'Idempotency-Key': 'period-close-tenant-test' } })
  const readiness = await requestServer('GET', `/api/accounting/periods/${IDS.periodB}/readiness`)
  const journal = await requestServer('GET', `/api/accounting/journals/${foreignJournal.journal.id}`)
  const settings = await requestServer('GET', '/api/accounting/settings?tenant_id=10000000-0000-4000-8000-000000000002')
  const settingsUpdate = await requestServer('PUT', '/api/accounting/settings', {
    tenant_id: IDS.tenantB, base_currency: 'USD'
  })
  const reversal = await requestServer('POST', `/api/accounting/journals/${foreignJournal.journal.id}/reverse`, {
    period_id: IDS.periodA, reversal_date: '2026-08-11', reason: 'Cross-tenant attempt'
  }, { headers: { 'Idempotency-Key': 'cross-tenant-reversal-key' } })
  const list = await requestServer('GET', '/api/accounting/journals')

  assert.equal(account.status, 404)
  assert.equal(period.status, 404)
  assert.equal(readiness.status, 404)
  assert.equal(journal.status, 404)
  assert.deepEqual(account.data, { error: 'Account not found' })
  assert.deepEqual(period.data, { error: 'Accounting period not found' })
  assert.deepEqual(journal.data, { error: 'Journal entry not found' })
  assert.equal(settings.data.tenant_id, IDS.tenantA)
  assert.equal(settingsUpdate.status, 200)
  assert.equal(state.settings.get(IDS.tenantA).base_currency, 'USD')
  assert.equal(state.settings.get(IDS.tenantB).base_currency, 'KES')
  assert.equal(reversal.status, 404)
  assert.deepEqual(reversal.data, { error: 'Journal entry not found' })
  assert.equal(list.data.some((entry) => entry.id === foreignJournal.journal.id), false)
  assert.equal(state.journals.size, 1)
  assert.equal(state.events.size, 1)
  assert.deepEqual(state.accounts.get(IDS.accountForeign), foreignAccountBefore)
  assert.deepEqual(state.periods.get(IDS.periodB), foreignPeriodBefore)
  assert.deepEqual(state.journals.get(foreignJournal.journal.id), foreignJournalBefore)
})

async function requestServer(method, route, body, {
  tenantId = IDS.tenantA,
  userId,
  role = 'admin',
  authenticated = true,
  token,
  headers: extraHeaders = {}
} = {}) {
  const app = express()
  app.use(express.json())
  app.use('/api/accounting', accountingRouter)
  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const headers = { ...extraHeaders }
    if (authenticated) headers.Authorization = `Bearer ${token || tokenFor({ tenantId, userId, role })}`
    const options = { method, headers }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      options.body = JSON.stringify(body)
    }
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, options)
    const responseText = await response.text()
    let data = responseText || null
    if (responseText && response.headers.get('content-type')?.includes('application/json')) {
      data = JSON.parse(responseText)
    }
    return { status: response.status, data }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

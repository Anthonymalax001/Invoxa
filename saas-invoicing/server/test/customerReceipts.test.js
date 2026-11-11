const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_A = '11111111-1111-4111-8111-111111111111'
const CUSTOMER_A = '22222222-2222-4222-8222-222222222222'
const CUSTOMER_B = '33333333-3333-4333-8333-333333333333'
const CASH_A = '44444444-4444-4444-8444-444444444444'
const AR_A = '55555555-5555-4555-8555-555555555555'
const PERIOD_A = '66666666-6666-4666-8666-666666666666'
const INVOICE_A = '77777777-7777-4777-8777-777777777777'
const INVOICE_B = '88888888-8888-4888-8888-888888888888'
const INVOICE_C = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

let sequence = 1
const uuid = () => `99999999-9999-4999-8999-${String(sequence++).padStart(12, '0')}`

function createFakePool() {
  const state = {
    customers: new Map([
      [CUSTOMER_A, { id: CUSTOMER_A, tenant_id: TENANT_A }],
      [CUSTOMER_B, { id: CUSTOMER_B, tenant_id: TENANT_B }]
    ]),
    invoices: new Map([
      [INVOICE_A, { id: INVOICE_A, invoice_number: 'INV-A', tenant_id: TENANT_A, client_id: CUSTOMER_A, total: '500.00', snapshot_total: '500.00', status: 'sent', due_date: '2026-11-30', invoice_currency: 'KES' }],
      [INVOICE_B, { id: INVOICE_B, invoice_number: 'INV-B', tenant_id: TENANT_A, client_id: CUSTOMER_A, total: '600.00', snapshot_total: '600.00', status: 'overdue', due_date: '2026-10-01', invoice_currency: 'KES' }],
      [INVOICE_C, { id: INVOICE_C, invoice_number: 'INV-C-FOREIGN', tenant_id: TENANT_B, client_id: CUSTOMER_B, total: '250.00', snapshot_total: '250.00', status: 'sent', due_date: '2026-11-30', invoice_currency: 'KES' }]
    ]),
    receipts: new Map(),
    events: [],
    allocations: [],
    batches: new Map(),
    journals: new Map(),
    postAttempts: [],
    stkRequests: [],
    reconciliationAudits: [],
    settings: new Map([[TENANT_A, 'KES']]),
    mappings: new Map([[TENANT_A, { receivables_account_id: AR_A, cash_account_id: CASH_A }]])
  }

  const query = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
    if (normalized.includes('to_regclass(')) return { rows: [{ available: true }], rowCount: 1 }
    if (normalized.includes('from clients where tenant_id = $1 and id = $2')) {
      const customer = state.customers.get(params[1])
      const rows = customer && customer.tenant_id === params[0] ? [{ id: customer.id }] : []
      return { rows, rowCount: rows.length }
    }
    if (normalized.startsWith('select id::text as id, client_id::text as customer_id from invoices')) {
      const rows = params[1].map((id) => state.invoices.get(id))
        .filter((invoice) => invoice && invoice.tenant_id === params[0])
        .map((invoice) => ({ id: invoice.id, customer_id: invoice.client_id }))
      return { rows, rowCount: rows.length }
    }
    if (normalized.startsWith('select request.id, request.invoice_id, request.request_status')) {
      const rows = state.stkRequests.filter((request) => request.tenant_id === params[0] &&
        request.request_status && ['reserved', 'outcome_unknown', 'provider_accepted', 'payment_recorded', 'provider_succeeded'].includes(request.request_status) &&
        state.invoices.get(request.invoice_id)?.client_id === params[1])
        .sort((left, right) => left.invoice_id.localeCompare(right.invoice_id))
      return { rows, rowCount: rows.length }
    }
    if (normalized.startsWith('select request.id from mpesa_stk_initiation_requests request')) {
      const rows = state.stkRequests.filter((request) => request.tenant_id === params[0] &&
        request.provider_checkout_request_id === params[1] && request.request_status === 'provider_succeeded' &&
        request.amount === params[2] && state.invoices.get(request.invoice_id)?.client_id === params[3])
      return { rows: rows.map((request) => ({ id: request.id })), rowCount: rows.length }
    }
    if (normalized.startsWith('select id, request_status, provider_checkout_request_id, payment_id from mpesa_stk_initiation_requests')) {
      const rows = state.stkRequests.filter((request) => request.tenant_id === params[0] && request.invoice_id === params[1] &&
        ['reserved', 'outcome_unknown', 'provider_accepted', 'payment_recorded', 'provider_succeeded'].includes(request.request_status))
      return { rows, rowCount: rows.length }
    }
    if (normalized.startsWith('select 1 from mpesa_payment_reconciliation_audit audit')) {
      const found = state.reconciliationAudits.some((audit) => audit.tenant_id === params[0] &&
        audit.payment_id === params[1] && audit.receipt_id === params[2] && audit.outcome === 'provider_success')
      return { rows: found ? [{ '?column?': 1 }] : [], rowCount: found ? 1 : 0 }
    }
    if (normalized.startsWith('select id, request_status, provider_checkout_request_id, payment_id from mpesa_stk_initiation_requests')) {
      const rows = state.stkRequests.filter((request) => request.tenant_id === params[0] && request.invoice_id === params[1])
      return { rows, rowCount: rows.length }
    }
    if (normalized.startsWith('select customer_id from customer_receipts where tenant_id = $1 and id = $2')) {
      const receipt = state.receipts.get(params[1])
      const rows = receipt && receipt.tenant_id === params[0] ? [{ customer_id: receipt.customer_id }] : []
      return { rows, rowCount: rows.length }
    }
    if (normalized.startsWith('select status from customer_receipts where tenant_id = $1 and id = $2')) {
      const receipt = state.receipts.get(params[1])
      const rows = receipt && receipt.tenant_id === params[0] ? [{ status: receipt.status }] : []
      return { rows, rowCount: rows.length }
    }
    if (normalized.startsWith('insert into customer_receipts')) {
      const [tenant_id, customer_id, amount, currency, payment_method, receipt_reference,
        payment_date, idempotency_key, payload_hash, created_by] = params
      const prior = [...state.receipts.values()].find((item) => item.tenant_id === tenant_id && item.idempotency_key === idempotency_key)
      if (prior) return { rows: [], rowCount: 0 }
      const receipt = {
        id: uuid(), tenant_id, customer_id, amount, currency, payment_method,
        receipt_reference, payment_date, idempotency_key, payload_hash, created_by,
        status: 'pending', created_at: '2026-10-30T00:00:00Z'
      }
      state.receipts.set(receipt.id, receipt)
      return { rows: [receipt], rowCount: 1 }
    }
    if (normalized.includes('from customer_receipts') && normalized.includes('idempotency_key = $2')) {
      const receipt = [...state.receipts.values()].find((item) => item.tenant_id === params[0] && item.idempotency_key === params[1])
      const rows = receipt ? [{ ...receipt }] : []
      return { rows, rowCount: rows.length }
    }
    if (normalized.startsWith('select * from customer_receipts where tenant_id = $1 and id = $2')) {
      const receipt = state.receipts.get(params[1])
      const rows = receipt && receipt.tenant_id === params[0] ? [{ ...receipt }] : []
      return { rows, rowCount: rows.length }
    }
    if (normalized.startsWith('insert into customer_receipt_events')) {
      state.events.push({ tenant_id: params[0], receipt_id: params[1], event_type: params[2], actor_id: params[3], details: JSON.parse(params[4]) })
      return { rows: [], rowCount: 1 }
    }
    if (normalized.startsWith('select base_currency from accounting_settings')) {
      const currency = state.settings.get(params[0])
      const rows = currency ? [{ base_currency: currency }] : []
      return { rows, rowCount: rows.length }
    }
    if (normalized.includes('from accounting_invoice_mappings mapping')) {
      const mapping = state.mappings.get(params[0])
      const rows = mapping && mapping.cash_account_id === params[1]
        ? [{ receivables_account_id: mapping.receivables_account_id, cash_type: 'asset', cash_normal_balance: 'debit', cash_active: true, receivable_type: 'asset', receivable_normal_balance: 'debit', receivable_active: true }]
        : []
      return { rows, rowCount: rows.length }
    }
    if (normalized.startsWith('update customer_receipts') && normalized.includes("set status = 'verified'")) {
      const [verification_idempotency_key, verification_payload_hash, cash_account_id, accounting_period_id,
        journal_entry_id, verified_by, tenant_id, id] = params
      const receipt = state.receipts.get(id)
      if (!receipt || receipt.tenant_id !== tenant_id || receipt.status !== 'pending') return { rows: [], rowCount: 0 }
      Object.assign(receipt, { status: 'verified', verification_idempotency_key, verification_payload_hash,
        cash_account_id, accounting_period_id, journal_entry_id, verified_by, verified_at: '2026-10-30T00:00:00Z' })
      return { rows: [{ ...receipt }], rowCount: 1 }
    }
    if (normalized.startsWith('update customer_receipts') && normalized.includes("set status = 'failed'")) {
      const [failure_reason, failed_by, tenant_id, id] = params
      const receipt = state.receipts.get(id)
      if (!receipt || receipt.tenant_id !== tenant_id || receipt.status !== 'pending') return { rows: [], rowCount: 0 }
      Object.assign(receipt, { status: 'failed', failure_reason, failed_by, failed_at: '2026-10-30T00:00:00Z' })
      return { rows: [{ ...receipt }], rowCount: 1 }
    }
    if (normalized.startsWith('update customer_receipts') && normalized.includes("set status = 'reversed'")) {
      const [reversal_idempotency_key, reversal_payload_hash, reversal_journal_entry_id,
        reversal_reason, reversed_by, tenant_id, id] = params
      const receipt = state.receipts.get(id)
      if (!receipt || receipt.tenant_id !== tenant_id || receipt.status !== 'verified') return { rows: [], rowCount: 0 }
      Object.assign(receipt, { status: 'reversed', reversal_idempotency_key, reversal_payload_hash,
        reversal_journal_entry_id, reversal_reason, reversed_by, reversed_at: '2026-10-30T00:00:00Z' })
      return { rows: [{ ...receipt }], rowCount: 1 }
    }
    if (normalized.startsWith("update invoices set status = 'paid'")) {
      const invoice = state.invoices.get(params[1])
      if (!invoice || invoice.tenant_id !== params[0] || !['sent', 'overdue'].includes(invoice.status)) return { rows: [], rowCount: 0 }
      invoice.status = 'paid'
      return { rows: [{ id: invoice.id }], rowCount: 1 }
    }
    if (normalized.startsWith('select invoice.id::text as id from invoices invoice where invoice.tenant_id = $1 and exists')) {
      const rows = [...new Set(state.allocations.filter((item) => item.tenant_id === params[0] && item.receipt_id === params[1]).map((item) => item.invoice_id))]
        .sort().map((id) => ({ id }))
      return { rows, rowCount: rows.length }
    }
    if (normalized.startsWith('update invoices invoice set status = case when invoice.due_date')) {
      const [tenant_id, ids] = params
      for (const id of ids) {
        const invoice = state.invoices.get(id)
        if (!invoice || invoice.tenant_id !== tenant_id || invoice.status !== 'paid') continue
        const activeAllocated = state.allocations.filter((item) => item.tenant_id === tenant_id && item.invoice_id === id)
          .filter((item) => state.receipts.get(item.receipt_id)?.status === 'verified')
          .reduce((sum, item) => sum + BigInt(item.amount.replace('.', '')), 0n)
        if (BigInt(invoice.total.replace('.', '')) > activeAllocated) {
          invoice.status = invoice.due_date && invoice.due_date < '2026-10-30' ? 'overdue' : 'sent'
        }
      }
      return { rows: [], rowCount: ids.length }
    }
    if (normalized.startsWith('select * from accounting_journal_entries')) {
      const journal = state.journals.get(params[1])
      const rows = journal && journal.tenant_id === params[0] ? [{ ...journal }] : []
      return { rows, rowCount: rows.length }
    }
    if (normalized.startsWith('select line_number, account_id, description, debit, credit')) {
      const journal = state.journals.get(params[1])
      const rows = journal && journal.tenant_id === params[0] ? journal.lines : []
      return { rows: rows.map((line) => ({ ...line })), rowCount: rows.length }
    }
    if (normalized.includes('from customer_receipt_allocation_batches') && normalized.includes('idempotency_key = $2')) {
      const batch = state.batches.get(`${params[0]}:${params[1]}`)
      const rows = batch ? [{ ...batch }] : []
      return { rows, rowCount: rows.length }
    }
    if (normalized.startsWith('select id::text as id, client_id::text as customer_id from invoices')) {
      const rows = params[1].map((id) => state.invoices.get(id))
        .filter((invoice) => invoice && invoice.tenant_id === params[0])
        .map((invoice) => ({ id: invoice.id, customer_id: invoice.client_id }))
      return { rows, rowCount: rows.length }
    }
    if (normalized.startsWith('select allocation.id, allocation.invoice_id, allocation.amount::text as amount')) {
      const batch_id = params[1]
      const rows = state.allocations.filter((item) => item.tenant_id === params[0] && item.batch_id === batch_id)
        .map((item) => ({ ...item }))
      return { rows, rowCount: rows.length }
    }
    if (normalized.startsWith('select i.id, i.invoice_number, i.client_id, i.total::text as total')) {
      const rows = params[1].map((id) => state.invoices.get(id))
        .filter((invoice) => invoice && invoice.tenant_id === params[0])
        .map((invoice) => ({ ...invoice }))
      return { rows, rowCount: rows.length }
    }
    if (normalized.startsWith('select coalesce(sum(allocation.amount), 0)::text as total')) {
      const receipt_id = params[1]
      const total = state.allocations.filter((item) => item.tenant_id === params[0] && item.receipt_id === receipt_id)
        .filter((item) => state.receipts.get(item.receipt_id)?.status === 'verified')
        .reduce((sum, item) => sum + BigInt(item.amount.replace('.', '')), 0n)
      return { rows: [{ total: `${total / 100n}.${String(total % 100n).padStart(2, '0')}` }], rowCount: 1 }
    }
    if (normalized.startsWith('select allocation.invoice_id, coalesce(sum(allocation.amount), 0)::text as allocated')) {
      const invoiceIds = params[1]
      const totals = new Map()
      for (const item of state.allocations) {
        if (item.tenant_id !== params[0] || !invoiceIds.includes(item.invoice_id) || state.receipts.get(item.receipt_id)?.status !== 'verified') continue
        totals.set(item.invoice_id, (totals.get(item.invoice_id) || 0n) + BigInt(item.amount.replace('.', '')))
      }
      const rows = [...totals.entries()].map(([invoice_id, total]) => ({
        invoice_id, allocated: `${total / 100n}.${String(total % 100n).padStart(2, '0')}`
      }))
      return { rows, rowCount: rows.length }
    }
    if (normalized.startsWith('insert into customer_receipt_allocation_batches')) {
      const [tenant_id, receipt_id, idempotency_key, payload_hash, created_by] = params
      const key = `${tenant_id}:${idempotency_key}`
      if (state.batches.has(key)) return { rows: [], rowCount: 0 }
      const batch = { id: uuid(), tenant_id, receipt_id, idempotency_key, payload_hash, created_by }
      state.batches.set(key, batch)
      return { rows: [{ id: batch.id }], rowCount: 1 }
    }
    if (normalized.startsWith('insert into customer_receipt_allocations')) {
      const [tenant_id, receipt_id, batch_id, invoice_id, customer_id, amount, created_by] = params
      const receipt = state.receipts.get(receipt_id)
      const invoice = state.invoices.get(invoice_id)
      if (!receipt || receipt.status !== 'verified' || receipt.tenant_id !== tenant_id || receipt.customer_id !== customer_id) {
        const error = new Error('Only verified receipts for the same customer may be allocated')
        error.code = '23514'
        throw error
      }
      if (!invoice || invoice.tenant_id !== tenant_id || invoice.client_id !== customer_id) {
        const error = new Error('Invoice customer/tenant mismatch')
        error.code = '23514'
        throw error
      }
      const amountCents = BigInt(amount.replace('.', ''))
      const receiptAllocated = state.allocations.filter((item) => item.receipt_id === receipt_id && state.receipts.get(item.receipt_id)?.status === 'verified')
        .reduce((sum, item) => sum + BigInt(item.amount.replace('.', '')), 0n)
      const invoiceAllocated = state.allocations.filter((item) => item.invoice_id === invoice_id && state.receipts.get(item.receipt_id)?.status === 'verified')
        .reduce((sum, item) => sum + BigInt(item.amount.replace('.', '')), 0n)
      if (receiptAllocated + amountCents > BigInt(receipt.amount.replace('.', ''))) {
        const error = new Error('Allocation exceeds the available receipt balance')
        error.code = '23514'
        throw error
      }
      if (invoiceAllocated + amountCents > BigInt(invoice.total.replace('.', ''))) {
        const error = new Error('Allocation exceeds the invoice outstanding balance')
        error.code = '23514'
        throw error
      }
      const allocation = { id: uuid(), tenant_id, receipt_id, batch_id, invoice_id,
        customer_id, amount, created_by, invoice_number: invoice.invoice_number }
      state.allocations.push(allocation)
      return { rows: [{ id: allocation.id, invoice_id, amount }], rowCount: 1 }
    }
    throw new Error(`Unhandled fake query: ${normalized.slice(0, 120)}`)
  }

  const pool = {
    state,
    async query(sql, params) { return query(sql, params) },
    async withTransaction(work) {
      const before = structuredClone(state)
      try {
        return await work({ query })
      } catch (error) {
        for (const key of Object.keys(state)) state[key] = before[key]
        throw error
      }
    }
  }
  return pool
}

const accountingPath = require.resolve('../src/services/accounting')
const originalAccountingModule = require.cache[accountingPath]
const fakeAccounting = {
  withTransaction: (pool, work) => pool.withTransaction(work),
  async assertDateNotInClosedPeriod() {},
  async postJournal(_pool, request, { client }) {
    assert.ok(client && typeof client.query === 'function', 'receipt posting must reuse the receipt transaction')
    const lines = request.body.lines.map((line, index) => ({ line_number: index + 1, ...line }))
    const debit = lines.reduce((sum, line) => sum + Number(line.debit), 0)
    const credit = lines.reduce((sum, line) => sum + Number(line.credit), 0)
    assert.equal(debit, credit, 'receipt journal must balance')
    client.state.postAttempts.push(request)
    const id = uuid()
    const journal = { id, tenant_id: request.tenantId, status: 'posted', source_type: request.body.source_type }
    client.state.journals.set(id, { ...journal, lines })
    return { journal, lines, replayed: false }
  },
  async reverseJournal(_pool, request, { client }) {
    assert.ok(client && typeof client.query === 'function', 'receipt reversal must reuse the receipt transaction')
    const id = uuid()
    const journal = { id, tenant_id: request.tenantId, status: 'posted', source_type: 'journal_reversal' }
    client.state.journals.set(id, { ...journal, lines: [] })
    return { journal, lines: [], replayed: false }
  }
}
const mockedAccounting = new Module(accountingPath)
mockedAccounting.filename = accountingPath
mockedAccounting.loaded = true
mockedAccounting.exports = fakeAccounting
require.cache[accountingPath] = mockedAccounting
const receipts = require('../src/services/customerReceipts')

function setup() {
  sequence = 1
  const pool = createFakePool()
  // Attach state to transaction clients for the mocked posting service.
  const originalWithTransaction = pool.withTransaction.bind(pool)
  pool.withTransaction = async (work) => originalWithTransaction((client) => {
    client.state = pool.state
    return work(client)
  })
  return pool
}

async function record(pool, { amount = '100.00', currency = 'KES', customerId = CUSTOMER_A, key = 'receipt-create-001' } = {}) {
  return receipts.createCustomerReceipt(pool, {
    tenantId: TENANT_A, userId: USER_A, idempotencyKey: key,
    body: { customer_id: customerId, amount, currency, payment_method: 'bank_transfer', receipt_reference: `REF-${key}`, payment_date: '2026-10-30' }
  })
}

async function verify(pool, receiptId, { key = 'receipt-verify-001', cashAccountId = CASH_A } = {}) {
  return receipts.verifyCustomerReceipt(pool, {
    tenantId: TENANT_A, userId: USER_A, receiptId, idempotencyKey: key,
    body: { cash_account_id: cashAccountId, accounting_period_id: PERIOD_A }
  })
}

test('receipt creation is pending and idempotent; tenant identity comes from the caller', async () => {
  const pool = setup()
  const first = await record(pool)
  const replay = await record(pool)
  assert.equal(first.receipt.status, 'pending')
  assert.equal(replay.replayed, true)
  assert.equal(replay.receipt.id, first.receipt.id)
  assert.equal(pool.state.receipts.size, 1)
  assert.equal(pool.state.events.filter((event) => event.event_type === 'recorded').length, 1)
  await assert.rejects(() => receipts.createCustomerReceipt(pool, {
    tenantId: TENANT_A, userId: USER_A, idempotencyKey: 'receipt-create-001',
    body: { customer_id: CUSTOMER_A, amount: '101.00', currency: 'KES', payment_method: 'bank_transfer', payment_date: '2026-10-30' }
  }), { statusCode: 409 })
  await assert.rejects(() => record(pool, { customerId: CUSTOMER_B, key: 'cross-tenant-customer-001' }), { statusCode: 404 })
})

test('provider-verified receipt audit stores only the query source and checkout identifier', async () => {
  const pool = setup()
  pool.state.invoices.set(INVOICE_A, {
    ...pool.state.invoices.get(INVOICE_A), total: '100.00', snapshot_total: '100.00'
  })
  pool.state.stkRequests.push({
    id: 'stk-request-001', tenant_id: TENANT_A, invoice_id: INVOICE_A,
    request_status: 'provider_succeeded', provider_checkout_request_id: 'ws_CO_audit_123',
    payment_id: 'legacy-payment-001', amount: '100.00'
  })
  const result = await receipts.createCustomerReceipt(pool, {
    tenantId: TENANT_A,
    userId: USER_A,
    idempotencyKey: 'mpesa-audit-receipt-001',
    body: {
      customer_id: CUSTOMER_A, amount: '100.00', currency: 'KES', payment_method: 'mpesa',
      receipt_reference: 'ws_CO_audit_123', payment_date: '2026-10-30'
    },
    providerEvidence: { source: 'daraja_stk_query', checkout_request_id: 'ws_CO_audit_123' }
  })
  assert.equal(result.receipt.status, 'pending')
  const event = pool.state.events.find((item) => item.receipt_id === result.receipt.id)
  assert.deepEqual(event.details, {
    amount: '100.00', currency: 'KES', payment_method: 'mpesa',
    verification_source: 'daraja_stk_query', checkout_request_id: 'ws_CO_audit_123'
  })
  await assert.rejects(() => receipts.createCustomerReceipt(pool, {
    tenantId: TENANT_A, userId: USER_A, idempotencyKey: 'mpesa-audit-receipt-002',
    body: {
      customer_id: CUSTOMER_A, amount: '100.00', currency: 'KES', payment_method: 'mpesa',
      receipt_reference: 'ws_CO_audit_124', payment_date: '2026-10-30'
    },
    providerEvidence: { source: 'untrusted', checkout_request_id: 'ws_CO_audit_124' }
  }), { statusCode: 400 })
})

test('manual receipt creation is held while the customer has an outstanding M-Pesa request', async () => {
  const pool = setup()
  pool.state.stkRequests.push({
    id: 'stk-request-active', tenant_id: TENANT_A, invoice_id: INVOICE_A,
    request_status: 'outcome_unknown', provider_checkout_request_id: null, payment_id: null
  })
  await assert.rejects(record(pool), (error) => error.statusCode === 409 && /M-Pesa request/.test(error.message))
  assert.equal(pool.state.receipts.size, 0)
})

test('manual receipt verification cannot compete with a pending M-Pesa reservation', async () => {
  const pool = setup()
  const created = await record(pool)
  pool.state.stkRequests.push({
    id: 'stk-request-active', tenant_id: TENANT_A, invoice_id: INVOICE_A,
    request_status: 'payment_recorded', provider_checkout_request_id: 'ws_CO_active_1',
    payment_id: 'legacy-payment-active'
  })
  await assert.rejects(verify(pool, created.receipt.id), (error) => error.statusCode === 409 && /outstanding/.test(error.message))
  assert.equal(pool.state.receipts.get(created.receipt.id).status, 'pending')
  assert.equal(pool.state.postAttempts.length, 0)
})

test('M-Pesa provider-confirmed receipt remains reserved but follows ordinary verification and allocation', async () => {
  const pool = setup()
  const checkoutId = 'ws_CO_success_001'
  pool.state.invoices.set(INVOICE_A, {
    ...pool.state.invoices.get(INVOICE_A), total: '100.00', snapshot_total: '100.00'
  })
  pool.state.stkRequests.push({
    id: 'stk-request-success', tenant_id: TENANT_A, invoice_id: INVOICE_A,
    request_status: 'provider_succeeded', provider_checkout_request_id: checkoutId,
    payment_id: 'legacy-payment-success', amount: '100.00'
  })
  const created = await receipts.createCustomerReceipt(pool, {
    tenantId: TENANT_A, userId: USER_A, idempotencyKey: 'mpesa-success-receipt-001',
    body: { customer_id: CUSTOMER_A, amount: '100.00', currency: 'KES', payment_method: 'mpesa', receipt_reference: checkoutId, payment_date: '2026-10-30' },
    providerEvidence: { source: 'daraja_stk_query', checkout_request_id: checkoutId }
  })
  pool.state.reconciliationAudits.push({
    tenant_id: TENANT_A, payment_id: 'legacy-payment-success', receipt_id: created.receipt.id,
    outcome: 'provider_success'
  })
  const verified = await verify(pool, created.receipt.id)
  assert.equal(verified.receipt.status, 'verified')
  const allocated = await receipts.allocateCustomerReceipt(pool, {
    tenantId: TENANT_A, userId: USER_A, receiptId: created.receipt.id,
    idempotencyKey: 'mpesa-success-alloc-001',
    body: { allocations: [{ invoice_id: INVOICE_A, amount: '100.00' }] }
  })
  assert.equal(allocated.allocations.length, 1)
  assert.equal(pool.state.invoices.get(INVOICE_A).status, 'paid')
  assert.equal(pool.state.stkRequests[0].request_status, 'provider_succeeded')
})

test('a second payment channel cannot allocate an invoice already reserved by STK Push', async () => {
  const pool = setup()
  const created = await record(pool, { amount: '100.00' })
  await verify(pool, created.receipt.id)
  pool.state.stkRequests.push({
    id: 'stk-request-active', tenant_id: TENANT_A, invoice_id: INVOICE_A,
    request_status: 'payment_recorded', provider_checkout_request_id: 'ws_CO_active_2',
    payment_id: 'legacy-payment-active', amount: '100.00'
  })
  await assert.rejects(receipts.allocateCustomerReceipt(pool, {
    tenantId: TENANT_A, userId: USER_A, receiptId: created.receipt.id,
    idempotencyKey: 'manual-alloc-race-001',
    body: { allocations: [{ invoice_id: INVOICE_A, amount: '100.00' }] }
  }), (error) => error.statusCode === 409 && /outstanding M-Pesa prompt/.test(error.message))
  assert.equal(pool.state.allocations.length, 0)
})

test('verified receipt posts one balanced cash debit and receivables credit; retries do not duplicate it', async () => {
  const pool = setup()
  const created = await record(pool, { amount: '250.50' })
  const result = await verify(pool, created.receipt.id)
  assert.equal(result.receipt.status, 'verified')
  assert.equal(pool.state.postAttempts.length, 1)
  assert.deepEqual(result.lines.map(({ account_id, debit, credit }) => ({ account_id, debit, credit })), [
    { account_id: CASH_A, debit: '250.50', credit: '0.00' },
    { account_id: AR_A, debit: '0.00', credit: '250.50' }
  ])
  assert.equal(result.lines.reduce((sum, line) => sum + Number(line.debit), 0), 250.5)
  assert.equal(result.lines.reduce((sum, line) => sum + Number(line.credit), 0), 250.5)
  const replay = await verify(pool, created.receipt.id)
  assert.equal(replay.replayed, true)
  assert.equal(replay.journal.id, result.journal.id)
  assert.equal(pool.state.postAttempts.length, 1)
  await assert.rejects(() => verify(pool, created.receipt.id, { key: 'receipt-verify-different-001' }), { statusCode: 409 })
})

test('verification replay remains idempotent after a later M-Pesa reservation', async () => {
  const pool = setup()
  const created = await record(pool, { amount: '100.00', key: 'receipt-create-replay-reservation-001' })
  const verified = await verify(pool, created.receipt.id, { key: 'receipt-verify-replay-reservation-001' })
  pool.state.stkRequests.push({
    id: 'stk-request-later', tenant_id: TENANT_A, invoice_id: INVOICE_A,
    request_status: 'outcome_unknown', provider_checkout_request_id: null, payment_id: null
  })
  const replay = await verify(pool, created.receipt.id, { key: 'receipt-verify-replay-reservation-001' })
  assert.equal(replay.replayed, true)
  assert.equal(replay.journal.id, verified.journal.id)
  assert.equal(pool.state.postAttempts.length, 1)
})

test('receipt allocation supports partial and multi-invoice allocations and multiple receipts per invoice', async () => {
  const pool = setup()
  const first = await record(pool, { amount: '150.00', key: 'receipt-create-multi-001' })
  await verify(pool, first.receipt.id, { key: 'receipt-verify-multi-001' })
  const firstAllocation = await receipts.allocateCustomerReceipt(pool, {
    tenantId: TENANT_A, userId: USER_A, receiptId: first.receipt.id, idempotencyKey: 'receipt-allocate-multi-001',
    body: { allocations: [{ invoice_id: INVOICE_A, amount: '60.00' }, { invoice_id: INVOICE_B, amount: '90.00' }] }
  })
  assert.equal(firstAllocation.allocations.length, 2)
  assert.equal(firstAllocation.replayed, false)

  const second = await record(pool, { amount: '350.00', key: 'receipt-create-second-001' })
  await verify(pool, second.receipt.id, { key: 'receipt-verify-second-001' })
  const secondAllocation = await receipts.allocateCustomerReceipt(pool, {
    tenantId: TENANT_A, userId: USER_A, receiptId: second.receipt.id, idempotencyKey: 'receipt-allocate-second-001',
    body: { allocations: [{ invoice_id: INVOICE_A, amount: '350.00' }] }
  })
  assert.equal(secondAllocation.allocations.length, 1)
  assert.equal(pool.state.allocations.filter((item) => item.invoice_id === INVOICE_A).length, 2)
})

test('allocation rejects insufficient receipt balance, invoice over-allocation, and cross-tenant invoices', async () => {
  const pool = setup()
  const created = await record(pool, { amount: '100.00', key: 'receipt-create-limits-001' })
  await verify(pool, created.receipt.id, { key: 'receipt-verify-limits-001' })
  await assert.rejects(() => receipts.allocateCustomerReceipt(pool, {
    tenantId: TENANT_A, userId: USER_A, receiptId: created.receipt.id, idempotencyKey: 'receipt-allocate-insufficient-001',
    body: { allocations: [{ invoice_id: INVOICE_A, amount: '100.01' }] }
  }), { statusCode: 409, message: 'Allocation exceeds the available receipt balance' })

  const invoice = pool.state.invoices.get(INVOICE_A)
  invoice.total = '40.00'
  invoice.snapshot_total = '40.00'
  const tooLarge = await record(pool, { amount: '50.00', key: 'receipt-create-outstanding-001' })
  await verify(pool, tooLarge.receipt.id, { key: 'receipt-verify-outstanding-001' })
  await assert.rejects(() => receipts.allocateCustomerReceipt(pool, {
    tenantId: TENANT_A, userId: USER_A, receiptId: tooLarge.receipt.id, idempotencyKey: 'receipt-allocate-outstanding-001',
    body: { allocations: [{ invoice_id: INVOICE_A, amount: '40.01' }] }
  }), { statusCode: 409, message: 'Allocation exceeds the invoice outstanding balance' })
  await assert.rejects(() => receipts.allocateCustomerReceipt(pool, {
    tenantId: TENANT_A, userId: USER_A, receiptId: tooLarge.receipt.id, idempotencyKey: 'receipt-allocate-foreign-001',
    body: { allocations: [{ invoice_id: INVOICE_C, amount: '1.00' }] }
  }), { statusCode: 404 })
  assert.equal(pool.state.allocations.length, 0)
})

test('receipt allocations are idempotent and do not let a second receipt exceed invoice outstanding', async () => {
  const pool = setup()
  const first = await record(pool, { amount: '300.00', key: 'receipt-create-first-limit-001' })
  await verify(pool, first.receipt.id, { key: 'receipt-verify-first-limit-001' })
  const request = {
    tenantId: TENANT_A, userId: USER_A, receiptId: first.receipt.id, idempotencyKey: 'receipt-allocate-first-limit-001',
    body: { allocations: [{ invoice_id: INVOICE_A, amount: '300.00' }] }
  }
  const allocated = await receipts.allocateCustomerReceipt(pool, request)
  const replay = await receipts.allocateCustomerReceipt(pool, request)
  assert.equal(replay.replayed, true)
  assert.equal(pool.state.allocations.length, 1)
  await assert.rejects(() => receipts.allocateCustomerReceipt(pool, {
    ...request,
    body: { allocations: [{ invoice_id: INVOICE_A, amount: '299.00' }] }
  }), { statusCode: 409 })

  const second = await record(pool, { amount: '250.00', key: 'receipt-create-second-limit-001' })
  await verify(pool, second.receipt.id, { key: 'receipt-verify-second-limit-001' })
  const completed = await receipts.allocateCustomerReceipt(pool, {
    tenantId: TENANT_A, userId: USER_A, receiptId: second.receipt.id, idempotencyKey: 'receipt-allocate-second-exact-001',
    body: { allocations: [{ invoice_id: INVOICE_A, amount: '200.00' }] }
  })
  assert.equal(completed.allocations[0].amount, '200.00')
  assert.equal(pool.state.invoices.get(INVOICE_A).status, 'paid')
  const third = await record(pool, { amount: '1.00', key: 'receipt-create-third-limit-001' })
  await verify(pool, third.receipt.id, { key: 'receipt-verify-third-limit-001' })
  await assert.rejects(() => receipts.allocateCustomerReceipt(pool, {
    tenantId: TENANT_A, userId: USER_A, receiptId: third.receipt.id, idempotencyKey: 'receipt-allocate-third-limit-001',
    body: { allocations: [{ invoice_id: INVOICE_A, amount: '0.01' }] }
  }), { statusCode: 409, message: 'Allocation exceeds the invoice outstanding balance' })
  assert.equal(allocated.allocations[0].invoice_id, INVOICE_A)
})

test('currency mismatches fail before posting and failed receipts cannot be verified', async () => {
  const pool = setup()
  const usdReceipt = await record(pool, { amount: '10.00', currency: 'USD', key: 'receipt-create-usd-001' })
  await assert.rejects(() => verify(pool, usdReceipt.receipt.id, { key: 'receipt-verify-usd-001' }), { statusCode: 409 })
  assert.equal(pool.state.receipts.get(usdReceipt.receipt.id).status, 'pending')

  const invoiceCurrencyReceipt = await record(pool, { key: 'receipt-create-invoice-currency-001' })
  await verify(pool, invoiceCurrencyReceipt.receipt.id, { key: 'receipt-verify-invoice-currency-001' })
  pool.state.invoices.get(INVOICE_A).invoice_currency = 'USD'
  await assert.rejects(() => receipts.allocateCustomerReceipt(pool, {
    tenantId: TENANT_A, userId: USER_A, receiptId: invoiceCurrencyReceipt.receipt.id,
    idempotencyKey: 'receipt-allocate-invoice-currency-001',
    body: { allocations: [{ invoice_id: INVOICE_A, amount: '10.00' }] }
  }), { statusCode: 409 })
  assert.equal(pool.state.allocations.length, 0)

  const failed = await record(pool, { key: 'receipt-create-fail-001' })
  const marked = await receipts.failCustomerReceipt(pool, {
    tenantId: TENANT_A, userId: USER_A, receiptId: failed.receipt.id, body: { reason: 'Bank transfer was not received' }
  })
  assert.equal(marked.receipt.status, 'failed')
  const failedReplay = await receipts.failCustomerReceipt(pool, {
    tenantId: TENANT_A, userId: USER_A, receiptId: failed.receipt.id, body: { reason: 'Bank transfer was not received' }
  })
  assert.equal(failedReplay.replayed, true)
  await assert.rejects(() => verify(pool, failed.receipt.id, { key: 'receipt-verify-fail-001' }), { statusCode: 409 })
  assert.equal(pool.state.journals.size, 1)
})

test('reversals retain the receipt and use the caller transaction; duplicate reversal is idempotent', async () => {
  const pool = setup()
  const created = await record(pool, { amount: '500.00', key: 'receipt-create-reverse-001' })
  await verify(pool, created.receipt.id, { key: 'receipt-verify-reverse-001' })
  await receipts.allocateCustomerReceipt(pool, {
    tenantId: TENANT_A, userId: USER_A, receiptId: created.receipt.id,
    idempotencyKey: 'receipt-allocate-reverse-001',
    body: { allocations: [{ invoice_id: INVOICE_A, amount: '500.00' }] }
  })
  assert.equal(pool.state.invoices.get(INVOICE_A).status, 'paid')
  const request = {
    tenantId: TENANT_A, userId: USER_A, receiptId: created.receipt.id,
    idempotencyKey: 'receipt-reverse-request-001',
    body: { accounting_period_id: PERIOD_A, reversal_date: '2026-10-30', reason: 'Bank statement correction' }
  }
  const reversed = await receipts.reverseCustomerReceipt(pool, request)
  assert.equal(reversed.receipt.status, 'reversed')
  pool.state.stkRequests.push({
    id: 'stk-request-after-reversal', tenant_id: TENANT_A, invoice_id: INVOICE_A,
    request_status: 'outcome_unknown', provider_checkout_request_id: null, payment_id: null
  })
  const replay = await receipts.reverseCustomerReceipt(pool, request)
  assert.equal(replay.replayed, true)
  assert.equal(replay.journal.id, reversed.journal.id)
  assert.equal(pool.state.receipts.get(created.receipt.id).status, 'reversed')
  assert.equal(pool.state.invoices.get(INVOICE_A).status, 'sent')
  assert.equal(pool.state.events.filter((event) => event.event_type === 'reversed').length, 1)
})

test('receipt reversal cannot release or bypass an active invoice reservation', async () => {
  const pool = setup()
  const created = await record(pool, { amount: '500.00', key: 'receipt-create-reverse-active-001' })
  await verify(pool, created.receipt.id, { key: 'receipt-verify-reverse-active-001' })
  await receipts.allocateCustomerReceipt(pool, {
    tenantId: TENANT_A, userId: USER_A, receiptId: created.receipt.id,
    idempotencyKey: 'receipt-allocate-reverse-active-001',
    body: { allocations: [{ invoice_id: INVOICE_A, amount: '500.00' }] }
  })
  pool.state.stkRequests.push({
    id: 'stk-request-active', tenant_id: TENANT_A, invoice_id: INVOICE_A,
    request_status: 'payment_recorded', provider_checkout_request_id: 'ws_CO_active_3',
    payment_id: 'legacy-payment-active', amount: '500.00'
  })
  await assert.rejects(receipts.reverseCustomerReceipt(pool, {
    tenantId: TENANT_A, userId: USER_A, receiptId: created.receipt.id,
    idempotencyKey: 'receipt-reverse-active-001',
    body: { accounting_period_id: PERIOD_A, reversal_date: '2026-10-31', reason: 'Correction after review' }
  }), (error) => error.statusCode === 409 && /outstanding M-Pesa prompt/.test(error.message))
  assert.equal(pool.state.receipts.get(created.receipt.id).status, 'verified')
  assert.equal(pool.state.invoices.get(INVOICE_A).status, 'paid')
})

test.after(() => {
  if (originalAccountingModule) require.cache[accountingPath] = originalAccountingModule
  else delete require.cache[accountingPath]
})

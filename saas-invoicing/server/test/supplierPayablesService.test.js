const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_TENANT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SUPPLIER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const MAKER = '11111111-1111-4111-8111-111111111111'
const CHECKER = '22222222-2222-4222-8222-222222222222'
const BILL_ID = '33333333-3333-4333-8333-333333333333'
const PAYMENT_ID = '44444444-4444-4444-8444-444444444444'
const PERIOD_ID = '55555555-5555-4555-8555-555555555555'
const EXPENSE_ACCOUNT = '66666666-6666-4666-8666-666666666666'
const ASSET_ACCOUNT = '77777777-7777-4777-8777-777777777777'
const PAYABLE_ACCOUNT = '88888888-8888-4888-8888-888888888888'
const CASH_ACCOUNT = '99999999-9999-4999-8999-999999999999'

const accountingPath = require.resolve('../src/services/accounting')
const supplierServicePath = require.resolve('../src/services/supplierPayables')
const originalAccountingModule = require.cache[accountingPath]
const originalSupplierServiceModule = require.cache[supplierServicePath]
const accounting = require(accountingPath)

function amountCents(value) {
  const [whole, fraction = ''] = String(value).split('.')
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2))
}

function normalizedSql(sql) {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase()
}

function rows(value = []) {
  return { rows: value, rowCount: value.length }
}

function mutation(rowCount = 1) {
  return { rows: [], rowCount }
}

function makeState({ approvedBill = false } = {}) {
  const bill = {
    id: BILL_ID,
    tenant_id: TENANT,
    supplier_id: SUPPLIER,
    bill_number: 'BILL-000001',
    supplier_invoice_number: 'SUP-INV-001',
    bill_date: '2026-10-30',
    due_date: '2026-11-30',
    currency: 'KES',
    subtotal: '100.00',
    tax_amount: '0.00',
    total: '100.00',
    notes: null,
    status: approvedBill ? 'approved' : 'submitted',
    created_by: MAKER,
    payable_account_id: approvedBill ? PAYABLE_ACCOUNT : null,
    journal_entry_id: approvedBill ? 'journal-existing-bill' : null,
    approval_payload_hash: null,
    approved_by: approvedBill ? CHECKER : null,
    approved_at: approvedBill ? '2026-10-30T10:00:00.000Z' : null
  }
  const state = {
    bills: [bill],
    billLines: [
      { id: 'line-1', tenant_id: TENANT, supplier_bill_id: BILL_ID, line_number: 1,
        description: 'Office supplies', line_subtotal: '60.00', tax_amount: '0.00',
        account_id: EXPENSE_ACCOUNT, account_code: '6100', account_name: 'Office expense' },
      { id: 'line-2', tenant_id: TENANT, supplier_bill_id: BILL_ID, line_number: 2,
        description: 'Small equipment', line_subtotal: '40.00', tax_amount: '0.00',
        account_id: ASSET_ACCOUNT, account_code: '1500', account_name: 'Equipment' }
    ],
    billEvents: [],
    payments: [],
    allocations: [],
    paymentEvents: [],
    accounts: [
      { id: EXPENSE_ACCOUNT, tenant_id: TENANT, account_type: 'expense', normal_balance: 'debit', is_active: true },
      { id: ASSET_ACCOUNT, tenant_id: TENANT, account_type: 'asset', normal_balance: 'debit', is_active: true },
      { id: PAYABLE_ACCOUNT, tenant_id: TENANT, account_type: 'liability', normal_balance: 'credit', is_active: true },
      { id: CASH_ACCOUNT, tenant_id: TENANT, account_type: 'asset', normal_balance: 'debit', is_active: true }
    ],
    settings: [{ tenant_id: TENANT, base_currency: 'KES' }],
    journals: [],
    journalLines: [],
    postingEvents: [],
    nextJournal: 1
  }

  if (approvedBill) {
    const existingBillLines = [
      { account_id: EXPENSE_ACCOUNT, debit: '60.00', credit: '0' },
      { account_id: ASSET_ACCOUNT, debit: '40.00', credit: '0' },
      { account_id: PAYABLE_ACCOUNT, debit: '0', credit: '100.00' }
    ]
    state.journals.push({
      id: 'journal-existing-bill', tenant_id: TENANT, source_type: 'supplier_bill', source_id: BILL_ID,
      status: 'posted', lines: existingBillLines
    })
    state.journalLines.push(...existingBillLines.map((line) => ({ journal_entry_id: 'journal-existing-bill', ...line })))
    state.postingEvents.push({
      tenant_id: TENANT, idempotency_key: `supplier-bill:${BILL_ID}:approve:v1`,
      journal_entry_id: 'journal-existing-bill', status: 'posted'
    })
  }

  return state
}

function verifiedAmount(state, billId) {
  return state.allocations.reduce((total, allocation) => {
    const payment = state.payments.find((row) => row.id === allocation.supplier_payment_id && row.tenant_id === allocation.tenant_id)
    return allocation.supplier_bill_id === billId && payment?.status === 'verified'
      ? total + amountCents(allocation.amount)
      : total
  }, 0n)
}

function readBillDetails(state, tenantId, billId) {
  const bill = state.bills.find((row) => row.tenant_id === tenantId && row.id === billId)
  if (!bill) return rows()
  const paidCents = verifiedAmount(state, billId)
  const totalCents = amountCents(bill.total)
  const balanceCents = bill.status === 'approved' && totalCents > paidCents ? totalCents - paidCents : 0n
  const displayStatus = bill.status !== 'approved' ? bill.status
    : paidCents >= totalCents ? 'paid'
      : paidCents > 0n ? 'partially_paid'
        : bill.due_date < '2026-11-01' ? 'overdue' : 'approved'
  return rows([{
    ...bill,
    supplier_name: 'Synthetic Test Supplier',
    paid_amount: `${paidCents / 100n}.${String(paidCents % 100n).padStart(2, '0')}`,
    balance_due: `${balanceCents / 100n}.${String(balanceCents % 100n).padStart(2, '0')}`,
    display_status: displayStatus
  }])
}

function executeQuery(state, sql, params = []) {
  const query = normalizedSql(sql)
  const [tenantId, recordId] = params

  if (query.startsWith('select bill.*, supplier.business_name as supplier_name')) {
    return readBillDetails(state, tenantId, recordId)
  }
  if (query.startsWith('select line.*, account.account_code')) {
    return rows(state.billLines.filter((line) => line.tenant_id === tenantId && line.supplier_bill_id === recordId))
  }
  if (query.startsWith('select id, actor_id, event_type, details, created_at from supplier_bill_events')) {
    return rows(state.billEvents.filter((event) => event.tenant_id === tenantId && event.supplier_bill_id === recordId))
  }
  if (query.startsWith('select payment.id, payment.payment_number')) {
    const billAllocations = state.allocations.filter((allocation) =>
      allocation.tenant_id === tenantId && allocation.supplier_bill_id === recordId)
    return rows(billAllocations.map((allocation) => {
      const payment = state.payments.find((row) => row.id === allocation.supplier_payment_id && row.tenant_id === tenantId)
      return payment && {
        id: payment.id,
        payment_number: payment.payment_number,
        amount: payment.amount,
        currency: payment.currency,
        payment_date: payment.payment_date,
        payment_method: payment.payment_method,
        payment_reference: payment.payment_reference,
        status: payment.status,
        allocated_amount: allocation.amount,
        journal_entry_id: payment.journal_entry_id,
        reversal_journal_entry_id: payment.reversal_journal_entry_id || null
      }
    }).filter(Boolean))
  }
  if (query.startsWith('select * from supplier_bills where tenant_id = $1 and id = $2 for update')) {
    return rows(state.bills.filter((bill) => bill.tenant_id === tenantId && bill.id === recordId))
  }
  if (query.startsWith('select * from supplier_payments where tenant_id = $1 and id = $2 for update')) {
    return rows(state.payments.filter((payment) => payment.tenant_id === tenantId && payment.id === recordId))
  }
  if (query.startsWith('select id from tenants where id = $1 for update')) {
    return rows(state.settings.filter((setting) => setting.tenant_id === params[0]).map((setting) => ({ id: setting.tenant_id })))
  }
  if (query.startsWith('select id, payload_hash from supplier_payments where tenant_id = $1 and idempotency_key = $2 for update')) {
    return rows(state.payments.filter((payment) => payment.tenant_id === params[0] && payment.idempotency_key === params[1])
      .map((payment) => ({ id: payment.id, payload_hash: payment.payload_hash })))
  }
  if (query.startsWith('select id, status from accounting_periods')) {
    return rows([{ id: PERIOD_ID, status: 'open' }])
  }
  if (query.startsWith('select id from suppliers where tenant_id = $1 and id = $2 and is_active = true for share')) {
    return rows(params[0] === TENANT && params[1] === SUPPLIER ? [{ id: SUPPLIER }] : [])
  }
  if (query.startsWith('select coalesce(max(substring(payment_number')) {
    const maximum = state.payments.reduce((current, payment) => {
      const match = /^SPAY-(\d+)$/.exec(payment.payment_number || '')
      return match ? Math.max(current, Number(match[1])) : current
    }, 0)
    return rows([{ next_number: maximum + 1 }])
  }
  if (query.startsWith('select base_currency from accounting_settings')) {
    return rows(state.settings.filter((setting) => setting.tenant_id === params[0]))
  }
  if (query.startsWith('select inventory_clearing_account_id from accounting_settings')) {
    return rows([{ inventory_clearing_account_id: null }])
  }
  if (query.startsWith('select id, account_type, normal_balance, is_active from accounting_accounts')) {
    const selected = query.includes('= any($2::uuid[])')
      ? state.accounts.filter((account) => account.tenant_id === params[0] && params[1].includes(account.id))
      : state.accounts.filter((account) => account.tenant_id === params[0] && account.id === params[1])
    return rows(selected)
  }
  if (query.startsWith('select line_number, description, line_subtotal, tax_amount, account_id')) {
    return rows(state.billLines
      .filter((line) => line.tenant_id === params[0] && line.supplier_bill_id === params[1])
      .sort((left, right) => left.line_number - right.line_number))
  }
  if (query.startsWith('select id, supplier_id, status, currency, total::text, payable_account_id from supplier_bills')) {
    const requested = new Set(params[1])
    return rows(state.bills.filter((bill) => bill.tenant_id === params[0] && requested.has(bill.id))
      .map(({ id, supplier_id, status, currency, total, payable_account_id }) => ({
        id, supplier_id, status, currency, total, payable_account_id
      })))
  }
  if (query.startsWith('select allocation.supplier_bill_id, coalesce(sum(allocation.amount), 0)::text as amount')) {
    const requested = new Set(params[1])
    const grouped = new Map()
    for (const allocation of state.allocations) {
      const payment = state.payments.find((row) => row.id === allocation.supplier_payment_id &&
        row.tenant_id === allocation.tenant_id && row.status === 'verified')
      if (allocation.tenant_id === params[0] && requested.has(allocation.supplier_bill_id) && payment) {
        grouped.set(allocation.supplier_bill_id, (grouped.get(allocation.supplier_bill_id) || 0n) + amountCents(allocation.amount))
      }
    }
    return rows([...grouped].map(([supplier_bill_id, cents]) => ({
      supplier_bill_id,
      amount: `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`
    })))
  }
  if (query.startsWith('select supplier_bill_id, amount::text as amount from supplier_payment_allocations')) {
    return rows(state.allocations.filter((allocation) => allocation.tenant_id === params[0] &&
      allocation.supplier_payment_id === params[1]).sort((a, b) => a.supplier_bill_id.localeCompare(b.supplier_bill_id)))
  }
  if (query.startsWith('select payment.*, supplier.business_name as supplier_name')) {
    const payment = state.payments.find((row) => row.tenant_id === tenantId && row.id === recordId)
    if (!payment) return rows()
    const allocated = state.allocations.filter((allocation) => allocation.tenant_id === tenantId &&
      allocation.supplier_payment_id === recordId).reduce((sum, allocation) => sum + amountCents(allocation.amount), 0n)
    return rows([{
      ...payment,
      supplier_name: 'Synthetic Test Supplier',
      allocated_amount: `${allocated / 100n}.${String(allocated % 100n).padStart(2, '0')}`
    }])
  }
  if (query.startsWith('select allocation.id, allocation.supplier_bill_id, bill.bill_number')) {
    return rows(state.allocations.filter((allocation) => allocation.tenant_id === params[0] &&
      allocation.supplier_payment_id === params[1]).map((allocation) => {
      const bill = state.bills.find((row) => row.tenant_id === allocation.tenant_id && row.id === allocation.supplier_bill_id)
      return bill && {
        id: allocation.id,
        supplier_bill_id: allocation.supplier_bill_id,
        bill_number: bill.bill_number,
        supplier_invoice_number: bill.supplier_invoice_number,
        amount: allocation.amount
      }
    }).filter(Boolean))
  }
  if (query.startsWith('select id, actor_id, event_type, details, created_at from supplier_payment_events')) {
    return rows(state.paymentEvents.filter((event) => event.tenant_id === tenantId && event.supplier_payment_id === recordId))
  }
  if (query.startsWith("update supplier_bills set status = 'approved'")) {
    const bill = state.bills.find((row) => row.tenant_id === params[4] && row.id === params[5] && row.status === 'submitted')
    if (!bill) return mutation(0)
    Object.assign(bill, {
      status: 'approved', payable_account_id: params[0], journal_entry_id: params[1],
      approval_payload_hash: params[2], approved_by: params[3], approved_at: '2026-11-01T09:00:00.000Z'
    })
    return mutation()
  }
  if (query.startsWith("update supplier_payments set status = 'verified'")) {
    const payment = state.payments.find((row) => row.tenant_id === params[4] && row.id === params[5] && row.status === 'pending')
    if (!payment) return mutation(0)
    Object.assign(payment, {
      status: 'verified', cash_account_id: params[0], journal_entry_id: params[1],
      verification_payload_hash: params[2], verified_by: params[3], verified_at: '2026-11-01T09:00:00.000Z'
    })
    return mutation()
  }
  if (query.startsWith('insert into supplier_bill_events')) {
    state.billEvents.push({
      tenant_id: params[0], supplier_bill_id: params[1], actor_id: params[2],
      event_type: params[3], details: JSON.parse(params[4]), created_at: '2026-11-01T09:00:00.000Z'
    })
    return mutation()
  }
  if (query.startsWith('insert into supplier_payments')) {
    const payment = {
      id: PAYMENT_ID,
      tenant_id: params[0],
      supplier_id: params[1],
      payment_number: params[2],
      amount: params[3],
      currency: params[4],
      payment_date: params[5],
      payment_method: params[6],
      payment_reference: params[7],
      notes: params[8],
      idempotency_key: params[9],
      payload_hash: params[10],
      created_by: params[11],
      status: 'pending',
      journal_entry_id: null,
      verification_payload_hash: null
    }
    state.payments.push(payment)
    return rows([{ id: payment.id }])
  }
  if (query.startsWith('insert into supplier_payment_allocations')) {
    state.allocations.push({
      id: `allocation-${state.allocations.length + 1}`,
      tenant_id: params[0], supplier_payment_id: params[1], supplier_bill_id: params[2],
      supplier_id: params[3], amount: params[4], created_by: params[5]
    })
    return mutation()
  }
  if (query.startsWith('insert into supplier_payment_events')) {
    state.paymentEvents.push({
      tenant_id: params[0], supplier_payment_id: params[1], actor_id: params[2],
      event_type: params[3], details: JSON.parse(params[4]), created_at: '2026-11-01T09:00:00.000Z'
    })
    return mutation()
  }

  throw new Error(`Unexpected supplier-payables service query: ${query}`)
}

function makeHarness(options = {}) {
  const harness = {
    state: makeState(options),
    postingCalls: [],
    lifecycle: { connections: 0, begins: 0, commits: 0, rollbacks: 0, releases: 0 },
    failNextPostingAfterWrite: false
  }
  const pool = {
    async query(sql, params = []) {
      return executeQuery(harness.state, sql, params)
    },
    async connect() {
      harness.lifecycle.connections += 1
      let working = null
      const client = {
        harness,
        get inTransaction() { return working !== null },
        query: async (sql, params = []) => {
          const query = normalizedSql(sql)
          if (query.startsWith('begin ')) {
            harness.lifecycle.begins += 1
            if (working !== null) throw new Error('Transaction already started')
            working = structuredClone(harness.state)
            return mutation(0)
          }
          if (query === 'commit') {
            if (working === null) throw new Error('No transaction to commit')
            harness.state = working
            working = null
            harness.lifecycle.commits += 1
            return mutation(0)
          }
          if (query === 'rollback') {
            if (working === null) throw new Error('No transaction to roll back')
            working = null
            harness.lifecycle.rollbacks += 1
            return mutation(0)
          }
          return executeQuery(working || harness.state, sql, params)
        },
        recordJournal: (input) => {
          if (working === null) throw new Error('Journal posting must use the caller transaction')
          const id = `journal-service-${working.nextJournal++}`
          const journal = {
            id,
            tenant_id: input.tenantId,
            accounting_period_id: input.body.accounting_period_id,
            entry_date: input.body.entry_date,
            status: 'posted',
            source_type: input.body.source_type,
            source_id: input.body.source_id,
            source_reference: input.body.source_reference,
            event_type: input.body.event_type
          }
          const journalLines = structuredClone(input.body.lines)
          const debit = journalLines.reduce((sum, line) => sum + amountCents(line.debit || '0'), 0n)
          const credit = journalLines.reduce((sum, line) => sum + amountCents(line.credit || '0'), 0n)
          if (debit !== credit) throw new Error('Mock posting received an unbalanced journal')
          working.journals.push({ journal, lines: journalLines })
          working.journalLines.push(...journalLines.map((line) => ({ journal_entry_id: id, ...line })))
          working.postingEvents.push({
            tenant_id: input.tenantId,
            idempotency_key: input.idempotencyKey,
            journal_entry_id: id,
            status: 'posted'
          })
          return { journal, lines: journalLines, replayed: false }
        },
        release: () => { harness.lifecycle.releases += 1 }
      }
      return client
    }
  }
  return { harness, pool }
}

async function mockPostJournal(pool, input, { client } = {}) {
  const posted = client.recordJournal(input)
  client.harness.postingCalls.push(structuredClone(input))
  if (client.harness.failNextPostingAfterWrite) {
    client.harness.failNextPostingAfterWrite = false
    throw new Error('simulated accounting posting failure after journal write')
  }
  return posted
}

const accountingMock = new Module(accountingPath)
accountingMock.filename = accountingPath
accountingMock.loaded = true
accountingMock.exports = { ...accounting, postJournal: mockPostJournal }
require.cache[accountingPath] = accountingMock

const {
  approveSupplierBill,
  createSupplierPayment,
  getSupplierBill,
  verifySupplierPayment
} = require('../src/services/supplierPayables')

const approvalInput = {
  accounting_period_id: PERIOD_ID,
  payable_account_id: PAYABLE_ACCOUNT
}
const verificationInput = {
  accounting_period_id: PERIOD_ID,
  cash_account_id: CASH_ACCOUNT
}
const paymentInput = {
  supplier_id: SUPPLIER,
  amount: '40.00',
  currency: 'KES',
  payment_date: '2026-10-31',
  payment_method: 'bank_transfer',
  payment_reference: 'BANK-REF-001',
  allocations: [{ bill_id: BILL_ID, amount: '40.00' }]
}

async function createPendingPayment(pool) {
  return createSupplierPayment(pool, {
    tenantId: TENANT,
    userId: MAKER,
    idempotencyKey: 'supplier-payment-service-create-001',
    body: paymentInput
  })
}

test('bill approval commits bill status, audit event, and one balanced debit-to-lines credit-to-AP journal atomically', async () => {
  const { harness, pool } = makeHarness()
  const first = await approveSupplierBill(pool, {
    tenantId: TENANT, userId: CHECKER, billId: BILL_ID, body: approvalInput
  })

  assert.equal(first.replayed, false)
  assert.equal(first.bill.status, 'approved')
  assert.equal(first.bill.payable_account_id, PAYABLE_ACCOUNT)
  assert.equal(first.bill.journal_entry_id, harness.state.journals[0].journal.id)
  assert.equal(harness.state.billEvents.length, 1)
  assert.equal(harness.state.billEvents[0].event_type, 'approved')
  assert.equal(harness.state.journals.length, 1)
  assert.equal(harness.state.postingEvents.length, 1)
  assert.equal(harness.state.postingEvents[0].idempotency_key, `supplier-bill:${BILL_ID}:approve:v1`)
  assert.equal(harness.lifecycle.commits, 1)
  assert.equal(harness.lifecycle.rollbacks, 0)

  const posting = harness.postingCalls[0]
  assert.equal(posting.tenantId, TENANT)
  assert.equal(posting.idempotencyKey, `supplier-bill:${BILL_ID}:approve:v1`)
  assert.equal(posting.body.source_type, 'supplier_bill')
  assert.equal(posting.body.source_id, BILL_ID)
  assert.deepEqual(posting.body.lines, [
    { account_id: EXPENSE_ACCOUNT, description: 'Office supplies', debit: '60.00', credit: '0' },
    { account_id: ASSET_ACCOUNT, description: 'Small equipment', debit: '40.00', credit: '0' },
    { account_id: PAYABLE_ACCOUNT, description: 'Accounts payable for BILL-000001', debit: '0', credit: '100.00' }
  ])
  assert.equal(posting.body.lines.reduce((sum, line) => sum + amountCents(line.debit), 0n), 10000n)
  assert.equal(posting.body.lines.reduce((sum, line) => sum + amountCents(line.credit), 0n), 10000n)

  const retry = await approveSupplierBill(pool, {
    tenantId: TENANT, userId: CHECKER, billId: BILL_ID, body: approvalInput
  })
  assert.equal(retry.replayed, true)
  assert.equal(harness.postingCalls.length, 1)
  assert.equal(harness.state.journals.length, 1)
  assert.equal(harness.state.postingEvents.length, 1)
  assert.equal(harness.state.billEvents.length, 1)
})

test('bill approval posting failure rolls back the linked bill update, audit event, and journal write', async () => {
  const { harness, pool } = makeHarness()
  harness.failNextPostingAfterWrite = true

  await assert.rejects(approveSupplierBill(pool, {
    tenantId: TENANT, userId: CHECKER, billId: BILL_ID, body: approvalInput
  }), /simulated accounting posting failure/)

  assert.equal(harness.state.bills[0].status, 'submitted')
  assert.equal(harness.state.bills[0].journal_entry_id, null)
  assert.equal(harness.state.billEvents.length, 0)
  assert.equal(harness.state.journals.length, 0)
  assert.equal(harness.state.journalLines.length, 0)
  assert.equal(harness.state.postingEvents.length, 0)
  assert.equal(harness.lifecycle.commits, 0)
  assert.equal(harness.lifecycle.rollbacks, 1)
  assert.equal(harness.lifecycle.releases, 1)
})

test('bill approval retains tenant scoping and maker-checker rejection in the service path', async () => {
  const { harness, pool } = makeHarness()

  await assert.rejects(approveSupplierBill(pool, {
    tenantId: TENANT, userId: MAKER, billId: BILL_ID, body: approvalInput
  }), (error) => error.statusCode === 403)
  await assert.rejects(approveSupplierBill(pool, {
    tenantId: OTHER_TENANT, userId: CHECKER, billId: BILL_ID, body: approvalInput
  }), (error) => error.statusCode === 404)

  assert.equal(harness.postingCalls.length, 0)
  assert.equal(harness.state.bills[0].status, 'submitted')
  assert.equal(harness.state.journals.length, 0)
})

test('payment verification alone reduces bill balance and posts debit AP credit selected asset; retries do not duplicate it', async () => {
  const { harness, pool } = makeHarness({ approvedBill: true })
  const pending = await createPendingPayment(pool)
  assert.equal(pending.payment.status, 'pending')
  assert.equal(pending.replayed, false)
  const before = await getSupplierBill(pool, TENANT, BILL_ID)
  assert.equal(before.balance_due, '100.00')
  assert.equal(harness.state.payments[0].status, 'pending')

  const pendingRetry = await createPendingPayment(pool)
  assert.equal(pendingRetry.replayed, true)
  assert.equal(harness.state.payments.length, 1)
  assert.equal(harness.state.allocations.length, 1)
  assert.equal((await getSupplierBill(pool, TENANT, BILL_ID)).balance_due, '100.00')

  await assert.rejects(verifySupplierPayment(pool, {
    tenantId: TENANT, userId: MAKER, paymentId: PAYMENT_ID, body: verificationInput
  }), (error) => error.statusCode === 403)
  assert.equal((await getSupplierBill(pool, TENANT, BILL_ID)).balance_due, '100.00')
  assert.equal(harness.state.payments[0].status, 'pending')
  assert.equal(harness.postingCalls.length, 0)

  const first = await verifySupplierPayment(pool, {
    tenantId: TENANT, userId: CHECKER, paymentId: PAYMENT_ID, body: verificationInput
  })
  assert.equal(first.replayed, false)
  assert.equal(first.payment.status, 'verified')
  assert.equal(first.payment.cash_account_id, CASH_ACCOUNT)
  assert.equal(first.payment.journal_entry_id, harness.state.journals[1].journal.id)
  assert.equal(harness.state.postingEvents.length, 2)
  assert.equal(harness.state.postingEvents[1].idempotency_key, `supplier-payment:${PAYMENT_ID}:verify:v1`)
  assert.equal(harness.state.paymentEvents.length, 2)
  assert.equal(harness.state.paymentEvents[1].event_type, 'verified')
  assert.equal((await getSupplierBill(pool, TENANT, BILL_ID)).balance_due, '60.00')

  const posting = harness.postingCalls[0]
  assert.equal(posting.tenantId, TENANT)
  assert.equal(posting.idempotencyKey, `supplier-payment:${PAYMENT_ID}:verify:v1`)
  assert.equal(posting.body.source_type, 'supplier_payment')
  assert.equal(posting.body.source_id, PAYMENT_ID)
  assert.deepEqual(posting.body.lines, [
    { account_id: PAYABLE_ACCOUNT, description: 'Supplier payment SPAY-000001', debit: '40.00', credit: '0' },
    { account_id: CASH_ACCOUNT, description: 'Supplier payment SPAY-000001', debit: '0', credit: '40.00' }
  ])

  const retry = await verifySupplierPayment(pool, {
    tenantId: TENANT, userId: CHECKER, paymentId: PAYMENT_ID, body: verificationInput
  })
  assert.equal(retry.replayed, true)
  assert.equal(harness.postingCalls.length, 1)
  assert.equal(harness.state.journals.length, 2)
  assert.equal(harness.state.postingEvents.length, 2)
  assert.equal(harness.state.paymentEvents.length, 2)
  assert.equal((await getSupplierBill(pool, TENANT, BILL_ID)).balance_due, '60.00')
})

test('payment verification posting failure keeps payment pending and leaves bill balance and journals unchanged', async () => {
  const { harness, pool } = makeHarness({ approvedBill: true })
  const pending = await createPendingPayment(pool)
  assert.equal(pending.payment.status, 'pending')
  harness.failNextPostingAfterWrite = true

  await assert.rejects(verifySupplierPayment(pool, {
    tenantId: TENANT, userId: CHECKER, paymentId: PAYMENT_ID, body: verificationInput
  }), /simulated accounting posting failure/)

  assert.equal(harness.state.payments[0].status, 'pending')
  assert.equal(harness.state.payments[0].journal_entry_id, null)
  assert.equal(harness.state.paymentEvents.length, 1)
  assert.equal(harness.state.paymentEvents[0].event_type, 'created')
  assert.equal(harness.state.journals.length, 1)
  assert.equal(harness.state.journalLines.length, 3)
  assert.equal(harness.state.postingEvents.length, 1)
  assert.equal((await getSupplierBill(pool, TENANT, BILL_ID)).balance_due, '100.00')
  assert.equal(harness.lifecycle.commits, 1)
  assert.equal(harness.lifecycle.rollbacks, 1)
})

test.after(() => {
  if (originalSupplierServiceModule) require.cache[supplierServicePath] = originalSupplierServiceModule
  else delete require.cache[supplierServicePath]
  if (originalAccountingModule) require.cache[accountingPath] = originalAccountingModule
  else delete require.cache[accountingPath]
})

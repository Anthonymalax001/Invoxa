const test = require('node:test')
const assert = require('node:assert/strict')
const {
  assertAllocationWithinBalance,
  assertApprovalAllowed,
  assertBillCanReverse,
  assertJournalBalanced,
  assertPaymentCanFail,
  assertPaymentCanVerify,
  assertPaymentCanReverse,
  assertSameCurrency,
  buildBillJournalLines,
  buildPaymentJournalLines,
  normalizeBillInput,
  normalizePaymentInput
} = require('../src/services/supplierPayables')

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SUPPLIER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const DEBIT_A = '11111111-1111-4111-8111-111111111111'
const DEBIT_B = '22222222-2222-4222-8222-222222222222'
const PAYABLE_A = '33333333-3333-4333-8333-333333333333'
const PAYABLE_B = '44444444-4444-4444-8444-444444444444'
const CASH = '55555555-5555-4555-8555-555555555555'
const BILL_A = '66666666-6666-4666-8666-666666666666'
const BILL_B = '77777777-7777-4777-8777-777777777777'

const billInput = (overrides = {}) => ({
  supplier_id: SUPPLIER,
  supplier_invoice_number: '  INV-001  ',
  bill_date: '2026-10-30', due_date: '2026-11-29', currency: 'KES',
  lines: [{ description: 'Office supplies', quantity: '2', unit_price: '12.50', tax_rate: '16.00', account_id: DEBIT_A }],
  ...overrides
})

test('bill input calculates rounded line tax and totals without trusting client totals', () => {
  const bill = normalizeBillInput(billInput({ subtotal: '1.00', total: '1.00', tax_amount: '0.00' }), 'bill-create-0001')
  assert.equal(bill.supplier_invoice_number, 'INV-001')
  assert.equal(bill.subtotal, '25.00')
  assert.equal(bill.tax_amount, '4.00')
  assert.equal(bill.total, '29.00')
  assert.equal(bill.lines[0].line_subtotal, '25.00')
  assert.equal(bill.lines[0].tax_amount, '4.00')
  assert.equal(bill.currency, 'KES')
})

test('bill normalization uses exact decimal rounding and rejects invalid financial inputs', () => {
  const rounded = normalizeBillInput(billInput({
    lines: [{ description: 'Fractional item', quantity: '0.333', unit_price: '2.00', tax_rate: '0', account_id: DEBIT_A }]
  }), 'bill-create-0002')
  assert.equal(rounded.subtotal, '0.67')
  assert.equal(rounded.total, '0.67')
  assert.throws(() => normalizeBillInput(billInput({ lines: [{ ...billInput().lines[0], tax_rate: '100.01' }] }), 'bill-create-0003'), /100 percent/)
  assert.throws(() => normalizeBillInput(billInput({ due_date: '2026-10-29' }), 'bill-create-0004'), /Due date/)
  assert.throws(() => normalizeBillInput(billInput({ lines: [{ ...billInput().lines[0], unit_price: '0' }] }), 'bill-create-0005'), /Bill total/)
})

test('PO and received goods references must be structurally complete', () => {
  const line = { description: 'Goods', quantity: '1', unit_price: '10', account_id: DEBIT_A }
  assert.throws(() => normalizeBillInput(billInput({ purchase_order_id: null, lines: [{ ...line, purchase_order_item_id: BILL_A }] }), 'bill-link-0001'), /Select the purchase order/)
  assert.throws(() => normalizeBillInput(billInput({ purchase_order_id: BILL_A, lines: [{ ...line, purchase_order_item_id: BILL_A, receipt_id: BILL_B }] }), 'bill-link-0002'), /both the goods receipt/)
  const linked = normalizeBillInput(billInput({
    purchase_order_id: BILL_A,
    lines: [{ ...line, purchase_order_item_id: BILL_B, receipt_id: TENANT, purchase_order_receipt_item_id: SUPPLIER }]
  }), 'bill-link-0003')
  assert.equal(linked.purchase_order_id, BILL_A)
  assert.equal(linked.lines[0].purchase_order_item_id, BILL_B)
  assert.equal(linked.lines[0].receipt_id, TENANT)
})

test('supplier invoice normalization supports duplicate detection keys and stable request retries', () => {
  const first = normalizeBillInput(billInput(), 'bill-retry-0001')
  const retry = normalizeBillInput(billInput(), 'bill-retry-0001')
  const changed = normalizeBillInput(billInput({ supplier_invoice_number: 'INV-002' }), 'bill-retry-0001')
  assert.equal(first.payload_hash, retry.payload_hash)
  assert.notEqual(first.payload_hash, changed.payload_hash)
  assert.equal(first.supplier_invoice_number, 'INV-001')
})

test('supplier payment allocations support partial, full, and multi-bill payments but must sum exactly', () => {
  const partial = normalizePaymentInput({
    supplier_id: SUPPLIER, amount: '30.00', currency: 'KES', payment_date: '2026-10-30',
    payment_method: 'bank_transfer', payment_reference: 'BANK-REF-1',
    allocations: [{ bill_id: BILL_A, amount: '30.00' }]
  }, 'payment-create-001')
  assert.equal(partial.allocations.length, 1)
  const multiBill = normalizePaymentInput({
    supplier_id: SUPPLIER, amount: '100.00', currency: 'KES', payment_date: '2026-10-30',
    payment_method: 'bank_transfer', payment_reference: 'BANK-REF-2',
    allocations: [{ bill_id: BILL_B, amount: '60.00' }, { bill_id: BILL_A, amount: '40.00' }]
  }, 'payment-create-002')
  assert.equal(multiBill.allocations.length, 2)
  assert.equal(multiBill.allocations[0].bill_id, BILL_A)
  assert.throws(() => normalizePaymentInput({
    supplier_id: SUPPLIER, amount: '100.00', currency: 'KES', payment_date: '2026-10-30',
    payment_method: 'cash', payment_reference: 'CASH-1',
    allocations: [{ bill_id: BILL_A, amount: '99.99' }]
  }, 'payment-create-003'), /must equal the full payment amount/)
  assert.throws(() => normalizePaymentInput({
    supplier_id: SUPPLIER, amount: '20.00', currency: 'KES', payment_date: '2026-10-30',
    payment_method: 'cash', payment_reference: 'CASH-2',
    allocations: [{ bill_id: BILL_A, amount: '10.00' }, { bill_id: BILL_A, amount: '10.00' }]
  }, 'payment-create-004'), /one allocation amount per bill/)
})

test('bill allocation cannot exceed the outstanding balance and currency must match', () => {
  assert.doesNotThrow(() => assertAllocationWithinBalance('25.00', '100.00', '25.00'))
  assert.doesNotThrow(() => assertAllocationWithinBalance('75.00', '100.00', '25.00'))
  assert.throws(() => assertAllocationWithinBalance('75.01', '100.00', '25.00'), (error) => error.statusCode === 409)
  assert.throws(() => assertSameCurrency('KES', 'USD'), (error) => error.statusCode === 409)
})

test('bill approval requires a different approver, an untaxed bill, and the base currency', () => {
  const valid = { status: 'submitted', created_by: 'creator', currency: 'KES', tax_amount: '0.00' }
  assert.doesNotThrow(() => assertApprovalAllowed(valid, 'approver', 'KES'))
  assert.throws(() => assertApprovalAllowed(valid, 'creator', 'KES'), (error) => error.statusCode === 403)
  assert.throws(() => assertApprovalAllowed({ ...valid, status: 'draft' }, 'approver', 'KES'), (error) => error.statusCode === 409)
  assert.throws(() => assertApprovalAllowed({ ...valid, tax_amount: '1.00' }, 'approver', 'KES'), /input-tax account mapping/)
  assert.throws(() => assertApprovalAllowed(valid, 'approver', 'USD'), /base currency/)
})

test('failed and reversed payment transitions preserve the verified-posting boundary', () => {
  assert.doesNotThrow(() => assertPaymentCanFail('pending'))
  assert.throws(() => assertPaymentCanFail('verified'), (error) => error.statusCode === 409)
  assert.doesNotThrow(() => assertPaymentCanReverse('verified'))
  assert.throws(() => assertPaymentCanReverse('pending'), (error) => error.statusCode === 409)
  assert.doesNotThrow(() => assertPaymentCanVerify({ status: 'pending', created_by: 'maker' }, 'checker'))
  assert.throws(() => assertPaymentCanVerify({ status: 'pending', created_by: 'maker' }, 'maker'), (error) => error.statusCode === 403)
  assert.doesNotThrow(() => assertBillCanReverse('approved', []))
  assert.throws(() => assertBillCanReverse('approved', ['verified']), /Reverse verified supplier payments/)
  assert.throws(() => assertBillCanReverse('approved', ['pending']), /Fail pending supplier payments/)
  assert.throws(() => assertBillCanReverse('paid', false), /unpaid approved/)
})

test('bill and payment journals balance with AP debit on payment and cash credit', () => {
  const billLines = buildBillJournalLines([
    { account_id: DEBIT_A, description: 'Services', line_subtotal: '80.00' },
    { account_id: DEBIT_B, description: 'Equipment', line_subtotal: '20.00' }
  ], PAYABLE_A, 'BILL-000001', '100.00')
  assert.deepEqual(assertJournalBalanced(billLines), { debit: '100.00', credit: '100.00' })
  assert.equal(billLines.at(-1).account_id, PAYABLE_A)
  assert.equal(billLines.at(-1).credit, '100.00')

  const paymentLines = buildPaymentJournalLines([
    { bill_id: BILL_A, amount: '30.00' }, { bill_id: BILL_B, amount: '70.00' }
  ], new Map([
    [BILL_A, { payable_account_id: PAYABLE_A }], [BILL_B, { payable_account_id: PAYABLE_B }]
  ]), CASH, 'SPAY-000001')
  assert.deepEqual(assertJournalBalanced(paymentLines), { debit: '100.00', credit: '100.00' })
  assert.equal(paymentLines.at(-1).account_id, CASH)
  assert.equal(paymentLines.at(-1).credit, '100.00')
  assert.deepEqual(paymentLines.slice(0, 2).map((line) => line.debit).sort(), ['30.00', '70.00'])
})

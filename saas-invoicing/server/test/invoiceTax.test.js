const test = require('node:test')
const assert = require('node:assert/strict')
const {
  calculateTaxTotals,
  normalizeDirectInvoiceItems,
  normalizeTaxProfileInput
} = require('../src/utils/invoiceTax')

const exclusive = {
  tax_rate: '16.00', calculation_method: 'exclusive', rounding_method: 'invoice_total'
}

test('calculates an exclusive invoice total using exact cents', () => {
  const items = normalizeDirectInvoiceItems([
    { description: 'A', quantity: '2.00', unit_price: '10.05' },
    { description: 'B', quantity: '1.00', unit_price: '4.90' }
  ])
  assert.deepEqual(calculateTaxTotals(items.map((item) => item.amountUnits), exclusive), {
    subtotal: '25.00', tax_amount: '4.00', total: '29.00'
  })
})
test('calculates inclusive tax as included tax without adding it twice', () => {
  const items = normalizeDirectInvoiceItems([
    { description: 'Inclusive amount', quantity: '1.00', unit_price: '116.00' }
  ])
  assert.deepEqual(calculateTaxTotals(items.map((item) => item.amountUnits), {
    ...exclusive, calculation_method: 'inclusive'
  }), { subtotal: '100.00', tax_amount: '16.00', total: '116.00' })
})

test('line-item rounding is explicit and repeatable', () => {
  const amounts = [5n, 5n, 5n]
  const invoiceRounded = calculateTaxTotals(amounts, { ...exclusive, tax_rate: '10.00' })
  const lineRounded = calculateTaxTotals(amounts, {
    ...exclusive, tax_rate: '10.00', rounding_method: 'line_item'
  })
  assert.deepEqual(invoiceRounded, { subtotal: '0.15', tax_amount: '0.02', total: '0.17' })
  assert.deepEqual(lineRounded, { subtotal: '0.15', tax_amount: '0.03', total: '0.18' })
})

test('rounds tax at half-cent boundaries for exclusive and inclusive calculations', () => {
  const exclusiveBoundary = (amount) => calculateTaxTotals([BigInt(amount)], {
    ...exclusive, tax_rate: '10.00'
  }).tax_amount
  assert.equal(exclusiveBoundary(4), '0.00', '0.4 cent rounds down')
  assert.equal(exclusiveBoundary(5), '0.01', 'an exact half-cent rounds up')
  assert.equal(exclusiveBoundary(6), '0.01', '0.6 cent rounds up')

  const inclusiveBoundary = (amount) => calculateTaxTotals([BigInt(amount)], {
    ...exclusive, tax_rate: '20.00', calculation_method: 'inclusive'
  }).tax_amount
  assert.equal(inclusiveBoundary(2), '0.00')
  assert.equal(inclusiveBoundary(3), '0.01', 'an exact inclusive half-cent rounds up')
  assert.equal(inclusiveBoundary(4), '0.01')
})

test('line-item and invoice-total rounding follow the selected policy for inclusive multi-line tax', () => {
  const amounts = [3n, 3n, 3n]
  const invoiceRounded = calculateTaxTotals(amounts, {
    ...exclusive, tax_rate: '20.00', calculation_method: 'inclusive'
  })
  const lineRounded = calculateTaxTotals(amounts, {
    ...exclusive, tax_rate: '20.00', calculation_method: 'inclusive', rounding_method: 'line_item'
  })

  assert.deepEqual(invoiceRounded, { subtotal: '0.07', tax_amount: '0.02', total: '0.09' })
  assert.deepEqual(lineRounded, { subtotal: '0.06', tax_amount: '0.03', total: '0.09' })
})

test('accepts supported two-place quantity and price precision and rejects extra places', () => {
  const items = normalizeDirectInvoiceItems([
    { description: 'Exact decimal', quantity: '1.25', unit_price: '0.08' }
  ])
  assert.equal(items[0].quantity, '1.25')
  assert.equal(items[0].unit_price, '0.08')
  assert.equal(items[0].amount, '0.10')

  assert.throws(() => normalizeDirectInvoiceItems([
    { description: 'Extra quantity precision', quantity: '1.001', unit_price: '1.00' }
  ]), /precision/)
  assert.throws(() => normalizeDirectInvoiceItems([
    { description: 'Extra price precision', quantity: '1.00', unit_price: '0.001' }
  ]), /precision/)
  assert.throws(() => normalizeTaxProfileInput({
    profile_key: 'standard', name: 'Tax', tax_rate: '16.001',
    calculation_method: 'exclusive', rounding_method: 'invoice_total',
    effective_from: '2026-01-01', requires_tax_payable: true,
    tax_payable_account_id: '60000000-0000-4000-8000-000000000001'
  }), /precision/)
})

test('rejects unsupported line precision, negative amounts, and missing tax-liability declaration', () => {
  assert.throws(() => normalizeDirectInvoiceItems([
    { description: 'Bad precision', quantity: '1.001', unit_price: '1.00' }
  ]), /precision/)
  assert.throws(() => normalizeDirectInvoiceItems([
    { description: 'Negative', quantity: '1.00', unit_price: '-1.00' }
  ]), /precision|range/)
  assert.throws(() => normalizeTaxProfileInput({
    profile_key: 'standard', name: 'Tax', tax_rate: '16.00',
    calculation_method: 'exclusive', rounding_method: 'invoice_total',
    effective_from: '2026-01-01', requires_tax_payable: false
  }), /explicit tax payable account/)
})

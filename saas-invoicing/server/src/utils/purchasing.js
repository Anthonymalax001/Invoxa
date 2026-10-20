const { validate: isUuid } = require('uuid')

const MAX_MONEY_CENTS = 999999999999n
const MAX_QUANTITY_MILLI = 999999999999n

function badRequest(message) {
  const error = new Error(message)
  error.statusCode = 400
  return error
}

function parseFixed(value, scale, maxIntegerDigits, label) {
  if (!(typeof value === 'number' || typeof value === 'string')) {
    throw badRequest(`${label} must be a number`)
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw badRequest(`${label} must be a finite number`)
  }
  const raw = String(value).trim()
  const fractionPattern = scale === 0 ? '' : `(?:\\.(\\d{1,${scale}}))?`
  const match = raw.match(new RegExp(`^(\\d{1,${maxIntegerDigits}})${fractionPattern}$`))
  if (!match) throw badRequest(`${label} has invalid precision or range`)
  const whole = BigInt(match[1])
  const fractional = scale === 0 ? '' : (match[2] || '').padEnd(scale, '0')
  const units = whole * (10n ** BigInt(scale)) + BigInt(fractional || '0')
  return units
}

function formatFixed(units, scale) {
  const negative = units < 0n
  const absolute = negative ? -units : units
  const factor = 10n ** BigInt(scale)
  const whole = absolute / factor
  const fraction = String(absolute % factor).padStart(scale, '0')
  return `${negative ? '-' : ''}${whole}${scale ? `.${fraction}` : ''}`
}

function normalizeText(value, label, maxLength, required = false) {
  if (value === undefined || value === null) {
    if (required) throw badRequest(`${label} is required`)
    return null
  }
  if (typeof value !== 'string') throw badRequest(`${label} must be text`)
  const text = value.trim()
  if (required && !text) throw badRequest(`${label} is required`)
  if (text.length > maxLength) throw badRequest(`${label} is too long`)
  return text || null
}

function normalizeIsoDate(value, label, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${label} is required`)
    return null
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw badRequest(`${label} must use YYYY-MM-DD`)
  }
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw badRequest(`${label} is not a valid date`)
  }
  return value
}

function normalizeSupplier(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  const business_name = normalizeText(source.business_name, 'Supplier name', 255, true)
  const contact_person = normalizeText(source.contact_person, 'Contact person', 255)
  const email = normalizeText(source.email, 'Email', 255)
  const phone = normalizeText(source.phone, 'Phone number', 50)
  const address = normalizeText(source.address, 'Address', 10000)
  const notes = normalizeText(source.notes, 'Notes', 10000)
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw badRequest('Email address is invalid')
  }
  if (phone && !/^\d{10}$/.test(phone)) {
    throw badRequest('Phone number must contain exactly 10 digits')
  }
  return { business_name, contact_person, email, phone, address, notes }
}

function normalizeOrder(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  if (!isUuid(source.supplier_id)) throw badRequest('A valid supplier is required')

  const order_date = normalizeIsoDate(source.order_date, 'Order date', true)
  const expected_delivery_date = normalizeIsoDate(
    source.expected_delivery_date,
    'Expected delivery date'
  )
  if (expected_delivery_date && expected_delivery_date < order_date) {
    throw badRequest('Expected delivery date cannot be before the order date')
  }

  const taxRateUnits = parseFixed(source.tax_rate ?? '0', 2, 3, 'Tax rate')
  if (taxRateUnits > 10000n) throw badRequest('Tax rate must be between 0 and 100')
  const notes = normalizeText(source.notes, 'Notes', 10000)
  if (!Array.isArray(source.items) || source.items.length === 0 || source.items.length > 200) {
    throw badRequest('At least one and no more than 200 product lines are required')
  }

  const seenProducts = new Set()
  const items = source.items.map((item) => {
    if (!item || typeof item !== 'object' || !isUuid(item.product_id)) {
      throw badRequest('Each product line needs a valid product')
    }
    if (seenProducts.has(item.product_id)) {
      throw badRequest('A product can appear only once per purchase order')
    }
    seenProducts.add(item.product_id)
    const quantityMilli = parseFixed(item.quantity, 3, 9, 'Quantity')
    if (quantityMilli === 0n || quantityMilli > MAX_QUANTITY_MILLI) {
      throw badRequest('Quantity must be greater than zero and within range')
    }
    const unitCostCents = parseFixed(item.unit_cost, 2, 10, 'Unit cost')
    const lineSubtotalCents = (quantityMilli * unitCostCents + 500n) / 1000n
    if (unitCostCents > MAX_MONEY_CENTS || lineSubtotalCents > MAX_MONEY_CENTS) {
      throw badRequest('Line cost exceeds the supported range')
    }
    return {
      product_id: item.product_id,
      quantity: formatFixed(quantityMilli, 3),
      quantityMilli,
      unit_cost: formatFixed(unitCostCents, 2),
      unitCostCents,
      lineSubtotalCents
    }
  })

  const subtotalCents = items.reduce((sum, item) => sum + item.lineSubtotalCents, 0n)
  const taxCents = (subtotalCents * taxRateUnits + 5000n) / 10000n
  const totalCents = subtotalCents + taxCents
  if (subtotalCents > MAX_MONEY_CENTS || taxCents > MAX_MONEY_CENTS || totalCents > MAX_MONEY_CENTS) {
    throw badRequest('Purchase order total exceeds the supported range')
  }

  return {
    supplier_id: source.supplier_id,
    order_date,
    expected_delivery_date,
    tax_rate: formatFixed(taxRateUnits, 2),
    subtotal: formatFixed(subtotalCents, 2),
    tax_amount: formatFixed(taxCents, 2),
    total: formatFixed(totalCents, 2),
    notes,
    items: items.map((item) => ({
      product_id: item.product_id,
      quantity: item.quantity,
      unit_cost: item.unit_cost,
      line_subtotal: formatFixed(item.lineSubtotalCents, 2)
    }))
  }
}

function normalizeReceipt(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  if (!Array.isArray(source.items) || source.items.length === 0 || source.items.length > 200) {
    throw badRequest('At least one receipt line is required')
  }
  const seenItems = new Set()
  const items = source.items.map((item) => {
    if (!item || typeof item !== 'object' || !isUuid(item.purchase_order_item_id)) {
      throw badRequest('Each receipt line needs a valid purchase order item')
    }
    if (seenItems.has(item.purchase_order_item_id)) {
      throw badRequest('A purchase order item can appear only once per receipt')
    }
    seenItems.add(item.purchase_order_item_id)
    const quantityMilli = parseFixed(item.quantity, 3, 9, 'Receipt quantity')
    if (quantityMilli === 0n || quantityMilli > MAX_QUANTITY_MILLI) {
      throw badRequest('Receipt quantity must be greater than zero and within range')
    }
    return { purchase_order_item_id: item.purchase_order_item_id, quantity: formatFixed(quantityMilli, 3), quantityMilli }
  })
  return { items, notes: normalizeText(source.notes, 'Receipt notes', 10000) }
}

module.exports = {
  badRequest,
  formatFixed,
  normalizeIsoDate,
  normalizeOrder,
  normalizeReceipt,
  normalizeSupplier,
  parseFixed
}

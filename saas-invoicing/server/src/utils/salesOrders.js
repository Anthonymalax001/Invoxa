const { validate: isUuid } = require('uuid')

const MAX_MONEY_CENTS = 999999999999n
const MAX_QUANTITY_HUNDREDTHS = 9999999999n

function validationError(message) {
  const error = new Error(message)
  error.statusCode = 400
  return error
}

function parseFixed(value, scale, maxIntegerDigits, label) {
  if (!(typeof value === 'number' || typeof value === 'string')) {
    throw validationError(`${label} must be a number`)
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw validationError(`${label} must be finite`)
  }
  const pattern = new RegExp(`^(\\d{1,${maxIntegerDigits}})(?:\\.(\\d{1,${scale}}))?$`)
  const match = String(value).trim().match(pattern)
  if (!match) throw validationError(`${label} has invalid precision or range`)
  return BigInt(match[1]) * (10n ** BigInt(scale)) + BigInt((match[2] || '').padEnd(scale, '0') || '0')
}

function formatFixed(units, scale) {
  const negative = units < 0n
  const absolute = negative ? -units : units
  const factor = 10n ** BigInt(scale)
  const fraction = String(absolute % factor).padStart(scale, '0')
  return `${negative ? '-' : ''}${absolute / factor}${scale ? `.${fraction}` : ''}`
}

function normalizeText(value, label, maxLength, required = false) {
  if (value === undefined || value === null) {
    if (required) throw validationError(`${label} is required`)
    return null
  }
  if (typeof value !== 'string') throw validationError(`${label} must be text`)
  const trimmed = value.trim()
  if (required && !trimmed) throw validationError(`${label} is required`)
  if (trimmed.length > maxLength) throw validationError(`${label} is too long`)
  return trimmed || null
}

function normalizeDate(value, label, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) throw validationError(`${label} is required`)
    return null
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw validationError(`${label} must use YYYY-MM-DD`)
  }
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw validationError(`${label} is invalid`)
  }
  return value
}

function normalizeOrder(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  if (!isUuid(source.client_id)) throw validationError('A valid client is required')
  const order_date = normalizeDate(source.order_date, 'Order date', true)
  const expected_delivery_date = normalizeDate(source.expected_delivery_date, 'Expected delivery date')
  if (expected_delivery_date && expected_delivery_date < order_date) {
    throw validationError('Expected delivery date cannot be before the order date')
  }
  const taxRateUnits = parseFixed(source.tax_rate ?? '0', 2, 3, 'Tax rate')
  if (taxRateUnits > 10000n) throw validationError('Tax rate must be between 0 and 100')
  const notes = normalizeText(source.notes, 'Notes', 10000)
  if (!Array.isArray(source.items) || source.items.length < 1 || source.items.length > 200) {
    throw validationError('At least one and no more than 200 product lines are required')
  }

  const seenProducts = new Set()
  const items = source.items.map((item) => {
    if (!item || typeof item !== 'object' || !isUuid(item.product_id)) {
      throw validationError('Each line needs a valid product')
    }
    if (seenProducts.has(item.product_id.toLowerCase())) {
      throw validationError('A product can appear only once per sales order')
    }
    seenProducts.add(item.product_id.toLowerCase())

    const quantity = parseFixed(item.quantity, 2, 8, 'Quantity')
    if (quantity === 0n || quantity > MAX_QUANTITY_HUNDREDTHS) {
      throw validationError('Quantity must be greater than zero and within range')
    }
    const unitPrice = parseFixed(item.unit_price, 2, 10, 'Unit price')
    const discountRate = parseFixed(item.discount_rate ?? '0', 2, 3, 'Discount rate')
    if (unitPrice > MAX_MONEY_CENTS || discountRate > 10000n) {
      throw validationError('Unit price or discount rate is outside the supported range')
    }
    const grossCents = (quantity * unitPrice + 50n) / 100n
    const discountCents = (grossCents * discountRate + 5000n) / 10000n
    const lineSubtotalCents = grossCents - discountCents
    if (grossCents > MAX_MONEY_CENTS || discountCents > MAX_MONEY_CENTS) {
      throw validationError('Line total exceeds the supported range')
    }
    return {
      product_id: item.product_id,
      quantity: formatFixed(quantity, 2),
      quantityUnits: quantity,
      unit_price: formatFixed(unitPrice, 2),
      unitPriceCents: unitPrice,
      discount_rate: formatFixed(discountRate, 2),
      discount_amount: formatFixed(discountCents, 2),
      discountCents,
      line_subtotal: formatFixed(lineSubtotalCents, 2),
      lineSubtotalCents
    }
  })

  const subtotalCents = items.reduce((sum, item) => sum + item.lineSubtotalCents, 0n)
  const discountTotalCents = items.reduce((sum, item) => sum + item.discountCents, 0n)
  const taxCents = (subtotalCents * taxRateUnits + 5000n) / 10000n
  const totalCents = subtotalCents + taxCents
  if (subtotalCents > MAX_MONEY_CENTS || discountTotalCents > MAX_MONEY_CENTS ||
      taxCents > MAX_MONEY_CENTS || totalCents > MAX_MONEY_CENTS) {
    throw validationError('Sales order total exceeds the supported range')
  }

  return {
    client_id: source.client_id,
    order_date,
    expected_delivery_date,
    subtotal: formatFixed(subtotalCents, 2),
    discount_total: formatFixed(discountTotalCents, 2),
    tax_rate: formatFixed(taxRateUnits, 2),
    tax_amount: formatFixed(taxCents, 2),
    total: formatFixed(totalCents, 2),
    notes,
    items: items.map(({ product_id, quantity, unit_price, discount_rate, discount_amount, line_subtotal }) => ({
      product_id, quantity, unit_price, discount_rate, discount_amount, line_subtotal
    }))
  }
}

function normalizeFulfillment(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  if (!Array.isArray(source.items) || source.items.length < 1 || source.items.length > 200) {
    throw validationError('At least one fulfillment line is required')
  }
  const seenItems = new Set()
  const items = source.items.map((item) => {
    if (!item || typeof item !== 'object' || !isUuid(item.sales_order_item_id)) {
      throw validationError('Each fulfillment line needs a valid sales order item')
    }
    const normalizedId = item.sales_order_item_id.toLowerCase()
    if (seenItems.has(normalizedId)) throw validationError('A sales order item can appear only once per fulfillment')
    seenItems.add(normalizedId)
    const quantity = parseFixed(item.quantity, 2, 8, 'Fulfillment quantity')
    if (quantity === 0n || quantity > MAX_QUANTITY_HUNDREDTHS) {
      throw validationError('Fulfillment quantity must be greater than zero and within range')
    }
    return { sales_order_item_id: item.sales_order_item_id, quantity: formatFixed(quantity, 2), quantityUnits: quantity }
  })
  return { items, notes: normalizeText(source.notes, 'Fulfillment notes', 10000) }
}

module.exports = { formatFixed, normalizeDate, normalizeFulfillment, normalizeOrder, parseFixed }

const { validate: isUuid } = require('uuid')
const { postJournal } = require('./accounting')
const { decimalUnits, formatUnits } = require('../utils/accounting')

function httpError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function quantityUnits(value) {
  return decimalUnits(String(value), 3, 'Inventory quantity', { allowZero: true })
}

function signedQuantityUnits(value) {
  const normalized = String(value)
  if (normalized.startsWith('-')) {
    return -decimalUnits(normalized.slice(1), 3, 'Inventory quantity', { allowZero: true })
  }
  return decimalUnits(normalized, 3, 'Inventory quantity', { allowZero: true })
}

function costUnits(value) {
  return decimalUnits(String(value), 6, 'Inventory unit cost', { allowZero: true })
}

function valueUnits(value) {
  return decimalUnits(String(value), 6, 'Inventory value', { allowZero: true })
}

function multiplyQuantityCost(quantity, cost) {
  return (quantity * cost + 500n) / 1000n
}

function averageCost(value, quantity) {
  if (quantity === 0n) return 0n
  return (value * 1000n + quantity / 2n) / quantity
}

function requireMappedAccount(settings, key, label) {
  if (!isUuid(settings[key])) throw httpError(409, `Configure the tenant ${label} account before posting inventory`)
  return settings[key]
}

async function settingsAndPeriod(client, tenantId, entryDate) {
  const settings = await client.query(
    `SELECT base_currency, inventory_asset_account_id, inventory_cogs_account_id,
            inventory_adjustment_account_id, inventory_clearing_account_id,
            inventory_opening_balance_account_id
     FROM accounting_settings WHERE tenant_id = $1 FOR SHARE`,
    [tenantId]
  )
  if (settings.rowCount !== 1) throw httpError(409, 'Configure tenant accounting settings before posting inventory')
  const period = await client.query(
    `SELECT id, status FROM accounting_periods
     WHERE tenant_id = $1 AND $2::date BETWEEN starts_on AND ends_on FOR SHARE`,
    [tenantId, entryDate]
  )
  if (period.rowCount !== 1 || period.rows[0].status !== 'open') {
    throw httpError(409, 'Inventory transaction date must be in an open accounting period')
  }
  return { settings: settings.rows[0], periodId: period.rows[0].id }
}

async function requireAccount(client, tenantId, accountId, types, normalBalance, label) {
  const result = await client.query(
    `SELECT account_type, normal_balance, is_active FROM accounting_accounts
     WHERE tenant_id = $1 AND id = $2 FOR SHARE`,
    [tenantId, accountId]
  )
  if (result.rowCount !== 1 || !result.rows[0].is_active ||
      !types.includes(result.rows[0].account_type) ||
      result.rows[0].normal_balance !== normalBalance) {
    throw httpError(409, `${label} must be an active tenant ${types.join(' or ')} ${normalBalance}-normal account`)
  }
}

async function postInventoryJournal(client, { tenantId, userId, periodId, entryDate,
  sourceType, sourceId, sourceReference, eventType, description, lines, idempotencyKey }) {
  return postJournal(null, {
    tenantId, userId,
    idempotencyKey: idempotencyKey || `inventory:${sourceType}:${sourceId}:${eventType}:v1`,
    body: {
      accounting_period_id: periodId, entry_date: entryDate, description,
      source_type: sourceType, source_id: sourceId, source_reference: sourceReference,
      event_type: eventType, lines
    }
  }, { client })
}

async function valueOpeningStock(client, input) {
      const quantity = quantityUnits(input.quantity)
      const unitCost = costUnits(input.unitCost)
      if (quantity < 0n) throw httpError(400, 'Opening quantity must not be negative')
      if (quantity > 0n && unitCost <= 0n) throw httpError(400, 'Opening unit cost must be positive for positive stock')
      const productResult = await client.query(
        `SELECT id, current_stock, weighted_average_cost, inventory_value, inventory_valuation_status
         FROM products WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [input.tenantId, input.productId]
      )
      if (productResult.rowCount !== 1) throw httpError(404, 'Product not found')
      const product = productResult.rows[0]
      const currentQuantity = quantityUnits(product.current_stock)
      if (currentQuantity !== quantity) {
        throw httpError(409, 'Opening quantity must match the product stock currently recorded')
      }
      const existingKey = await client.query(
        `SELECT 1 FROM accounting_posting_events
         WHERE tenant_id = $1 AND idempotency_key = $2 FOR SHARE`,
        [input.tenantId, input.idempotencyKey]
      )
      if (product.inventory_valuation_status === 'valued' && existingKey.rowCount === 0) {
        throw httpError(409, 'Opening stock has already been valued')
      }
      const beforeValue = valueUnits(product.inventory_value || '0')
      const openingValue = multiplyQuantityCost(quantity, unitCost)
      const { settings, periodId } = await settingsAndPeriod(client, input.tenantId, input.entryDate)
      const inventoryAccount = requireMappedAccount(settings, 'inventory_asset_account_id', 'inventory asset')
      const openingAccount = requireMappedAccount(
        settings, 'inventory_opening_balance_account_id', 'inventory opening-balance counterpart'
      )
      await requireAccount(client, input.tenantId, inventoryAccount, ['asset'], 'debit', 'Inventory asset')
      await requireAccount(client, input.tenantId, openingAccount, ['equity'], 'credit', 'Inventory opening-balance counterpart')

      let journalId = null
      if (openingValue > 0n) {
        const posting = await postInventoryJournal(client, {
          tenantId: input.tenantId, userId: input.userId, periodId, entryDate: input.entryDate,
          sourceType: 'opening_stock', sourceId: input.productId, sourceReference: input.sourceReference,
          eventType: 'opening', description: `Opening inventory valuation ${input.sourceReference}`,
          idempotencyKey: input.idempotencyKey,
          lines: [
            { account_id: inventoryAccount, description: `Opening inventory ${input.sourceReference}`,
              debit: formatUnits(openingValue, 6), credit: '0' },
            { account_id: openingAccount, description: `Opening balance ${input.sourceReference}`,
              debit: '0', credit: formatUnits(openingValue, 6) }
          ]
        })
        journalId = posting.journal.id
        if (posting.replayed) return posting
      }

      const average = averageCost(openingValue, quantity)
      await client.query(
        `UPDATE products SET weighted_average_cost = $1, inventory_value = $2,
           inventory_valuation_status = 'valued', updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = $3 AND id = $4`,
        [formatUnits(average, 6), formatUnits(openingValue, 6), input.tenantId, input.productId]
      )
      const movement = await client.query(
        `INSERT INTO stock_movements
           (tenant_id, product_id, movement_type, quantity_delta, quantity_before, quantity_after,
            reference, notes, created_by, unit_cost, value_delta, inventory_value_before,
            inventory_value_after, source_type, source_id, idempotency_key, journal_entry_id)
         VALUES ($1, $2, 'opening', 0, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING id`,
        [input.tenantId, input.productId, formatUnits(quantity, 3), input.sourceReference,
          input.notes || null, input.userId, formatUnits(unitCost, 6), formatUnits(openingValue, 6),
          formatUnits(beforeValue, 6), formatUnits(openingValue, 6), 'opening_stock',
          input.productId, input.idempotencyKey, journalId]
      )
      if (movement.rowCount !== 1) throw httpError(409, 'Opening stock movement could not be recorded')
      return journalId ? { journal: { id: journalId }, replayed: false } : { journal: null, replayed: false }
}

async function valueReceipt(client, input) {
  const quantity = quantityUnits(input.quantity)
  const unitCost = costUnits(input.unitCost)
  if (quantity <= 0n) throw httpError(400, 'Receipt quantity must be positive')
  const productResult = await client.query(
    `SELECT id, current_stock, weighted_average_cost, inventory_value, inventory_valuation_status
     FROM products WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [input.tenantId, input.productId]
  )
  if (productResult.rowCount !== 1) throw httpError(404, 'Product not found')
  const product = productResult.rows[0]
  const beforeQuantity = quantityUnits(product.current_stock)
  const beforeValue = valueUnits(product.inventory_value || '0')
  if (beforeQuantity > 0n && product.inventory_valuation_status !== 'valued') {
    throw httpError(409, 'Existing stock has no known opening valuation; value the opening stock explicitly before receiving more goods')
  }
  const receiptValue = multiplyQuantityCost(quantity, unitCost)
  const afterValue = beforeValue + receiptValue
  const afterQuantity = beforeQuantity + quantity
  const average = averageCost(afterValue, afterQuantity)
  const { settings, periodId } = await settingsAndPeriod(client, input.tenantId, input.entryDate)
  const inventoryAccount = requireMappedAccount(settings, 'inventory_asset_account_id', 'inventory asset')
  const clearingAccount = requireMappedAccount(settings, 'inventory_clearing_account_id', 'inventory clearing')
  await requireAccount(client, input.tenantId, inventoryAccount, ['asset'], 'debit', 'Inventory asset')
  await requireAccount(client, input.tenantId, clearingAccount, ['liability'], 'credit', 'Inventory clearing')
  const posting = await postInventoryJournal(client, {
    tenantId: input.tenantId, userId: input.userId, periodId, entryDate: input.entryDate,
    sourceType: input.sourceType, sourceId: input.sourceId, sourceReference: input.sourceReference,
    eventType: 'receipt', description: `Inventory receipt ${input.sourceReference}`,
    lines: [
      { account_id: inventoryAccount, description: `Inventory received ${input.sourceReference}`,
        debit: formatUnits(receiptValue, 6), credit: '0' },
      { account_id: clearingAccount, description: `Inventory clearing ${input.sourceReference}`,
        debit: '0', credit: formatUnits(receiptValue, 6) }
    ]
  })
  await client.query(
    `UPDATE products SET weighted_average_cost = $1, inventory_value = $2,
       inventory_valuation_status = 'valued', updated_at = CURRENT_TIMESTAMP
     WHERE tenant_id = $3 AND id = $4`,
    [formatUnits(average, 6), formatUnits(afterValue, 6), input.tenantId, input.productId]
  )
  await linkMovement(client, input, {
    unitCost: unitCost, valueDelta: receiptValue, beforeValue, afterValue,
    journalId: posting.journal.id
  })
  return posting
}

async function valueIssue(client, input) {
  const quantity = quantityUnits(input.quantity)
  if (quantity <= 0n) throw httpError(400, 'Fulfilment quantity must be positive')
  const productResult = await client.query(
    `SELECT id, current_stock, weighted_average_cost, inventory_value, inventory_valuation_status
     FROM products WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [input.tenantId, input.productId]
  )
  if (productResult.rowCount !== 1) throw httpError(404, 'Product not found')
  const product = productResult.rows[0]
  const beforeQuantity = quantityUnits(product.current_stock)
  const beforeValue = valueUnits(product.inventory_value || '0')
  if (product.inventory_valuation_status !== 'valued') {
    throw httpError(409, 'Stock has no known valuation; value the opening stock explicitly before fulfilment')
  }
  if (beforeQuantity < quantity) throw httpError(409, 'Insufficient valued stock')
  const unitCost = costUnits(product.weighted_average_cost || '0')
  const issueValue = multiplyQuantityCost(quantity, unitCost)
  const afterQuantity = beforeQuantity - quantity
  const afterValue = afterQuantity === 0n ? 0n : beforeValue - issueValue
  if (afterValue < 0n) throw httpError(409, 'Inventory valuation would become negative')
  const { settings, periodId } = await settingsAndPeriod(client, input.tenantId, input.entryDate)
  const inventoryAccount = requireMappedAccount(settings, 'inventory_asset_account_id', 'inventory asset')
  const cogsAccount = requireMappedAccount(settings, 'inventory_cogs_account_id', 'inventory COGS')
  await requireAccount(client, input.tenantId, inventoryAccount, ['asset'], 'debit', 'Inventory asset')
  await requireAccount(client, input.tenantId, cogsAccount, ['expense'], 'debit', 'Inventory COGS')
  const posting = await postInventoryJournal(client, {
    tenantId: input.tenantId, userId: input.userId, periodId, entryDate: input.entryDate,
    sourceType: input.sourceType, sourceId: input.sourceId, sourceReference: input.sourceReference,
    eventType: 'issue', description: `COGS for fulfilment ${input.sourceReference}`,
    lines: [
      { account_id: cogsAccount, description: `COGS ${input.sourceReference}`,
        debit: formatUnits(issueValue, 6), credit: '0' },
      { account_id: inventoryAccount, description: `Inventory issued ${input.sourceReference}`,
        debit: '0', credit: formatUnits(issueValue, 6) }
    ]
  })
  await client.query(
    `UPDATE products SET inventory_value = $1,
       weighted_average_cost = CASE WHEN $2::numeric = 0 THEN 0 ELSE weighted_average_cost END,
       updated_at = CURRENT_TIMESTAMP
     WHERE tenant_id = $3 AND id = $4`,
    [formatUnits(afterValue, 6), formatUnits(afterQuantity, 3), input.tenantId, input.productId]
  )
  await linkMovement(client, input, {
    unitCost, valueDelta: -issueValue, beforeValue, afterValue, journalId: posting.journal.id
  })
  return posting
}

async function valueAdjustment(client, input) {
  const deltaQuantity = signedQuantityUnits(input.quantityDelta)
  if (deltaQuantity === 0n) throw httpError(400, 'Adjustment quantity must not be zero')
  const productResult = await client.query(
    `SELECT id, current_stock, weighted_average_cost, inventory_value, inventory_valuation_status
     FROM products WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [input.tenantId, input.productId]
  )
  if (productResult.rowCount !== 1) throw httpError(404, 'Product not found')
  const product = productResult.rows[0]
  const beforeQuantity = quantityUnits(product.current_stock)
  const beforeValue = valueUnits(product.inventory_value || '0')
  if (product.inventory_valuation_status !== 'valued') {
    throw httpError(409, 'Stock has no known valuation; explicitly value opening stock before adjusting it')
  }
  const unitCost = deltaQuantity > 0n
    ? costUnits(input.unitCost)
    : costUnits(product.weighted_average_cost || '0')
  const absoluteQuantity = deltaQuantity > 0n ? deltaQuantity : -deltaQuantity
  const adjustmentValue = multiplyQuantityCost(absoluteQuantity, unitCost)
  const afterQuantity = beforeQuantity + deltaQuantity
  const afterValue = deltaQuantity > 0n ? beforeValue + adjustmentValue : beforeValue - adjustmentValue
  if (afterQuantity < 0n || afterValue < 0n) throw httpError(409, 'Inventory adjustment would create negative stock or value')
  const { settings, periodId } = await settingsAndPeriod(client, input.tenantId, input.entryDate)
  const inventoryAccount = requireMappedAccount(settings, 'inventory_asset_account_id', 'inventory asset')
  const adjustmentAccount = requireMappedAccount(settings, 'inventory_adjustment_account_id', 'inventory adjustment')
  await requireAccount(client, input.tenantId, inventoryAccount, ['asset'], 'debit', 'Inventory asset')
  await requireAccount(client, input.tenantId, adjustmentAccount,
    deltaQuantity > 0n ? ['revenue'] : ['expense'],
    deltaQuantity > 0n ? 'credit' : 'debit', 'Inventory adjustment')
  const lines = deltaQuantity > 0n
    ? [
        { account_id: inventoryAccount, description: `Inventory adjustment ${input.sourceReference}`, debit: formatUnits(adjustmentValue, 6), credit: '0' },
        { account_id: adjustmentAccount, description: `Inventory adjustment ${input.sourceReference}`, debit: '0', credit: formatUnits(adjustmentValue, 6) }
      ]
    : [
        { account_id: adjustmentAccount, description: `Inventory adjustment ${input.sourceReference}`, debit: formatUnits(adjustmentValue, 6), credit: '0' },
        { account_id: inventoryAccount, description: `Inventory adjustment ${input.sourceReference}`, debit: '0', credit: formatUnits(adjustmentValue, 6) }
      ]
  const posting = await postInventoryJournal(client, {
    tenantId: input.tenantId, userId: input.userId, periodId, entryDate: input.entryDate,
    sourceType: input.sourceType, sourceId: input.sourceId, sourceReference: input.sourceReference,
    eventType: 'adjustment', description: `Inventory adjustment ${input.sourceReference}`, lines
  })
  const average = averageCost(afterValue, afterQuantity)
  await client.query(
    `UPDATE products SET inventory_value = $1, weighted_average_cost = $2,
       inventory_valuation_status = 'valued', updated_at = CURRENT_TIMESTAMP
     WHERE tenant_id = $3 AND id = $4`,
    [formatUnits(afterValue, 6), formatUnits(average, 6), input.tenantId, input.productId]
  )
  await linkMovement(client, input, {
    unitCost, valueDelta: deltaQuantity > 0n ? adjustmentValue : -adjustmentValue,
    beforeValue, afterValue, journalId: posting.journal.id
  })
  return posting
}

async function valueReturn(client, input) {
  const quantity = quantityUnits(input.quantity)
  if (quantity <= 0n) throw httpError(400, 'Return quantity must be positive')
  const productResult = await client.query(
    `SELECT id, current_stock, weighted_average_cost, inventory_value, inventory_valuation_status
     FROM products WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [input.tenantId, input.productId]
  )
  if (productResult.rowCount !== 1) throw httpError(404, 'Product not found')
  const product = productResult.rows[0]
  if (product.inventory_valuation_status !== 'valued') {
    throw httpError(409, 'Stock has no known valuation; value the opening stock explicitly before recording a return')
  }
  const beforeValue = valueUnits(product.inventory_value || '0')
  const unitCost = costUnits(product.weighted_average_cost || '0')
  const returnValue = multiplyQuantityCost(quantity, unitCost)
  const afterValue = beforeValue + returnValue
  const { settings, periodId } = await settingsAndPeriod(client, input.tenantId, input.entryDate)
  const inventoryAccount = requireMappedAccount(settings, 'inventory_asset_account_id', 'inventory asset')
  const cogsAccount = requireMappedAccount(settings, 'inventory_cogs_account_id', 'inventory COGS')
  await requireAccount(client, input.tenantId, inventoryAccount, ['asset'], 'debit', 'Inventory asset')
  await requireAccount(client, input.tenantId, cogsAccount, ['expense'], 'debit', 'Inventory COGS')
  const posting = await postInventoryJournal(client, {
    tenantId: input.tenantId, userId: input.userId, periodId, entryDate: input.entryDate,
    sourceType: input.sourceType, sourceId: input.sourceId, sourceReference: input.sourceReference,
    eventType: 'return', description: `Inventory return ${input.sourceReference}`,
    lines: [
      { account_id: inventoryAccount, description: `Inventory returned ${input.sourceReference}`, debit: formatUnits(returnValue, 6), credit: '0' },
      { account_id: cogsAccount, description: `COGS returned ${input.sourceReference}`, debit: '0', credit: formatUnits(returnValue, 6) }
    ]
  })
  const afterQuantity = quantityUnits(product.current_stock) + quantity
  await client.query(
    `UPDATE products SET inventory_value = $1, updated_at = CURRENT_TIMESTAMP
     WHERE tenant_id = $2 AND id = $3`,
    [formatUnits(afterValue, 6), input.tenantId, input.productId]
  )
  await linkMovement(client, input, {
    movementId: input.movementId, unitCost, valueDelta: returnValue,
    beforeValue, afterValue, journalId: posting.journal.id
  })
  return posting
}

async function linkMovement(client, input, values) {
  const result = await client.query(
    `UPDATE stock_movements SET unit_cost = $1, value_delta = $2,
       inventory_value_before = $3, inventory_value_after = $4, journal_entry_id = $5
     WHERE tenant_id = $6 AND product_id = $7 AND
       (($8::uuid IS NOT NULL AND id = $8)
        OR ($9::uuid IS NOT NULL AND purchase_order_receipt_item_id = $9)
        OR ($10::uuid IS NOT NULL AND sales_order_fulfillment_item_id = $10)
        OR ($11::text IS NOT NULL AND source_type = $11 AND source_id = $12))`,
    [formatUnits(values.unitCost, 6), formatUnits(values.valueDelta, 6),
      formatUnits(values.beforeValue, 6), formatUnits(values.afterValue, 6),
      values.journalId, input.tenantId, input.productId,
      input.movementId || null, input.receiptItemId || null, input.fulfillmentItemId || null,
      input.sourceType || null, input.sourceId || null]
  )
  if (result.rowCount !== 1) throw httpError(409, 'Inventory movement could not be linked to its accounting journal')
}

module.exports = {
  valueReceipt, valueIssue, valueAdjustment, valueReturn, valueOpeningStock,
  quantityUnits, costUnits, multiplyQuantityCost
}

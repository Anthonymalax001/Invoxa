const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

const TENANT = '10000000-0000-4000-8000-000000000001'
const USER = '20000000-0000-4000-8000-000000000001'
const PRODUCT = '30000000-0000-4000-8000-000000000001'
const ASSET = '40000000-0000-4000-8000-000000000001'
const COGS = '40000000-0000-4000-8000-000000000002'
const ADJUSTMENT = '40000000-0000-4000-8000-000000000003'
const CLEARING = '40000000-0000-4000-8000-000000000004'
const OPENING = '40000000-0000-4000-8000-000000000005'
const PERIOD = '50000000-0000-4000-8000-000000000001'

const state = {
  product: {
    id: PRODUCT, current_stock: '10.000', weighted_average_cost: '12.500000',
    inventory_value: '125.000000', inventory_valuation_status: 'valued'
  },
  journals: [],
  updates: [],
  openingEvent: false,
  movements: 0
}

function installMockModule(modulePath, exports) {
  const mock = new Module(modulePath)
  mock.filename = modulePath
  mock.loaded = true
  mock.exports = exports
  require.cache[modulePath] = mock
}

installMockModule(require.resolve('../src/services/accounting'), {
  async postJournal(pool, request) {
    state.journals.push(request)
    return { journal: { id: `60000000-0000-4000-8000-${String(state.journals.length).padStart(12, '0')}` } }
  }
})

const { valueReceipt, valueIssue, valueAdjustment, valueOpeningStock } = require('../src/services/inventoryAccounting')

function result(rows = []) {
  return { rows, rowCount: rows.length }
}

function client() {
  return {
    async query(sql, params = []) {
      const query = sql.replace(/\s+/g, ' ').trim()
      if (query.startsWith('SELECT id, current_stock, weighted_average_cost')) return result([state.product])
      if (query.startsWith('SELECT base_currency, inventory_asset_account_id')) {
        return result([{
          base_currency: 'KES', inventory_asset_account_id: ASSET,
          inventory_cogs_account_id: COGS, inventory_adjustment_account_id: ADJUSTMENT,
          inventory_clearing_account_id: CLEARING, inventory_opening_balance_account_id: OPENING
        }])
      }
      if (query.startsWith('SELECT 1 FROM accounting_posting_events')) {
        return result(state.openingEvent ? [{}] : [])
      }
      if (query.startsWith('SELECT id, status FROM accounting_periods')) return result([{ id: PERIOD, status: 'open' }])
      if (query.startsWith('SELECT account_type, normal_balance, is_active')) {
        const accountId = params[1]
        const account = accountId === ASSET
          ? { account_type: 'asset', normal_balance: 'debit', is_active: true }
          : accountId === COGS || accountId === ADJUSTMENT
            ? { account_type: 'expense', normal_balance: 'debit', is_active: true }
            : accountId === OPENING
              ? { account_type: 'equity', normal_balance: 'credit', is_active: true }
            : { account_type: 'liability', normal_balance: 'credit', is_active: true }
        return result([account])
      }
      if (query.startsWith('UPDATE products SET')) {
        state.updates.push(params)
        state.product.inventory_value = params[0]
        if (params.length > 1 && query.includes('weighted_average_cost = $2')) {
          state.product.weighted_average_cost = params[1]
        }
        return result([])
      }
      if (query.startsWith('UPDATE stock_movements SET')) return result([{ id: 'movement' }])
      if (query.startsWith('INSERT INTO stock_movements')) {
        state.movements += 1
        return result([{ id: 'movement' }])
      }
      throw new Error(`Unexpected inventory query: ${query}`)
    }
  }
}

test.beforeEach(() => {
  state.product = {
    id: PRODUCT, current_stock: '10.000', weighted_average_cost: '12.500000',
    inventory_value: '125.000000', inventory_valuation_status: 'valued'
  }
  state.journals.length = 0
  state.updates.length = 0
  state.openingEvent = false
  state.movements = 0
})

test('receipt uses exact weighted-average arithmetic and posts inventory against clearing', async () => {
  await valueReceipt(client(), {
    tenantId: TENANT, userId: USER, productId: PRODUCT, quantity: '3.000',
    unitCost: '17.333333', entryDate: '2026-11-02', sourceType: 'purchase_receipt',
    sourceId: '70000000-0000-4000-8000-000000000001',
    sourceReference: 'PO-1', movementId: '80000000-0000-4000-8000-000000000001'
  })
  assert.equal(state.journals[0].body.lines[0].debit, '51.999999')
  assert.equal(state.journals[0].body.lines[1].credit, '51.999999')
  assert.equal(state.updates[0][1], '176.999999')
})

test('issue posts COGS at the applicable weighted average and reduces value', async () => {
  await valueIssue(client(), {
    tenantId: TENANT, userId: USER, productId: PRODUCT, quantity: '2.500',
    entryDate: '2026-11-02', sourceType: 'sales_fulfilment',
    sourceId: '70000000-0000-4000-8000-000000000002',
    sourceReference: 'SO-1', movementId: '80000000-0000-4000-8000-000000000002'
  })
  assert.equal(state.journals[0].body.lines[0].debit, '31.250000')
  assert.equal(state.journals[0].body.lines[1].credit, '31.250000')
  assert.equal(state.updates[0][0], '93.750000')
})

test('unvalued opening stock fails closed instead of inventing a cost', async () => {
  state.product.inventory_valuation_status = 'unvalued'
  await assert.rejects(
    valueIssue(client(), {
      tenantId: TENANT, userId: USER, productId: PRODUCT, quantity: '1.000',
      entryDate: '2026-11-02', sourceType: 'sales_fulfilment',
      sourceId: '70000000-0000-4000-8000-000000000003', sourceReference: 'SO-2',
      movementId: '80000000-0000-4000-8000-000000000003'
    }),
    /no known valuation/
  )
  assert.equal(state.journals.length, 0)
})

test('negative adjustment uses weighted average and the adjustment account', async () => {
  await valueAdjustment(client(), {
    tenantId: TENANT, userId: USER, productId: PRODUCT, quantityDelta: '-1.000',
    entryDate: '2026-11-02', sourceType: 'inventory_adjustment',
    sourceId: '70000000-0000-4000-8000-000000000004',
    sourceReference: 'COUNT-1', movementId: '80000000-0000-4000-8000-000000000004'
  })
  assert.equal(state.journals[0].body.lines[0].debit, '12.500000')
  assert.equal(state.journals[0].body.lines[1].credit, '12.500000')
  assert.equal(state.updates[0][0], '112.500000')
})

test('opening valuation posts exact inventory and counterpart amounts', async () => {
  state.product.inventory_valuation_status = 'unvalued'
  await valueOpeningStock(client(), {
    tenantId: TENANT, userId: USER, productId: PRODUCT, quantity: '10.000',
    unitCost: '12.345678', entryDate: '2026-11-02', sourceReference: 'OPEN-1',
    idempotencyKey: 'opening-key-1'
  })
  assert.equal(state.journals[0].body.lines[0].debit, '123.456780')
  assert.equal(state.journals[0].body.lines[1].credit, '123.456780')
  assert.equal(state.updates[0][0], '12.345678')
  assert.equal(state.updates[0][1], '123.456780')
  assert.equal(state.movements, 1)
})

test('opening valuation rejects a second valuation and quantity mismatch', async () => {
  state.product.inventory_valuation_status = 'unvalued'
  await valueOpeningStock(client(), {
    tenantId: TENANT, userId: USER, productId: PRODUCT, quantity: '10.000',
    unitCost: '12.000000', entryDate: '2026-11-02', sourceReference: 'OPEN-1',
    idempotencyKey: 'opening-key-2'
  })
  state.product.inventory_valuation_status = 'valued'
  await assert.rejects(
    valueOpeningStock(client(), {
      tenantId: TENANT, userId: USER, productId: PRODUCT, quantity: '9.000',
      unitCost: '12.000000', entryDate: '2026-11-02', sourceReference: 'OPEN-2',
      idempotencyKey: 'opening-key-3'
    }),
    /must match/
  )
})

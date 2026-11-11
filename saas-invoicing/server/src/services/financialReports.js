const { validate: isUuid } = require('uuid')
const { httpError, validationError } = require('../utils/accounting')

const SCALE = 6
const FACTOR = 10n ** BigInt(SCALE)
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function amountUnits(value) {
  const input = String(value == null ? '0' : value)
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(input)
  if (!match) throw new Error('Database returned an invalid six-place accounting amount')
  const fraction = (match[3] || '').padEnd(SCALE, '0')
  const units = BigInt(match[2]) * FACTOR + BigInt(fraction || '0')
  return match[1] ? -units : units
}

function formatUnits(units) {
  const negative = units < 0n
  const absolute = negative ? -units : units
  return (negative ? '-' : '') + (absolute / FACTOR).toString() + '.' +
    (absolute % FACTOR).toString().padStart(SCALE, '0')
}

function normalBalanceUnits(debit, credit, normalBalance) {
  const debitUnits = amountUnits(debit)
  const creditUnits = amountUnits(credit)
  return normalBalance === 'debit' ? debitUnits - creditUnits : creditUnits - debitUnits
}

function statementBalanceUnits(debit, credit, accountType, normalBalance) {
  const balance = normalBalanceUnits(debit, credit, normalBalance)
  const statementNormalBalance = accountType === 'asset' || accountType === 'expense' ? 'debit' : 'credit'
  return normalBalance === statementNormalBalance ? balance : -balance
}

function balanceSides(normalAmount, normalBalance) {
  const debitNatureAmount = normalBalance === 'debit' ? normalAmount : -normalAmount
  return {
    debit: formatUnits(debitNatureAmount > 0n ? debitNatureAmount : 0n),
    credit: formatUnits(debitNatureAmount < 0n ? -debitNatureAmount : 0n)
  }
}

function addField(rows, field) {
  return rows.reduce((total, row) => total + amountUnits(row[field]), 0n)
}

function mapTrialBalanceRows(accounts) {
  return accounts.map((account) => {
    const opening = normalBalanceUnits(account.opening_debit, account.opening_credit, account.normal_balance)
    const movement = normalBalanceUnits(account.period_debit, account.period_credit, account.normal_balance)
    const closing = opening + movement
    const openingSides = balanceSides(opening, account.normal_balance)
    const closingSides = balanceSides(closing, account.normal_balance)
    return {
      account_id: account.id,
      account_code: account.account_code,
      account_name: account.name,
      account_type: account.account_type,
      normal_balance: account.normal_balance,
      opening_debit: openingSides.debit,
      opening_credit: openingSides.credit,
      debit_movement: formatUnits(amountUnits(account.period_debit)),
      credit_movement: formatUnits(amountUnits(account.period_credit)),
      closing_debit: closingSides.debit,
      closing_credit: closingSides.credit
    }
  })
}

function sumSides(rows, debitField, creditField) {
  return {
    debit: formatUnits(addField(rows, debitField)),
    credit: formatUnits(addField(rows, creditField))
  }
}

function buildTrialBalance(accounts) {
  const rows = mapTrialBalanceRows(accounts)
  const opening = sumSides(rows, 'opening_debit', 'opening_credit')
  const movement = sumSides(rows, 'debit_movement', 'credit_movement')
  const closing = sumSides(rows, 'closing_debit', 'closing_credit')
  return {
    rows,
    totals: {
      opening_debit: opening.debit,
      opening_credit: opening.credit,
      debit_movement: movement.debit,
      credit_movement: movement.credit,
      closing_debit: closing.debit,
      closing_credit: closing.credit
    },
    balanced: amountUnits(closing.debit) === amountUnits(closing.credit)
  }
}

function buildProfitAndLoss(accounts) {
  const revenueAccounts = []
  const expenseAccounts = []
  for (const account of accounts) {
    const balance = statementBalanceUnits(
      account.period_debit,
      account.period_credit,
      account.account_type,
      account.normal_balance
    )
    const row = {
      account_id: account.id,
      account_code: account.account_code,
      account_name: account.name,
      amount: formatUnits(balance)
    }
    if (account.account_type === 'revenue') revenueAccounts.push(row)
    if (account.account_type === 'expense') expenseAccounts.push(row)
  }
  const revenue = revenueAccounts.reduce((total, row) => total + amountUnits(row.amount), 0n)
  const expenses = expenseAccounts.reduce((total, row) => total + amountUnits(row.amount), 0n)
  return {
    revenue_accounts: revenueAccounts,
    expense_accounts: expenseAccounts,
    revenue_total: formatUnits(revenue),
    expense_total: formatUnits(expenses),
    net_profit: formatUnits(revenue - expenses),
    classification_note: 'Expense accounts are shown without cost-of-sales, operating-expense, or other-expense subcategories because the chart of accounts does not store those classifications.'
  }
}

function buildBalanceSheet(accounts) {
  const sections = { asset: [], liability: [], equity: [] }
  let currentEarnings = 0n
  for (const account of accounts) {
    const balance = statementBalanceUnits(
      account.opening_debit,
      account.opening_credit,
      account.account_type,
      account.normal_balance
    ) + statementBalanceUnits(
      account.period_debit,
      account.period_credit,
      account.account_type,
      account.normal_balance
    )
    if (sections[account.account_type]) {
      sections[account.account_type].push({
        account_id: account.id,
        account_code: account.account_code,
        account_name: account.name,
        balance: formatUnits(balance)
      })
    }
    if (account.account_type === 'revenue') currentEarnings += balance
    if (account.account_type === 'expense') currentEarnings -= balance
  }
  const total = (items) => items.reduce((sum, row) => sum + amountUnits(row.balance), 0n)
  const assets = total(sections.asset)
  const liabilities = total(sections.liability)
  const equity = total(sections.equity)
  const liabilitiesAndEquity = liabilities + equity + currentEarnings
  return {
    assets: sections.asset,
    liabilities: sections.liability,
    equity: sections.equity,
    total_assets: formatUnits(assets),
    total_liabilities: formatUnits(liabilities),
    total_equity: formatUnits(equity),
    unclosed_earnings: formatUnits(currentEarnings),
    total_liabilities_and_equity: formatUnits(liabilitiesAndEquity),
    balanced: assets === liabilitiesAndEquity,
    classification_note: 'Current and non-current asset or liability subtotals are unavailable because account classifications are not stored.'
  }
}

function classifyCashFlow(counterpartTypes) {
  const types = new Set(counterpartTypes || [])
  if (types.size === 1 && types.has('equity')) return 'financing'
  if (types.size === 1 && types.has('asset')) return 'investing'
  if (types.size > 0 && [...types].every((type) => ['liability', 'revenue', 'expense'].includes(type))) {
    return 'operating'
  }
  return 'unclassified'
}

function emptyCashFlowSection() {
  return { inflows: '0.000000', outflows: '0.000000', net: '0.000000' }
}

function buildCashFlow(accounts, movements) {
  const sections = {
    operating: emptyCashFlowSection(),
    investing: emptyCashFlowSection(),
    financing: emptyCashFlowSection(),
    unclassified: emptyCashFlowSection()
  }
  const accountBalances = accounts.map((account) => ({
    account_id: account.id,
    account_code: account.account_code,
    account_name: account.name,
    opening_balance: '0.000000',
    period_inflows: '0.000000',
    period_outflows: '0.000000',
    closing_balance: '0.000000'
  }))
  const byAccount = new Map(accountBalances.map((account) => [account.account_id, account]))
  let opening = 0n
  let periodNet = 0n
  for (const movement of movements) {
    const net = amountUnits(movement.debit) - amountUnits(movement.credit)
    const section = classifyCashFlow(movement.counterpart_types)
    const inflow = net > 0n ? net : 0n
    const outflow = net < 0n ? -net : 0n
    if (movement.in_period) {
      const current = sections[section]
      current.inflows = formatUnits(amountUnits(current.inflows) + inflow)
      current.outflows = formatUnits(amountUnits(current.outflows) + outflow)
      current.net = formatUnits(amountUnits(current.net) + net)
      periodNet += net
    } else {
      opening += net
    }
    const account = byAccount.get(movement.account_id)
    if (account) {
      if (movement.in_period) {
        account.period_inflows = formatUnits(amountUnits(account.period_inflows) + inflow)
        account.period_outflows = formatUnits(amountUnits(account.period_outflows) + outflow)
      } else {
        account.opening_balance = formatUnits(amountUnits(account.opening_balance) + net)
      }
      account.closing_balance = formatUnits(amountUnits(account.opening_balance) +
        amountUnits(account.period_inflows) - amountUnits(account.period_outflows))
    }
  }
  return {
    accounts: accountBalances,
    opening_cash: formatUnits(opening),
    net_change: formatUnits(periodNet),
    closing_cash: formatUnits(opening + periodNet),
    sections
  }
}

function validateDate(value, label, optional = false) {
  if ((value == null || value === '') && optional) return null
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    throw validationError(label + ' must use YYYY-MM-DD')
  }
  const parsed = new Date(value + 'T00:00:00.000Z')
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw validationError(label + ' is invalid')
  }
  return value
}

async function withReportSnapshot(pool, work) {
  const client = await pool.connect()
  let transactionOpen = false
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    transactionOpen = true
    const result = await work(client)
    await client.query('COMMIT')
    transactionOpen = false
    return result
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK')
        transactionOpen = false
      } catch (rollbackError) {
        error.rollbackError = rollbackError
      }
    }
    throw error
  } finally {
    client.release()
  }
}

async function resolveDateRange(pool, tenantId, { from, to, periodId, asOf } = {}) {
  if (!isUuid(tenantId)) throw httpError(401, 'Authenticated tenant identity is required')
  const normalizedFrom = validateDate(from, 'Start date', true)
  const normalizedTo = validateDate(to, 'End date', true)
  const normalizedAsOf = validateDate(asOf, 'As-of date', true)
  if (periodId != null && periodId !== '' && !isUuid(periodId)) {
    throw validationError('A valid accounting period is required')
  }

  let period = null
  if (periodId) {
    const result = await pool.query(
      'SELECT id, name, starts_on, ends_on FROM accounting_periods WHERE tenant_id = $1 AND id = $2',
      [tenantId, periodId]
    )
    if (result.rowCount !== 1) throw httpError(404, 'Accounting period not found')
    period = result.rows[0]
  }

  if (normalizedAsOf) {
    if (period && String(period.ends_on).slice(0, 10) !== normalizedAsOf) {
      throw validationError('As-of date must match the selected accounting period end date')
    }
    return {
      from: null,
      to: normalizedAsOf,
      period: period ? { id: period.id, name: period.name } : null,
      as_of: normalizedAsOf
    }
  }

  if (period) {
    const periodFrom = String(period.starts_on).slice(0, 10)
    const periodTo = String(period.ends_on).slice(0, 10)
    if ((normalizedFrom && normalizedFrom !== periodFrom) || (normalizedTo && normalizedTo !== periodTo)) {
      throw validationError('Date range must match the selected accounting period')
    }
    return { from: periodFrom, to: periodTo, period: { id: period.id, name: period.name } }
  }

  if (!normalizedFrom || !normalizedTo) {
    throw validationError('Provide a start and end date or select an accounting period')
  }
  if (normalizedFrom > normalizedTo) throw validationError('Start date must not follow end date')
  return { from: normalizedFrom, to: normalizedTo, period: null }
}

async function loadSettings(pool, tenantId) {
  const result = await pool.query(
    'SELECT base_currency FROM accounting_settings WHERE tenant_id = $1',
    [tenantId]
  )
  if (result.rowCount !== 1) throw httpError(409, 'Configure the tenant accounting currency before running financial reports')
  return result.rows[0].base_currency
}

async function loadAccountAggregates(pool, tenantId, { from, to }) {
  const result = await pool.query(
    [
      'WITH posted AS (',
      '  SELECT l.account_id, l.debit, l.credit, j.entry_date',
      '  FROM accounting_journal_lines l',
      '  JOIN accounting_journal_entries j',
      '    ON j.tenant_id = l.tenant_id AND j.id = l.journal_entry_id',
      "  WHERE l.tenant_id = $1 AND j.tenant_id = $1 AND j.status = 'posted'",
      '    AND j.entry_date <= $3::date',
      ')',
      'SELECT a.id, a.account_code, a.name, a.account_type, a.normal_balance,',
      "       COALESCE(SUM(p.debit) FILTER (WHERE $2::date IS NOT NULL AND p.entry_date < $2::date), 0)::text AS opening_debit,",
      "       COALESCE(SUM(p.credit) FILTER (WHERE $2::date IS NOT NULL AND p.entry_date < $2::date), 0)::text AS opening_credit,",
      "       COALESCE(SUM(p.debit) FILTER (WHERE $2::date IS NULL OR p.entry_date >= $2::date), 0)::text AS period_debit,",
      "       COALESCE(SUM(p.credit) FILTER (WHERE $2::date IS NULL OR p.entry_date >= $2::date), 0)::text AS period_credit",
      'FROM accounting_accounts a',
      'LEFT JOIN posted p ON p.account_id = a.id',
      'WHERE a.tenant_id = $1',
      'GROUP BY a.id, a.account_code, a.name, a.account_type, a.normal_balance',
      'ORDER BY a.account_code, a.id'
    ].join('\n'),
    [tenantId, from, to]
  )
  return result.rows
}

async function getTrialBalance(pool, tenantId, filters) {
  return withReportSnapshot(pool, async (client) => {
    const range = await resolveDateRange(client, tenantId, filters)
    const currency = await loadSettings(client, tenantId)
    const aggregates = await loadAccountAggregates(client, tenantId, range)
    const result = buildTrialBalance(aggregates)
    return { report: 'trial_balance', currency, range, ...result }
  })
}

async function getGeneralLedger(pool, tenantId, filters = {}) {
  return withReportSnapshot(pool, async (client) => {
  if (filters.asOf != null && filters.asOf !== '') {
    throw validationError('As-of dates are not supported for the general ledger; provide a start and end date or select an accounting period')
  }
  const range = await resolveDateRange(client, tenantId, filters)
  if (!isUuid(filters.accountId)) throw validationError('A valid account is required for the general ledger')
  const parsePageValue = (value, fallback) => {
    if (value == null || value === '') return fallback
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value
    if (typeof value === 'string' && /^\d+$/.test(value)) {
      const parsed = Number(value)
      if (Number.isSafeInteger(parsed)) return parsed
    }
    return Number.NaN
  }
  const page = parsePageValue(filters.page, 1)
  const pageSize = parsePageValue(filters.pageSize, 100)
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
    throw validationError('General ledger page must be positive and page size must be between 1 and 200')
  }
  const reference = typeof filters.reference === 'string' ? filters.reference.trim().slice(0, 100) : ''
  const accountResult = await client.query(
    'SELECT id, account_code, name, account_type, normal_balance FROM accounting_accounts WHERE tenant_id = $1 AND id = $2',
    [tenantId, filters.accountId]
  )
  if (accountResult.rowCount !== 1) throw httpError(404, 'Account not found')
  const account = accountResult.rows[0]
  const [currency, openingResult] = await Promise.all([
    loadSettings(client, tenantId),
    client.query(
      [
        "SELECT COALESCE(SUM(CASE WHEN a.normal_balance = 'debit' THEN l.debit - l.credit ELSE l.credit - l.debit END), 0)::text AS opening_balance",
        'FROM accounting_journal_lines l',
        'JOIN accounting_journal_entries j ON j.tenant_id = l.tenant_id AND j.id = l.journal_entry_id',
        'JOIN accounting_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id',
        "WHERE l.tenant_id = $1 AND j.tenant_id = $1 AND j.status = 'posted'",
        '  AND a.id = $2 AND j.entry_date < $3::date'
      ].join('\n'),
      [tenantId, filters.accountId, range.from]
    )
  ])
  const [countResult, rowsResult] = await Promise.all([
    client.query(
      [
        'SELECT count(*)::integer AS total',
        'FROM accounting_journal_entries j',
        'JOIN accounting_journal_lines l ON l.tenant_id = j.tenant_id AND l.journal_entry_id = j.id',
        "WHERE j.tenant_id = $1 AND j.status = 'posted' AND l.account_id = $2",
        '  AND j.entry_date >= $3::date AND j.entry_date <= $4::date',
        "  AND ($5 = '' OR COALESCE(j.source_reference, '') ILIKE '%' || $5 || '%')"
      ].join('\n'),
      [tenantId, filters.accountId, range.from, range.to, reference]
    ),
    client.query(
      [
        'WITH ledger_lines AS (',
        '  SELECT j.id AS journal_entry_id, j.entry_date, j.created_at, j.description AS journal_description,',
        '         j.source_reference, j.source_type, j.event_type, j.reversal_of_entry_id,',
        '         l.id AS journal_line_id, l.line_number, l.description AS line_description, l.debit, l.credit,',
        "         CASE WHEN a.normal_balance = 'debit' THEN l.debit - l.credit ELSE l.credit - l.debit END AS signed_amount",
        '  FROM accounting_journal_entries j',
        '  JOIN accounting_journal_lines l ON l.tenant_id = j.tenant_id AND l.journal_entry_id = j.id',
        '  JOIN accounting_accounts a ON a.tenant_id = j.tenant_id AND a.id = l.account_id',
        "  WHERE j.tenant_id = $1 AND j.status = 'posted' AND l.account_id = $2",
        '    AND j.entry_date >= $3::date AND j.entry_date <= $4::date',
        '), running_lines AS (',
        '  SELECT ledger_lines.*,',
        '         ($5::numeric + SUM(signed_amount) OVER (ORDER BY entry_date, created_at, journal_entry_id, line_number, journal_line_id',
        '           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW))::text AS running_balance',
        '  FROM ledger_lines',
        ')',
        'SELECT * FROM running_lines',
        "WHERE ($6 = '' OR COALESCE(source_reference, '') ILIKE '%' || $6 || '%')",
        'ORDER BY entry_date, created_at, journal_entry_id, line_number, journal_line_id',
        'LIMIT $7 OFFSET $8'
      ].join('\n'),
      [tenantId, filters.accountId, range.from, range.to, openingResult.rows[0].opening_balance,
        reference, pageSize, (page - 1) * pageSize]
    )
  ])
  const opening = amountUnits(openingResult.rows[0].opening_balance)
  return {
    report: 'general_ledger',
    currency,
    range,
    account,
    opening_balance: balanceSides(opening, account.normal_balance),
    rows: rowsResult.rows.map((row) => {
      const running = amountUnits(row.running_balance)
      const sides = balanceSides(running, account.normal_balance)
      return {
        journal_entry_id: row.journal_entry_id,
        journal_line_id: row.journal_line_id,
        entry_date: String(row.entry_date).slice(0, 10),
        reference: row.source_reference,
        journal_description: row.journal_description,
        line_description: row.line_description,
        source_type: row.source_type,
        event_type: row.event_type,
        reversal_of_entry_id: row.reversal_of_entry_id,
        debit: formatUnits(amountUnits(row.debit)),
        credit: formatUnits(amountUnits(row.credit)),
        running_debit: sides.debit,
        running_credit: sides.credit
      }
    }),
    page,
    page_size: pageSize,
    total_rows: countResult.rows[0].total
  }
  })
}

async function getProfitAndLoss(pool, tenantId, filters) {
  return withReportSnapshot(pool, async (client) => {
    const range = await resolveDateRange(client, tenantId, filters)
    const currency = await loadSettings(client, tenantId)
    const aggregates = await loadAccountAggregates(client, tenantId, range)
    return {
      report: 'profit_and_loss',
      currency,
      range,
      ...buildProfitAndLoss(aggregates)
    }
  })
}

async function getBalanceSheet(pool, tenantId, filters = {}) {
  return withReportSnapshot(pool, async (client) => {
    const resolved = await resolveDateRange(client, tenantId, {
      periodId: filters.periodId,
      asOf: filters.asOf
    })
    const range = { from: null, to: resolved.to, period: resolved.period, as_of: resolved.to }
    const currency = await loadSettings(client, tenantId)
    const aggregates = await loadAccountAggregates(client, tenantId, range)
    return {
      report: 'balance_sheet',
      currency,
      range: { as_of: range.to, period: range.period },
      ...buildBalanceSheet(aggregates)
    }
  })
}

async function getCashFlow(pool, tenantId, filters) {
  return withReportSnapshot(pool, async (client) => {
    const range = await resolveDateRange(client, tenantId, filters)
    if (!range.from) {
      throw validationError('Cash flow requires a start and end date or an accounting period')
    }
    const currency = await loadSettings(client, tenantId)
    const accounts = await client.query(
      `SELECT a.id, a.account_code, a.name
       FROM bank_reconciliation_accounts b
       JOIN accounting_accounts a ON a.tenant_id = b.tenant_id AND a.id = b.account_id
       WHERE b.tenant_id = $1
       ORDER BY a.account_code, a.id`,
      [tenantId]
    )
    const movements = await client.query(
      `WITH cash_lines AS (
         SELECT j.id AS journal_entry_id, j.entry_date, l.account_id, l.debit, l.credit,
                CASE WHEN j.entry_date >= $2::date THEN true ELSE false END AS in_period
         FROM accounting_journal_entries j
         JOIN accounting_journal_lines l ON l.tenant_id = j.tenant_id AND l.journal_entry_id = j.id
         JOIN bank_reconciliation_accounts b ON b.tenant_id = j.tenant_id AND b.account_id = l.account_id
         WHERE j.tenant_id = $1 AND j.status = 'posted' AND j.entry_date <= $3::date
       )
       SELECT c.*,
              COALESCE((
                SELECT array_agg(DISTINCT a.account_type)
                FROM accounting_journal_lines other
                JOIN accounting_accounts a ON a.tenant_id = other.tenant_id AND a.id = other.account_id
                WHERE other.tenant_id = $1 AND other.journal_entry_id = c.journal_entry_id
                  AND other.account_id <> c.account_id
              ), ARRAY[]::text[]) AS counterpart_types
       FROM cash_lines c
       ORDER BY c.entry_date, c.journal_entry_id`,
      [tenantId, range.from, range.to]
    )
    const report = buildCashFlow(accounts.rows, movements.rows)
    return {
      report: 'cash_flow',
      available: true,
      currency,
      range,
      classification_note: 'Cash and bank accounts are the tenant accounts explicitly designated for bank reconciliation. Activity is classified from the posted journal counterpart account types; mixed or unsupported counterpart types are reported as unclassified.',
      ...report
    }
  })
}

function cashFlowUnavailable() {
  return {
    report: 'cash_flow',
    available: false,
    reason: 'Posted journal lines do not record whether cash accounts are cash equivalents or classify cash movements as operating, investing, financing, or transfers.',
    required_configuration: [
      'Classify each cash and bank account as a cash equivalent or non-cash account.',
      'Record a cash-flow activity on each posted cash-equivalent journal line.',
      'Tag internal transfers between cash-equivalent accounts so they are excluded from activity totals.',
      'Confirm the ledger includes opening cash balances from the start of the reporting history.'
    ]
  }
}

module.exports = {
  amountUnits,
  balanceSides,
  buildBalanceSheet,
  buildCashFlow,
  buildProfitAndLoss,
  buildTrialBalance,
  cashFlowUnavailable,
  formatUnits,
  getBalanceSheet,
  getCashFlow,
  getGeneralLedger,
  getProfitAndLoss,
  getTrialBalance,
  normalBalanceUnits,
  resolveDateRange
}

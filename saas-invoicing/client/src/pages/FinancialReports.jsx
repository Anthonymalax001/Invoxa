import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../api'
import { createFinancialReportCsv } from '../utils/financialReportCsv'

const REPORTS = [
  { id: 'trial-balance', label: 'Trial balance' },
  { id: 'general-ledger', label: 'General ledger' },
  { id: 'profit-and-loss', label: 'Profit and loss' },
  { id: 'balance-sheet', label: 'Balance sheet' },
  { id: 'cash-flow', label: 'Cash flow' }
]

function localDate(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return year + '-' + month + '-' + day
}

function emptyDateRange() {
  const now = new Date()
  return { from: localDate(new Date(now.getFullYear(), now.getMonth(), 1)), to: localDate(now) }
}

function amount(currency, value) {
  return (currency || '') + ' ' + (value == null ? '0.000000' : value)
}

function fileSafeDate(value) {
  return String(value || 'report').replace(/[^0-9A-Za-z-]/g, '')
}

export default function FinancialReports() {
  const initialRange = emptyDateRange()
  const [reportType, setReportType] = useState('trial-balance')
  const [from, setFrom] = useState(initialRange.from)
  const [to, setTo] = useState(initialRange.to)
  const [periods, setPeriods] = useState([])
  const [accounts, setAccounts] = useState([])
  const [periodId, setPeriodId] = useState('')
  const [accountId, setAccountId] = useState('')
  const [reference, setReference] = useState('')
  const [page, setPage] = useState(1)
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(false)
  const [setupLoading, setSetupLoading] = useState(true)
  const [error, setError] = useState('')
  const [setupError, setSetupError] = useState('')
  const [journal, setJournal] = useState(null)
  const [journalError, setJournalError] = useState('')

  useEffect(() => {
    let active = true
    Promise.all([
      api.get('/accounting/periods'),
      api.get('/accounting/accounts', { params: { active: 'all' } })
    ]).then(([periodResult, accountResult]) => {
      if (!active) return
      setPeriods(periodResult.data || [])
      setAccounts(accountResult.data || [])
    }).catch((requestError) => {
      if (active) setSetupError(requestError.response?.data?.error || 'Could not load accounting periods and accounts.')
    }).finally(() => {
      if (active) setSetupLoading(false)
    })
    return () => { active = false }
  }, [])

  const title = useMemo(() => REPORTS.find((item) => item.id === reportType)?.label || 'Financial reports', [reportType])

  async function runReport(type = reportType, selectedAccount = accountId, selectedPage = 1) {
    setError('')
    setLoading(true)
    setPage(selectedPage)
    try {
      let response
      if (type === 'cash-flow') {
        const params = periodId ? { period_id: periodId } : { from, to }
        response = await api.get('/accounting/reports/cash-flow', { params })
      } else {
        const params = periodId ? { period_id: periodId } : {}
        if (type === 'balance-sheet') {
          if (!periodId) params.as_of = to
        } else if (!periodId) {
          params.from = from
          params.to = to
        }
        let endpoint = '/accounting/reports/' + type
        if (type === 'general-ledger') {
          if (!selectedAccount) {
            setError('Choose an account to view its general ledger.')
            setLoading(false)
            return
          }
          params.account_id = selectedAccount
          params.reference = reference
          params.page = selectedPage
          params.page_size = 100
        }
        response = await api.get(endpoint, { params })
      }
      setReport(response.data)
    } catch (requestError) {
      setReport(null)
      setError(requestError.response?.data?.error || 'Could not generate this report.')
    } finally {
      setLoading(false)
    }
  }

  function changeReport(type) {
    setReportType(type)
    setReport(null)
    setError('')
    setPage(1)
  }

  function openLedger(id) {
    setReportType('general-ledger')
    setAccountId(id)
    setPage(1)
    runReport('general-ledger', id, 1)
  }

  async function openJournal(id) {
    setJournal(null)
    setJournalError('')
    try {
      const response = await api.get('/accounting/journals/' + id)
      setJournal(response.data)
    } catch (requestError) {
      setJournalError(requestError.response?.data?.error || 'Could not load journal details.')
    }
  }

  function exportRows() {
    if (!report || report.available === false) return null
    if (reportType === 'trial-balance') {
      return {
        columns: [
          { key: 'account_code', label: 'Account code', type: 'text' },
          { key: 'account_name', label: 'Account name', type: 'text' },
          { key: 'opening_debit', label: 'Opening debit', type: 'number' },
          { key: 'opening_credit', label: 'Opening credit', type: 'number' },
          { key: 'debit_movement', label: 'Period debits', type: 'number' },
          { key: 'credit_movement', label: 'Period credits', type: 'number' },
          { key: 'closing_debit', label: 'Closing debit', type: 'number' },
          { key: 'closing_credit', label: 'Closing credit', type: 'number' }
        ],
        rows: report.rows
      }
    }
    if (reportType === 'general-ledger') {
      return {
        columns: [
          { key: 'entry_date', label: 'Posting date', type: 'text' },
          { key: 'journal_entry_id', label: 'Journal ID', type: 'text' },
          { key: 'reference', label: 'Reference', type: 'text' },
          { key: 'description', label: 'Description', type: 'text' },
          { key: 'debit', label: 'Debit', type: 'number' },
          { key: 'credit', label: 'Credit', type: 'number' },
          { key: 'running_debit', label: 'Running debit balance', type: 'number' },
          { key: 'running_credit', label: 'Running credit balance', type: 'number' }
        ],
        rows: report.rows.map((row) => ({
          ...row,
          description: row.line_description || row.journal_description
        }))
      }
    }
    if (reportType === 'profit-and-loss') {
      const rows = [
        ...report.revenue_accounts.map((row) => ({ section: 'Revenue', account_code: row.account_code, account_name: row.account_name, amount: row.amount })),
        { section: 'Total revenue', account_code: '', account_name: '', amount: report.revenue_total },
        ...report.expense_accounts.map((row) => ({ section: 'Expenses', account_code: row.account_code, account_name: row.account_name, amount: row.amount })),
        { section: 'Total expenses', account_code: '', account_name: '', amount: report.expense_total },
        { section: 'Net profit / (loss)', account_code: '', account_name: '', amount: report.net_profit }
      ]
      return {
        columns: [
          { key: 'section', label: 'Section', type: 'text' },
          { key: 'account_code', label: 'Account code', type: 'text' },
          { key: 'account_name', label: 'Account name', type: 'text' },
          { key: 'amount', label: report.currency + ' amount', type: 'number' }
        ],
        rows
      }
    }
    if (reportType === 'cash-flow') {
      const rows = Object.entries(report.sections).flatMap(([section, values]) => [
        { section, account_code: '', account_name: 'Inflows', amount: values.inflows },
        { section, account_code: '', account_name: 'Outflows', amount: values.outflows },
        { section, account_code: '', account_name: 'Net', amount: values.net }
      ])
      return {
        columns: [
          { key: 'section', label: 'Activity', type: 'text' },
          { key: 'account_code', label: 'Account code', type: 'text' },
          { key: 'account_name', label: 'Line', type: 'text' },
          { key: 'amount', label: report.currency + ' amount', type: 'number' }
        ],
        rows: [
          { section: 'Opening cash', account_code: '', account_name: '', amount: report.opening_cash },
          ...rows,
          { section: 'Closing cash', account_code: '', account_name: '', amount: report.closing_cash }
        ]
      }
    }
    const rows = [
      ...report.assets.map((row) => ({ section: 'Assets', account_code: row.account_code, account_name: row.account_name, amount: row.balance })),
      { section: 'Total assets', account_code: '', account_name: '', amount: report.total_assets },
      ...report.liabilities.map((row) => ({ section: 'Liabilities', account_code: row.account_code, account_name: row.account_name, amount: row.balance })),
      { section: 'Total liabilities', account_code: '', account_name: '', amount: report.total_liabilities },
      ...report.equity.map((row) => ({ section: 'Equity', account_code: row.account_code, account_name: row.account_name, amount: row.balance })),
      { section: 'Unclosed earnings', account_code: '', account_name: '', amount: report.unclosed_earnings },
      { section: 'Total liabilities and equity', account_code: '', account_name: '', amount: report.total_liabilities_and_equity }
    ]
    return {
      columns: [
        { key: 'section', label: 'Section', type: 'text' },
        { key: 'account_code', label: 'Account code', type: 'text' },
        { key: 'account_name', label: 'Account name', type: 'text' },
        { key: 'amount', label: report.currency + ' amount', type: 'number' }
      ],
      rows
    }
  }

  function downloadCsv() {
    const data = exportRows()
    if (!data) return
    const content = createFinancialReportCsv(data.columns, data.rows)
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    const suffix = report.range?.to || report.range?.as_of || to
    anchor.href = url
    anchor.download = 'invoxa-' + reportType + '-' + fileSafeDate(suffix) + '.csv'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  function drillLink(account) {
    return (
      <button type="button" className="font-medium text-blue-700 underline" onClick={() => openLedger(account.account_id)}>
        {account.account_code} · {account.account_name}
      </button>
    )
  }

  function reportRangeLabel() {
    if (!report?.range) return ''
    if (report.range.as_of) return 'As of ' + report.range.as_of
    if (report.range.period) return report.range.period.name + ' · ' + report.range.from + ' – ' + report.range.to
    return report.range.from + ' – ' + report.range.to
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <nav className="no-print flex flex-wrap items-center justify-between gap-3 border-b bg-white px-4 py-4 sm:px-6">
        <Link to="/dashboard" className="text-xl font-bold text-blue-700">Invoxa</Link>
        <div className="flex flex-wrap gap-4 text-sm font-medium text-gray-600">
          <Link to="/dashboard" className="hover:text-blue-700">Dashboard</Link>
          <Link to="/invoices" className="hover:text-blue-700">Invoices</Link>
          <Link to="/supplier-bills" className="hover:text-blue-700">Supplier bills</Link>
          <Link to="/financial-reports" className="text-blue-700">Financial reports</Link>
          <Link to="/accounting-periods" className="hover:text-blue-700">Accounting periods</Link>
        </div>
      </nav>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
        <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold sm:text-3xl">Financial reports</h1>
            <p className="mt-1 text-sm text-gray-600">Built from posted accounting journals in the authenticated tenant ledger.</p>
          </div>
          <div className="no-print flex gap-2">
            <button type="button" onClick={downloadCsv} disabled={!report || report.available === false} className="rounded-lg border bg-white px-3 py-2 text-sm font-semibold disabled:opacity-50">{reportType === 'general-ledger' ? 'Export page CSV' : 'Export CSV'}</button>
            <button type="button" onClick={() => window.print()} disabled={!report} className="rounded-lg border bg-white px-3 py-2 text-sm font-semibold disabled:opacity-50">Print / Save PDF</button>
          </div>
        </header>

        <section className="no-print mb-6 rounded-xl border bg-white p-4 shadow-sm">
          <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Financial report">
            {REPORTS.map((item) => (
              <button key={item.id} type="button" role="tab" aria-selected={reportType === item.id} onClick={() => changeReport(item.id)} className={'rounded-lg px-3 py-2 text-sm font-semibold ' + (reportType === item.id ? 'bg-blue-700 text-white' : 'bg-gray-100 text-gray-700')}>
                {item.label}
              </button>
            ))}
          </div>

          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
            <label className="text-sm font-medium">Accounting period
              <select value={periodId} onChange={(event) => setPeriodId(event.target.value)} className="mt-1 w-full rounded border p-2">
                <option value="">Use dates</option>
                {periods.map((period) => <option key={period.id} value={period.id}>{period.name} ({String(period.starts_on).slice(0, 10)} – {String(period.ends_on).slice(0, 10)})</option>)}
              </select>
            </label>
            {reportType === 'balance-sheet' ? (
              <label className="text-sm font-medium">As-of date
                <input type="date" value={to} disabled={Boolean(periodId)} onChange={(event) => setTo(event.target.value)} className="mt-1 w-full rounded border p-2 disabled:bg-gray-100" />
              </label>
            ) : (
              <>
                <label className="text-sm font-medium">From
                  <input type="date" value={from} disabled={Boolean(periodId)} onChange={(event) => setFrom(event.target.value)} className="mt-1 w-full rounded border p-2 disabled:bg-gray-100" />
                </label>
                <label className="text-sm font-medium">To
                  <input type="date" value={to} disabled={Boolean(periodId)} onChange={(event) => setTo(event.target.value)} className="mt-1 w-full rounded border p-2 disabled:bg-gray-100" />
                </label>
              </>
            )}
            {reportType === 'general-ledger' && (
              <>
                <label className="text-sm font-medium">Account
                  <select value={accountId} onChange={(event) => setAccountId(event.target.value)} className="mt-1 w-full rounded border p-2">
                    <option value="">Choose account</option>
                    {accounts.map((account) => <option key={account.id} value={account.id}>{account.account_code} · {account.name}</option>)}
                  </select>
                </label>
                <label className="text-sm font-medium">Reference contains
                  <input value={reference} onChange={(event) => setReference(event.target.value)} maxLength={100} className="mt-1 w-full rounded border p-2" />
                </label>
              </>
            )}
          </div>

          {setupError && <p role="alert" className="mt-3 rounded bg-amber-50 p-3 text-sm text-amber-800">{setupError}</p>}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => runReport()} disabled={loading || setupLoading} className="rounded-lg bg-blue-700 px-4 py-2 font-semibold text-white disabled:opacity-60">{loading ? 'Loading…' : 'Generate report'}</button>
            {setupLoading && <span className="text-sm text-gray-500">Loading accounting setup…</span>}
            {reportType === 'cash-flow' && <span className="text-sm text-gray-500">Cash flow uses designated bank accounts and posted journal activity.</span>}
          </div>
          {error && <p role="alert" className="mt-3 rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        </section>

        {report && (
          <section className="report-paper rounded-xl border bg-white p-4 shadow-sm sm:p-6">
            <div className="mb-5 border-b pb-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-blue-700">Invoxa · Financial reporting</p>
              <h2 className="mt-1 text-xl font-bold">{title}</h2>
              <p className="mt-1 text-sm text-gray-600">{reportRangeLabel()}</p>
              {report.currency && <p className="text-sm text-gray-600">Functional currency: {report.currency}</p>}
            </div>

            {report.available === false ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                <h3 className="font-semibold text-amber-900">Cash flow statement unavailable</h3>
                <p className="mt-1 text-sm text-amber-900">{report.reason}</p>
                <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-amber-900">
                  {report.required_configuration.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </div>
            ) : reportType === 'trial-balance' ? (
              <>
                {!report.balanced && <p role="alert" className="mb-3 rounded bg-red-50 p-3 text-sm text-red-700">The posted ledger does not balance for this range.</p>}
                {report.rows.length === 0 ? <p className="py-8 text-center text-gray-500">No accounts are configured for this tenant.</p> : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[900px] text-left text-sm">
                      <thead className="bg-gray-50 text-xs uppercase text-gray-600"><tr><th className="p-2">Account</th><th className="p-2 text-right">Opening debit</th><th className="p-2 text-right">Opening credit</th><th className="p-2 text-right">Period debits</th><th className="p-2 text-right">Period credits</th><th className="p-2 text-right">Closing debit</th><th className="p-2 text-right">Closing credit</th></tr></thead>
                      <tbody>
                        {report.rows.map((row) => <tr key={row.account_id} className="border-t"><td className="p-2">{drillLink(row)}</td><td className="p-2 text-right tabular-nums">{row.opening_debit}</td><td className="p-2 text-right tabular-nums">{row.opening_credit}</td><td className="p-2 text-right tabular-nums">{row.debit_movement}</td><td className="p-2 text-right tabular-nums">{row.credit_movement}</td><td className="p-2 text-right tabular-nums">{row.closing_debit}</td><td className="p-2 text-right tabular-nums">{row.closing_credit}</td></tr>)}
                      </tbody>
                      <tfoot className="border-t-2 bg-gray-50 font-bold"><tr><td className="p-2">Total · {report.currency}</td><td className="p-2 text-right">{report.totals.opening_debit}</td><td className="p-2 text-right">{report.totals.opening_credit}</td><td className="p-2 text-right">{report.totals.debit_movement}</td><td className="p-2 text-right">{report.totals.credit_movement}</td><td className="p-2 text-right">{report.totals.closing_debit}</td><td className="p-2 text-right">{report.totals.closing_credit}</td></tr></tfoot>
                    </table>
                  </div>
                )}
              </>
            ) : reportType === 'general-ledger' ? (
              <>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm">
                  <p><strong>{report.account.account_code} · {report.account.name}</strong> · Opening balance {amount(report.currency, report.opening_balance.debit !== '0.000000' ? report.opening_balance.debit + ' Dr' : report.opening_balance.credit + ' Cr')}</p>
                  <p>{report.total_rows} matching entries · Page {report.page}</p>
                </div>
                {report.rows.length === 0 ? <p className="py-8 text-center text-gray-500">No posted journal lines match this filter.</p> : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[900px] text-left text-sm">
                      <thead className="bg-gray-50 text-xs uppercase text-gray-600"><tr><th className="p-2">Date</th><th className="p-2">Journal ID</th><th className="p-2">Reference</th><th className="p-2">Description</th><th className="p-2 text-right">Debit</th><th className="p-2 text-right">Credit</th><th className="p-2 text-right">Running debit</th><th className="p-2 text-right">Running credit</th></tr></thead>
                      <tbody>
                        {report.rows.map((row) => <tr key={row.journal_line_id} className="border-t"><td className="p-2">{row.entry_date}</td><td className="p-2"><button type="button" title={row.journal_entry_id} onClick={() => openJournal(row.journal_entry_id)} className="font-medium text-blue-700 underline">{String(row.journal_entry_id).slice(0, 8)}…</button>{row.reversal_of_entry_id && <span className="ml-1 text-xs text-gray-500" title={'Reversal of ' + row.reversal_of_entry_id}>reversal</span>}</td><td className="p-2">{row.reference || '—'}</td><td className="p-2">{row.line_description || row.journal_description}</td><td className="p-2 text-right tabular-nums">{row.debit}</td><td className="p-2 text-right tabular-nums">{row.credit}</td><td className="p-2 text-right tabular-nums">{row.running_debit}</td><td className="p-2 text-right tabular-nums">{row.running_credit}</td></tr>)}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="no-print mt-4 flex justify-end gap-2">
                  <button type="button" disabled={loading || report.page <= 1} onClick={() => runReport('general-ledger', accountId, page - 1)} className="rounded border px-3 py-2 disabled:opacity-50">Previous</button>
                  <button type="button" disabled={loading || report.page * report.page_size >= report.total_rows} onClick={() => runReport('general-ledger', accountId, page + 1)} className="rounded border px-3 py-2 disabled:opacity-50">Next</button>
                </div>
              </>
            ) : reportType === 'cash-flow' ? (
              <>
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                  {Object.entries(report.sections).map(([section, values]) => (
                    <div key={section} className="rounded border p-3">
                      <h3 className="font-bold capitalize">{section}</h3>
                      <p className="mt-2 text-sm">Inflows <strong>{amount(report.currency, values.inflows)}</strong></p>
                      <p className="text-sm">Outflows <strong>{amount(report.currency, values.outflows)}</strong></p>
                      <p className="mt-2 border-t pt-2 font-semibold">Net {amount(report.currency, values.net)}</p>
                    </div>
                  ))}
                </div>
                <div className="mt-5 space-y-2 border-t-2 pt-3 text-right">
                  <p>Opening cash <strong>{amount(report.currency, report.opening_cash)}</strong></p>
                  <p>Net change <strong>{amount(report.currency, report.net_change)}</strong></p>
                  <p>Closing cash <strong>{amount(report.currency, report.closing_cash)}</strong></p>
                </div>
                <p className="mt-3 rounded bg-blue-50 p-3 text-sm text-blue-900">{report.classification_note}</p>
              </>
            ) : reportType === 'profit-and-loss' ? (
              <>
                <div className="grid gap-6 md:grid-cols-2">
                  <div>
                    <h3 className="mb-2 font-bold">Revenue</h3>
                    <ReportAccountTable accounts={report.revenue_accounts} currency={report.currency} onDrill={openLedger} />
                    <p className="mt-2 flex justify-between border-t pt-2 font-semibold"><span>Total revenue</span><span>{amount(report.currency, report.revenue_total)}</span></p>
                  </div>
                  <div>
                    <h3 className="mb-2 font-bold">Expenses</h3>
                    <ReportAccountTable accounts={report.expense_accounts} currency={report.currency} onDrill={openLedger} />
                    <p className="mt-2 flex justify-between border-t pt-2 font-semibold"><span>Total expenses</span><span>{amount(report.currency, report.expense_total)}</span></p>
                  </div>
                </div>
                <p className="mt-6 flex justify-between border-t-2 pt-3 text-lg font-bold"><span>Net profit / (loss)</span><span>{amount(report.currency, report.net_profit)}</span></p>
                <p className="mt-3 rounded bg-blue-50 p-3 text-sm text-blue-900">{report.classification_note}</p>
              </>
            ) : (
              <>
                {!report.balanced && <p role="alert" className="mb-3 rounded bg-red-50 p-3 text-sm text-red-700">Assets do not equal liabilities plus equity and unclosed earnings.</p>}
                <BalanceSheetSection title="Assets" accounts={report.assets} total={report.total_assets} currency={report.currency} onDrill={openLedger} />
                <BalanceSheetSection title="Liabilities" accounts={report.liabilities} total={report.total_liabilities} currency={report.currency} onDrill={openLedger} />
                <BalanceSheetSection title="Equity" accounts={report.equity} total={report.total_equity} currency={report.currency} onDrill={openLedger} />
                <div className="mt-5 space-y-2 border-t-2 pt-3 text-right">
                  <p>Unclosed earnings <strong>{amount(report.currency, report.unclosed_earnings)}</strong></p>
                  <p className="text-lg font-bold">Total liabilities and equity <strong>{amount(report.currency, report.total_liabilities_and_equity)}</strong></p>
                  <p className="text-sm text-gray-600">Total assets <strong>{amount(report.currency, report.total_assets)}</strong></p>
                </div>
                <p className="mt-4 rounded bg-blue-50 p-3 text-sm text-blue-900">{report.classification_note}</p>
              </>
            )}
          </section>
        )}
      </main>

      {journal && (
        <div className="no-print fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setJournal(null)}>
          <section role="dialog" aria-modal="true" aria-label="Journal details" onClick={(event) => event.stopPropagation()} className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-xl bg-white p-5 shadow-xl">
            <div className="mb-4 flex items-start justify-between gap-3"><div><h2 className="text-xl font-bold">Journal details</h2><p className="text-sm text-gray-600">{journal.entry_date} · {journal.source_reference || journal.id}</p></div><button type="button" onClick={() => setJournal(null)} className="rounded border px-3 py-1">Close</button></div>
            {journal.reversal_of_entry_id && <p className="mb-3 rounded bg-amber-50 p-3 text-sm">Reversal of journal {journal.reversal_of_entry_id}</p>}
            <p className="mb-3 text-sm">{journal.description}</p>
            {journalError && <p role="alert" className="mb-3 text-sm text-red-700">{journalError}</p>}
            <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b"><th className="p-2">Account</th><th className="p-2">Description</th><th className="p-2 text-right">Debit</th><th className="p-2 text-right">Credit</th></tr></thead><tbody>{journal.lines?.map((line) => <tr key={line.line_number} className="border-b"><td className="p-2">{line.account_code} · {line.account_name}</td><td className="p-2">{line.description || '—'}</td><td className="p-2 text-right">{line.debit}</td><td className="p-2 text-right">{line.credit}</td></tr>)}</tbody></table></div>
          </section>
        </div>
      )}
      {!journal && journalError && <div className="no-print fixed bottom-4 right-4 rounded bg-red-700 p-3 text-white" role="alert">{journalError}<button onClick={() => setJournalError('')} className="ml-3 underline">Dismiss</button></div>}
    </div>
  )
}

function ReportAccountTable({ accounts, currency, onDrill }) {
  if (!accounts.length) return <p className="rounded bg-gray-50 p-3 text-sm text-gray-500">No posted balance in this section for the selected range.</p>
  return (
    <table className="w-full text-left text-sm">
      <thead><tr className="border-b text-xs uppercase text-gray-500"><th className="p-2">Account</th><th className="p-2 text-right">Amount</th></tr></thead>
      <tbody>{accounts.map((account) => <tr key={account.account_id} className="border-b"><td className="p-2"><button type="button" onClick={() => onDrill(account.account_id)} className="text-left font-medium text-blue-700 underline">{account.account_code} · {account.account_name}</button></td><td className="p-2 text-right tabular-nums">{amount(currency, account.amount)}</td></tr>)}</tbody>
    </table>
  )
}

function BalanceSheetSection({ title, accounts, total, currency, onDrill }) {
  return (
    <section className="mb-5">
      <h3 className="mb-2 font-bold">{title}</h3>
      {accounts.length ? (
        <table className="w-full text-left text-sm">
          <tbody>{accounts.map((account) => <tr key={account.account_id} className="border-b"><td className="p-2"><button type="button" onClick={() => onDrill(account.account_id)} className="text-left font-medium text-blue-700 underline">{account.account_code} · {account.account_name}</button></td><td className="p-2 text-right tabular-nums">{amount(currency, account.balance)}</td></tr>)}</tbody>
        </table>
      ) : <p className="rounded bg-gray-50 p-3 text-sm text-gray-500">No posted balance in this section.</p>}
      <p className="mt-2 flex justify-between border-t pt-2 font-semibold"><span>Total {title.toLowerCase()}</span><span>{amount(currency, total)}</span></p>
    </section>
  )
}

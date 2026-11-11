import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../api'

const base = '/accounting/bank-reconciliation'
const empty = []

function amount(value, currency) {
  return `${currency || ''} ${value ?? '0.000000'}`.trim()
}

function dateText(value) {
  return value ? String(value).slice(0, 10) : '—'
}

function errorText(error, fallback) {
  return error.response?.data?.error || fallback
}

export default function BankReconciliation() {
  const user = useMemo(() => {
    try { return JSON.parse(sessionStorage.getItem('user') || '{}') }
    catch { return {} }
  }, [])
  const isAdmin = user.role === 'admin'
  const [accounts, setAccounts] = useState(empty)
  const [candidates, setCandidates] = useState(empty)
  const [ledgerAccounts, setLedgerAccounts] = useState(empty)
  const [periods, setPeriods] = useState(empty)
  const [imports, setImports] = useState(empty)
  const [selectedAccount, setSelectedAccount] = useState('')
  const [selectedBatch, setSelectedBatch] = useState('')
  const [detail, setDetail] = useState(null)
  const [page, setPage] = useState(1)
  const [importPage, setImportPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [candidateAccount, setCandidateAccount] = useState('')
  const [bankLabel, setBankLabel] = useState('')
  const [file, setFile] = useState(null)
  const [csvText, setCsvText] = useState('')
  const [openingBalance, setOpeningBalance] = useState('')
  const [closingBalance, setClosingBalance] = useState('')
  const [preview, setPreview] = useState(null)

  const [suggestions, setSuggestions] = useState({})
  const [chosenLines, setChosenLines] = useState({})
  const [confirmMatch, setConfirmMatch] = useState({})
  const [unmatchReasons, setUnmatchReasons] = useState({})
  const [adjustmentForm, setAdjustmentForm] = useState({})
  const [reconcileConfirm, setReconcileConfirm] = useState(false)
  const [reopenReason, setReopenReason] = useState('')

  const loadCore = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [accountResponse, candidateResponse, ledgerResponse, periodResponse] = await Promise.all([
        api.get(`${base}/accounts`),
        api.get(`${base}/account-candidates`),
        api.get('/accounting/accounts?active=true'),
        api.get('/accounting/periods')
      ])
      const nextAccounts = accountResponse.data || []
      setAccounts(nextAccounts)
      setCandidates(candidateResponse.data || [])
      setLedgerAccounts(ledgerResponse.data || [])
      setPeriods(periodResponse.data || [])
      setSelectedAccount((current) => current || nextAccounts[0]?.account_id || '')
    } catch (requestError) {
      setError(errorText(requestError, 'Could not load bank reconciliation setup.'))
    } finally {
      setLoading(false)
    }
  }, [])

  const loadImports = useCallback(async () => {
    try {
      const response = await api.get(`${base}/imports`, {
        params: { account_id: selectedAccount || undefined, page: importPage, page_size: 10 }
      })
      setImports(response.data.imports || [])
      if (selectedBatch && !response.data.imports?.some((item) => item.id === selectedBatch) && importPage === 1) {
        setSelectedBatch('')
      }
    } catch (requestError) {
      setError(errorText(requestError, 'Could not load statement import history.'))
    }
  }, [selectedAccount, importPage, selectedBatch])

  const loadDetail = useCallback(async (batchId = selectedBatch, nextPage = page) => {
    if (!batchId) { setDetail(null); return }
    try {
      const response = await api.get(`${base}/imports/${batchId}`, { params: { page: nextPage, page_size: 25 } })
      setDetail(response.data)
      setSuggestions({})
      setChosenLines({})
      setConfirmMatch({})
    } catch (requestError) {
      setError(errorText(requestError, 'Could not load reconciliation details.'))
    }
  }, [selectedBatch, page])

  useEffect(() => { loadCore() }, [loadCore])
  useEffect(() => { loadImports() }, [loadImports])
  useEffect(() => { if (selectedBatch) loadDetail(selectedBatch, page) }, [selectedBatch, page, loadDetail])

  const selectedBankAccount = accounts.find((account) => account.account_id === selectedAccount)
  const selectedCurrency = preview?.currency || selectedBankAccount?.currency || ''
  const detailBatch = detail?.batch
  const transactions = detail?.statement_transactions?.rows || empty
  const unmatchedLedger = detail?.unmatched_ledger_transactions?.rows || empty
  const pageCount = Math.max(1, Math.ceil((detail?.statement_transactions?.total || 0) / (detail?.page_size || 25)))

  async function enableBankAccount(event) {
    event.preventDefault()
    setBusy(true); setError(''); setNotice('')
    try {
      await api.post(`${base}/accounts`, { account_id: candidateAccount, bank_label: bankLabel.trim() })
      setCandidateAccount(''); setBankLabel('')
      setNotice('Bank account is ready for reconciliation.')
      await loadCore()
    } catch (requestError) { setError(errorText(requestError, 'Could not enable this account.')) }
    finally { setBusy(false) }
  }

  async function readFile(nextFile) {
    setFile(nextFile || null)
    setPreview(null)
    setNotice('')
    if (!nextFile) { setCsvText(''); return }
    if (nextFile.size > 1024 * 1024) {
      setCsvText('')
      setError('CSV file must be 1 MiB or smaller.')
      return
    }
    try { setCsvText(await nextFile.text()); setError('') }
    catch { setCsvText(''); setError('Could not read the selected CSV file.') }
  }

  async function validateStatement(event) {
    event.preventDefault()
    setBusy(true); setError(''); setNotice(''); setPreview(null)
    try {
      const response = await api.post(`${base}/imports/preview`, {
        account_id: selectedAccount,
        file_name: file?.name || '',
        csv_text: csvText,
        opening_balance: openingBalance,
        closing_balance: closingBalance
      })
      setPreview(response.data)
      if (!response.data.valid) setError('Review the validation errors below, then correct the CSV and preview it again.')
      else setError('')
    } catch (requestError) { setError(errorText(requestError, 'Could not validate this statement.')) }
    finally { setBusy(false) }
  }

  async function importStatement() {
    if (!preview?.valid || !file) return
    setBusy(true); setError(''); setNotice('')
    try {
      const response = await api.post(`${base}/imports`, {
        account_id: selectedAccount, file_name: file.name, csv_text: csvText,
        opening_balance: openingBalance, closing_balance: closingBalance,
        preview_token: preview.preview_token, confirm: true
      }, { headers: { 'Idempotency-Key': `bank-import-${crypto.randomUUID()}` } })
      setSelectedBatch(response.data.id)
      setPage(1); setImportPage(1); setPreview(null); setFile(null); setCsvText('')
      setNotice(response.data.replayed ? 'This import was already recorded.' : 'Bank statement imported.')
      await loadImports()
    } catch (requestError) { setError(errorText(requestError, 'Could not import this statement.')) }
    finally { setBusy(false) }
  }

  async function findSuggestions(transactionId) {
    setError('')
    try {
      const response = await api.get(`${base}/transactions/${transactionId}/suggestions`)
      setSuggestions((current) => ({ ...current, [transactionId]: response.data }))
    } catch (requestError) { setError(errorText(requestError, 'Could not find posted ledger matches.')) }
  }

  async function matchTransaction(transactionId) {
    const journalLineId = chosenLines[transactionId]
    if (!journalLineId || !confirmMatch[transactionId]) return
    setBusy(true); setError(''); setNotice('')
    try {
      await api.post(`${base}/transactions/${transactionId}/match`, { journal_line_id: journalLineId, confirm: true })
      setNotice('Transaction matched to a posted journal line.')
      await loadDetail(selectedBatch, page)
    } catch (requestError) { setError(errorText(requestError, 'Could not match this transaction.')) }
    finally { setBusy(false) }
  }

  async function unmatchTransaction(transactionId) {
    const reason = unmatchReasons[transactionId]?.trim()
    if (!reason) { setError('Enter a reason before releasing this match.'); return }
    setBusy(true); setError(''); setNotice('')
    try {
      await api.post(`${base}/transactions/${transactionId}/unmatch`, { reason })
      setNotice('Match released and recorded in the audit history.')
      await loadDetail(selectedBatch, page)
    } catch (requestError) { setError(errorText(requestError, 'Could not release this match.')) }
    finally { setBusy(false) }
  }

  async function postAdjustment(transactionId) {
    const form = adjustmentForm[transactionId] || {}
    if (!form.confirm) { setError('Confirm the adjustment after reviewing its account and amount.'); return }
    setBusy(true); setError(''); setNotice('')
    try {
      await api.post(`${base}/transactions/${transactionId}/adjustment`, {
        offset_account_id: form.account_id,
        accounting_period_id: form.period_id,
        description: form.description,
        confirm: true
      }, { headers: { 'Idempotency-Key': `bank-adjustment-${transactionId}-v1` } })
      setNotice('Adjustment posted through accounting and matched to the statement transaction.')
      await loadDetail(selectedBatch, page)
    } catch (requestError) { setError(errorText(requestError, 'Could not post this adjustment.')) }
    finally { setBusy(false) }
  }

  async function completeReconciliation() {
    if (!reconcileConfirm) { setError('Confirm that you reviewed the matches and the reconciliation difference.'); return }
    setBusy(true); setError(''); setNotice('')
    try {
      await api.post(`${base}/imports/${selectedBatch}/reconcile`, { confirm: true })
      setReconcileConfirm(false)
      setNotice('Reconciliation completed and recorded in the audit history.')
      await loadDetail(selectedBatch, page); await loadImports()
    } catch (requestError) { setError(errorText(requestError, 'Could not complete reconciliation.')) }
    finally { setBusy(false) }
  }

  async function reopenReconciliation() {
    if (!reopenReason.trim()) { setError('Enter a reason before reopening this reconciliation.'); return }
    setBusy(true); setError(''); setNotice('')
    try {
      await api.post(`${base}/imports/${selectedBatch}/reopen`, { reason: reopenReason.trim() })
      setReopenReason('')
      setNotice('Reconciliation reopened. The reason was added to its audit history.')
      await loadDetail(selectedBatch, page); await loadImports()
    } catch (requestError) { setError(errorText(requestError, 'Could not reopen reconciliation.')) }
    finally { setBusy(false) }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="flex flex-wrap items-center gap-4 border-b bg-white px-4 py-4 text-sm font-medium text-gray-600 sm:px-6">
        <Link to="/dashboard" className="mr-2 text-xl font-bold text-blue-600">Invoxa</Link>
        <Link to="/dashboard" className="hover:text-blue-600">Dashboard</Link>
        <Link to="/financial-reports" className="hover:text-blue-600">Financial Reports</Link>
        <span className="text-blue-700">Bank Reconciliation</span>
      </nav>

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6">
        <header>
          <h1 className="text-2xl font-bold text-gray-900">Bank Reconciliation</h1>
          <p className="mt-1 text-sm text-gray-600">Import a statement, match its transactions to posted journals, and review any difference before completing the reconciliation.</p>
        </header>

        {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}
        {notice && <div role="status" className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">{notice}</div>}

        {isAdmin && candidates.some((candidate) => candidate.is_active && !candidate.already_designated) && (
          <section className="rounded-xl border bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold text-gray-900">Set up a bank account</h2>
            <p className="mt-1 text-sm text-gray-600">Choose an active debit-normal asset account after confirming it represents a bank account in your chart.</p>
            <form onSubmit={enableBankAccount} className="mt-4 grid gap-3 md:grid-cols-[1fr_1fr_auto]">
              <select required value={candidateAccount} onChange={(event) => setCandidateAccount(event.target.value)} className="rounded-md border px-3 py-2 text-sm">
                <option value="">Choose an eligible account</option>
                {candidates.filter((candidate) => candidate.is_active && !candidate.already_designated).map((candidate) => <option key={candidate.account_id} value={candidate.account_id}>{candidate.account_code} · {candidate.account_name}</option>)}
              </select>
              <input required maxLength={150} value={bankLabel} onChange={(event) => setBankLabel(event.target.value)} placeholder="Bank label, e.g. Main operating account" className="rounded-md border px-3 py-2 text-sm" />
              <button disabled={busy || !candidateAccount} className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Enable account</button>
            </form>
          </section>
        )}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
          <section className="rounded-xl border bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold text-gray-900">Statement import</h2>
            <p className="mt-1 text-sm text-gray-600">Use the documented CSV format. Each import is validated before it is saved.</p>
            <div className="mt-4 space-y-4">
              <label className="block text-sm font-medium text-gray-700">Bank account
                <select value={selectedAccount} onChange={(event) => { setSelectedAccount(event.target.value); setSelectedBatch(''); setPage(1); setPreview(null) }} className="mt-1 block w-full rounded-md border px-3 py-2">
                  <option value="">Choose a designated account</option>
                  {accounts.map((account) => <option key={account.account_id} value={account.account_id}>{account.account_code} · {account.bank_label} ({account.currency})</option>)}
                </select>
              </label>
              <form onSubmit={validateStatement} className="space-y-3">
                <label className="block text-sm font-medium text-gray-700">CSV file
                  <input type="file" accept=".csv,text/csv" onChange={(event) => readFile(event.target.files?.[0])} className="mt-1 block w-full rounded-md border bg-white px-3 py-2 text-sm" />
                </label>
                {csvText && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="text-sm font-medium text-gray-700">Statement opening balance
                      <input inputMode="decimal" value={openingBalance} onChange={(event) => setOpeningBalance(event.target.value)} placeholder="0.000000" className="mt-1 block w-full rounded-md border px-3 py-2" />
                    </label>
                    <label className="text-sm font-medium text-gray-700">Statement closing balance
                      <input inputMode="decimal" value={closingBalance} onChange={(event) => setClosingBalance(event.target.value)} placeholder="0.000000" className="mt-1 block w-full rounded-md border px-3 py-2" />
                    </label>
                  </div>
                )}
                {file && <p className="text-xs text-gray-500">{file.name} · {(file.size / 1024).toFixed(1)} KiB</p>}
                <div className="flex flex-wrap gap-2">
                  <button disabled={busy || !selectedAccount || !csvText} className="rounded-md border border-blue-700 px-4 py-2 text-sm font-semibold text-blue-700 disabled:opacity-50">{busy ? 'Working…' : 'Validate and preview'}</button>
                  {preview?.valid && <button type="button" disabled={busy || !isAdmin} onClick={importStatement} className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Confirm import</button>}
                </div>
                <p className="text-xs text-gray-500">Without a running_balance column, enter both statement balances above. Expected headers: transaction_date, bank_reference, description, debit, credit, running_balance.</p>
                {!isAdmin && <p className="text-xs text-amber-700">An administrator must confirm statement imports and reconciliation changes.</p>}
              </form>
            </div>
          </section>

          <section className="rounded-xl border bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold text-gray-900">Import validation</h2>
            {!preview ? <p className="mt-2 text-sm text-gray-500">Select a CSV and validate it to see the transaction preview.</p> : (
              <div className="mt-3 space-y-3 text-sm">
                <div className={`rounded-md px-3 py-2 ${preview.valid ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'}`}>
                  {preview.valid ? `Valid · ${preview.row_count} rows · ${preview.currency} · ${dateText(preview.statement_start_date)} to ${dateText(preview.statement_end_date)}` : `${preview.errors.length} validation issue(s)`}
                </div>
                {preview.valid && <p className="text-gray-600">Opening {amount(preview.opening_balance, preview.currency)} · Closing {amount(preview.closing_balance, preview.currency)}</p>}
                {!!preview.errors?.length && <ul className="max-h-40 list-disc space-y-1 overflow-auto pl-5 text-red-700">{preview.errors.map((item, index) => <li key={`${item.row_number}-${item.field}-${index}`}>{item.row_number ? `Row ${item.row_number}: ` : ''}{item.message}</li>)}</ul>}
                {preview.transactions?.length > 0 && <div className="max-h-64 overflow-auto rounded border">
                  <table className="min-w-full text-left text-xs">
                    <thead className="sticky top-0 bg-gray-100 text-gray-600"><tr><th className="p-2">Date</th><th className="p-2">Reference / description</th><th className="p-2">Debit</th><th className="p-2">Credit</th><th className="p-2">Balance</th></tr></thead>
                    <tbody>{preview.transactions.slice(0, 100).map((transaction) => <tr key={transaction.row_number} className="border-t"><td className="whitespace-nowrap p-2">{transaction.transaction_date}</td><td className="p-2">{transaction.bank_reference || '—'} · {transaction.description}</td><td className="whitespace-nowrap p-2">{transaction.debit}</td><td className="whitespace-nowrap p-2">{transaction.credit}</td><td className="whitespace-nowrap p-2">{transaction.running_balance || '—'}</td></tr>)}</tbody>
                  </table>
                  {preview.transactions.length > 100 && <p className="p-2 text-gray-500">Showing first 100 of {preview.transactions.length} rows.</p>}
                </div>}
              </div>
            )}
          </section>
        </div>

        <section className="rounded-xl border bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><h2 className="text-lg font-semibold text-gray-900">Import history</h2><p className="text-sm text-gray-500">Statement files remain available as immutable import records.</p></div>
            <select aria-label="Filter import history by bank account" value={selectedAccount} onChange={(event) => { setSelectedAccount(event.target.value); setImportPage(1); setSelectedBatch(''); setPage(1) }} className="rounded-md border px-3 py-2 text-sm">
              <option value="">All bank accounts</option>{accounts.map((account) => <option key={account.account_id} value={account.account_id}>{account.bank_label}</option>)}
            </select>
          </div>
          {loading ? <p className="mt-4 text-sm text-gray-500">Loading…</p> : imports.length === 0 ? <p className="mt-4 text-sm text-gray-500">No statement imports for this account yet.</p> : (
            <div className="mt-4 overflow-x-auto"><table className="min-w-full text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500"><tr><th className="p-3">Statement</th><th className="p-3">Period</th><th className="p-3">Transactions</th><th className="p-3">Matched</th><th className="p-3">Status</th><th className="p-3"></th></tr></thead>
              <tbody>{imports.map((item) => <tr key={item.id} className="border-t"><td className="p-3"><div className="font-medium text-gray-800">{item.file_name}</div><div className="text-xs text-gray-500">{item.bank_label} · {new Date(item.imported_at).toLocaleString()}</div></td><td className="whitespace-nowrap p-3">{dateText(item.statement_start_date)} – {dateText(item.statement_end_date)}</td><td className="p-3">{item.transaction_count}</td><td className="p-3">{item.matched_count}</td><td className="p-3"><span className={`rounded-full px-2 py-1 text-xs ${item.reconciliation_status === 'reconciled' ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}>{item.reconciliation_status}</span></td><td className="p-3"><button onClick={() => { setSelectedBatch(item.id); setPage(1) }} className="font-semibold text-blue-700 hover:underline">Open</button></td></tr>)}</tbody>
            </table></div>
          )}
          <div className="mt-3 flex items-center justify-end gap-2 text-sm"><button disabled={importPage <= 1} onClick={() => setImportPage((value) => value - 1)} className="rounded border px-3 py-1 disabled:opacity-40">Previous</button><span>Page {importPage}</span><button disabled={imports.length < 10} onClick={() => setImportPage((value) => value + 1)} className="rounded border px-3 py-1 disabled:opacity-40">Next</button></div>
        </section>

        {detail && detailBatch && <section className="space-y-5 rounded-xl border bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h2 className="text-lg font-semibold text-gray-900">Reconciliation details</h2><p className="mt-1 text-sm text-gray-600">{detailBatch.bank_label} · {detailBatch.file_name} · {dateText(detailBatch.statement_start_date)} to {dateText(detailBatch.statement_end_date)}</p></div>
            <span className={`rounded-full px-3 py-1 text-xs font-semibold ${detailBatch.reconciliation_status === 'reconciled' ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}>{detailBatch.reconciliation_status}</span>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ['Statement closing', detail.summary.statement_closing_balance],
              ['Book closing', detail.summary.book_closing_balance],
              ['Adjusted statement', detail.summary.adjusted_statement_closing_balance],
              ['Difference', detail.summary.difference]
            ].map(([label, value]) => <div key={label} className="rounded-lg bg-gray-50 p-4"><p className="text-xs text-gray-500">{label}</p><p className={`mt-1 text-lg font-bold ${label === 'Difference' && detail.summary.difference !== '0.000000' ? 'text-red-700' : 'text-gray-900'}`}>{amount(value, detail.summary.currency)}</p></div>)}
          </div>
          <div className="grid gap-2 text-sm text-gray-600 sm:grid-cols-2 xl:grid-cols-4">
            <p>Statement opening: <strong>{amount(detail.summary.statement_opening_balance, detail.summary.currency)}</strong></p>
            <p>Book opening: <strong>{amount(detail.summary.book_opening_balance, detail.summary.currency)}</strong></p>
            <p>Opening difference: <strong>{amount(detail.summary.opening_difference, detail.summary.currency)}</strong></p>
            <p>Outstanding ledger net: <strong>{amount(detail.summary.outstanding_ledger_net, detail.summary.currency)}</strong></p>
            <p>Statement debits: <strong>{amount(detail.summary.statement_debits, detail.summary.currency)}</strong></p>
            <p>Statement credits: <strong>{amount(detail.summary.statement_credits, detail.summary.currency)}</strong></p>
            <p>Matched {detail.summary.matched_count} / {detail.summary.transaction_count}</p>
            <p>Unmatched ledger lines in period: {detail.unmatched_ledger_transactions.total}</p>
          </div>

          <div className="flex flex-wrap items-end gap-3 rounded-lg border border-blue-100 bg-blue-50 p-4">
            {detailBatch.reconciliation_status === 'open' ? <>
              <label className="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" checked={reconcileConfirm} onChange={(event) => setReconcileConfirm(event.target.checked)} />I reviewed the matches and statement difference.</label>
              <button disabled={busy || !isAdmin || !detail.summary.can_reconcile || !reconcileConfirm} onClick={completeReconciliation} className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Complete reconciliation</button>
              {!detail.summary.can_reconcile && <p className="basis-full text-xs text-amber-800">Match every statement transaction and bring the difference to zero to complete reconciliation. Unmatched ledger transactions are included in the adjusted statement balance.</p>}
            </> : isAdmin && <>
              <label className="min-w-64 flex-1 text-sm text-gray-700">Reason for reopening
                <input maxLength={1000} value={reopenReason} onChange={(event) => setReopenReason(event.target.value)} className="mt-1 block w-full rounded border px-3 py-2" placeholder="Explain the correction being made" />
              </label>
              <button disabled={busy || !reopenReason.trim()} onClick={reopenReconciliation} className="rounded-md border border-amber-700 px-4 py-2 text-sm font-semibold text-amber-800 disabled:opacity-50">Reopen with audit reason</button>
            </>}
          </div>

          <div className="overflow-x-auto">
            <h3 className="mb-2 font-semibold text-gray-800">Bank statement transactions</h3>
            <table className="min-w-full text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500"><tr><th className="p-3">Date</th><th className="p-3">Reference / description</th><th className="p-3">Withdrawal</th><th className="p-3">Deposit</th><th className="p-3">Status / ledger entry</th><th className="p-3">Action</th></tr></thead>
              <tbody>{transactions.map((transaction) => <tr key={transaction.id} className="align-top border-t">
                <td className="whitespace-nowrap p-3">{dateText(transaction.transaction_date)}</td>
                <td className="max-w-sm p-3"><div className="font-medium text-gray-800">{transaction.bank_reference || 'No reference'}</div><div className="text-xs text-gray-500">{transaction.description}</div></td>
                <td className="whitespace-nowrap p-3">{transaction.debit !== '0.000000' ? amount(transaction.debit, detail.summary.currency) : '—'}</td>
                <td className="whitespace-nowrap p-3">{transaction.credit !== '0.000000' ? amount(transaction.credit, detail.summary.currency) : '—'}</td>
                <td className="p-3">{transaction.match_status === 'matched' ? <><span className="rounded bg-green-100 px-2 py-1 text-xs text-green-800">matched</span><div className="mt-2 text-xs text-gray-700">{transaction.source_type} · {transaction.source_reference || transaction.journal_entry_id}</div><div className="text-xs text-gray-500">{dateText(transaction.journal_date)} · {transaction.journal_description}{transaction.reversal_of_entry_id ? ` · reversal of ${transaction.reversal_of_entry_id}` : ''}</div></> : <span className="rounded bg-amber-100 px-2 py-1 text-xs text-amber-800">unmatched</span>}</td>
                <td className="min-w-56 p-3">
                  {detailBatch.reconciliation_status === 'open' && transaction.match_status === 'matched' && isAdmin && <div className="space-y-2"><input value={unmatchReasons[transaction.id] || ''} onChange={(event) => setUnmatchReasons((current) => ({ ...current, [transaction.id]: event.target.value }))} placeholder="Reason to unmatch" className="w-full rounded border px-2 py-1 text-xs"/><button disabled={busy || !unmatchReasons[transaction.id]?.trim()} onClick={() => unmatchTransaction(transaction.id)} className="text-xs font-semibold text-amber-800 disabled:opacity-50">Release match with audit reason</button></div>}
                  {detailBatch.reconciliation_status === 'open' && !transaction.match_status && <div className="space-y-2">
                    <button onClick={() => findSuggestions(transaction.id)} className="text-xs font-semibold text-blue-700 hover:underline">Find suggested matches</button>
                    {suggestions[transaction.id] && <div className="space-y-2">
                        {(() => {
                          const suggested = suggestions[transaction.id] || []
                          const bankIsCredit = transaction.credit !== '0.000000'
                          const bankAmount = bankIsCredit ? transaction.credit : transaction.debit
                          const manual = unmatchedLedger.filter((line) => bankIsCredit
                            ? line.debit === bankAmount && line.credit === '0.000000'
                            : line.credit === bankAmount && line.debit === '0.000000')
                            .filter((line) => !suggested.some((candidate) => candidate.journal_line_id === line.journal_line_id))
                          const options = [...suggested, ...manual]
                          return options.length > 0 && <>
                            <select value={chosenLines[transaction.id] || ''} onChange={(event) => { setChosenLines((current) => ({ ...current, [transaction.id]: event.target.value })); setConfirmMatch((current) => ({ ...current, [transaction.id]: false })) }} className="w-full rounded border px-2 py-1 text-xs">
                              <option value="">Choose a posted entry</option>{options.map((candidate) => <option key={candidate.journal_line_id} value={candidate.journal_line_id}>{dateText(candidate.entry_date)} · {candidate.source_type}/{candidate.source_reference || candidate.journal_entry_id} · {amount(candidate.debit !== '0.000000' ? candidate.debit : `-${candidate.credit}`, detail.summary.currency)} · {candidate.description || candidate.journal_description}{candidate.reversal_of_entry_id ? ' (reversal)' : ''}</option>)}
                            </select>
                            {chosenLines[transaction.id] && <><label className="flex gap-2 text-xs text-gray-600"><input type="checkbox" checked={Boolean(confirmMatch[transaction.id])} onChange={(event) => setConfirmMatch((current) => ({ ...current, [transaction.id]: event.target.checked }))} />I confirmed amount, date, direction, and reference.</label><button disabled={busy || !confirmMatch[transaction.id] || !isAdmin} onClick={() => matchTransaction(transaction.id)} className="rounded bg-blue-700 px-2 py-1 text-xs font-semibold text-white disabled:opacity-50">Confirm match</button></>}
                          </>
                        })()}
                    </div>}
                    {isAdmin && <details className="pt-1"><summary className="cursor-pointer text-xs font-semibold text-gray-700">Review a bank fee, interest, or other adjustment</summary>
                      <div className="mt-2 space-y-2 rounded bg-gray-50 p-2">
                        <select value={adjustmentForm[transaction.id]?.account_id || ''} onChange={(event) => setAdjustmentForm((current) => ({ ...current, [transaction.id]: { ...current[transaction.id], account_id: event.target.value } }))} className="w-full rounded border px-2 py-1 text-xs"><option value="">Select offset account</option>{ledgerAccounts.filter((account) => account.id !== detailBatch.bank_account_id).map((account) => <option key={account.id} value={account.id}>{account.account_code} · {account.name}</option>)}</select>
                        <select value={adjustmentForm[transaction.id]?.period_id || ''} onChange={(event) => setAdjustmentForm((current) => ({ ...current, [transaction.id]: { ...current[transaction.id], period_id: event.target.value } }))} className="w-full rounded border px-2 py-1 text-xs"><option value="">Select open accounting period</option>{periods.filter((period) => period.status === 'open').map((period) => <option key={period.id} value={period.id}>{period.name} ({dateText(period.starts_on)}–{dateText(period.ends_on)})</option>)}</select>
                        <input maxLength={500} value={adjustmentForm[transaction.id]?.description || ''} onChange={(event) => setAdjustmentForm((current) => ({ ...current, [transaction.id]: { ...current[transaction.id], description: event.target.value } }))} placeholder="Journal description, e.g. Monthly bank fee" className="w-full rounded border px-2 py-1 text-xs" />
                        <p className="text-xs text-gray-600">The journal will be {transaction.credit !== '0.000000' ? 'debited' : 'credited'} to the bank account for {amount(transaction.credit !== '0.000000' ? transaction.credit : transaction.debit, detail.summary.currency)}. Review the offset account and posting period.</p>
                        <label className="flex gap-2 text-xs text-gray-700"><input type="checkbox" checked={Boolean(adjustmentForm[transaction.id]?.confirm)} onChange={(event) => setAdjustmentForm((current) => ({ ...current, [transaction.id]: { ...current[transaction.id], confirm: event.target.checked } }))} />I reviewed this journal and authorize posting.</label>
                        <button disabled={busy || !adjustmentForm[transaction.id]?.account_id || !adjustmentForm[transaction.id]?.period_id || !adjustmentForm[transaction.id]?.description?.trim() || !adjustmentForm[transaction.id]?.confirm} onClick={() => postAdjustment(transaction.id)} className="rounded bg-indigo-700 px-2 py-1 text-xs font-semibold text-white disabled:opacity-50">Post reviewed adjustment</button>
                      </div>
                    </details>}
                  </div>}
                </td>
              </tr>)}</tbody>
            </table>
            {transactions.length === 0 && <p className="py-5 text-sm text-gray-500">No statement transactions on this page.</p>}
          </div>

          <div className="overflow-x-auto">
            <h3 className="mb-2 font-semibold text-gray-800">Unmatched ledger transactions in statement period</h3>
            <table className="min-w-full text-left text-sm"><thead className="bg-gray-50 text-xs uppercase text-gray-500"><tr><th className="p-3">Date</th><th className="p-3">Source</th><th className="p-3">Description</th><th className="p-3">Debit</th><th className="p-3">Credit</th><th className="p-3">Match</th></tr></thead><tbody>
              {unmatchedLedger.map((line) => <tr key={line.journal_line_id} className="border-t"><td className="whitespace-nowrap p-3">{dateText(line.entry_date)}</td><td className="p-3">{line.source_type} · {line.source_reference || line.journal_entry_id}{line.reversal_of_entry_id ? <div className="text-xs text-gray-500">Reversal</div> : null}</td><td className="p-3">{line.journal_description}</td><td className="p-3">{line.debit !== '0.000000' ? amount(line.debit, detail.summary.currency) : '—'}</td><td className="p-3">{line.credit !== '0.000000' ? amount(line.credit, detail.summary.currency) : '—'}</td><td className="p-3">Unmatched</td></tr>)}
              {unmatchedLedger.length === 0 && <tr><td colSpan="6" className="p-4 text-sm text-gray-500">No unmatched posted ledger entries in this statement period.</td></tr>}
            </tbody></table>
            {detail.unmatched_ledger_transactions.total > 0 && <p className="mt-2 text-xs text-gray-500">{detail.unmatched_ledger_transactions.total} unmatched posted ledger line(s); the list follows the statement transaction page.</p>}
          </div>

          <div>
            <h3 className="mb-2 font-semibold text-gray-800">Audit history</h3>
            {detail.audit_history.length ? <ol className="space-y-2">{detail.audit_history.map((event) => <li key={event.id} className="flex flex-wrap justify-between gap-2 rounded border bg-gray-50 px-3 py-2 text-sm"><span><strong className="capitalize">{event.event_type.replaceAll('_', ' ')}</strong>{event.details?.reason ? ` · ${event.details.reason}` : ''}{event.details?.file_name ? ` · ${event.details.file_name}` : ''}</span><span className="text-xs text-gray-500">{new Date(event.created_at).toLocaleString()} · {event.actor_id}</span></li>)}</ol> : <p className="text-sm text-gray-500">No audit events were returned for this import.</p>}
          </div>

          <div className="flex items-center justify-end gap-3 border-t pt-4 text-sm"><button disabled={page <= 1} onClick={() => setPage((value) => value - 1)} className="rounded border px-3 py-1 disabled:opacity-40">Previous</button><span>Page {page} of {pageCount}</span><button disabled={page >= pageCount} onClick={() => setPage((value) => value + 1)} className="rounded border px-3 py-1 disabled:opacity-40">Next</button></div>
        </section>}
        <p className="text-xs text-gray-500">Bank statement amounts use the tenant accounting currency. CSV imports are saved as immutable rows; corrections use audited unmatching and reopening. Adjustment journals require explicit administrator review.</p>
      </main>
    </div>
  )
}

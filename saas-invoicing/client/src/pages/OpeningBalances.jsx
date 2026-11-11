import { useCallback, useEffect, useMemo, useState } from 'react'
import api from '../api'

const zeroLine = () => ({ account_id: '', debit: '', credit: '', description: '' })

function units(value) {
  const text = String(value || '').trim()
  if (!text) return 0n
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(text)
  if (!match) return null
  return BigInt(match[1]) * 1000000n + BigInt((match[2] || '').padEnd(6, '0') || '0')
}

function displayUnits(value) {
  const whole = value / 1000000n
  const fraction = (value % 1000000n).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : String(whole)
}

function balanceStatus(lines) {
  let debit = 0n
  let credit = 0n
  for (const line of lines) {
    const d = units(line.debit)
    const c = units(line.credit)
    if (d == null || c == null) return { valid: false, debit: '—', credit: '—', difference: '—' }
    debit += d
    credit += c
  }
  return { valid: debit === credit && debit > 0n, debit: displayUnits(debit), credit: displayUnits(credit), difference: displayUnits(debit - credit) }
}

function errorMessage(error, fallback) {
  return error.response?.data?.error || fallback
}

function currencyTotals(row) {
  return row.totals_by_currency?.map((item) => `${item.currency || 'currency unknown'} ${item.amount}`).join(' · ') || '—'
}

export default function OpeningBalances() {
  const user = useMemo(() => {
    try { return JSON.parse(sessionStorage.getItem('user') || '{}') } catch { return {} }
  }, [])
  const isAdmin = user.role === 'admin'
  const [accounts, setAccounts] = useState([])
  const [periods, setPeriods] = useState([])
  const [batches, setBatches] = useState([])
  const [preview, setPreview] = useState(null)
  const [effectiveDate, setEffectiveDate] = useState('')
  const [periodId, setPeriodId] = useState('')
  const [description, setDescription] = useState('Opening balance cutover')
  const [lines, setLines] = useState([zeroLine(), zeroLine()])
  const [actionReason, setActionReason] = useState('')
  const [reversalDate, setReversalDate] = useState('')
  const [reversalPeriod, setReversalPeriod] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [accountResponse, periodResponse, batchResponse, previewResponse] = await Promise.all([
        api.get('/accounting/accounts?active=true'),
        api.get('/accounting/periods'),
        api.get('/accounting/opening-balances'),
        api.get('/accounting/opening-balances/cutover-preview')
      ])
      setAccounts((accountResponse.data || []).filter((account) => ['asset', 'liability', 'equity'].includes(account.account_type)))
      const openPeriods = (periodResponse.data || []).filter((period) => period.status === 'open')
      setPeriods(openPeriods)
      const returnedBatches = batchResponse.data || []
      const priorReversal = returnedBatches.find((batch) => batch.status === 'reversed')
      const priorDate = priorReversal ? String(priorReversal.effective_date).slice(0, 10) : ''
      const priorPeriod = openPeriods.find((period) => priorDate >= String(period.starts_on).slice(0, 10) && priorDate <= String(period.ends_on).slice(0, 10))
      setPeriodId((current) => openPeriods.some((period) => period.id === current) ? current : priorPeriod?.id || openPeriods[0]?.id || '')
      setEffectiveDate((current) => current || priorDate)
      setReversalPeriod((current) => openPeriods.some((period) => period.id === current) ? current : openPeriods[0]?.id || '')
      setBatches(returnedBatches)
      setPreview(previewResponse.data)
    } catch (requestError) {
      setError(errorMessage(requestError, 'Could not load accounting cutover information.'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const activeCutover = batches.find((batch) => ['draft', 'posted'].includes(batch.status))
  const priorReversals = batches.filter((batch) => batch.status === 'reversed')
  const cancelledCutovers = batches.filter((batch) => batch.status === 'cancelled')
  const activePeriod = periods.find((period) => period.id === periodId)
  const totals = balanceStatus(lines)
  const selectedAccounts = lines.map((line) => line.account_id).filter(Boolean)
  const canCreate = isAdmin && !activeCutover && effectiveDate && periodId && description.trim() && totals.valid &&
    selectedAccounts.length === lines.length && new Set(selectedAccounts).size === selectedAccounts.length

  function updateLine(index, field, value) {
    setLines((current) => current.map((line, i) => i === index ? { ...line, [field]: value } : line))
  }

  async function submitDraft(event) {
    event.preventDefault()
    if (!canCreate) return
    setBusy(true); setError(''); setNotice(''); setConfirmed(false); setActionReason('')
    try {
      await api.post('/accounting/opening-balances', {
        effective_date: effectiveDate,
        accounting_period_id: periodId,
        description: description.trim(),
        lines: lines.map((line) => ({
          account_id: line.account_id,
          debit: line.debit.trim() || '0',
          credit: line.credit.trim() || '0',
          description: line.description.trim() || null
        }))
      }, { headers: { 'Idempotency-Key': window.crypto.randomUUID() } })
      setNotice('Opening balance draft created. A different accounting administrator must review and post it.')
      await load()
    } catch (requestError) {
      setError(errorMessage(requestError, 'Could not create the opening balance draft.'))
    } finally { setBusy(false) }
  }

  async function postDraft(batch) {
    if (!confirmed || !actionReason.trim()) return
    setBusy(true); setError(''); setNotice('')
    try {
      await api.post(`/accounting/opening-balances/${batch.id}/post`, { confirm: true, reason: actionReason.trim() }, {
        headers: { 'Idempotency-Key': window.crypto.randomUUID() }
      })
      setNotice('Opening balance was posted through the accounting journal service.')
      setConfirmed(false); setActionReason('')
      await load()
    } catch (requestError) {
      setError(errorMessage(requestError, 'Could not approve and post the opening balance.'))
    } finally { setBusy(false) }
  }

  async function cancelDraft(batch) {
    if (!confirmed || !actionReason.trim()) return
    setBusy(true); setError(''); setNotice('')
    try {
      await api.post(`/accounting/opening-balances/${batch.id}/cancel`, { confirm: true, reason: actionReason.trim() }, {
        headers: { 'Idempotency-Key': window.crypto.randomUUID() }
      })
      setNotice('Opening balance draft was cancelled and retained in history.')
      setConfirmed(false); setActionReason('')
      await load()
    } catch (requestError) {
      setError(errorMessage(requestError, 'Could not cancel this draft.'))
    } finally { setBusy(false) }
  }

  async function reverseCutover(batch) {
    if (!confirmed || !actionReason.trim() || !reversalDate || !reversalPeriod) return
    setBusy(true); setError(''); setNotice('')
    try {
      await api.post(`/accounting/opening-balances/${batch.id}/reverse`, {
        confirm: true, reason: actionReason.trim(), reversal_date: reversalDate, accounting_period_id: reversalPeriod
      }, { headers: { 'Idempotency-Key': window.crypto.randomUUID() } })
      setNotice('A linked reversal journal was posted; the original opening journal remains unchanged.')
      setConfirmed(false); setActionReason('')
      await load()
    } catch (requestError) {
      setError(errorMessage(requestError, 'Could not reverse the opening balance.'))
    } finally { setBusy(false) }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 md:p-8">
      <header>
        <p className="text-sm font-semibold uppercase tracking-wide text-blue-700">Accounting controls</p>
        <h1 className="mt-1 text-3xl font-bold text-gray-900">Opening balance cutover</h1>
        <p className="mt-2 max-w-3xl text-sm text-gray-600">Enter a reviewed opening trial balance in functional currency. Historical records are previewed only; no invoice, receipt, bill, payment, expense, or M-Pesa request is bulk-posted.</p>
      </header>

      {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}
      {notice && <div role="status" className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">{notice}</div>}
      {loading ? <p className="text-sm text-gray-500">Loading cutover controls…</p> : <>
        <section className="rounded-xl border bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold">Historical-record preview</h2>
          <p className="mt-1 text-sm text-gray-600">Read-only classification. “Eligible” remains zero because automatic legacy posting is not supported.</p>
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead><tr className="border-b text-gray-500"><th className="py-2 pr-4">Source</th><th className="py-2 pr-4">Already accounted</th><th className="py-2 pr-4">Excluded</th><th className="py-2 pr-4">Ambiguous</th><th className="py-2">Availability</th></tr></thead>
              <tbody>{(preview?.sources || []).map((source) => <tr className="border-b align-top" key={source.source}>
                <td className="py-3 pr-4 font-medium">{source.source}</td>
                <td className="py-3 pr-4">{source.already_accounted_for.count ?? 'unknown'}<div className="text-xs text-gray-500">{currencyTotals(source.already_accounted_for)}</div></td>
                <td className="py-3 pr-4">{source.excluded.count ?? 'unknown'}<div className="text-xs text-gray-500">{currencyTotals(source.excluded)}</div></td>
                <td className="py-3 pr-4">{source.ambiguous.count ?? 'unknown'}<div className="text-xs text-gray-500">{currencyTotals(source.ambiguous)}</div></td>
                <td className="py-3">{source.available ? 'Classified' : 'Unavailable'}<p className="mt-1 max-w-xl text-xs text-gray-500">{source.message}</p></td>
              </tr>)}</tbody>
            </table>
          </div>
          {(preview?.sources || []).some((source) => source.examples?.length > 0) && <details className="mt-4">
            <summary className="cursor-pointer text-sm font-medium text-blue-700">Review source record examples</summary>
            <div className="mt-3 space-y-3">{preview.sources.filter((source) => source.examples?.length).map((source) => <div key={source.source}>
              <h3 className="font-medium">{source.source}{source.truncated ? ' (first 100)' : ''}</h3>
              <ul className="mt-1 space-y-1 text-xs text-gray-600">{source.examples.map((item) => <li key={item.record_id}>{item.reference || item.record_id} · {item.status} · {item.currency || 'currency unknown'} {item.amount} · {item.classification}: {item.reason}</li>)}</ul>
            </div>)}</div>
          </details>}
        </section>

        {activeCutover && <section className="space-y-4 rounded-xl border bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h2 className="text-lg font-semibold">Current cutover</h2><p className="text-sm text-gray-600">{activeCutover.description} · {String(activeCutover.effective_date).slice(0, 10)} · {activeCutover.accounting_period_name}</p></div>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-sm font-medium capitalize">{activeCutover.status}</span>
          </div>
          <div className="overflow-x-auto"><table className="min-w-full text-sm"><thead><tr className="border-b text-left text-gray-500"><th className="py-2 pr-4">Account</th><th className="py-2 pr-4">Type</th><th className="py-2 pr-4">Debit</th><th className="py-2">Credit</th></tr></thead><tbody>
            {activeCutover.lines.map((line) => <tr className="border-b" key={line.line_number}><td className="py-2 pr-4">{line.account_code} · {line.account_name}</td><td className="py-2 pr-4 capitalize">{line.account_type}</td><td className="py-2 pr-4">{line.debit}</td><td className="py-2">{line.credit}</td></tr>)}
          </tbody></table></div>
          {isAdmin && (activeCutover.status === 'draft' || activeCutover.status === 'posted') && <div className="grid gap-3 rounded-lg bg-gray-50 p-4 md:grid-cols-2">
            {activeCutover.status === 'draft' && <p className="md:col-span-2 text-sm text-amber-800">Draft creator: {activeCutover.created_by}. Posting requires a different administrator. Posting creates one immutable journal.</p>}
            {activeCutover.status === 'posted' && <p className="md:col-span-2 text-sm text-amber-800">Posted journal: {activeCutover.journal_entry_id}. Reversal posts a separate journal into an open period.</p>}
            {activeCutover.status === 'posted' && <>
              <label className="text-sm">Reversal date<input type="date" value={reversalDate} onChange={(event) => setReversalDate(event.target.value)} className="mt-1 block w-full rounded border p-2" /></label>
              <label className="text-sm">Reversal period<select value={reversalPeriod} onChange={(event) => setReversalPeriod(event.target.value)} className="mt-1 block w-full rounded border p-2"><option value="">Choose period</option>{periods.map((period) => <option key={period.id} value={period.id}>{period.name} · {period.starts_on}–{period.ends_on}</option>)}</select></label>
            </>}
            <label className="text-sm md:col-span-2">Action reason<textarea value={actionReason} onChange={(event) => setActionReason(event.target.value)} maxLength={1800} className="mt-1 block w-full rounded border p-2" required /></label>
            <label className="flex items-start gap-2 text-sm md:col-span-2"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>I reviewed this action and confirm it should be recorded.</span></label>
            {activeCutover.status === 'draft' && <div className="flex gap-2 md:col-span-2"><button disabled={busy || !confirmed || !actionReason.trim() || activeCutover.created_by === user.userId} onClick={() => postDraft(activeCutover)} className="rounded bg-blue-700 px-4 py-2 text-white disabled:opacity-50">Approve and post</button><button disabled={busy || !confirmed || !actionReason.trim()} onClick={() => cancelDraft(activeCutover)} className="rounded border px-4 py-2 disabled:opacity-50">Cancel draft</button></div>}
            {activeCutover.status === 'posted' && <button disabled={busy || !confirmed || !actionReason.trim() || !reversalDate || !reversalPeriod} onClick={() => reverseCutover(activeCutover)} className="rounded bg-red-700 px-4 py-2 text-white disabled:opacity-50 md:col-span-2">Post reversal</button>}
          </div>}
          <div><h3 className="font-semibold">Audit history</h3><ol className="mt-2 space-y-2 text-sm">{activeCutover.events.map((event) => <li key={event.id} className="border-l-2 border-blue-200 pl-3"><span className="font-medium capitalize">{event.event_type.replace('_', ' ')}</span> · {event.actor_id} · {new Date(event.created_at).toLocaleString()}<p className="text-gray-600">{event.reason}</p></li>)}</ol></div>
        </section>}

        {priorReversals.length > 0 && <section className="space-y-3 rounded-xl border bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold">Reversed cutover history</h2>
          <p className="text-sm text-gray-600">A replacement must use the same effective date and an open accounting period. The previous journal remains in the ledger with its linked reversal.</p>
          {priorReversals.map((batch) => <details className="rounded border p-3" key={batch.id}>
            <summary className="cursor-pointer text-sm font-medium">{String(batch.effective_date).slice(0, 10)} · {batch.description} · reversed</summary>
            <p className="mt-2 text-xs text-gray-600">Original journal {batch.journal_entry_id} · reversal journal {batch.reversal_journal_entry_id}</p>
            <ol className="mt-2 space-y-2 text-sm">{batch.events.map((event) => <li key={event.id} className="border-l-2 border-blue-200 pl-3"><span className="font-medium capitalize">{event.event_type.replace('_', ' ')}</span> · {event.actor_id} · {new Date(event.created_at).toLocaleString()}<p className="text-gray-600">{event.reason}</p></li>)}</ol>
          </details>)}
        </section>}

        {cancelledCutovers.length > 0 && <section className="space-y-3 rounded-xl border bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold">Cancelled draft history</h2>
          {cancelledCutovers.map((batch) => <details className="rounded border p-3" key={batch.id}>
            <summary className="cursor-pointer text-sm font-medium">{String(batch.effective_date).slice(0, 10)} · {batch.description} · cancelled</summary>
            <ol className="mt-2 space-y-2 text-sm">{batch.events.map((event) => <li key={event.id} className="border-l-2 border-blue-200 pl-3"><span className="font-medium capitalize">{event.event_type.replace('_', ' ')}</span> · {event.actor_id} · {new Date(event.created_at).toLocaleString()}<p className="text-gray-600">{event.reason}</p></li>)}</ol>
          </details>)}
        </section>}

        {!activeCutover && <form onSubmit={submitDraft} className="space-y-4 rounded-xl border bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold">Create opening-balance draft</h2>
          {priorReversals[0] && <p className="rounded bg-amber-50 p-3 text-sm text-amber-900">A prior cutover was reversed. Its replacement must use {String(priorReversals[0].effective_date).slice(0, 10)} and the accounting period containing that date must still be open.</p>}
          <p className="text-sm text-gray-600">Only active asset, liability and equity accounts are allowed. Revenue and expense balances belong in the approved historical reporting process, not this opening entry. Enter a balancing equity or retained-earnings line explicitly; nothing will be auto-balanced.</p>
          {!isAdmin && <p className="rounded bg-amber-50 p-3 text-sm text-amber-800">Only an accounting administrator can create or approve a cutover.</p>}
          <div className="grid gap-3 md:grid-cols-3">
            <label className="text-sm">Effective date<input type="date" value={effectiveDate} onChange={(event) => setEffectiveDate(event.target.value)} className="mt-1 block w-full rounded border p-2" required /></label>
            <label className="text-sm">Open accounting period<select value={periodId} onChange={(event) => setPeriodId(event.target.value)} className="mt-1 block w-full rounded border p-2" required><option value="">Choose period</option>{periods.map((period) => <option key={period.id} value={period.id}>{period.name} · {period.starts_on}–{period.ends_on}</option>)}</select></label>
            <label className="text-sm">Description<input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={2000} className="mt-1 block w-full rounded border p-2" required /></label>
          </div>
          {activePeriod && effectiveDate && (effectiveDate < String(activePeriod.starts_on).slice(0, 10) || effectiveDate > String(activePeriod.ends_on).slice(0, 10)) && <p className="text-sm text-red-700">The effective date must fall within the selected open period.</p>}
          <div className="space-y-3">{lines.map((line, index) => <div key={index} className="grid gap-2 rounded border p-3 md:grid-cols-[2fr_1fr_1fr_2fr_auto]">
            <label className="text-xs text-gray-500">Account<select value={line.account_id} onChange={(event) => updateLine(index, 'account_id', event.target.value)} className="mt-1 block w-full rounded border p-2 text-sm" required><option value="">Choose account</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.account_code} · {account.name} ({account.account_type})</option>)}</select></label>
            <label className="text-xs text-gray-500">Debit<input inputMode="decimal" value={line.debit} onChange={(event) => updateLine(index, 'debit', event.target.value)} className="mt-1 block w-full rounded border p-2 text-sm" placeholder="0" /></label>
            <label className="text-xs text-gray-500">Credit<input inputMode="decimal" value={line.credit} onChange={(event) => updateLine(index, 'credit', event.target.value)} className="mt-1 block w-full rounded border p-2 text-sm" placeholder="0" /></label>
            <label className="text-xs text-gray-500">Line description<input value={line.description} onChange={(event) => updateLine(index, 'description', event.target.value)} className="mt-1 block w-full rounded border p-2 text-sm" /></label>
            <button type="button" disabled={lines.length <= 2} onClick={() => setLines((current) => current.filter((_, i) => i !== index))} className="self-end rounded border px-3 py-2 text-sm disabled:opacity-40">Remove</button>
          </div>)}</div>
          <button type="button" disabled={lines.length >= 500} onClick={() => setLines((current) => [...current, zeroLine()])} className="rounded border px-3 py-2 text-sm">Add account line</button>
          <div className="flex flex-wrap gap-6 rounded bg-gray-50 p-3 text-sm"><span>Total debits: {totals.debit}</span><span>Total credits: {totals.credit}</span><span>Difference: {totals.difference}</span><span className={totals.valid ? 'font-semibold text-green-700' : 'font-semibold text-amber-700'}>{totals.valid ? 'Balanced' : 'Not balanced'}</span></div>
          <button disabled={busy || !canCreate} className="rounded bg-blue-700 px-4 py-2 text-white disabled:opacity-50">Create draft</button>
        </form>}
      </>}
    </div>
  )
}

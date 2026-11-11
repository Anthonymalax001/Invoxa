import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../api'

function dateLabel(value) {
  return value ? String(value).slice(0, 10) : '—'
}

function statusStyle(status) {
  if (status === 'passed') return 'bg-green-100 text-green-800'
  if (status === 'warning') return 'bg-amber-100 text-amber-900'
  if (status === 'unavailable') return 'bg-amber-100 text-amber-900'
  return 'bg-red-100 text-red-800'
}

function detailText(item) {
  return [item.entry_date, item.payment_date, item.payment_number, item.bill_number, item.receipt_reference,
    item.payment_reference, item.description, item.file_name, item.bank_label, item.status]
    .filter(Boolean).join(' · ')
}

function errorText(error, fallback) {
  return error.response?.data?.error || fallback
}

export default function AccountingPeriods() {
  const user = useMemo(() => {
    try { return JSON.parse(sessionStorage.getItem('user') || '{}') }
    catch { return {} }
  }, [])
  const isAdmin = user.role === 'admin'
  const [periods, setPeriods] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [readiness, setReadiness] = useState(null)
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const loadPeriods = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const response = await api.get('/accounting/periods')
      const rows = response.data || []
      setPeriods(rows)
      setSelectedId((current) => rows.some((period) => period.id === current)
        ? current : (rows.find((period) => period.status === 'open') || rows[0])?.id || '')
    } catch (requestError) {
      setError(errorText(requestError, 'Could not load accounting periods.'))
    } finally {
      setLoading(false)
    }
  }, [])

  const loadReadiness = useCallback(async (periodId) => {
    if (!periodId) {
      setReadiness(null)
      return
    }
    setError('')
    try {
      const response = await api.get(`/accounting/periods/${periodId}/readiness`)
      setReadiness(response.data)
    } catch (requestError) {
      setReadiness(null)
      setError(errorText(requestError, 'Could not assess accounting period readiness.'))
    }
  }, [])

  useEffect(() => { loadPeriods() }, [loadPeriods])
  useEffect(() => { loadReadiness(selectedId) }, [selectedId, loadReadiness])

  async function closePeriod(event) {
    event.preventDefault()
    if (!selectedId || !confirmed || !reason.trim()) return
    setBusy(true)
    setError('')
    setNotice('')
    const key = window.crypto?.randomUUID?.() || `period-close-${Date.now()}-${Math.random().toString(36).slice(2)}`
    try {
      const response = await api.patch(`/accounting/periods/${selectedId}/close`, {
        confirm: true,
        reason: reason.trim()
      }, { headers: { 'Idempotency-Key': key } })
      setReadiness((current) => current ? {
        ...current,
        period: response.data.period,
        can_close: false,
        checks: current.checks.map((check) => check.id === 'period_status'
          ? { ...check, status: 'blocked', severity: 'blocker', count: 1, message: 'This accounting period is already closed.' }
          : check),
        blockers: [...(current.blockers || []), {
          id: 'period_status', label: 'Period status', status: 'blocked', severity: 'blocker', count: 1,
          message: 'This accounting period is already closed.', items: []
        }],
        history: [{ outcome: 'closed', reason: reason.trim(), actor_id: user.userId, created_at: new Date().toISOString() }, ...(current.history || [])]
      } : current)
      setNotice(response.data.replayed ? 'This close request was already completed.' : 'Accounting period closed and recorded in the audit history.')
      setReason('')
      setConfirmed(false)
      await Promise.all([loadPeriods(), loadReadiness(selectedId)])
    } catch (requestError) {
      const response = requestError.response?.data
      if (response?.readiness) setReadiness(response.readiness)
      const message = errorText(requestError, 'Could not close this accounting period.')
      setReason('')
      setConfirmed(false)
      await loadReadiness(selectedId)
      setError(message)
    } finally {
      setBusy(false)
    }
  }

  const selected = periods.find((period) => period.id === selectedId)

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <nav className="flex flex-wrap items-center gap-4 border-b bg-white px-4 py-4 text-sm font-medium text-gray-600 sm:px-6">
        <Link to="/dashboard" className="mr-2 text-xl font-bold text-blue-700">Invoxa</Link>
        <Link to="/financial-reports" className="hover:text-blue-700">Financial reports</Link>
        <Link to="/bank-reconciliation" className="hover:text-blue-700">Bank reconciliation</Link>
        <span className="text-blue-700">Accounting periods</span>
      </nav>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6 sm:py-8">
        <header>
          <h1 className="text-2xl font-bold sm:text-3xl">Accounting periods</h1>
          <p className="mt-1 text-sm text-gray-600">Review unresolved accounting work before an administrator closes a period.</p>
        </header>

        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
        {notice && <p role="status" className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">{notice}</p>}

        <section className="rounded-xl border bg-white p-4 shadow-sm">
          <label className="block text-sm font-semibold">Accounting period
            <select disabled={loading || periods.length === 0} value={selectedId} onChange={(event) => setSelectedId(event.target.value)} className="mt-2 w-full rounded-lg border px-3 py-2 sm:max-w-xl">
              {periods.length === 0 && <option value="">No periods configured</option>}
              {periods.map((period) => <option key={period.id} value={period.id}>{period.name} · {dateLabel(period.starts_on)} to {dateLabel(period.ends_on)} · {period.status}</option>)}
            </select>
          </label>
          {selected && <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
            <div><dt className="text-gray-500">Status</dt><dd className="font-semibold capitalize">{selected.status}</dd></div>
            <div><dt className="text-gray-500">Period</dt><dd>{dateLabel(selected.starts_on)} to {dateLabel(selected.ends_on)}</dd></div>
            <div><dt className="text-gray-500">Closed</dt><dd>{selected.closed_at ? `${new Date(selected.closed_at).toLocaleString()} · actor ${selected.closed_by}` : 'Not closed'}</dd></div>
          </dl>}
        </section>

        {readiness && <>
          <section className="rounded-xl border bg-white p-4 shadow-sm">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div><h2 className="text-lg font-bold">Close-readiness checklist</h2><p className="text-sm text-gray-600">Unavailable checks are treated as blockers and are never shown as passed.</p></div>
              <span className={`rounded-full px-3 py-1 text-sm font-semibold ${readiness.can_close ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-900'}`}>
                {readiness.can_close ? `Ready to close${readiness.warnings?.length ? ` · ${readiness.warnings.length} warning(s)` : ''}` : `${(readiness.blockers || []).length} blocker(s)`}
              </span>
            </div>
            <div className="space-y-3">
              {(readiness.checks || []).map((check) => <article key={check.id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold">{check.label}</h3>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusStyle(check.status)}`}>{check.status}{check.count != null ? ` · ${check.count}` : ''}</span>
                </div>
                <p className="mt-1 text-sm text-gray-600">{check.message}</p>
                {check.items?.length > 0 && <ul className="mt-2 space-y-1 text-sm text-gray-700">{check.items.map((item, index) => (
                  <li key={item.id || index} className="break-words">{detailText(item) || JSON.stringify(item)}</li>
                ))}</ul>}
                {check.truncated && <p className="mt-2 text-xs text-gray-500">Showing the first {check.items.length} records.</p>}
              </article>)}
            </div>
          </section>

          {isAdmin && readiness.period?.status === 'open' && <section className="rounded-xl border bg-white p-4 shadow-sm">
            <h2 className="text-lg font-bold">Close this period</h2>
            <p className="mt-1 text-sm text-gray-600">The server rechecks the checklist while holding the period lock. Blocked attempts and successful closes are audited.</p>
            <form onSubmit={closePeriod} className="mt-4 space-y-3">
              <label className="block text-sm font-medium">Reason for closing
                <textarea required maxLength={1800} value={reason} onChange={(event) => setReason(event.target.value)} rows="3" className="mt-1 w-full rounded-lg border px-3 py-2" />
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-1" />
                <span>I confirm this period should be closed after reviewing the checklist.</span>
              </label>
              <button disabled={busy || !readiness.can_close || !reason.trim() || !confirmed} className="rounded-lg bg-red-700 px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
                {busy ? 'Closing…' : 'Confirm period close'}
              </button>
            </form>
          </section>}

          <section className="rounded-xl border bg-white p-4 shadow-sm">
            <h2 className="text-lg font-bold">Closure history</h2>
            {readiness.history === null ? <p className="mt-2 text-sm text-amber-800">Audit history is unavailable. Period closing is blocked until its audit migration is applied.</p>
              : readiness.history?.length ? <ol className="mt-3 divide-y">{readiness.history.map((event) => <li key={event.id || `${event.outcome}-${event.created_at}`} className="py-3 text-sm">
                <div className="flex flex-wrap justify-between gap-2"><span className="font-semibold capitalize">{event.outcome}</span><time className="text-gray-500">{new Date(event.created_at).toLocaleString()}</time></div>
                <p className="mt-1 text-gray-700">{event.reason}</p><p className="text-xs text-gray-500">Actor {event.actor_id}</p>
                {event.details?.readiness?.blockers?.length > 0 && <p className="mt-1 text-xs text-amber-800">Blockers recorded at attempt: {event.details.readiness.blockers.map((check) => check.label).join(', ')}</p>}
              </li>)}</ol>
                : <p className="mt-2 text-sm text-gray-500">No close attempts have been recorded for this period.</p>}
          </section>
        </>}
      </main>
    </div>
  )
}

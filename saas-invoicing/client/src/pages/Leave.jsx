import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../api'

const today = new Date().toISOString().slice(0, 10)
const year = new Date().getUTCFullYear()
const STATUSES = ['pending', 'approved', 'rejected', 'cancelled']
const EMPTY = { employee_id: '', leave_type_id: '', start_date: today, end_date: today, reason: '' }
const NAV = [['/dashboard', 'Dashboard'], ['/employees', 'Employees'], ['/attendance', 'Attendance'], ['/leave', 'Leave'], ['/clients', 'Clients']]

export default function Leave() {
  const [types, setTypes] = useState([])
  const [employees, setEmployees] = useState([])
  const [applications, setApplications] = useState([])
  const [balances, setBalances] = useState([])
  const [form, setForm] = useState(EMPTY)
  const [filters, setFilters] = useState({ status: '', employee_id: '', leave_type_id: '' })
  const [formOpen, setFormOpen] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [balanceOpen, setBalanceOpen] = useState(false)
  const [typeForm, setTypeForm] = useState({ code: '', name: '', annual_entitlement: '', allow_negative: false })
  const [balanceForm, setBalanceForm] = useState({ employee_id: '', leave_type_id: '', leave_year: year, entitled_days: '', allow_negative: false })
  const [rejecting, setRejecting] = useState(null)
  const [rejectionReason, setRejectionReason] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [formError, setFormError] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const params = Object.fromEntries(Object.entries(filters).filter(([, value]) => value))
      const [typeResult, employeeResult, applicationResult, balanceResult] = await Promise.all([
        api.get('/leave/types'),
        api.get('/employees', { params: { status: 'active' } }),
        api.get('/leave', { params }),
        api.get('/leave/balances', { params: { leave_year: year } })
      ])
      setTypes(typeResult.data); setEmployees(employeeResult.data); setApplications(applicationResult.data); setBalances(balanceResult.data.balances)
    } catch (requestError) { setError(requestError.response?.data?.error || 'Could not load leave management data.') }
    finally { setLoading(false) }
  }, [filters])

  useEffect(() => { load() }, [load])
  const update = (event) => setForm((current) => ({ ...current, [event.target.name]: event.target.value }))
  const setFilter = (event) => setFilters((current) => ({ ...current, [event.target.name]: event.target.value }))
  const submitApplication = async (event) => {
    event.preventDefault(); setSaving(true); setFormError('')
    try { await api.post('/leave', form); setFormOpen(false); setForm(EMPTY); await load() }
    catch (requestError) { setFormError(requestError.response?.data?.error || 'Could not submit leave application.') }
    finally { setSaving(false) }
  }
  const saveType = async (event) => {
    event.preventDefault(); setSaving(true); setFormError('')
    try { await api.post('/leave/types', typeForm); setConfigOpen(false); setTypeForm({ code: '', name: '', annual_entitlement: '', allow_negative: false }); await load() }
    catch (requestError) { setFormError(requestError.response?.data?.error || 'Could not create leave type.') }
    finally { setSaving(false) }
  }
  const saveBalance = async (event) => {
    event.preventDefault(); setSaving(true); setFormError('')
    try { await api.put('/leave/balances', balanceForm); setBalanceOpen(false); await load() }
    catch (requestError) { setFormError(requestError.response?.data?.error || 'Could not save leave balance.') }
    finally { setSaving(false) }
  }
  const decide = async (application, action, body = {}) => {
    try { await api.patch(`/leave/${application.id}/${action}`, body); await load() }
    catch (requestError) { setError(requestError.response?.data?.error || 'Could not update leave application.') }
  }
  const reject = async (event) => {
    event.preventDefault(); await decide(rejecting, 'reject', { rejection_reason: rejectionReason }); setRejecting(null); setRejectionReason('')
  }

  return <div className="min-h-screen bg-gray-50">
    <header className="border-b bg-white"><div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"><Link to="/dashboard" className="text-xl font-bold text-blue-700">Invoxa</Link><nav className="flex gap-4 overflow-x-auto whitespace-nowrap text-sm font-medium text-gray-600">{NAV.map(([path, label]) => <Link key={path} to={path} className={path === '/leave' ? 'text-blue-600' : 'hover:text-blue-600'}>{label}</Link>)}</nav><button onClick={() => { sessionStorage.clear(); window.location.href = '/login' }} className="rounded border px-3 py-2 text-sm">Logout</button></div></header>
    <main className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-sm font-semibold uppercase tracking-wide text-blue-600">Human resources</p><h1 className="text-2xl font-bold text-gray-900">Leave management</h1><p className="text-sm text-gray-500">Configure leave, manage balances and review applications.</p></div><div className="flex flex-wrap gap-2"><button onClick={() => setConfigOpen(true)} className="rounded-lg border bg-white px-3 py-2 font-medium">Leave types</button><button onClick={() => setBalanceOpen(true)} className="rounded-lg border bg-white px-3 py-2 font-medium">Set balance</button><button onClick={() => setFormOpen(true)} className="rounded-lg bg-blue-600 px-4 py-2.5 font-semibold text-white">New application</button></div></div>
      {error && <div role="alert" className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}{formError && <div role="alert" className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{formError}</div>}
      <div className="mb-5 grid gap-2 rounded-xl border bg-white p-4 sm:grid-cols-3"><label className="text-sm font-medium">Employee<select name="employee_id" value={filters.employee_id} onChange={setFilter} className="mt-1 w-full rounded border px-3 py-2"><option value="">All employees</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.employee_number} — {employee.first_name} {employee.last_name}</option>)}</select></label><label className="text-sm font-medium">Leave type<select name="leave_type_id" value={filters.leave_type_id} onChange={setFilter} className="mt-1 w-full rounded border px-3 py-2"><option value="">All leave types</option>{types.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label><label className="text-sm font-medium">Status<select name="status" value={filters.status} onChange={setFilter} className="mt-1 w-full rounded border px-3 py-2"><option value="">All statuses</option>{STATUSES.map((status) => <option key={status}>{status}</option>)}</select></label></div>
      {formOpen && <form onSubmit={submitApplication} className="mb-6 rounded-xl border bg-white p-5 shadow-sm"><div className="mb-4 flex justify-between"><h2 className="font-semibold">New leave application</h2><button type="button" onClick={() => setFormOpen(false)} className="text-sm text-gray-500">Cancel</button></div><div className="grid gap-3 md:grid-cols-3"><label className="text-sm font-medium">Employee<select required name="employee_id" value={form.employee_id} onChange={update} className="mt-1 w-full rounded border px-3 py-2"><option value="">Select employee</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.employee_number} — {employee.first_name} {employee.last_name}</option>)}</select></label><label className="text-sm font-medium">Leave type<select required name="leave_type_id" value={form.leave_type_id} onChange={update} className="mt-1 w-full rounded border px-3 py-2"><option value="">Select leave type</option>{types.filter((type) => type.is_active).map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label><label className="text-sm font-medium">Start date<input required type="date" name="start_date" value={form.start_date} onChange={update} className="mt-1 w-full rounded border px-3 py-2" /></label><label className="text-sm font-medium">End date<input required type="date" name="end_date" value={form.end_date} onChange={update} className="mt-1 w-full rounded border px-3 py-2" /></label><label className="text-sm font-medium md:col-span-2">Reason<textarea required name="reason" value={form.reason} onChange={update} className="mt-1 min-h-20 w-full rounded border px-3 py-2" /></label></div><button disabled={saving} className="mt-4 rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white disabled:opacity-50">{saving ? 'Saving…' : 'Submit application'}</button></form>}
      {configOpen && <form onSubmit={saveType} className="mb-6 rounded-xl border bg-white p-5 shadow-sm"><div className="mb-4 flex justify-between"><h2 className="font-semibold">Add configurable leave type</h2><button type="button" onClick={() => setConfigOpen(false)} className="text-sm text-gray-500">Cancel</button></div><div className="grid gap-3 md:grid-cols-4"><input required placeholder="Code e.g. study" value={typeForm.code} onChange={(event) => setTypeForm({ ...typeForm, code: event.target.value })} className="rounded border px-3 py-2" /><input required placeholder="Name" value={typeForm.name} onChange={(event) => setTypeForm({ ...typeForm, name: event.target.value })} className="rounded border px-3 py-2" /><input placeholder="Annual entitlement" value={typeForm.annual_entitlement} onChange={(event) => setTypeForm({ ...typeForm, annual_entitlement: event.target.value })} className="rounded border px-3 py-2" /><button className="rounded bg-blue-600 px-3 py-2 font-semibold text-white">Create type</button></div></form>}
      {balanceOpen && <form onSubmit={saveBalance} className="mb-6 rounded-xl border bg-white p-5 shadow-sm"><div className="mb-4 flex justify-between"><h2 className="font-semibold">Configure employee leave balance</h2><button type="button" onClick={() => setBalanceOpen(false)} className="text-sm text-gray-500">Cancel</button></div><div className="grid gap-3 md:grid-cols-5"><select required value={balanceForm.employee_id} onChange={(event) => setBalanceForm({ ...balanceForm, employee_id: event.target.value })} className="rounded border px-3 py-2"><option value="">Employee</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.employee_number}</option>)}</select><select required value={balanceForm.leave_type_id} onChange={(event) => setBalanceForm({ ...balanceForm, leave_type_id: event.target.value })} className="rounded border px-3 py-2"><option value="">Leave type</option>{types.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select><input required type="number" min="0" step="0.01" placeholder="Entitled days" value={balanceForm.entitled_days} onChange={(event) => setBalanceForm({ ...balanceForm, entitled_days: event.target.value })} className="rounded border px-3 py-2" /><input required type="number" min="2000" max="2200" value={balanceForm.leave_year} onChange={(event) => setBalanceForm({ ...balanceForm, leave_year: event.target.value })} className="rounded border px-3 py-2" /><button className="rounded bg-blue-600 px-3 py-2 font-semibold text-white">Save balance</button></div></form>}
      {rejecting && <form onSubmit={reject} className="mb-6 rounded-xl border bg-white p-5 shadow-sm"><h2 className="mb-3 font-semibold">Reject leave application</h2><textarea required value={rejectionReason} onChange={(event) => setRejectionReason(event.target.value)} placeholder="Rejection reason" className="mb-3 min-h-20 w-full rounded border px-3 py-2" /><div><button className="rounded bg-red-600 px-3 py-2 font-semibold text-white">Confirm rejection</button> <button type="button" onClick={() => setRejecting(null)} className="rounded border px-3 py-2">Cancel</button></div></form>}
      <div className="mb-5 rounded-xl border bg-white p-4"><h2 className="mb-3 font-semibold">Leave balances ({year})</h2>{balances.length === 0 ? <p className="text-sm text-gray-500">No balances configured.</p> : <div className="grid gap-2 md:grid-cols-3">{balances.map((balance) => <div key={balance.id} className="rounded border p-3 text-sm"><strong>{balance.employee_number} — {balance.leave_type_name}</strong><p>Entitled: {balance.entitled_days} · Used: {balance.used_days} · Remaining: {balance.remaining_days}</p></div>)}</div>}</div>
      {loading ? <div className="rounded-xl border bg-white p-10 text-center text-gray-500">Loading leave applications…</div> : applications.length === 0 ? <div className="rounded-xl border border-dashed bg-white p-10 text-center text-gray-500">No leave applications found.</div> : <div className="overflow-x-auto rounded-xl border bg-white shadow-sm"><table className="w-full min-w-[1000px] text-left text-sm"><thead className="bg-gray-50 text-xs uppercase text-gray-600"><tr><th className="p-3">Employee</th><th className="p-3">Leave</th><th className="p-3">Dates</th><th className="p-3">Days</th><th className="p-3">Status</th><th className="p-3">Actions</th></tr></thead><tbody>{applications.map((application) => <tr key={application.id} className="border-t"><td className="p-3"><strong>{application.employee_number}</strong><br />{application.first_name} {application.last_name}</td><td className="p-3">{application.leave_type_name}</td><td className="p-3">{String(application.start_date).slice(0, 10)} — {String(application.end_date).slice(0, 10)}</td><td className="p-3">{application.working_days}</td><td className="p-3 capitalize">{application.status}</td><td className="p-3">{application.status === 'pending' && <><button onClick={() => decide(application, 'approve')} className="mr-3 text-green-700 underline">Approve</button><button onClick={() => setRejecting(application)} className="mr-3 text-red-700 underline">Reject</button></>}{['pending', 'approved'].includes(application.status) && <button onClick={() => decide(application, 'cancel')} className="text-blue-600 underline">Cancel</button>}</td></tr>)}</tbody></table></div>}
    </main>
  </div>
}

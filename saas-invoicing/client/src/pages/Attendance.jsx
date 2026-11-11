import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../api'

const STATUSES = ['present', 'absent', 'late', 'half-day', 'on leave']
const today = new Date().toISOString().slice(0, 10)
const month = today.slice(0, 7)
const EMPTY = { employee_id: '', attendance_date: today, clock_in: '', clock_out: '', attendance_status: 'present', notes: '' }
const NAV = [['/dashboard', 'Dashboard'], ['/employees', 'Employees'], ['/attendance', 'Attendance'], ['/clients', 'Clients'], ['/invoices', 'Invoices']]

export default function Attendance() {
  const [records, setRecords] = useState([])
  const [employees, setEmployees] = useState([])
  const [departments, setDepartments] = useState([])
  const [summary, setSummary] = useState(null)
  const [summaryMonth, setSummaryMonth] = useState(month)
  const [filters, setFilters] = useState({ date: today, status: '', employee_id: '', department_id: '' })
  const [form, setForm] = useState(EMPTY)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [formError, setFormError] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const params = Object.fromEntries(Object.entries(filters).filter(([, value]) => value))
      const [attendance, employeeList, departmentList, monthSummary] = await Promise.all([
        api.get('/attendance', { params }),
        api.get('/employees', { params: { status: 'active' } }),
        api.get('/employees/departments'),
        api.get('/attendance/summary', { params: { month: summaryMonth } })
      ])
      setRecords(attendance.data); setEmployees(employeeList.data); setDepartments(departmentList.data); setSummary(monthSummary.data)
    } catch (requestError) {
      setError(requestError.response?.data?.error || 'Could not load attendance.')
    } finally { setLoading(false) }
  }, [filters, summaryMonth])

  useEffect(() => { load() }, [load])
  const update = (event) => setForm((current) => ({ ...current, [event.target.name]: event.target.value }))
  const openCreate = () => { setEditing(null); setForm({ ...EMPTY, attendance_date: filters.date || today }); setFormOpen(true); setFormError('') }
  const openEdit = (record) => {
    setEditing(record); setFormOpen(true); setFormError('')
    setForm({ employee_id: record.employee_id, attendance_date: String(record.attendance_date).slice(0, 10), clock_in: record.clock_in?.slice(0, 5) || '', clock_out: record.clock_out?.slice(0, 5) || '', attendance_status: record.attendance_status, notes: record.notes || '' })
  }
  const submit = async (event) => {
    event.preventDefault(); setSaving(true); setFormError('')
    try {
      if (editing) await api.put(`/attendance/${editing.id}`, form)
      else await api.post('/attendance', form)
      setFormOpen(false); setEditing(null); await load()
    } catch (requestError) {
      setFormError(requestError.response?.data?.error || 'Could not save attendance.')
    } finally { setSaving(false) }
  }
  const setFilter = (event) => setFilters((current) => ({ ...current, [event.target.name]: event.target.value }))

  return <div className="min-h-screen bg-gray-50">
    <header className="border-b bg-white"><div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"><Link to="/dashboard" className="text-xl font-bold text-blue-700">Invoxa</Link><nav className="flex gap-4 overflow-x-auto whitespace-nowrap text-sm font-medium text-gray-600">{NAV.map(([path, label]) => <Link key={path} to={path} className={path === '/attendance' ? 'text-blue-600' : 'hover:text-blue-600'}>{label}</Link>)}</nav><button onClick={() => { sessionStorage.clear(); window.location.href = '/login' }} className="rounded border px-3 py-2 text-sm">Logout</button></div></header>
    <main className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-sm font-semibold uppercase tracking-wide text-blue-600">Human resources</p><h1 className="text-2xl font-bold text-gray-900">Attendance</h1><p className="text-sm text-gray-500">Record and review daily employee attendance.</p></div><button onClick={openCreate} className="rounded-lg bg-blue-600 px-4 py-2.5 font-semibold text-white">Record attendance</button></div>
      <div className="mb-5 grid gap-2 rounded-xl border bg-white p-4 sm:grid-cols-2 lg:grid-cols-5"><label className="text-sm font-medium">Date<input type="date" name="date" value={filters.date} onChange={setFilter} className="mt-1 w-full rounded border px-3 py-2" /></label><label className="text-sm font-medium">Employee<select name="employee_id" value={filters.employee_id} onChange={setFilter} className="mt-1 w-full rounded border px-3 py-2"><option value="">All employees</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.employee_number} — {employee.first_name} {employee.last_name}</option>)}</select></label><label className="text-sm font-medium">Department<select name="department_id" value={filters.department_id} onChange={setFilter} className="mt-1 w-full rounded border px-3 py-2"><option value="">All departments</option>{departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></label><label className="text-sm font-medium">Status<select name="status" value={filters.status} onChange={setFilter} className="mt-1 w-full rounded border px-3 py-2"><option value="">All statuses</option>{STATUSES.map((status) => <option key={status}>{status}</option>)}</select></label><button onClick={() => setFilters((current) => ({ ...current, date: '' }))} className="self-end rounded border px-3 py-2 text-sm">All dates</button></div>
      {error && <div role="alert" className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}{formError && <div role="alert" className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{formError}</div>}
      {formOpen && <form onSubmit={submit} className="mb-6 rounded-xl border bg-white p-5 shadow-sm"><div className="mb-4 flex justify-between"><h2 className="font-semibold">{editing ? 'Edit attendance' : 'Record attendance'}</h2><button type="button" onClick={() => setFormOpen(false)} className="text-sm text-gray-500">Cancel</button></div><div className="grid gap-3 md:grid-cols-3"><label className="text-sm font-medium">Employee<select required name="employee_id" value={form.employee_id} onChange={update} className="mt-1 w-full rounded border px-3 py-2"><option value="">Select employee</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.employee_number} — {employee.first_name} {employee.last_name}</option>)}</select></label><label className="text-sm font-medium">Date<input required type="date" name="attendance_date" value={form.attendance_date} onChange={update} className="mt-1 w-full rounded border px-3 py-2" /></label><label className="text-sm font-medium">Status<select name="attendance_status" value={form.attendance_status} onChange={update} className="mt-1 w-full rounded border px-3 py-2">{STATUSES.map((status) => <option key={status}>{status}</option>)}</select></label><label className="text-sm font-medium">Clock in<input type="time" name="clock_in" value={form.clock_in} onChange={update} disabled={['absent', 'on leave'].includes(form.attendance_status)} className="mt-1 w-full rounded border px-3 py-2 disabled:bg-gray-100" /></label><label className="text-sm font-medium">Clock out<input type="time" name="clock_out" value={form.clock_out} onChange={update} disabled={['absent', 'on leave'].includes(form.attendance_status)} className="mt-1 w-full rounded border px-3 py-2 disabled:bg-gray-100" /></label><label className="text-sm font-medium">Notes<textarea name="notes" value={form.notes} onChange={update} className="mt-1 w-full rounded border px-3 py-2" /></label></div><button disabled={saving} className="mt-4 rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save attendance'}</button></form>}
      {summary && <div className="mb-5 rounded-xl border bg-white p-4"><div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">Monthly summary</h2><input type="month" value={summaryMonth} onChange={(event) => setSummaryMonth(event.target.value)} className="rounded border px-3 py-1.5 text-sm" /></div><div className="grid gap-3 sm:grid-cols-4"><div><p className="text-xs text-gray-500">Employees</p><p className="text-xl font-bold">{summary.employees.length}</p></div><div><p className="text-xs text-gray-500">Recorded days</p><p className="text-xl font-bold">{summary.employees.reduce((total, row) => total + row.recorded_days, 0)}</p></div><div><p className="text-xs text-gray-500">Working hours</p><p className="text-xl font-bold">{(summary.employees.reduce((total, row) => total + row.working_minutes, 0) / 60).toFixed(2)}</p></div><div><p className="text-xs text-gray-500">Overtime hours</p><p className="text-xl font-bold">{(summary.employees.reduce((total, row) => total + row.overtime_minutes, 0) / 60).toFixed(2)}</p></div></div></div>}
      {loading ? <div className="rounded-xl border bg-white p-10 text-center text-gray-500">Loading attendance…</div> : records.length === 0 ? <div className="rounded-xl border border-dashed bg-white p-10 text-center text-gray-500">No attendance records found for the selected filters.</div> : <div className="overflow-x-auto rounded-xl border bg-white shadow-sm"><table className="w-full min-w-[900px] text-left text-sm"><thead className="bg-gray-50 text-xs uppercase text-gray-600"><tr><th className="p-3">Date</th><th className="p-3">Employee</th><th className="p-3">Status</th><th className="p-3">Clock in/out</th><th className="p-3">Hours</th><th className="p-3">Actions</th></tr></thead><tbody>{records.map((record) => <tr key={record.id} className="border-t"><td className="p-3">{String(record.attendance_date).slice(0, 10)}</td><td className="p-3"><strong>{record.employee_number}</strong><br />{record.first_name} {record.last_name}<br /><span className="text-gray-500">{record.department_name || 'No department'}</span></td><td className="p-3 capitalize">{record.attendance_status}</td><td className="p-3">{record.clock_in?.slice(0, 5) || '—'} / {record.clock_out?.slice(0, 5) || '—'}</td><td className="p-3">{(record.working_minutes / 60).toFixed(2)}<span className="text-gray-500"> (+{(record.overtime_minutes / 60).toFixed(2)} OT)</span></td><td className="p-3"><button onClick={() => openEdit(record)} className="text-blue-600 underline">Edit</button></td></tr>)}</tbody></table></div>}
    </main>
  </div>
}

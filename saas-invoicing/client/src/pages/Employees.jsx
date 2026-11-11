import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../api'

const EMPTY = {
  first_name: '', middle_name: '', last_name: '', work_email: '', phone: '',
  department_id: '', job_title: '', employment_type: 'permanent',
  employment_start_date: '', employment_status: 'active', reporting_manager_id: '', notes: ''
}

const NAV = [
  ['/dashboard', 'Dashboard'], ['/clients', 'Clients'], ['/products', 'Products'],
  ['/suppliers', 'Suppliers'], ['/employees', 'Employees'], ['/invoices', 'Invoices']
]

export default function Employees() {
  const [employees, setEmployees] = useState([])
  const [departments, setDepartments] = useState([])
  const [form, setForm] = useState(EMPTY)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [editing, setEditing] = useState(null)
  const [selected, setSelected] = useState(null)
  const [formOpen, setFormOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [formError, setFormError] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [employeeResult, departmentResult] = await Promise.all([
        api.get('/employees', { params: { search, status: status || undefined } }),
        api.get('/employees/departments')
      ])
      setEmployees(employeeResult.data); setDepartments(departmentResult.data)
    } catch (requestError) {
      setError(requestError.response?.data?.error || 'Could not load employees.')
    } finally { setLoading(false) }
  }, [search, status])

  useEffect(() => { load() }, [load])

  const openCreate = () => { setEditing(null); setFormOpen(true); setForm({ ...EMPTY, employment_start_date: new Date().toISOString().slice(0, 10) }); setFormError('') }
  const openEdit = (employee) => {
    setEditing(employee)
    setFormOpen(true)
    setForm({
      first_name: employee.first_name || '', middle_name: employee.middle_name || '',
      last_name: employee.last_name || '', work_email: employee.work_email || '',
      phone: employee.phone || '', department_id: employee.department_id || '',
      job_title: employee.job_title || '', employment_type: employee.employment_type,
      employment_start_date: String(employee.employment_start_date).slice(0, 10),
      employment_status: employee.employment_status, reporting_manager_id: employee.reporting_manager_id || '',
      notes: employee.notes || ''
    })
    setFormError('')
  }
  const update = (event) => setForm((current) => ({ ...current, [event.target.name]: event.target.value }))
  const submit = async (event) => {
    event.preventDefault(); setSaving(true); setFormError('')
    try {
      if (editing) await api.put(`/employees/${editing.id}`, form)
      else await api.post('/employees', form)
      setEditing(null); setFormOpen(false); setForm(EMPTY); await load()
    } catch (requestError) {
      setFormError(requestError.response?.data?.error || 'Could not save employee.')
    } finally { setSaving(false) }
  }
  const changeStatus = async (employee) => {
    const next = employee.employment_status === 'active' ? 'inactive' : 'active'
    try { await api.patch(`/employees/${employee.id}/status`, { employment_status: next }); await load() }
    catch (requestError) { setError(requestError.response?.data?.error || 'Could not update employee status.') }
  }

  return <div className="min-h-screen bg-gray-50">
    <header className="border-b bg-white">
      <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <Link to="/dashboard" className="text-xl font-bold text-blue-700">Invoxa</Link>
        <nav className="flex gap-4 overflow-x-auto whitespace-nowrap text-sm font-medium text-gray-600">
          {NAV.map(([path, label]) => <Link key={path} to={path} className={path === '/employees' ? 'text-blue-600' : 'hover:text-blue-600'}>{label}</Link>)}
        </nav>
        <button onClick={() => { sessionStorage.clear(); window.location.href = '/login' }} className="rounded border px-3 py-2 text-sm">Logout</button>
      </div>
    </header>
    <main className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div><p className="text-sm font-semibold uppercase tracking-wide text-blue-600">Human resources</p><h1 className="text-2xl font-bold text-gray-900">Employees</h1><p className="text-sm text-gray-500">Manage tenant employee records and employment status.</p></div>
        <button onClick={openCreate} className="rounded-lg bg-blue-600 px-4 py-2.5 font-semibold text-white">Register employee</button>
      </div>
      <form onSubmit={(event) => { event.preventDefault(); setSearch(searchInput.trim()) }} className="mb-5 flex flex-col gap-2 sm:flex-row">
        <input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Search name, employee number or email" className="flex-1 rounded-lg border bg-white px-3 py-2.5" />
        <select value={status} onChange={(event) => setStatus(event.target.value)} className="rounded-lg border bg-white px-3 py-2.5"><option value="">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option><option value="suspended">Suspended</option><option value="terminated">Terminated</option></select>
        <button className="rounded-lg border bg-white px-4 py-2 font-medium">Search</button>
      </form>
      {error && <div role="alert" className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {formError && <div role="alert" className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{formError}</div>}
      {formOpen ? <form onSubmit={submit} className="mb-6 rounded-xl border bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">{editing ? 'Edit employee' : 'Register employee'}</h2><button type="button" onClick={() => { setEditing(null); setFormOpen(false); setForm(EMPTY) }} className="text-sm text-gray-500">Cancel</button></div>
        <div className="grid gap-3 md:grid-cols-3">
          {['first_name', 'middle_name', 'last_name', 'work_email', 'phone', 'job_title'].map((name) => <label key={name} className="text-sm font-medium capitalize">{name.replaceAll('_', ' ')}{name !== 'middle_name' && name !== 'phone' ? ' *' : ''}<input required={name !== 'middle_name' && name !== 'phone'} name={name} value={form[name]} onChange={update} className="mt-1 w-full rounded border px-3 py-2" /></label>)}
          <label className="text-sm font-medium">Department<select name="department_id" value={form.department_id} onChange={update} className="mt-1 w-full rounded border px-3 py-2"><option value="">No department</option>{departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></label>
          <label className="text-sm font-medium">Employment type<select name="employment_type" value={form.employment_type} onChange={update} className="mt-1 w-full rounded border px-3 py-2">{['permanent', 'contract', 'temporary', 'intern', 'casual', 'consultant'].map((value) => <option key={value}>{value}</option>)}</select></label>
          <label className="text-sm font-medium">Start date<input required type="date" name="employment_start_date" value={form.employment_start_date} onChange={update} className="mt-1 w-full rounded border px-3 py-2" /></label>
          <label className="text-sm font-medium">Status<select name="employment_status" value={form.employment_status} onChange={update} className="mt-1 w-full rounded border px-3 py-2">{['active', 'inactive', 'suspended', 'terminated'].map((value) => <option key={value}>{value}</option>)}</select></label>
          <label className="text-sm font-medium">Reporting manager<select name="reporting_manager_id" value={form.reporting_manager_id} onChange={update} className="mt-1 w-full rounded border px-3 py-2"><option value="">No manager</option>{employees.filter((employee) => employee.id !== editing?.id).map((employee) => <option key={employee.id} value={employee.id}>{employee.employee_number} — {employee.first_name} {employee.last_name}</option>)}</select></label>
          <label className="text-sm font-medium md:col-span-2">Notes<textarea name="notes" value={form.notes} onChange={update} className="mt-1 min-h-20 w-full rounded border px-3 py-2" /></label>
        </div>
        <button disabled={saving} className="mt-4 rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save employee'}</button>
      </form> : null}
      {selected && <div className="mb-5 rounded-xl border bg-white p-5 shadow-sm"><div className="flex items-start justify-between"><div><h2 className="text-lg font-semibold">{selected.first_name} {selected.middle_name || ''} {selected.last_name}</h2><p className="text-sm text-gray-500">{selected.employee_number} · {selected.job_title || 'No job title'}</p></div><button onClick={() => setSelected(null)} className="text-sm text-gray-500">Close</button></div><dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3"><div><dt className="text-gray-500">Email</dt><dd>{selected.work_email || '—'}</dd></div><div><dt className="text-gray-500">Phone</dt><dd>{selected.phone || '—'}</dd></div><div><dt className="text-gray-500">Start date</dt><dd>{String(selected.employment_start_date).slice(0, 10)}</dd></div><div><dt className="text-gray-500">Department</dt><dd>{selected.department_name || '—'}</dd></div><div><dt className="text-gray-500">Employment type</dt><dd className="capitalize">{selected.employment_type}</dd></div><div><dt className="text-gray-500">Status</dt><dd className="capitalize">{selected.employment_status}</dd></div></dl></div>}
      {loading ? <div className="rounded-xl border bg-white p-10 text-center text-gray-500">Loading employees…</div> : employees.length === 0 ? <div className="rounded-xl border border-dashed bg-white p-10 text-center text-gray-500">No employees found.</div> : <div className="overflow-x-auto rounded-xl border bg-white shadow-sm"><table className="w-full min-w-[900px] text-left text-sm"><thead className="bg-gray-50 text-xs uppercase text-gray-600"><tr><th className="p-3">Employee</th><th className="p-3">Department</th><th className="p-3">Job title</th><th className="p-3">Type</th><th className="p-3">Status</th><th className="p-3">Actions</th></tr></thead><tbody>{employees.map((employee) => <tr key={employee.id} className="border-t"><td className="p-3"><button onClick={() => setSelected(employee)} className="text-left"><strong className="text-blue-600 underline">{employee.employee_number}</strong><br />{employee.first_name} {employee.middle_name || ''} {employee.last_name}<br /><span className="text-gray-500">{employee.work_email || 'No email'}</span></button></td><td className="p-3">{employee.department_name || '—'}</td><td className="p-3">{employee.job_title || '—'}</td><td className="p-3 capitalize">{employee.employment_type}</td><td className="p-3 capitalize">{employee.employment_status}</td><td className="p-3"><button onClick={() => openEdit(employee)} className="mr-3 text-blue-600 underline">Edit</button><button onClick={() => changeStatus(employee)} className="text-blue-600 underline">{employee.employment_status === 'active' ? 'Deactivate' : 'Activate'}</button></td></tr>)}</tbody></table></div>}
    </main>
  </div>
}

import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../api'

const today = new Date()
const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)).toISOString().slice(0, 10)
const monthEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).toISOString().slice(0, 10)
const NAV = [['/dashboard', 'Dashboard'], ['/employees', 'Employees'], ['/attendance', 'Attendance'], ['/leave', 'Leave'], ['/payroll', 'Payroll']]
const blankComponent = { code: '', name: '', component_kind: 'earning', calculation_type: 'fixed', amount: '', base_component_code: '', is_taxable: false, is_active: true, effective_from: monthStart, effective_to: '', is_statutory: false, statutory_authority: '', statutory_code: '', configuration: {} }

export default function Payroll() {
  const [settings, setSettings] = useState(null)
  const [runs, setRuns] = useState([])
  const [items, setItems] = useState([])
  const [employees, setEmployees] = useState([])
  const [compensation, setCompensation] = useState([])
  const [components, setComponents] = useState([])
  const [form, setForm] = useState({ period_start: monthStart, period_end: monthEnd, pay_frequency: 'monthly', accounting_period_id: '' })
  const [settingsForm, setSettingsForm] = useState({ currency: 'KES', pay_frequency: 'monthly', salary_expense_account_id: '', employer_contribution_expense_account_id: '', employer_contributions_payable_account_id: '', employee_deductions_payable_account_id: '', net_salary_payable_account_id: '', payroll_cash_account_id: '' })
  const [compForm, setCompForm] = useState({ employee_id: '', effective_from: monthStart, pay_frequency: 'monthly', basic_salary: '', currency: 'KES' })
  const [componentForm, setComponentForm] = useState(blankComponent)
  const [editingComponent, setEditingComponent] = useState(null)
  const [selectedRun, setSelectedRun] = useState(null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const results = await Promise.all([
        api.get('/payroll/settings'), api.get('/payroll/runs'), api.get('/employees', { params: { status: 'active' } }),
        api.get('/payroll/compensation'), api.get('/payroll/components')
      ])
      setSettings(results[0].data)
      setSettingsForm((current) => ({ ...current, ...(results[0].data || {}) }))
      setRuns(results[1].data); setEmployees(results[2].data); setCompensation(results[3].data); setComponents(results[4].data)
    } catch (requestError) { setError(requestError.response?.data?.error || 'Could not load payroll.') }
  }, [])

  useEffect(() => { load() }, [load])
  const saveSettings = async (event) => {
    event.preventDefault(); setSaving(true)
    try { await api.put('/payroll/settings', settingsForm); await load() } catch (e) { setError(e.response?.data?.error || 'Could not save payroll settings.') } finally { setSaving(false) }
  }
  const saveComponent = async (event) => {
    event.preventDefault(); setSaving(true)
    try {
      const payload = { ...componentForm, amount: componentForm.amount || '0', effective_to: componentForm.effective_to || null }
      if (editingComponent) await api.put(`/payroll/components/${editingComponent.id}`, payload)
      else await api.post('/payroll/components', payload)
      setComponentForm(blankComponent); setEditingComponent(null); await load()
    } catch (e) { setError(e.response?.data?.error || 'Could not save payroll component.') } finally { setSaving(false) }
  }
  const editComponent = (component) => {
    setEditingComponent(component)
    setComponentForm({ ...blankComponent, ...component, configuration: component.configuration || {} })
  }
  const createRun = async (event) => {
    event.preventDefault(); setSaving(true)
    try { await api.post('/payroll/runs', form); await load() } catch (e) { setError(e.response?.data?.error || 'Could not create payroll run.') } finally { setSaving(false) }
  }
  const calculate = async (run) => { try { await api.post(`/payroll/runs/${run.id}/calculate`); await load() } catch (e) { setError(e.response?.data?.error || 'Could not calculate payroll.') } }
  const approve = async (run) => { try { await api.patch(`/payroll/runs/${run.id}/approve`, {}, { headers: { 'Idempotency-Key': `payroll-approve-${run.id}` } }); await load() } catch (e) { setError(e.response?.data?.error || 'Could not approve payroll.') } }
  const pay = async (run) => { try { await api.patch(`/payroll/runs/${run.id}/pay`, {}, { headers: { 'Idempotency-Key': `payroll-pay-${run.id}` } }); await load() } catch (e) { setError(e.response?.data?.error || 'Could not pay payroll.') } }
  const viewItems = async (run) => { setSelectedRun(run); try { const result = await api.get(`/payroll/runs/${run.id}/items`); setItems(result.data) } catch (e) { setError(e.response?.data?.error || 'Could not load payroll breakdown.') } }
  const saveCompensation = async (event) => { event.preventDefault(); try { await api.post('/payroll/compensation', compForm); setOpen(false); await load() } catch (e) { setError(e.response?.data?.error || 'Could not save compensation.') } }
  const updateSettings = (event) => setSettingsForm({ ...settingsForm, [event.target.name]: event.target.value })
  const updateComponent = (event) => {
    const { name, value, type, checked } = event.target
    setComponentForm({ ...componentForm, [name]: type === 'checkbox' ? checked : value })
  }

  return <div className="min-h-screen bg-gray-50">
    <header className="border-b bg-white"><div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"><Link to="/dashboard" className="text-xl font-bold text-blue-700">Invoxa</Link><nav className="flex gap-4 overflow-x-auto whitespace-nowrap text-sm font-medium text-gray-600">{NAV.map(([path, label]) => <Link key={path} to={path} className={path === '/payroll' ? 'text-blue-600' : 'hover:text-blue-600'}>{label}</Link>)}</nav></div></header>
    <main className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-6"><p className="text-sm font-semibold uppercase tracking-wide text-blue-600">Human resources</p><h1 className="text-2xl font-bold">Payroll</h1><p className="text-sm text-gray-500">Configure, calculate, approve and pay payroll runs.</p></div>
      {error && <div role="alert" className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      <form onSubmit={saveSettings} className="mb-5 rounded-xl border bg-white p-5"><h2 className="mb-3 font-semibold">Payroll settings and accounting mappings</h2><div className="grid gap-2 md:grid-cols-3">{Object.keys(settingsForm).map((key) => <label key={key} className="text-xs font-medium capitalize">{key.replaceAll('_', ' ')}<input name={key} value={settingsForm[key] || ''} onChange={updateSettings} className="mt-1 w-full rounded border px-3 py-2 text-sm" /></label>)}</div><button disabled={saving} className="mt-3 rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white">Save settings</button></form>
      <section className="mb-5 rounded-xl border bg-white p-5"><div className="mb-3 flex items-center justify-between"><div><h2 className="font-semibold">Payroll components</h2><p className="text-xs text-gray-500">Effective-dated components are snapshotted when payroll is calculated. Statutory rates require professional review.</p></div><button type="button" onClick={() => { setEditingComponent(null); setComponentForm(blankComponent) }} className="rounded bg-blue-600 px-3 py-2 text-sm font-semibold text-white">New component</button></div>
        <form onSubmit={saveComponent} className="mb-4 grid gap-2 rounded border bg-gray-50 p-3 md:grid-cols-4">
          <input required name="code" placeholder="Code (e.g. paye)" value={componentForm.code} onChange={updateComponent} className="rounded border px-3 py-2 text-sm" />
          <input required name="name" placeholder="Name" value={componentForm.name} onChange={updateComponent} className="rounded border px-3 py-2 text-sm" />
          <select name="component_kind" value={componentForm.component_kind} onChange={updateComponent} className="rounded border px-3 py-2 text-sm"><option value="earning">Employee earning</option><option value="deduction">Employee deduction</option><option value="employer_contribution">Employer contribution</option></select>
          <select name="calculation_type" value={componentForm.calculation_type} onChange={updateComponent} className="rounded border px-3 py-2 text-sm"><option value="fixed">Fixed amount</option><option value="percentage">Percentage</option></select>
          <input required name="amount" placeholder="Amount / percentage" value={componentForm.amount} onChange={updateComponent} className="rounded border px-3 py-2 text-sm" />
          <input name="base_component_code" placeholder="Percentage base (gross optional)" value={componentForm.base_component_code || ''} onChange={updateComponent} className="rounded border px-3 py-2 text-sm" />
          <input required type="date" name="effective_from" value={componentForm.effective_from} onChange={updateComponent} className="rounded border px-3 py-2 text-sm" />
          <input type="date" name="effective_to" value={componentForm.effective_to || ''} onChange={updateComponent} className="rounded border px-3 py-2 text-sm" />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="is_taxable" checked={componentForm.is_taxable} onChange={updateComponent} /> Taxable</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="is_active" checked={componentForm.is_active} onChange={updateComponent} /> Active</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="is_statutory" checked={componentForm.is_statutory} onChange={updateComponent} /> Statutory</label>
          {componentForm.is_statutory && <><input required name="statutory_authority" placeholder="Authority (KRA/NSSF/SHA)" value={componentForm.statutory_authority || ''} onChange={updateComponent} className="rounded border px-3 py-2 text-sm" /><input required name="statutory_code" placeholder="Statutory code" value={componentForm.statutory_code || ''} onChange={updateComponent} className="rounded border px-3 py-2 text-sm" /></>}
          <div className="flex gap-2 md:col-span-4"><button disabled={saving} className="rounded bg-blue-600 px-3 py-2 text-sm font-semibold text-white">{editingComponent ? 'Update component' : 'Save component'}</button>{editingComponent && <button type="button" onClick={() => { setEditingComponent(null); setComponentForm(blankComponent) }} className="rounded border px-3 py-2 text-sm">Cancel</button>}</div>
        </form>
        {components.length === 0 ? <p className="text-sm text-gray-500">No payroll components configured.</p> : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b text-xs uppercase text-gray-500"><th className="p-2">Component</th><th className="p-2">Kind</th><th className="p-2">Calculation</th><th className="p-2">Effective</th><th className="p-2">Status</th><th className="p-2"></th></tr></thead><tbody>{components.map((component) => <tr key={component.id} className="border-b"><td className="p-2"><strong>{component.name}</strong><div className="text-xs text-gray-500">{component.code}{component.is_statutory ? ` · ${component.statutory_authority}/${component.statutory_code}` : ' · non-statutory'}</div></td><td className="p-2">{component.component_kind}</td><td className="p-2">{component.amount} {component.calculation_type}</td><td className="p-2">{component.effective_from} – {component.effective_to || 'open'}</td><td className="p-2">{component.is_active ? 'Active' : 'Disabled'}</td><td className="p-2"><button type="button" onClick={() => editComponent(component)} className="text-blue-600 underline">Edit</button></td></tr>)}</tbody></table></div>}
      </section>
      <div className="mb-5 flex items-center justify-between"><h2 className="font-semibold">Payroll runs</h2><button onClick={() => setOpen(!open)} className="rounded bg-blue-600 px-4 py-2 font-semibold text-white">Compensation</button></div>
      {open && <form onSubmit={saveCompensation} className="mb-5 rounded-xl border bg-white p-5"><h2 className="mb-3 font-semibold">Employee compensation</h2><div className="grid gap-2 md:grid-cols-5"><select required value={compForm.employee_id} onChange={(e) => setCompForm({ ...compForm, employee_id: e.target.value })} className="rounded border px-3 py-2"><option value="">Employee</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.employee_number}</option>)}</select><input required type="date" value={compForm.effective_from} onChange={(e) => setCompForm({ ...compForm, effective_from: e.target.value })} className="rounded border px-3 py-2" /><input required type="number" min="0" step="0.000001" placeholder="Basic salary" value={compForm.basic_salary} onChange={(e) => setCompForm({ ...compForm, basic_salary: e.target.value })} className="rounded border px-3 py-2" /><select value={compForm.pay_frequency} onChange={(e) => setCompForm({ ...compForm, pay_frequency: e.target.value })} className="rounded border px-3 py-2"><option>monthly</option><option>biweekly</option><option>weekly</option></select><button className="rounded bg-blue-600 px-3 py-2 font-semibold text-white">Save compensation</button></div></form>}
      <form onSubmit={createRun} className="mb-5 rounded-xl border bg-white p-5"><h2 className="mb-3 font-semibold">Create payroll run</h2><div className="grid gap-2 md:grid-cols-5"><input required type="date" value={form.period_start} onChange={(e) => setForm({ ...form, period_start: e.target.value })} className="rounded border px-3 py-2" /><input required type="date" value={form.period_end} onChange={(e) => setForm({ ...form, period_end: e.target.value })} className="rounded border px-3 py-2" /><select value={form.pay_frequency} onChange={(e) => setForm({ ...form, pay_frequency: e.target.value })} className="rounded border px-3 py-2"><option>monthly</option><option>biweekly</option><option>weekly</option></select><input required placeholder="Accounting period UUID" value={form.accounting_period_id} onChange={(e) => setForm({ ...form, accounting_period_id: e.target.value })} className="rounded border px-3 py-2" /><button className="rounded bg-blue-600 px-3 py-2 font-semibold text-white">Create run</button></div></form>
      {selectedRun && <div className="mb-5 rounded-xl border bg-white p-5"><h2 className="mb-3 font-semibold">Breakdown: {selectedRun.period_start} to {selectedRun.period_end}</h2>{items.map((item) => <div key={item.id} className="flex justify-between border-b py-2 text-sm"><span>{item.employee_number}</span><span>Gross {item.gross_pay} · Net {item.net_pay}</span><a className="text-blue-600 underline" href={`/api/payroll/items/${item.id}/payslip.pdf`}>Payslip</a></div>)}</div>}
      <div className="overflow-x-auto rounded-xl border bg-white"><table className="w-full text-left text-sm"><thead><tr className="border-b text-xs uppercase text-gray-500"><th className="p-3">Period</th><th className="p-3">Status</th><th className="p-3">Gross</th><th className="p-3">Net</th><th className="p-3">Actions</th></tr></thead><tbody>{runs.map((run) => <tr key={run.id} className="border-b"><td className="p-3">{run.period_start} – {run.period_end}</td><td className="p-3">{run.status}</td><td className="p-3">{run.total_gross} {run.currency}</td><td className="p-3">{run.total_net} {run.currency}</td><td className="flex gap-2 p-3"><button onClick={() => viewItems(run)} className="text-blue-600 underline">Review</button>{run.status === 'draft' || run.status === 'calculated' ? <button onClick={() => calculate(run)} className="text-blue-600 underline">Calculate</button> : null}{run.status === 'calculated' && <button onClick={() => approve(run)} className="text-blue-600 underline">Approve</button>}{run.status === 'approved' && <button onClick={() => pay(run)} className="text-blue-600 underline">Pay</button>}</td></tr>)}</tbody></table>{runs.length === 0 && <p className="p-5 text-sm text-gray-500">No payroll runs yet.</p>}</div>
    </main>
  </div>
}

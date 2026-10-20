import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../api'

const today = () => {
  const now = new Date()
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}
const emptyForm = () => ({
  expense_date: today(), category_id: '', supplier_id: '', payee_name: '', description: '',
  amount: '', currency: 'KES', payment_method: '', payment_reference: '', notes: ''
})
const makeKey = () => window.crypto?.randomUUID?.() || `expense-${Date.now()}-${Math.random().toString(36).slice(2)}`
const money = (amount, currency) => `${currency || 'KES'} ${Number(amount || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const STATUSES = ['draft', 'approved', 'paid', 'cancelled']
const METHODS = [
  ['cash', 'Cash'], ['bank_transfer', 'Bank transfer'], ['card', 'Card'],
  ['mpesa', 'M-Pesa'], ['cheque', 'Cheque'], ['other', 'Other']
]
const STATUS_STYLES = {
  draft: 'bg-gray-100 text-gray-700', approved: 'bg-blue-100 text-blue-700',
  paid: 'bg-green-100 text-green-700', cancelled: 'bg-red-100 text-red-700'
}

function Nav() {
  return (
    <nav className="flex gap-5 overflow-x-auto whitespace-nowrap text-sm font-medium text-gray-600">
      <Link to="/dashboard" className="hover:text-blue-600">Dashboard</Link>
      <Link to="/clients" className="hover:text-blue-600">Clients</Link>
      <Link to="/products" className="hover:text-blue-600">Products</Link>
      <Link to="/suppliers" className="hover:text-blue-600">Suppliers</Link>
      <Link to="/purchasing" className="hover:text-blue-600">Purchasing</Link>
      <Link to="/sales-orders" className="hover:text-blue-600">Sales Orders</Link>
      <Link to="/expenses" className="text-blue-600">Expenses</Link>
      <Link to="/invoices" className="hover:text-blue-600">Invoices</Link>
    </nav>
  )
}

function StatusBadge({ status }) {
  return <span className={`rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${STATUS_STYLES[status] || STATUS_STYLES.draft}`}>{status}</span>
}

export default function Expenses() {
  const [expenses, setExpenses] = useState([])
  const [categories, setCategories] = useState([])
  const [suppliers, setSuppliers] = useState([])
  const [summary, setSummary] = useState(null)
  const [period, setPeriod] = useState('month')
  const [loading, setLoading] = useState(true)
  const [summaryLoading, setSummaryLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [summaryError, setSummaryError] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [payeeFilter, setPayeeFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(emptyForm)
  const [formError, setFormError] = useState('')
  const [expenseKey, setExpenseKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false)
  const [categoryForm, setCategoryForm] = useState({ name: '', description: '' })
  const [categoryError, setCategoryError] = useState('')
  const [savingCategory, setSavingCategory] = useState(false)
  const [paymentTarget, setPaymentTarget] = useState(null)
  const [paymentForm, setPaymentForm] = useState({ payment_method: '', payment_reference: '' })
  const [paymentError, setPaymentError] = useState('')
  const [savingPayment, setSavingPayment] = useState(false)
  const [actionError, setActionError] = useState('')

  const loadExpenses = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    const params = {
      search: search || undefined, payee: payeeFilter || undefined,
      status: statusFilter || undefined, category_id: categoryFilter || undefined,
      from: fromDate || undefined, to: toDate || undefined
    }
    try {
      const [expenseResponse, categoryResponse, supplierResponse] = await Promise.all([
        api.get('/expenses', { params }),
        api.get('/expenses/categories', { params: { active: 'true' } }),
        api.get('/suppliers', { params: { active: 'true' } })
      ])
      setExpenses(expenseResponse.data)
      setCategories(categoryResponse.data)
      setSuppliers(supplierResponse.data)
    } catch (error) {
      setLoadError(error.response?.data?.error || 'Could not load expenses. Check that the required migrations are installed, then retry.')
    } finally {
      setLoading(false)
    }
  }, [search, payeeFilter, statusFilter, categoryFilter, fromDate, toDate])

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true)
    setSummaryError('')
    try {
      const response = await api.get('/expenses/summary', { params: { period } })
      setSummary(response.data)
    } catch (error) {
      setSummaryError(error.response?.data?.error || 'Could not load the expense summary.')
    } finally {
      setSummaryLoading(false)
    }
  }, [period])

  useEffect(() => { loadExpenses() }, [loadExpenses, reloadKey])
  useEffect(() => { loadSummary() }, [loadSummary, reloadKey])

  const openCreate = () => {
    setEditing(null)
    setForm(emptyForm())
    setExpenseKey(makeKey())
    setFormError('')
    setFormOpen(true)
  }

  const openEdit = (expense) => {
    setEditing(expense)
    setForm({
      expense_date: String(expense.expense_date).slice(0, 10),
      category_id: expense.category_id,
      supplier_id: expense.supplier_id || '',
      payee_name: expense.payee_name || '',
      description: expense.description,
      amount: String(expense.amount),
      currency: expense.currency.trim(),
      payment_method: expense.payment_method || '',
      payment_reference: expense.payment_reference || '',
      notes: expense.notes || ''
    })
    setFormError('')
    setFormOpen(true)
  }

  const saveExpense = async (event) => {
    event.preventDefault()
    setSaving(true)
    setFormError('')
    const payload = { ...form, supplier_id: form.supplier_id || null }
    try {
      if (editing) await api.put(`/expenses/${editing.id}`, payload)
      else await api.post('/expenses', payload, { headers: { 'Idempotency-Key': expenseKey } })
      setFormOpen(false)
      setReloadKey((value) => value + 1)
    } catch (error) {
      setFormError(error.response?.data?.error || 'Could not save the expense. Retrying this draft uses the same request key.')
    } finally {
      setSaving(false)
    }
  }

  const showDetails = async (expense) => {
    setDetail(expense)
    setDetailLoading(true)
    setDetailError('')
    try {
      const response = await api.get(`/expenses/${expense.id}`)
      setDetail(response.data)
    } catch (error) {
      setDetailError(error.response?.data?.error || 'Could not load expense details.')
    } finally {
      setDetailLoading(false)
    }
  }

  const changeStatus = async (expense, status) => {
    if (status === 'cancelled' && !window.confirm(`Cancel ${expense.expense_number}?`)) return
    setActionError('')
    try {
      await api.patch(`/expenses/${expense.id}/status`, { status })
      setReloadKey((value) => value + 1)
      if (detail?.id === expense.id) await showDetails(expense)
    } catch (error) {
      setActionError(error.response?.data?.error || 'Could not update expense status.')
    }
  }

  const openPayment = (expense) => {
    setPaymentTarget(expense)
    setPaymentForm({ payment_method: expense.payment_method || '', payment_reference: expense.payment_reference || '' })
    setPaymentError('')
  }

  const recordPayment = async (event) => {
    event.preventDefault()
    if (!paymentTarget) return
    setSavingPayment(true)
    setPaymentError('')
    try {
      await api.patch(`/expenses/${paymentTarget.id}/status`, { status: 'paid', ...paymentForm })
      const paidExpense = paymentTarget
      setPaymentTarget(null)
      setReloadKey((value) => value + 1)
      if (detail?.id === paidExpense.id) await showDetails(paidExpense)
    } catch (error) {
      setPaymentError(error.response?.data?.error || 'Payment was not recorded. The expense remains approved.')
    } finally {
      setSavingPayment(false)
    }
  }

  const addCategory = async (event) => {
    event.preventDefault()
    setSavingCategory(true)
    setCategoryError('')
    try {
      await api.post('/expenses/categories', categoryForm)
      setCategoryForm({ name: '', description: '' })
      setReloadKey((value) => value + 1)
    } catch (error) {
      setCategoryError(error.response?.data?.error || 'Could not add expense category.')
    } finally {
      setSavingCategory(false)
    }
  }

  const deactivateCategory = async (category) => {
    if (!window.confirm(`Deactivate ${category.name}? Existing expenses will keep this category.`)) return
    try {
      await api.patch(`/expenses/categories/${category.id}/deactivate`)
      setReloadKey((value) => value + 1)
    } catch (error) {
      setCategoryError(error.response?.data?.error || 'Could not deactivate category.')
    }
  }

  const Actions = ({ expense }) => (
    <div className="flex flex-wrap gap-3 text-sm">
      <button onClick={() => showDetails(expense)} className="font-medium text-blue-700 hover:underline">View</button>
      {expense.status === 'draft' && <>
        <button onClick={() => openEdit(expense)} className="text-gray-700 hover:underline">Edit</button>
        <button onClick={() => changeStatus(expense, 'approved')} className="text-green-700 hover:underline">Approve</button>
      </>}
      {expense.status === 'approved' && <button onClick={() => openPayment(expense)} className="text-green-700 hover:underline">Record payment</button>}
      {['draft', 'approved'].includes(expense.status) && <button onClick={() => changeStatus(expense, 'cancelled')} className="text-red-700 hover:underline">Cancel</button>}
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
          <Link to="/dashboard" className="text-xl font-bold text-blue-700">Invoxa</Link>
          <Nav />
          <button onClick={() => { sessionStorage.clear(); window.location.href = '/login' }} className="self-start rounded-lg border px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 lg:self-auto">Logout</button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-8">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div><p className="text-sm font-semibold uppercase tracking-wide text-blue-600">Spend management</p><h1 className="mt-1 text-2xl font-bold text-gray-900">Expenses</h1><p className="mt-1 text-sm text-gray-500">Record, approve and mark business expenses paid.</p></div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setCategoryManagerOpen(true)} className="rounded-lg border bg-white px-4 py-2.5 font-medium text-gray-700 hover:bg-gray-50">Manage categories</button>
            <button onClick={openCreate} disabled={categories.length === 0} className="rounded-lg bg-blue-600 px-4 py-2.5 font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">Add expense</button>
          </div>
        </div>

        <p className="mb-5 rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-900">Expenses are entered manually. Bank and M-Pesa transaction imports are not connected, and invoices or purchase orders do not create expenses automatically.</p>

        {actionError && <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{actionError}</div>}
        {categories.length === 0 && !loading && <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><span>Add an expense category before creating expenses.</span><button onClick={() => setCategoryManagerOpen(true)} className="font-semibold underline">Add a category</button></div>}

        <section className="mb-6 rounded-xl border bg-white p-4 shadow-sm sm:p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold text-gray-900">Expense summary</h2><p className="text-xs text-gray-500">Approved and paid expenses only; currencies are kept separate.</p></div><select value={period} onChange={(event) => setPeriod(event.target.value)} className="rounded-lg border bg-white px-3 py-2 text-sm"><option value="month">This month</option><option value="quarter">This quarter</option><option value="year">This year</option></select></div>
          {summaryLoading ? <p className="text-sm text-gray-500">Loading summary…</p> : summaryError ? <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{summaryError}</p> : <>
            <p className="mb-3 text-xs text-gray-500">{summary.from} to {summary.to}</p>
            {!summary.currency_totals.length ? <p className="rounded-lg bg-gray-50 p-4 text-sm text-gray-500">No approved or paid expenses for this period.</p> : <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{summary.currency_totals.map((total) => <article key={total.currency} className="rounded-lg bg-blue-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-blue-700">{total.currency} expenses</p><p className="mt-1 text-xl font-bold text-gray-900">{money(total.total, total.currency)}</p><p className="mt-1 text-xs text-gray-500">{total.expense_count} expenses · {money(total.approved_total, total.currency)} approved · {money(total.paid_total, total.currency)} paid</p></article>)}</div>}
            {summary.category_totals.length > 0 && <div className="mt-4"><h3 className="mb-2 text-sm font-semibold text-gray-800">By category</h3><div className="flex flex-wrap gap-2">{summary.category_totals.map((row) => <span key={`${row.category_id}-${row.currency}`} className="rounded-full border bg-white px-3 py-1.5 text-xs text-gray-700">{row.category_name}: <strong>{money(row.total, row.currency)}</strong></span>)}</div></div>}
          </>}
        </section>

        <section className="mb-5 rounded-xl border bg-white p-4 shadow-sm">
          <form onSubmit={(event) => { event.preventDefault(); setSearch(searchInput.trim()) }} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-xs font-medium text-gray-600 lg:col-span-2">Search<input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Expense number, description or payee" className="mt-1 w-full rounded-lg border px-3 py-2.5 text-sm" /></label>
            <label className="text-xs font-medium text-gray-600">Payee filter<input value={payeeFilter} onChange={(event) => setPayeeFilter(event.target.value)} placeholder="Supplier or payee" className="mt-1 w-full rounded-lg border px-3 py-2.5 text-sm" /></label>
            <label className="text-xs font-medium text-gray-600">Status<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="mt-1 w-full rounded-lg border bg-white px-3 py-2.5 text-sm"><option value="">All statuses</option>{STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}</select></label>
            <label className="text-xs font-medium text-gray-600">Category<select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)} className="mt-1 w-full rounded-lg border bg-white px-3 py-2.5 text-sm"><option value="">All categories</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
            <label className="text-xs font-medium text-gray-600">From date<input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2.5 text-sm" /></label>
            <label className="text-xs font-medium text-gray-600">To date<input type="date" min={fromDate || undefined} value={toDate} onChange={(event) => setToDate(event.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2.5 text-sm" /></label>
          </form>
        </section>

        {loadError && <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{loadError}</div>}
        {loading ? <div className="rounded-xl border bg-white p-10 text-center text-gray-500">Loading expenses…</div> : expenses.length === 0 ? (
          <div className="rounded-xl border border-dashed bg-white p-10 text-center"><h2 className="font-semibold text-gray-800">No expenses found</h2><p className="mt-1 text-sm text-gray-500">Create a draft expense or adjust your filters.</p></div>
        ) : <div className="overflow-hidden rounded-xl border bg-white shadow-sm">
          <div className="hidden overflow-x-auto md:block"><table className="min-w-full divide-y divide-gray-200"><thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500"><tr><th className="px-5 py-3">Expense</th><th className="px-5 py-3">Date / category</th><th className="px-5 py-3">Payee</th><th className="px-5 py-3">Amount</th><th className="px-5 py-3">Status</th><th className="px-5 py-3">Actions</th></tr></thead><tbody className="divide-y divide-gray-100 text-sm">{expenses.map((expense) => <tr key={expense.id} className="hover:bg-gray-50"><td className="px-5 py-4"><p className="font-semibold text-blue-700">{expense.expense_number}</p><p className="max-w-xs truncate text-xs text-gray-500">{expense.description}</p></td><td className="px-5 py-4"><p>{String(expense.expense_date).slice(0, 10)}</p><p className="text-xs text-gray-500">{expense.category_name}</p></td><td className="px-5 py-4">{expense.supplier_name || expense.payee_name || '—'}</td><td className="px-5 py-4 font-semibold">{money(expense.amount, expense.currency.trim())}</td><td className="px-5 py-4"><StatusBadge status={expense.status} /></td><td className="px-5 py-4"><Actions expense={expense} /></td></tr>)}</tbody></table></div>
          <div className="divide-y md:hidden">{expenses.map((expense) => <article key={expense.id} className="space-y-3 p-4"><div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold text-blue-700">{expense.expense_number}</h2><p className="text-sm text-gray-600">{expense.description}</p></div><StatusBadge status={expense.status} /></div><div className="flex justify-between text-sm"><span className="text-gray-500">{String(expense.expense_date).slice(0, 10)} · {expense.category_name}</span><strong>{money(expense.amount, expense.currency.trim())}</strong></div><p className="text-xs text-gray-500">{expense.supplier_name || expense.payee_name || 'No payee recorded'}</p><div className="border-t pt-3"><Actions expense={expense} /></div></article>)}</div>
        </div>}
      </main>

      {formOpen && <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"><section role="dialog" aria-modal="true" aria-labelledby="expense-form-title" className="max-h-[95vh] w-full max-w-3xl overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl sm:p-6">
        <div className="mb-5 flex items-start justify-between gap-4"><div><p className="text-sm text-blue-600">Draft expense</p><h2 id="expense-form-title" className="text-xl font-bold text-gray-900">{editing ? `Edit ${editing.expense_number}` : 'Add expense'}</h2></div><button disabled={saving} onClick={() => setFormOpen(false)} className="rounded-md px-2 py-1 text-xl text-gray-500 hover:bg-gray-100" aria-label="Close">×</button></div>
        <form onSubmit={saveExpense} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <label className="text-sm font-medium text-gray-700">Expense date *<input required type="date" value={form.expense_date} onChange={(event) => setForm({ ...form, expense_date: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2.5" /></label>
            <label className="text-sm font-medium text-gray-700">Category *<select required value={form.category_id} onChange={(event) => setForm({ ...form, category_id: event.target.value })} className="mt-1 w-full rounded-lg border bg-white px-3 py-2.5"><option value="">Choose category</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
            <label className="text-sm font-medium text-gray-700">Supplier (optional)<select value={form.supplier_id} onChange={(event) => setForm({ ...form, supplier_id: event.target.value })} className="mt-1 w-full rounded-lg border bg-white px-3 py-2.5"><option value="">No supplier selected</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.business_name}</option>)}</select></label>
            <label className="text-sm font-medium text-gray-700">Payee name<input maxLength="255" value={form.payee_name} onChange={(event) => setForm({ ...form, payee_name: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2.5" /></label>
            <label className="text-sm font-medium text-gray-700">Amount *<input required type="number" min="0.01" step="0.01" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2.5" /></label>
            <label className="text-sm font-medium text-gray-700">Currency<select value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value })} className="mt-1 w-full rounded-lg border bg-white px-3 py-2.5">{['KES', 'USD', 'EUR', 'GBP', 'TZS', 'UGX'].map((currency) => <option key={currency}>{currency}</option>)}</select></label>
          </div>
          <label className="block text-sm font-medium text-gray-700">Description *<input required maxLength="2000" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2.5" /></label>
          <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-medium text-gray-700">Payment method (optional)<select value={form.payment_method} onChange={(event) => setForm({ ...form, payment_method: event.target.value })} className="mt-1 w-full rounded-lg border bg-white px-3 py-2.5"><option value="">Not recorded</option>{METHODS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="text-sm font-medium text-gray-700">Payment reference<input maxLength="255" value={form.payment_reference} onChange={(event) => setForm({ ...form, payment_reference: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2.5" /></label></div>
          <label className="block text-sm font-medium text-gray-700">Notes<textarea maxLength="10000" rows="3" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2.5" /></label>
          <p className="text-xs text-gray-500">Attachments are not enabled because this app has no file storage or upload validation flow.</p>
          {formError && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{formError}</p>}
          <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end"><button type="button" disabled={saving} onClick={() => setFormOpen(false)} className="rounded-lg border px-4 py-2.5 text-gray-700">Close</button><button disabled={saving} className="rounded-lg bg-blue-600 px-4 py-2.5 font-semibold text-white disabled:opacity-60">{saving ? 'Saving…' : 'Save draft'}</button></div>
        </form>
      </section></div>}

      {categoryManagerOpen && <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"><section role="dialog" aria-modal="true" aria-labelledby="category-manager-title" className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl sm:p-6">
        <div className="mb-5 flex items-start justify-between"><div><p className="text-sm text-blue-600">Expense setup</p><h2 id="category-manager-title" className="text-xl font-bold text-gray-900">Categories</h2></div><button onClick={() => setCategoryManagerOpen(false)} className="rounded-md px-2 py-1 text-xl text-gray-500" aria-label="Close">×</button></div>
        <form onSubmit={addCategory} className="space-y-3 rounded-lg bg-gray-50 p-4"><label className="block text-sm font-medium text-gray-700">Category name *<input required maxLength="100" value={categoryForm.name} onChange={(event) => setCategoryForm({ ...categoryForm, name: event.target.value })} className="mt-1 w-full rounded-lg border bg-white px-3 py-2.5" /></label><label className="block text-sm font-medium text-gray-700">Description<input maxLength="1000" value={categoryForm.description} onChange={(event) => setCategoryForm({ ...categoryForm, description: event.target.value })} className="mt-1 w-full rounded-lg border bg-white px-3 py-2.5" /></label>{categoryError && <p role="alert" className="text-sm text-red-700">{categoryError}</p>}<button disabled={savingCategory} className="rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white disabled:opacity-50">{savingCategory ? 'Adding…' : 'Add category'}</button></form>
        <div className="mt-5"><h3 className="mb-2 font-semibold text-gray-800">Active categories</h3>{categories.length === 0 ? <p className="rounded-lg bg-gray-50 p-4 text-sm text-gray-500">No categories yet.</p> : <ul className="divide-y rounded-lg border">{categories.map((category) => <li key={category.id} className="flex items-center justify-between gap-3 p-3"><div><p className="font-medium text-gray-800">{category.name}</p><p className="text-xs text-gray-500">{category.expense_count} expenses</p></div><button onClick={() => deactivateCategory(category)} className="text-sm text-red-700 hover:underline">Deactivate</button></li>)}</ul>}</div>
      </section></div>}

      {paymentTarget && <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"><section role="dialog" aria-modal="true" aria-labelledby="expense-payment-title" className="w-full max-w-lg rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl sm:p-6"><h2 id="expense-payment-title" className="text-xl font-bold text-gray-900">Record payment</h2><p className="mt-1 text-sm text-gray-500">{paymentTarget.expense_number} · {money(paymentTarget.amount, paymentTarget.currency.trim())}</p><form onSubmit={recordPayment} className="mt-5 space-y-4"><label className="block text-sm font-medium text-gray-700">Payment method *<select required value={paymentForm.payment_method} onChange={(event) => setPaymentForm({ ...paymentForm, payment_method: event.target.value })} className="mt-1 w-full rounded-lg border bg-white px-3 py-2.5"><option value="">Choose method</option>{METHODS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="block text-sm font-medium text-gray-700">Payment reference<input maxLength="255" value={paymentForm.payment_reference} onChange={(event) => setPaymentForm({ ...paymentForm, payment_reference: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2.5" /></label>{paymentError && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{paymentError}</p>}<p className="text-xs text-gray-500">Marking paid records the payment method, user and timestamp. It does not initiate a bank or M-Pesa transfer.</p><div className="flex justify-end gap-2 border-t pt-4"><button type="button" disabled={savingPayment} onClick={() => setPaymentTarget(null)} className="rounded-lg border px-4 py-2.5">Close</button><button disabled={savingPayment} className="rounded-lg bg-green-600 px-4 py-2.5 font-semibold text-white disabled:opacity-50">{savingPayment ? 'Recording…' : 'Confirm payment'}</button></div></form></section></div>}

      {detail && <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"><section role="dialog" aria-modal="true" aria-labelledby="expense-detail-title" className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl sm:p-6"><div className="mb-5 flex items-start justify-between"><div><p className="text-sm text-blue-600">Expense record</p><h2 id="expense-detail-title" className="text-xl font-bold text-gray-900">{detail.expense_number}</h2></div><button onClick={() => setDetail(null)} className="rounded-md px-2 py-1 text-xl text-gray-500" aria-label="Close">×</button></div>{detailLoading ? <p className="py-10 text-center text-gray-500">Loading details…</p> : detailError ? <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{detailError}</p> : <><div className="grid gap-4 rounded-lg bg-gray-50 p-4 text-sm sm:grid-cols-2"><div><p className="text-gray-500">Status</p><StatusBadge status={detail.status} /></div><div><p className="text-gray-500">Amount</p><p className="font-semibold">{money(detail.amount, detail.currency.trim())}</p></div><div><p className="text-gray-500">Expense date</p><p>{String(detail.expense_date).slice(0, 10)}</p></div><div><p className="text-gray-500">Category</p><p>{detail.category_name}</p></div><div><p className="text-gray-500">Supplier / payee</p><p>{detail.supplier_name || detail.payee_name || '—'}</p></div><div><p className="text-gray-500">Payment method / reference</p><p>{detail.payment_method || '—'}{detail.payment_reference ? ` · ${detail.payment_reference}` : ''}</p></div><div className="sm:col-span-2"><p className="text-gray-500">Description</p><p>{detail.description}</p></div>{detail.notes && <div className="sm:col-span-2"><p className="text-gray-500">Notes</p><p className="whitespace-pre-wrap">{detail.notes}</p></div>}</div><div className="mt-4 space-y-1 text-xs text-gray-500"><p>Created {new Date(detail.created_at).toLocaleString('en-KE')}{detail.created_by ? ` · user ${detail.created_by}` : ''}</p>{detail.approved_at && <p>Approved {new Date(detail.approved_at).toLocaleString('en-KE')}{detail.approved_by ? ` · user ${detail.approved_by}` : ''}</p>}{detail.paid_at && <p>Paid {new Date(detail.paid_at).toLocaleString('en-KE')}{detail.paid_by ? ` · user ${detail.paid_by}` : ''}</p>}{detail.cancelled_at && <p>Cancelled {new Date(detail.cancelled_at).toLocaleString('en-KE')}{detail.cancelled_by ? ` · user ${detail.cancelled_by}` : ''}</p>}</div></>}</section></div>}
    </div>
  )
}

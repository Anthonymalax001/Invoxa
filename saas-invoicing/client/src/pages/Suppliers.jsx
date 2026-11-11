import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../api'

const EMPTY_SUPPLIER = {
  business_name: '', contact_person: '', email: '', phone: '', address: '', notes: ''
}

const dateLabel = (value) => value ? new Date(`${value.slice(0, 10)}T00:00:00`).toLocaleDateString('en-KE') : '—'

function Nav() {
  return (
    <nav className="flex gap-5 overflow-x-auto whitespace-nowrap text-sm font-medium text-gray-600">
      <Link to="/dashboard" className="hover:text-blue-600">Dashboard</Link>
      <Link to="/clients" className="hover:text-blue-600">Clients</Link>
      <Link to="/products" className="hover:text-blue-600">Products</Link>
      <Link to="/suppliers" className="text-blue-600">Suppliers</Link>
      <Link to="/purchasing" className="hover:text-blue-600">Purchasing</Link>
      <Link to="/supplier-bills" className="hover:text-blue-600">Supplier bills</Link>
      <Link to="/sales-orders" className="hover:text-blue-600">Sales Orders</Link>
      <Link to="/expenses" className="hover:text-blue-600">Expenses</Link>
      <Link to="/invoices" className="hover:text-blue-600">Invoices</Link>
    </nav>
  )
}

export default function Suppliers() {
  const [suppliers, setSuppliers] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(EMPTY_SUPPLIER)
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)
  const [historySupplier, setHistorySupplier] = useState(null)
  const [history, setHistory] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')

  const loadSuppliers = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const response = await api.get('/suppliers', { params: { search } })
      setSuppliers(response.data)
    } catch (error) {
      setLoadError(error.response?.data?.error || 'Could not load suppliers. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [search])

  useEffect(() => { loadSuppliers() }, [loadSuppliers, reloadKey])

  const openCreate = () => {
    setEditing(null)
    setForm(EMPTY_SUPPLIER)
    setFormError('')
    setFormOpen(true)
  }

  const openEdit = (supplier) => {
    setEditing(supplier)
    setForm({
      business_name: supplier.business_name || '', contact_person: supplier.contact_person || '',
      email: supplier.email || '', phone: supplier.phone || '', address: supplier.address || '',
      notes: supplier.notes || ''
    })
    setFormError('')
    setFormOpen(true)
  }

  const submitForm = async (event) => {
    event.preventDefault()
    const phone = form.phone.trim()
    if (phone && !/^\d{10}$/.test(phone)) {
      setFormError('Phone number must contain exactly 10 digits, with no letters or punctuation.')
      return
    }
    setSaving(true)
    setFormError('')
    try {
      const payload = { ...form, phone }
      if (editing) await api.put(`/suppliers/${editing.id}`, payload)
      else await api.post('/suppliers', payload)
      setFormOpen(false)
      setEditing(null)
      setReloadKey((value) => value + 1)
    } catch (error) {
      setFormError(error.response?.data?.error || 'Could not save supplier. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const toggleActive = async (supplier) => {
    try {
      await api.patch(`/suppliers/${supplier.id}/status`, { is_active: !supplier.is_active })
      setReloadKey((value) => value + 1)
    } catch (error) {
      setLoadError(error.response?.data?.error || 'Could not update supplier status.')
    }
  }

  const openHistory = async (supplier) => {
    setHistorySupplier(supplier)
    setHistory([])
    setHistoryError('')
    setHistoryLoading(true)
    try {
      const response = await api.get(`/suppliers/${supplier.id}/purchase-orders`)
      setHistory(response.data)
    } catch (error) {
      setHistoryError(error.response?.data?.error || 'Could not load purchase history.')
    } finally {
      setHistoryLoading(false)
    }
  }

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
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-blue-600">Purchasing</p>
            <h1 className="mt-1 text-2xl font-bold text-gray-900">Suppliers</h1>
            <p className="mt-1 text-sm text-gray-500">Manage supplier contacts and review their purchase order history.</p>
          </div>
          <button onClick={openCreate} className="rounded-lg bg-blue-600 px-4 py-2.5 font-semibold text-white hover:bg-blue-700">Add supplier</button>
        </div>

        <form onSubmit={(event) => { event.preventDefault(); setSearch(searchInput.trim()) }} className="mb-5 flex gap-2">
          <input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Search supplier, contact or email" className="min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2.5 outline-none focus:border-blue-500" />
          <button className="rounded-lg border bg-white px-4 py-2 font-medium text-gray-700 hover:bg-gray-50">Search</button>
        </form>

        {loadError && <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{loadError}</div>}
        {loading ? (
          <div className="rounded-xl border bg-white p-10 text-center text-gray-500">Loading suppliers…</div>
        ) : suppliers.length === 0 ? (
          <div className="rounded-xl border border-dashed bg-white p-10 text-center">
            <h2 className="font-semibold text-gray-800">No suppliers found</h2>
            <p className="mt-1 text-sm text-gray-500">Add a supplier to start preparing purchase orders.</p>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {suppliers.map((supplier) => (
              <article key={supplier.id} className="rounded-xl border bg-white p-5 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-lg font-semibold text-gray-900">{supplier.business_name}</h2>
                    <p className="mt-1 text-sm text-gray-500">{supplier.contact_person || 'No contact person'}</p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${supplier.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                    {supplier.is_active ? 'Active' : 'Inactive'}
                  </span>
                </div>
                <div className="mt-4 space-y-1 text-sm text-gray-600">
                  <p className="break-all">{supplier.email || 'No email'}</p>
                  <p>{supplier.phone || 'No phone'}</p>
                  <p className="text-gray-500">{supplier.purchase_order_count || 0} purchase orders</p>
                </div>
                <div className="mt-5 flex flex-wrap gap-2 border-t pt-4">
                  <button onClick={() => openEdit(supplier)} className="rounded-md border px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50">Edit</button>
                  <button onClick={() => openHistory(supplier)} className="rounded-md border px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-50">Purchase history</button>
                  <button onClick={() => toggleActive(supplier)} className="rounded-md px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50">
                    {supplier.is_active ? 'Deactivate' : 'Reactivate'}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </main>

      {formOpen && (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) { setEditing(null); setForm(EMPTY_SUPPLIER); setFormError(''); setFormOpen(false) } }}>
          <section role="dialog" aria-modal="true" aria-labelledby="supplier-form-title" className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl sm:p-6">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div><h2 id="supplier-form-title" className="text-xl font-bold text-gray-900">{editing ? 'Edit supplier' : 'Add supplier'}</h2><p className="mt-1 text-sm text-gray-500">Supplier details are private to your workspace.</p></div>
              <button onClick={() => { setEditing(null); setForm(EMPTY_SUPPLIER); setFormError(''); setFormOpen(false) }} className="rounded-md px-2 py-1 text-xl text-gray-500 hover:bg-gray-100" aria-label="Close">×</button>
            </div>
            <form onSubmit={submitForm} className="space-y-4">
              <label className="block text-sm font-medium text-gray-700">Supplier/business name *
                <input required maxLength={255} value={form.business_name} onChange={(event) => setForm({ ...form, business_name: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2.5" />
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-sm font-medium text-gray-700">Contact person
                  <input maxLength={255} value={form.contact_person} onChange={(event) => setForm({ ...form, contact_person: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2.5" />
                </label>
                <label className="block text-sm font-medium text-gray-700">Email
                  <input type="email" maxLength={255} value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2.5" />
                </label>
                <label className="block text-sm font-medium text-gray-700">Phone
                  <input
                    type="tel"
                    inputMode="numeric"
                    autoComplete="tel-national"
                    maxLength={10}
                    value={form.phone}
                    onChange={(event) => setForm({ ...form, phone: event.target.value })}
                    onPaste={(event) => {
                      const pasted = event.clipboardData.getData('text').trim()
                      if (!/^\d{10}$/.test(pasted)) {
                        event.preventDefault()
                        setFormError('Pasted phone number must contain exactly 10 digits, with no letters or punctuation.')
                        return
                      }
                      event.preventDefault()
                      setForm((current) => ({ ...current, phone: pasted }))
                      setFormError('')
                    }}
                    aria-describedby="supplier-phone-help"
                    className="mt-1 w-full rounded-lg border px-3 py-2.5"
                  />
                  <span id="supplier-phone-help" className="mt-1 block text-xs font-normal text-gray-500">Optional. Enter exactly 10 digits; leading zeroes are preserved.</span>
                </label>
                <label className="block text-sm font-medium text-gray-700">Address
                  <input maxLength={10000} value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2.5" />
                </label>
              </div>
              <label className="block text-sm font-medium text-gray-700">Notes
                <textarea rows="3" maxLength={10000} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2.5" />
              </label>
              {formError && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{formError}</p>}
              <div className="flex justify-end gap-2 border-t pt-4">
                <button type="button" disabled={saving} onClick={() => { setEditing(null); setForm(EMPTY_SUPPLIER); setFormError(''); setFormOpen(false) }} className="rounded-lg border px-4 py-2.5 text-gray-700">Cancel</button>
                <button disabled={saving} className="rounded-lg bg-blue-600 px-4 py-2.5 font-semibold text-white disabled:opacity-60">{saving ? 'Saving…' : 'Save supplier'}</button>
              </div>
            </form>
          </section>
        </div>
      )}

      {historySupplier && (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
          <section role="dialog" aria-modal="true" aria-labelledby="supplier-history-title" className="max-h-[88vh] w-full max-w-3xl overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl sm:p-6">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div><p className="text-sm text-blue-600">Supplier purchase history</p><h2 id="supplier-history-title" className="text-xl font-bold text-gray-900">{historySupplier.business_name}</h2></div>
              <button onClick={() => setHistorySupplier(null)} className="rounded-md px-2 py-1 text-xl text-gray-500 hover:bg-gray-100" aria-label="Close">×</button>
            </div>
            {historyLoading ? <p className="py-8 text-center text-gray-500">Loading purchase history…</p> : historyError ? <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{historyError}</p> : history.length === 0 ? <p className="rounded-lg bg-gray-50 p-8 text-center text-gray-500">No purchase orders for this supplier yet.</p> : (
              <div className="divide-y rounded-lg border">
                {history.map((order) => (
                  <Link key={order.id} to={`/purchasing?search=${encodeURIComponent(order.purchase_order_number)}`} onClick={() => setHistorySupplier(null)} className="flex flex-col gap-2 p-4 hover:bg-gray-50 sm:flex-row sm:items-center sm:justify-between">
                    <div><p className="font-semibold text-blue-700">{order.purchase_order_number}</p><p className="text-sm text-gray-500">{dateLabel(order.order_date)} · {order.item_count} lines</p></div>
                    <div className="flex items-center gap-3"><span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold capitalize text-blue-700">{order.status.replaceAll('_', ' ')}</span><span className="font-semibold">KES {Number(order.total || 0).toLocaleString('en-KE', { minimumFractionDigits: 2 })}</span></div>
                  </Link>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

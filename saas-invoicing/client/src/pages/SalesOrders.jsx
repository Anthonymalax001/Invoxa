import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../api'

const today = () => {
  const now = new Date()
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}
const emptyForm = () => ({
  client_id: '', order_date: today(), expected_delivery_date: '', tax_rate: '16.00', notes: '',
  items: [{ product_id: '', quantity: '1.00', unit_price: '0.00', discount_rate: '0.00' }]
})
const money = (value) => `KES ${Number(value || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const quantity = (value) => Number(value || 0).toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 })

const STATUS_STYLES = {
  draft: 'bg-gray-100 text-gray-700',
  confirmed: 'bg-blue-100 text-blue-700',
  partially_fulfilled: 'bg-amber-100 text-amber-800',
  fulfilled: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-700'
}

function Nav() {
  return (
    <nav className="flex gap-5 overflow-x-auto whitespace-nowrap text-sm font-medium text-gray-600">
      <Link to="/dashboard" className="hover:text-blue-600">Dashboard</Link>
      <Link to="/clients" className="hover:text-blue-600">Clients</Link>
      <Link to="/products" className="hover:text-blue-600">Products</Link>
      <Link to="/suppliers" className="hover:text-blue-600">Suppliers</Link>
      <Link to="/purchasing" className="hover:text-blue-600">Purchasing</Link>
      <Link to="/sales-orders" className="text-blue-600">Sales Orders</Link>
      <Link to="/expenses" className="hover:text-blue-600">Expenses</Link>
      <Link to="/invoices" className="hover:text-blue-600">Invoices</Link>
    </nav>
  )
}

function StatusBadge({ status }) {
  return <span className={`rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${STATUS_STYLES[status] || STATUS_STYLES.draft}`}>{status.replaceAll('_', ' ')}</span>
}

export default function SalesOrders() {
  const [orders, setOrders] = useState([])
  const [clients, setClients] = useState([])
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [formOpen, setFormOpen] = useState(false)
  const [editingOrder, setEditingOrder] = useState(null)
  const [form, setForm] = useState(emptyForm)
  const [formError, setFormError] = useState('')
  const [savingOrder, setSavingOrder] = useState(false)
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [fulfillmentTarget, setFulfillmentTarget] = useState(null)
  const [fulfillmentQuantities, setFulfillmentQuantities] = useState({})
  const [fulfillmentKey, setFulfillmentKey] = useState('')
  const [fulfillmentNotes, setFulfillmentNotes] = useState('')
  const [fulfillmentError, setFulfillmentError] = useState('')
  const [savingFulfillment, setSavingFulfillment] = useState(false)
  const [creatingInvoiceId, setCreatingInvoiceId] = useState('')
  const [invoiceNotice, setInvoiceNotice] = useState(null)

  const loadOrders = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const response = await api.get('/sales-orders', { params: { search, status: statusFilter || undefined } })
      setOrders(response.data)
    } catch (error) {
      setLoadError(error.response?.data?.error || 'Could not load sales orders. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [search, statusFilter])

  useEffect(() => { loadOrders() }, [loadOrders, reloadKey])

  useEffect(() => {
    Promise.all([
      api.get('/clients'),
      api.get('/products', { params: { active: 'true' } })
    ]).then(([clientResponse, productResponse]) => {
      setClients(clientResponse.data)
      setProducts(productResponse.data)
    }).catch((error) => {
      setLoadError(error.response?.data?.error || 'Could not load clients or products.')
    })
  }, [reloadKey])

  const openCreate = () => {
    setEditingOrder(null)
    setForm(emptyForm())
    setFormError('')
    setFormOpen(true)
  }

  const openEdit = (order) => {
    setEditingOrder(order)
    setForm({
      client_id: order.client_id,
      order_date: String(order.order_date).slice(0, 10),
      expected_delivery_date: order.expected_delivery_date ? String(order.expected_delivery_date).slice(0, 10) : '',
      tax_rate: String(order.tax_rate ?? '0'),
      notes: order.notes || '',
      items: order.items.map((item) => ({
        product_id: item.product_id,
        quantity: String(item.quantity_ordered),
        unit_price: String(item.unit_price),
        discount_rate: String(item.discount_rate)
      }))
    })
    setFormError('')
    setFormOpen(true)
  }

  const editOrder = async (order) => {
    try {
      const response = await api.get(`/sales-orders/${order.id}`)
      openEdit(response.data)
    } catch (error) {
      setLoadError(error.response?.data?.error || 'Could not load the draft sales order.')
    }
  }

  const updateLine = (index, key, value) => {
    setForm((current) => ({
      ...current,
      items: current.items.map((item, itemIndex) => {
        if (itemIndex !== index) return item
        if (key === 'product_id') {
          const product = products.find((row) => row.id === value)
          return { ...item, product_id: value, unit_price: product ? String(product.selling_price) : item.unit_price }
        }
        return { ...item, [key]: value }
      })
    }))
  }

  const addLine = () => setForm((current) => ({ ...current, items: [...current.items, { product_id: '', quantity: '1.00', unit_price: '0.00', discount_rate: '0.00' }] }))
  const removeLine = (index) => setForm((current) => ({ ...current, items: current.items.filter((_, itemIndex) => itemIndex !== index) }))

  const saveOrder = async (event) => {
    event.preventDefault()
    setSavingOrder(true)
    setFormError('')
    const payload = {
      ...form,
      expected_delivery_date: form.expected_delivery_date || null,
      items: form.items.map((item) => ({ ...item,
        quantity: item.quantity.trim(), unit_price: item.unit_price.trim(), discount_rate: item.discount_rate.trim() }))
    }
    try {
      if (editingOrder) await api.put(`/sales-orders/${editingOrder.id}`, payload)
      else await api.post('/sales-orders', payload)
      setFormOpen(false)
      setReloadKey((value) => value + 1)
    } catch (error) {
      setFormError(error.response?.data?.error || 'Could not save sales order. Please try again.')
    } finally {
      setSavingOrder(false)
    }
  }

  const showDetails = async (order) => {
    setDetail(order)
    setDetailLoading(true)
    setDetailError('')
    try {
      const response = await api.get(`/sales-orders/${order.id}`)
      setDetail(response.data)
    } catch (error) {
      setDetailError(error.response?.data?.error || 'Could not load sales order details.')
    } finally {
      setDetailLoading(false)
    }
  }

  const changeStatus = async (order, status) => {
    const message = status === 'confirmed'
      ? `Confirm ${order.order_number}? This will lock its line items for fulfillment.`
      : `Cancel ${order.order_number}?`
    if (!window.confirm(message)) return
    try {
      await api.patch(`/sales-orders/${order.id}/status`, { status })
      setReloadKey((value) => value + 1)
      if (detail?.id === order.id) await showDetails(order)
    } catch (error) {
      setLoadError(error.response?.data?.error || 'Could not update sales order status.')
    }
  }

  const openFulfillment = async (order) => {
    setFulfillmentError('')
    setFulfillmentNotes('')
    try {
      const response = await api.get(`/sales-orders/${order.id}`)
      const freshOrder = response.data
      setFulfillmentTarget(freshOrder)
      setFulfillmentQuantities(Object.fromEntries(freshOrder.items.map((item) => [item.id, ''])))
      setFulfillmentKey(window.crypto?.randomUUID?.() || `sales-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    } catch (error) {
      setLoadError(error.response?.data?.error || 'Could not load outstanding order quantities.')
    }
  }

  const remaining = (item) => Math.max(0, Number(item.quantity_ordered) - Number(item.quantity_fulfilled))

  const submitFulfillment = async (event) => {
    event.preventDefault()
    const items = fulfillmentTarget.items
      .filter((item) => fulfillmentQuantities[item.id] !== '' && Number(fulfillmentQuantities[item.id]) > 0)
      .map((item) => ({ sales_order_item_id: item.id, quantity: fulfillmentQuantities[item.id] }))
    if (items.length === 0) {
      setFulfillmentError('Enter a positive quantity for at least one line.')
      return
    }
    setSavingFulfillment(true)
    setFulfillmentError('')
    try {
      await api.post(`/sales-orders/${fulfillmentTarget.id}/fulfillments`, { items, notes: fulfillmentNotes }, {
        headers: { 'Idempotency-Key': fulfillmentKey }
      })
      const fulfilledId = fulfillmentTarget.id
      setFulfillmentTarget(null)
      setReloadKey((value) => value + 1)
      if (detail?.id === fulfilledId) await showDetails({ id: fulfilledId })
    } catch (error) {
      setFulfillmentError(error.response?.data?.error || 'Could not fulfill this order. Retry with the same open fulfillment form.')
    } finally {
      setSavingFulfillment(false)
    }
  }

  const createInvoice = async (order) => {
    setCreatingInvoiceId(order.id)
    setInvoiceNotice(null)
    try {
      const response = await api.post(`/sales-orders/${order.id}/invoice`)
      setInvoiceNotice({ invoiceNumber: response.data.invoice_number, error: '' })
      setReloadKey((value) => value + 1)
      if (detail?.id === order.id) await showDetails(order)
    } catch (error) {
      setInvoiceNotice({ error: error.response?.data?.error || 'Could not create invoice.' })
    } finally {
      setCreatingInvoiceId('')
    }
  }

  const linePreview = (line) => {
    const gross = Number(line.quantity || 0) * Number(line.unit_price || 0)
    return gross - gross * (Number(line.discount_rate || 0) / 100)
  }
  const subtotalPreview = form.items.reduce((total, line) => total + linePreview(line), 0)
  const taxPreview = subtotalPreview * Number(form.tax_rate || 0) / 100

  const OrderActions = ({ order }) => (
    <div className="flex flex-wrap gap-3 text-sm">
      <button onClick={() => showDetails(order)} className="font-medium text-blue-700 hover:underline">View</button>
      {order.status === 'draft' && <><button onClick={() => editOrder(order)} className="text-gray-700 hover:underline">Edit</button><button onClick={() => changeStatus(order, 'confirmed')} className="text-green-700 hover:underline">Confirm</button></>}
      {['confirmed', 'partially_fulfilled'].includes(order.status) && <button onClick={() => openFulfillment(order)} className="text-green-700 hover:underline">Fulfill</button>}
      {order.status === 'fulfilled' && !order.invoice_number && <button onClick={() => createInvoice(order)} disabled={creatingInvoiceId === order.id} className="text-purple-700 hover:underline disabled:opacity-50">{creatingInvoiceId === order.id ? 'Creating invoice…' : 'Create invoice'}</button>}
      {order.invoice_number && <Link to="/invoices" className="text-purple-700 hover:underline">Invoice {order.invoice_number}</Link>}
      {['draft', 'confirmed'].includes(order.status) && <button onClick={() => changeStatus(order, 'cancelled')} className="text-red-700 hover:underline">Cancel</button>}
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
          <div><p className="text-sm font-semibold uppercase tracking-wide text-blue-600">Sales</p><h1 className="mt-1 text-2xl font-bold text-gray-900">Sales orders</h1><p className="mt-1 text-sm text-gray-500">Quote products, confirm orders, fulfill stock and create invoices.</p></div>
          <button onClick={openCreate} disabled={!clients.length || !products.length} className="rounded-lg bg-blue-600 px-4 py-2.5 font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">Create sales order</button>
        </div>

        {invoiceNotice && <div role={invoiceNotice.error ? 'alert' : 'status'} className={`mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm ${invoiceNotice.error ? 'border-red-200 bg-red-50 text-red-700' : 'border-green-200 bg-green-50 text-green-800'}`}>
          <span>{invoiceNotice.error || `Invoice ${invoiceNotice.invoiceNumber} created from the fulfilled sales order.`}</span>
          {!invoiceNotice.error && <Link to="/invoices" className="font-semibold underline">Open invoices</Link>}
        </div>}

        <div className="mb-5 grid gap-3 sm:grid-cols-[1fr_220px_auto]">
          <form onSubmit={(event) => { event.preventDefault(); setSearch(searchInput.trim()) }} className="flex gap-2">
            <input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Search order number or client" className="min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2.5 outline-none focus:border-blue-500" />
            <button className="rounded-lg border bg-white px-4 py-2 font-medium text-gray-700 hover:bg-gray-50">Search</button>
          </form>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-gray-700">
            <option value="">All statuses</option><option value="draft">Draft</option><option value="confirmed">Confirmed</option><option value="partially_fulfilled">Partially fulfilled</option><option value="fulfilled">Fulfilled</option><option value="cancelled">Cancelled</option>
          </select>
          <Link to="/invoices" className="rounded-lg border bg-white px-4 py-2.5 text-center font-medium text-gray-700 hover:bg-gray-50">Invoices</Link>
        </div>

        {loadError && <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{loadError}</div>}
        {loading ? <div className="rounded-xl border bg-white p-10 text-center text-gray-500">Loading sales orders…</div> : orders.length === 0 ? (
          <div className="rounded-xl border border-dashed bg-white p-10 text-center"><h2 className="font-semibold text-gray-800">No sales orders found</h2><p className="mt-1 text-sm text-gray-500">Create a draft order for one of your clients.</p></div>
        ) : (
          <div className="overflow-hidden rounded-xl border bg-white shadow-sm">
            <div className="hidden overflow-x-auto md:block"><table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500"><tr><th className="px-5 py-3">Order</th><th className="px-5 py-3">Client</th><th className="px-5 py-3">Order date</th><th className="px-5 py-3">Lines</th><th className="px-5 py-3">Total</th><th className="px-5 py-3">Status</th><th className="px-5 py-3">Actions</th></tr></thead>
              <tbody className="divide-y divide-gray-100 text-sm">{orders.map((order) => <tr key={order.id} className="hover:bg-gray-50"><td className="px-5 py-4 font-semibold text-blue-700">{order.order_number}</td><td className="px-5 py-4">{order.client_name}</td><td className="px-5 py-4">{String(order.order_date).slice(0, 10)}</td><td className="px-5 py-4">{order.item_count}</td><td className="px-5 py-4 font-medium">{money(order.total)}</td><td className="px-5 py-4"><StatusBadge status={order.status} /></td><td className="px-5 py-4"><OrderActions order={order} /></td></tr>)}</tbody>
            </table></div>
            <div className="divide-y md:hidden">{orders.map((order) => <article key={order.id} className="space-y-3 p-4"><div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold text-blue-700">{order.order_number}</h2><p className="text-sm text-gray-600">{order.client_name}</p></div><StatusBadge status={order.status} /></div><div className="flex justify-between text-sm text-gray-500"><span>{String(order.order_date).slice(0, 10)} · {order.item_count} lines</span><strong className="text-gray-900">{money(order.total)}</strong></div><div className="border-t pt-3"><OrderActions order={order} /></div></article>)}</div>
          </div>
        )}
      </main>

      {formOpen && <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
        <section role="dialog" aria-modal="true" aria-labelledby="sales-form-title" className="max-h-[95vh] w-full max-w-5xl overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl sm:p-6">
          <div className="mb-5 flex items-start justify-between gap-4"><div><p className="text-sm text-blue-600">Draft sales order</p><h2 id="sales-form-title" className="text-xl font-bold text-gray-900">{editingOrder ? `Edit ${editingOrder.order_number}` : 'Create sales order'}</h2></div><button onClick={() => setFormOpen(false)} className="rounded-md px-2 py-1 text-xl text-gray-500 hover:bg-gray-100" aria-label="Close">×</button></div>
          <form onSubmit={saveOrder} className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <label className="text-sm font-medium text-gray-700 sm:col-span-2">Customer/client *<select required value={form.client_id} onChange={(event) => setForm({ ...form, client_id: event.target.value })} className="mt-1 w-full rounded-lg border bg-white px-3 py-2.5"><option value="">Choose client</option>{clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>
              <label className="text-sm font-medium text-gray-700">Order date *<input required type="date" value={form.order_date} onChange={(event) => setForm({ ...form, order_date: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2.5" /></label>
              <label className="text-sm font-medium text-gray-700">Expected delivery<input type="date" min={form.order_date} value={form.expected_delivery_date} onChange={(event) => setForm({ ...form, expected_delivery_date: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2.5" /></label>
            </div>
            <div className="rounded-xl border"><div className="flex items-center justify-between border-b bg-gray-50 px-4 py-3"><h3 className="font-semibold text-gray-800">Product lines</h3><button type="button" onClick={addLine} className="text-sm font-semibold text-blue-700 hover:underline">Add line</button></div>
              <div className="space-y-4 p-4">{form.items.map((item, index) => <div key={`${index}-${item.product_id}`} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_1fr_1fr_1fr_auto] lg:items-end">
                <label className="text-sm font-medium text-gray-700 sm:col-span-2 lg:col-span-1">Product *<select required value={item.product_id} onChange={(event) => updateLine(index, 'product_id', event.target.value)} className="mt-1 w-full rounded-lg border bg-white px-3 py-2.5"><option value="">Choose product</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name} · {product.sku}</option>)}</select></label>
                <label className="text-sm font-medium text-gray-700">Quantity *<input required type="number" min="0.01" step="0.01" value={item.quantity} onChange={(event) => updateLine(index, 'quantity', event.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2.5" /></label>
                <label className="text-sm font-medium text-gray-700">Unit price (KES) *<input required type="number" min="0" step="0.01" value={item.unit_price} onChange={(event) => updateLine(index, 'unit_price', event.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2.5" /></label>
                <label className="text-sm font-medium text-gray-700">Discount (%)<input type="number" min="0" max="100" step="0.01" value={item.discount_rate} onChange={(event) => updateLine(index, 'discount_rate', event.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2.5" /></label>
                <button type="button" disabled={form.items.length === 1} onClick={() => removeLine(index)} className="rounded-lg px-3 py-2 text-sm text-red-700 hover:bg-red-50 disabled:opacity-40">Remove</button>
              </div>)}</div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-medium text-gray-700">Tax rate (%)<input type="number" min="0" max="100" step="0.01" value={form.tax_rate} onChange={(event) => setForm({ ...form, tax_rate: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2.5" /><span className="mt-1 block text-xs font-normal text-gray-500">Totals shown here are estimates; the server recalculates and rounds them.</span></label><label className="text-sm font-medium text-gray-700">Notes<textarea maxLength={10000} rows="2" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2.5" /></label></div>
            <div className="ml-auto max-w-xs space-y-1 border-t pt-3 text-sm"><div className="flex justify-between"><span>Estimated net subtotal</span><span>{money(subtotalPreview)}</span></div><div className="flex justify-between"><span>Estimated tax</span><span>{money(taxPreview)}</span></div><div className="flex justify-between border-t pt-2 font-bold"><span>Estimated total</span><span>{money(subtotalPreview + taxPreview)}</span></div></div>
            {formError && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{formError}</p>}
            <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end"><button type="button" disabled={savingOrder} onClick={() => setFormOpen(false)} className="rounded-lg border px-4 py-2.5 text-gray-700">Cancel</button><button disabled={savingOrder} className="rounded-lg bg-blue-600 px-4 py-2.5 font-semibold text-white disabled:opacity-60">{savingOrder ? 'Saving…' : 'Save as draft'}</button></div>
          </form>
        </section>
      </div>}

      {detail && <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"><section role="dialog" aria-modal="true" aria-labelledby="sales-detail-title" className="max-h-[94vh] w-full max-w-5xl overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl sm:p-6">
        <div className="mb-5 flex items-start justify-between gap-4"><div><p className="text-sm text-blue-600">Sales order</p><h2 id="sales-detail-title" className="text-xl font-bold text-gray-900">{detail.order_number}</h2></div><button onClick={() => setDetail(null)} className="rounded-md px-2 py-1 text-xl text-gray-500 hover:bg-gray-100" aria-label="Close">×</button></div>
        {detailLoading ? <p className="py-10 text-center text-gray-500">Loading details…</p> : detailError ? <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{detailError}</p> : <>
          <div className="mb-5 grid gap-3 rounded-lg bg-gray-50 p-4 text-sm sm:grid-cols-2 lg:grid-cols-4"><div><p className="text-gray-500">Client</p><p className="font-semibold">{detail.client_name}</p></div><div><p className="text-gray-500">Order date</p><p className="font-semibold">{String(detail.order_date).slice(0, 10)}</p></div><div><p className="text-gray-500">Expected delivery</p><p className="font-semibold">{detail.expected_delivery_date ? String(detail.expected_delivery_date).slice(0, 10) : '—'}</p></div><div><p className="text-gray-500">Status</p><StatusBadge status={detail.status} /></div></div>
          <div className="overflow-x-auto rounded-lg border"><table className="min-w-full divide-y"><thead className="bg-gray-50 text-left text-xs uppercase text-gray-500"><tr><th className="px-4 py-3">Product</th><th className="px-4 py-3">Ordered</th><th className="px-4 py-3">Fulfilled</th><th className="px-4 py-3">Unit price</th><th className="px-4 py-3">Discount</th><th className="px-4 py-3">Subtotal</th></tr></thead><tbody className="divide-y text-sm">{detail.items?.map((item) => <tr key={item.id}><td className="px-4 py-3"><p className="font-medium">{item.product_name}</p><p className="text-xs text-gray-500">{item.product_sku}</p></td><td className="px-4 py-3">{quantity(item.quantity_ordered)}</td><td className="px-4 py-3">{quantity(item.quantity_fulfilled)}</td><td className="px-4 py-3">{money(item.unit_price)}</td><td className="px-4 py-3">{Number(item.discount_rate).toFixed(2)}% ({money(item.discount_amount)})</td><td className="px-4 py-3">{money(item.line_subtotal)}</td></tr>)}</tbody></table></div>
          <div className="mt-4 ml-auto max-w-xs space-y-1 border-t pt-3 text-sm"><div className="flex justify-between"><span>Discounts</span><span>−{money(detail.discount_total)}</span></div><div className="flex justify-between"><span>Net subtotal</span><span>{money(detail.subtotal)}</span></div><div className="flex justify-between"><span>Tax ({Number(detail.tax_rate).toFixed(2)}%)</span><span>{money(detail.tax_amount)}</span></div><div className="flex justify-between border-t pt-2 text-base font-bold"><span>Total</span><span>{money(detail.total)}</span></div></div>
          <div className="mt-7"><h3 className="mb-3 font-semibold text-gray-900">Fulfillment history</h3>{!detail.fulfillments?.length ? <p className="rounded-lg bg-gray-50 p-4 text-sm text-gray-500">No fulfillment has been recorded.</p> : <div className="space-y-3">{detail.fulfillments.map((fulfillment) => <article key={fulfillment.id} className="rounded-lg border p-4"><div className="flex flex-wrap justify-between gap-2"><p className="font-medium">Fulfilled {new Date(fulfillment.fulfilled_at).toLocaleString('en-KE')}</p><p className="text-xs text-gray-500">Reference {fulfillment.id.slice(0, 8)}</p></div><ul className="mt-2 space-y-1 text-sm text-gray-600">{fulfillment.items.map((item) => <li key={item.id}>{item.product_name}: {quantity(item.fulfilled_quantity)}</li>)}</ul>{fulfillment.notes && <p className="mt-2 text-sm text-gray-500">{fulfillment.notes}</p>}</article>)}</div>}</div>
          <div className="mt-6 rounded-lg border p-4">{detail.invoice ? <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-semibold text-gray-900">Invoice {detail.invoice.invoice_number}</p><p className="text-sm text-gray-500">Created from this sales order</p></div><Link to="/invoices" className="rounded-lg border px-3 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50">Open invoices</Link></div> : detail.status === 'fulfilled' ? <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-semibold text-gray-900">Ready to invoice</p><p className="text-sm text-gray-500">One invoice will be created for the full fulfilled order.</p></div><button onClick={() => createInvoice(detail)} disabled={creatingInvoiceId === detail.id} className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{creatingInvoiceId === detail.id ? 'Creating…' : 'Create invoice'}</button></div> : <p className="text-sm text-gray-500">Invoice creation becomes available after all order lines are fulfilled.</p>}</div>
        </>}
      </section></div>}

      {fulfillmentTarget && <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"><section role="dialog" aria-modal="true" aria-labelledby="fulfillment-title" className="max-h-[94vh] w-full max-w-3xl overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl sm:p-6">
        <div className="mb-5 flex items-start justify-between gap-4"><div><p className="text-sm text-green-700">Fulfill sales order</p><h2 id="fulfillment-title" className="text-xl font-bold text-gray-900">{fulfillmentTarget.order_number}</h2></div><button disabled={savingFulfillment} onClick={() => setFulfillmentTarget(null)} className="rounded-md px-2 py-1 text-xl text-gray-500 hover:bg-gray-100" aria-label="Close">×</button></div>
        <form onSubmit={submitFulfillment} className="space-y-4"><p className="rounded-lg bg-blue-50 p-3 text-sm text-blue-800">Enter the quantities shipped now. The server rechecks outstanding quantities and stock before deducting inventory.</p><div className="space-y-3">{fulfillmentTarget.items.map((item) => <div key={item.id} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_auto_180px] sm:items-center"><div><p className="font-medium">{item.product_name}</p><p className="text-xs text-gray-500">{item.product_sku} · ordered {quantity(item.quantity_ordered)} · fulfilled {quantity(item.quantity_fulfilled)}</p></div><p className="text-sm text-gray-600">Outstanding: <strong>{quantity(remaining(item))}</strong></p><label className="text-sm font-medium text-gray-700">Fulfill now<input type="number" min="0" max={remaining(item)} step="0.01" value={fulfillmentQuantities[item.id] || ''} onChange={(event) => setFulfillmentQuantities((current) => ({ ...current, [item.id]: event.target.value }))} className="mt-1 w-full rounded-lg border px-3 py-2" /></label></div>)}</div><label className="block text-sm font-medium text-gray-700">Fulfillment notes<textarea maxLength={10000} rows="2" value={fulfillmentNotes} onChange={(event) => setFulfillmentNotes(event.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2.5" /></label>{fulfillmentError && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{fulfillmentError}</p>}<div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end"><button type="button" disabled={savingFulfillment} onClick={() => setFulfillmentTarget(null)} className="rounded-lg border px-4 py-2.5 text-gray-700">Close</button><button disabled={savingFulfillment} className="rounded-lg bg-green-600 px-4 py-2.5 font-semibold text-white disabled:opacity-60">{savingFulfillment ? 'Recording…' : 'Record fulfillment'}</button></div></form>
      </section></div>}
    </div>
  )
}

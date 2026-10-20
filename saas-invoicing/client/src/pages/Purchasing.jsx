import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../api'

const today = () => new Date().toISOString().slice(0, 10)
const EMPTY_FORM = () => ({
  supplier_id: '', order_date: today(), expected_delivery_date: '', tax_rate: '0', notes: '',
  items: [{ product_id: '', quantity: '1', unit_cost: '0.00' }]
})
const money = (value) => `KES ${Number(value || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const quantity = (value) => Number(value || 0).toLocaleString('en-KE', { maximumFractionDigits: 3 })

const STATUS_STYLES = {
  draft: 'bg-gray-100 text-gray-700',
  ordered: 'bg-blue-100 text-blue-700',
  partially_received: 'bg-amber-100 text-amber-800',
  received: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-700'
}

function Nav() {
  return (
    <nav className="flex gap-5 overflow-x-auto whitespace-nowrap text-sm font-medium text-gray-600">
      <Link to="/dashboard" className="hover:text-blue-600">Dashboard</Link>
      <Link to="/clients" className="hover:text-blue-600">Clients</Link>
      <Link to="/products" className="hover:text-blue-600">Products</Link>
      <Link to="/suppliers" className="hover:text-blue-600">Suppliers</Link>
      <Link to="/purchasing" className="text-blue-600">Purchasing</Link>
      <Link to="/sales-orders" className="hover:text-blue-600">Sales Orders</Link>
      <Link to="/expenses" className="hover:text-blue-600">Expenses</Link>
      <Link to="/invoices" className="hover:text-blue-600">Invoices</Link>
    </nav>
  )
}

function StatusBadge({ status }) {
  return <span className={`rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${STATUS_STYLES[status] || STATUS_STYLES.draft}`}>{status.replaceAll('_', ' ')}</span>
}

export default function Purchasing() {
  const [orders, setOrders] = useState([])
  const [suppliers, setSuppliers] = useState([])
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [searchInput, setSearchInput] = useState(() => new URLSearchParams(window.location.search).get('search') || '')
  const [search, setSearch] = useState(() => new URLSearchParams(window.location.search).get('search') || '')
  const [statusFilter, setStatusFilter] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [formOpen, setFormOpen] = useState(false)
  const [editingOrder, setEditingOrder] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [formError, setFormError] = useState('')
  const [savingOrder, setSavingOrder] = useState(false)
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [receiptTarget, setReceiptTarget] = useState(null)
  const [receiptQuantities, setReceiptQuantities] = useState({})
  const [receiptKey, setReceiptKey] = useState('')
  const [receiptNotes, setReceiptNotes] = useState('')
  const [receiptError, setReceiptError] = useState('')
  const [savingReceipt, setSavingReceipt] = useState(false)

  const loadOrders = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const response = await api.get('/purchase-orders', { params: { search, status: statusFilter || undefined } })
      setOrders(response.data)
    } catch (error) {
      setLoadError(error.response?.data?.error || 'Could not load purchase orders. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [search, statusFilter])

  useEffect(() => { loadOrders() }, [loadOrders, reloadKey])

  useEffect(() => {
    Promise.all([
      api.get('/suppliers', { params: { active: 'true' } }),
      api.get('/products', { params: { active: 'true' } })
    ]).then(([supplierResponse, productResponse]) => {
      setSuppliers(supplierResponse.data)
      setProducts(productResponse.data)
    }).catch((error) => {
      setLoadError(error.response?.data?.error || 'Could not load suppliers or products.')
    })
  }, [reloadKey])

  const openCreate = () => {
    setEditingOrder(null)
    setForm(EMPTY_FORM())
    setFormError('')
    setFormOpen(true)
  }

  const openEdit = (order) => {
    setEditingOrder(order)
    setForm({
      supplier_id: order.supplier_id,
      order_date: String(order.order_date).slice(0, 10),
      expected_delivery_date: order.expected_delivery_date ? String(order.expected_delivery_date).slice(0, 10) : '',
      tax_rate: String(order.tax_rate ?? '0'),
      notes: order.notes || '',
      items: order.items.map((item) => ({
        product_id: item.product_id, quantity: String(item.quantity_ordered), unit_cost: String(item.unit_cost)
      }))
    })
    setFormError('')
    setFormOpen(true)
  }

  const editOrder = async (order) => {
    try {
      const response = await api.get(`/purchase-orders/${order.id}`)
      openEdit(response.data)
    } catch (error) {
      setLoadError(error.response?.data?.error || 'Could not load the draft purchase order.')
    }
  }

  const changeLine = (index, key, value) => {
    setForm((current) => ({
      ...current,
      items: current.items.map((item, lineIndex) => {
        if (lineIndex !== index) return item
        if (key === 'product_id') {
          const product = products.find((row) => row.id === value)
          return { ...item, product_id: value, unit_cost: product ? String(product.cost_price) : item.unit_cost }
        }
        return { ...item, [key]: value }
      })
    }))
  }

  const addLine = () => setForm((current) => ({ ...current, items: [...current.items, { product_id: '', quantity: '1', unit_cost: '0.00' }] }))
  const removeLine = (index) => setForm((current) => ({ ...current, items: current.items.filter((_, lineIndex) => lineIndex !== index) }))

  const saveOrder = async (event) => {
    event.preventDefault()
    setSavingOrder(true)
    setFormError('')
    const payload = {
      ...form,
      expected_delivery_date: form.expected_delivery_date || null,
      items: form.items.map((item) => ({ ...item, quantity: item.quantity.trim(), unit_cost: item.unit_cost.trim() }))
    }
    try {
      if (editingOrder) await api.put(`/purchase-orders/${editingOrder.id}`, payload)
      else await api.post('/purchase-orders', payload)
      setFormOpen(false)
      setReloadKey((value) => value + 1)
    } catch (error) {
      setFormError(error.response?.data?.error || 'Could not save purchase order. Please try again.')
    } finally {
      setSavingOrder(false)
    }
  }

  const showDetails = async (order) => {
    setDetail(order)
    setDetailLoading(true)
    setDetailError('')
    try {
      const response = await api.get(`/purchase-orders/${order.id}`)
      setDetail(response.data)
    } catch (error) {
      setDetailError(error.response?.data?.error || 'Could not load purchase order details.')
    } finally {
      setDetailLoading(false)
    }
  }

  const changeStatus = async (order, status) => {
    const prompt = status === 'ordered'
      ? `Mark ${order.purchase_order_number} as ordered?`
      : `Cancel ${order.purchase_order_number}?`
    if (!window.confirm(prompt)) return
    try {
      await api.patch(`/purchase-orders/${order.id}/status`, { status })
      setReloadKey((value) => value + 1)
      if (detail?.id === order.id) await showDetails(order)
    } catch (error) {
      setLoadError(error.response?.data?.error || 'Could not update purchase order status.')
    }
  }

  const openReceipt = async (order) => {
    setReceiptError('')
    setReceiptNotes('')
    try {
      const response = await api.get(`/purchase-orders/${order.id}`)
      const freshOrder = response.data
      setReceiptTarget(freshOrder)
      setReceiptQuantities(Object.fromEntries(freshOrder.items.map((item) => [item.id, ''])))
      const generatedKey = window.crypto?.randomUUID?.() || `receipt-${Date.now()}-${Math.random().toString(36).slice(2)}`
      setReceiptKey(generatedKey)
    } catch (error) {
      setLoadError(error.response?.data?.error || 'Could not load outstanding purchase order quantities.')
    }
  }

  const submitReceipt = async (event) => {
    event.preventDefault()
    setSavingReceipt(true)
    setReceiptError('')
    const items = receiptTarget.items
      .filter((item) => receiptQuantities[item.id] !== '' && Number(receiptQuantities[item.id]) > 0)
      .map((item) => ({ purchase_order_item_id: item.id, quantity: receiptQuantities[item.id] }))
    if (items.length === 0) {
      setReceiptError('Enter a positive quantity for at least one line.')
      setSavingReceipt(false)
      return
    }
    try {
      await api.post(`/purchase-orders/${receiptTarget.id}/receipts`, { items, notes: receiptNotes }, {
        headers: { 'Idempotency-Key': receiptKey }
      })
      setReceiptTarget(null)
      setReloadKey((value) => value + 1)
      if (detail?.id === receiptTarget.id) await showDetails({ id: receiptTarget.id })
    } catch (error) {
      setReceiptError(error.response?.data?.error || 'Could not record receipt. Retry using this same open receipt form.')
    } finally {
      setSavingReceipt(false)
    }
  }

  const receiptOutstanding = (item) => Math.max(0, Number(item.quantity_ordered) - Number(item.quantity_received))

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
          <div><p className="text-sm font-semibold uppercase tracking-wide text-blue-600">Suppliers & purchasing</p><h1 className="mt-1 text-2xl font-bold text-gray-900">Purchase orders</h1><p className="mt-1 text-sm text-gray-500">Track agreed costs, deliveries and stock receipts.</p></div>
          <button onClick={openCreate} disabled={!suppliers.length || !products.length} className="rounded-lg bg-blue-600 px-4 py-2.5 font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">Create purchase order</button>
        </div>

        <div className="mb-5 grid gap-3 sm:grid-cols-[1fr_220px_auto]">
          <form onSubmit={(event) => { event.preventDefault(); setSearch(searchInput.trim()) }} className="flex gap-2">
            <input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Search PO number or supplier" className="min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2.5 outline-none focus:border-blue-500" />
            <button className="rounded-lg border bg-white px-4 py-2 font-medium text-gray-700 hover:bg-gray-50">Search</button>
          </form>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-gray-700">
            <option value="">All statuses</option><option value="draft">Draft</option><option value="ordered">Ordered</option><option value="partially_received">Partially received</option><option value="received">Received</option><option value="cancelled">Cancelled</option>
          </select>
          <Link to="/suppliers" className="rounded-lg border bg-white px-4 py-2.5 text-center font-medium text-gray-700 hover:bg-gray-50">Manage suppliers</Link>
        </div>

        {loadError && <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{loadError}</div>}
        {loading ? <div className="rounded-xl border bg-white p-10 text-center text-gray-500">Loading purchase orders…</div> : orders.length === 0 ? (
          <div className="rounded-xl border border-dashed bg-white p-10 text-center"><h2 className="font-semibold text-gray-800">No purchase orders found</h2><p className="mt-1 text-sm text-gray-500">Create a draft order for one of your suppliers.</p></div>
        ) : (
          <div className="overflow-hidden rounded-xl border bg-white shadow-sm">
            <div className="hidden overflow-x-auto md:block">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500"><tr><th className="px-5 py-3">Purchase order</th><th className="px-5 py-3">Supplier</th><th className="px-5 py-3">Order date</th><th className="px-5 py-3">Lines</th><th className="px-5 py-3">Total</th><th className="px-5 py-3">Status</th><th className="px-5 py-3">Actions</th></tr></thead>
                <tbody className="divide-y divide-gray-100 text-sm">
                  {orders.map((order) => <tr key={order.id} className="hover:bg-gray-50">
                    <td className="px-5 py-4 font-semibold text-blue-700">{order.purchase_order_number}</td><td className="px-5 py-4">{order.supplier_name}</td><td className="px-5 py-4">{String(order.order_date).slice(0, 10)}</td><td className="px-5 py-4">{order.item_count}</td><td className="px-5 py-4 font-medium">{money(order.total)}</td><td className="px-5 py-4"><StatusBadge status={order.status} /></td>
                    <td className="px-5 py-4"><div className="flex flex-wrap gap-2"><button onClick={() => showDetails(order)} className="text-blue-700 hover:underline">View</button>{order.status === 'draft' && <><button onClick={() => editOrder(order)} className="text-gray-700 hover:underline">Edit</button><button onClick={() => changeStatus(order, 'ordered')} className="text-green-700 hover:underline">Mark ordered</button></>}{['ordered', 'partially_received'].includes(order.status) && <button onClick={() => openReceipt(order)} className="text-green-700 hover:underline">Receive</button>}{['draft', 'ordered'].includes(order.status) && <button onClick={() => changeStatus(order, 'cancelled')} className="text-red-700 hover:underline">Cancel</button>}</div></td>
                  </tr>)}
                </tbody>
              </table>
            </div>
            <div className="divide-y md:hidden">
              {orders.map((order) => <article key={order.id} className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold text-blue-700">{order.purchase_order_number}</h2><p className="text-sm text-gray-600">{order.supplier_name}</p></div><StatusBadge status={order.status} /></div>
                <div className="flex justify-between text-sm text-gray-500"><span>{String(order.order_date).slice(0, 10)} · {order.item_count} lines</span><strong className="text-gray-900">{money(order.total)}</strong></div>
                <div className="flex flex-wrap gap-3 border-t pt-3 text-sm"><button onClick={() => showDetails(order)} className="font-medium text-blue-700">View</button>{order.status === 'draft' && <><button onClick={() => editOrder(order)} className="text-gray-700">Edit</button><button onClick={() => changeStatus(order, 'ordered')} className="text-green-700">Mark ordered</button></>}{['ordered', 'partially_received'].includes(order.status) && <button onClick={() => openReceipt(order)} className="text-green-700">Receive goods</button>}{['draft', 'ordered'].includes(order.status) && <button onClick={() => changeStatus(order, 'cancelled')} className="text-red-700">Cancel</button>}</div>
              </article>)}
            </div>
          </div>
        )}
      </main>

      {formOpen && <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
        <section role="dialog" aria-modal="true" aria-labelledby="purchase-form-title" className="max-h-[95vh] w-full max-w-4xl overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl sm:p-6">
          <div className="mb-5 flex items-start justify-between gap-4"><div><p className="text-sm text-blue-600">Draft purchase order</p><h2 id="purchase-form-title" className="text-xl font-bold text-gray-900">{editingOrder ? `Edit ${editingOrder.purchase_order_number}` : 'Create purchase order'}</h2></div><button onClick={() => setFormOpen(false)} className="rounded-md px-2 py-1 text-xl text-gray-500 hover:bg-gray-100" aria-label="Close">×</button></div>
          <form onSubmit={saveOrder} className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <label className="text-sm font-medium text-gray-700 sm:col-span-2">Supplier *<select required value={form.supplier_id} onChange={(event) => setForm({ ...form, supplier_id: event.target.value })} className="mt-1 w-full rounded-lg border bg-white px-3 py-2.5"><option value="">Choose supplier</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.business_name}</option>)}</select></label>
              <label className="text-sm font-medium text-gray-700">Order date *<input required type="date" value={form.order_date} onChange={(event) => setForm({ ...form, order_date: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2.5" /></label>
              <label className="text-sm font-medium text-gray-700">Expected delivery<input type="date" min={form.order_date} value={form.expected_delivery_date} onChange={(event) => setForm({ ...form, expected_delivery_date: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2.5" /></label>
            </div>

            <div className="rounded-xl border">
              <div className="flex items-center justify-between border-b bg-gray-50 px-4 py-3"><h3 className="font-semibold text-gray-800">Product lines</h3><button type="button" onClick={addLine} className="text-sm font-semibold text-blue-700 hover:underline">Add line</button></div>
              <div className="space-y-4 p-4">
                {form.items.map((item, index) => <div key={`${index}-${item.product_id}`} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_1fr_1fr_auto] lg:items-end">
                  <label className="text-sm font-medium text-gray-700 sm:col-span-2 lg:col-span-1">Product *<select required value={item.product_id} onChange={(event) => changeLine(index, 'product_id', event.target.value)} className="mt-1 w-full rounded-lg border bg-white px-3 py-2.5"><option value="">Choose product</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name} · {product.sku}</option>)}</select></label>
                  <label className="text-sm font-medium text-gray-700">Quantity *<input required type="number" min="0.001" step="0.001" value={item.quantity} onChange={(event) => changeLine(index, 'quantity', event.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2.5" /></label>
                  <label className="text-sm font-medium text-gray-700">Agreed unit cost (KES) *<input required type="number" min="0" step="0.01" value={item.unit_cost} onChange={(event) => changeLine(index, 'unit_cost', event.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2.5" /></label>
                  <button type="button" disabled={form.items.length === 1} onClick={() => removeLine(index)} className="rounded-lg px-3 py-2 text-sm text-red-700 hover:bg-red-50 disabled:opacity-40">Remove</button>
                </div>)}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm font-medium text-gray-700">Tax rate (%)<input type="number" min="0" max="100" step="0.01" value={form.tax_rate} onChange={(event) => setForm({ ...form, tax_rate: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2.5" /><span className="mt-1 block text-xs font-normal text-gray-500">Totals are recalculated and rounded by the server.</span></label>
              <label className="text-sm font-medium text-gray-700">Notes<textarea rows="2" maxLength={10000} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2.5" /></label>
            </div>
            {formError && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{formError}</p>}
            <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end"><button type="button" disabled={savingOrder} onClick={() => setFormOpen(false)} className="rounded-lg border px-4 py-2.5 text-gray-700">Cancel</button><button disabled={savingOrder} className="rounded-lg bg-blue-600 px-4 py-2.5 font-semibold text-white disabled:opacity-60">{savingOrder ? 'Saving…' : 'Save as draft'}</button></div>
          </form>
        </section>
      </div>}

      {detail && <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
        <section role="dialog" aria-modal="true" aria-labelledby="purchase-detail-title" className="max-h-[94vh] w-full max-w-4xl overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl sm:p-6">
          <div className="mb-5 flex items-start justify-between gap-4"><div><p className="text-sm text-blue-600">Purchase order</p><h2 id="purchase-detail-title" className="text-xl font-bold text-gray-900">{detail.purchase_order_number}</h2></div><button onClick={() => setDetail(null)} className="rounded-md px-2 py-1 text-xl text-gray-500 hover:bg-gray-100" aria-label="Close">×</button></div>
          {detailLoading ? <p className="py-10 text-center text-gray-500">Loading details…</p> : detailError ? <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{detailError}</p> : <>
            <div className="mb-5 grid gap-3 rounded-lg bg-gray-50 p-4 text-sm sm:grid-cols-2 lg:grid-cols-4"><div><p className="text-gray-500">Supplier</p><p className="font-semibold">{detail.supplier_name}</p></div><div><p className="text-gray-500">Order date</p><p className="font-semibold">{String(detail.order_date).slice(0, 10)}</p></div><div><p className="text-gray-500">Expected delivery</p><p className="font-semibold">{detail.expected_delivery_date ? String(detail.expected_delivery_date).slice(0, 10) : '—'}</p></div><div><p className="text-gray-500">Status</p><StatusBadge status={detail.status} /></div></div>
            <div className="overflow-x-auto rounded-lg border"><table className="min-w-full divide-y"><thead className="bg-gray-50 text-left text-xs uppercase text-gray-500"><tr><th className="px-4 py-3">Product</th><th className="px-4 py-3">Ordered</th><th className="px-4 py-3">Received</th><th className="px-4 py-3">Unit cost</th><th className="px-4 py-3">Subtotal</th></tr></thead><tbody className="divide-y text-sm">{detail.items?.map((item) => <tr key={item.id}><td className="px-4 py-3"><p className="font-medium">{item.product_name}</p><p className="text-xs text-gray-500">{item.product_sku}</p></td><td className="px-4 py-3">{quantity(item.quantity_ordered)}</td><td className="px-4 py-3">{quantity(item.quantity_received)}</td><td className="px-4 py-3">{money(item.unit_cost)}</td><td className="px-4 py-3">{money(item.line_subtotal)}</td></tr>)}</tbody></table></div>
            <div className="mt-4 ml-auto max-w-xs space-y-1 border-t pt-3 text-sm"><div className="flex justify-between"><span>Subtotal</span><span>{money(detail.subtotal)}</span></div><div className="flex justify-between"><span>Tax ({Number(detail.tax_rate).toFixed(2)}%)</span><span>{money(detail.tax_amount)}</span></div><div className="flex justify-between border-t pt-2 text-base font-bold"><span>Total</span><span>{money(detail.total)}</span></div></div>
            <div className="mt-7"><h3 className="mb-3 font-semibold text-gray-900">Goods receipt history</h3>{!detail.receipts?.length ? <p className="rounded-lg bg-gray-50 p-4 text-sm text-gray-500">No goods have been received yet.</p> : <div className="space-y-3">{detail.receipts.map((receipt) => <article key={receipt.id} className="rounded-lg border p-4"><div className="flex flex-wrap justify-between gap-2"><p className="font-medium">Received {new Date(receipt.received_at).toLocaleString('en-KE')}</p><p className="text-xs text-gray-500">Receipt {receipt.id.slice(0, 8)}</p></div><ul className="mt-2 space-y-1 text-sm text-gray-600">{receipt.items.map((item) => <li key={item.id}>{item.product_name}: {quantity(item.received_quantity)}</li>)}</ul>{receipt.notes && <p className="mt-2 text-sm text-gray-500">{receipt.notes}</p>}</article>)}</div>}</div>
          </>}
        </section>
      </div>}

      {receiptTarget && <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
        <section role="dialog" aria-modal="true" aria-labelledby="receipt-title" className="max-h-[94vh] w-full max-w-3xl overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl sm:p-6">
          <div className="mb-5 flex items-start justify-between gap-4"><div><p className="text-sm text-green-700">Receive goods</p><h2 id="receipt-title" className="text-xl font-bold text-gray-900">{receiptTarget.purchase_order_number}</h2></div><button disabled={savingReceipt} onClick={() => setReceiptTarget(null)} className="rounded-md px-2 py-1 text-xl text-gray-500 hover:bg-gray-100" aria-label="Close">×</button></div>
          <form onSubmit={submitReceipt} className="space-y-4">
            <p className="rounded-lg bg-blue-50 p-3 text-sm text-blue-800">Enter the quantity received for each line. Outstanding quantities are checked again before stock is updated.</p>
            <div className="space-y-3">{receiptTarget.items.map((item) => <div key={item.id} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_auto_180px] sm:items-center"><div><p className="font-medium">{item.product_name}</p><p className="text-xs text-gray-500">{item.product_sku} · ordered {quantity(item.quantity_ordered)} · received {quantity(item.quantity_received)}</p></div><p className="text-sm text-gray-600">Outstanding: <strong>{quantity(receiptOutstanding(item))}</strong></p><label className="text-sm font-medium text-gray-700">Receive now<input type="number" min="0" max={receiptOutstanding(item)} step="0.001" value={receiptQuantities[item.id] || ''} onChange={(event) => setReceiptQuantities({ ...receiptQuantities, [item.id]: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2" /></label></div>)}</div>
            <label className="block text-sm font-medium text-gray-700">Receipt notes<textarea maxLength={10000} rows="2" value={receiptNotes} onChange={(event) => setReceiptNotes(event.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2.5" /></label>
            {receiptError && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{receiptError}</p>}
            <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end"><button type="button" disabled={savingReceipt} onClick={() => setReceiptTarget(null)} className="rounded-lg border px-4 py-2.5 text-gray-700">Close</button><button disabled={savingReceipt} className="rounded-lg bg-green-600 px-4 py-2.5 font-semibold text-white disabled:opacity-60">{savingReceipt ? 'Recording…' : 'Record receipt'}</button></div>
          </form>
        </section>
      </div>}
    </div>
  )
}

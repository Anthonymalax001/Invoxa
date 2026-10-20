import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../api'

const EMPTY_PRODUCT = {
  name: '',
  sku: '',
  description: '',
  unit_of_measure: 'each',
  cost_price: '0.00',
  selling_price: '0.00',
  low_stock_threshold: '0'
}

const EMPTY_MOVEMENT = { quantity: '', quantity_delta: '', reference: '', notes: '' }

const money = (value) => `KES ${Number(value || 0).toLocaleString('en-KE', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})}`

const quantity = (value) => Number(value || 0).toLocaleString('en-KE', {
  maximumFractionDigits: 3
})

function StockBadge({ product }) {
  const current = Number(product.current_stock || 0)
  const threshold = Number(product.low_stock_threshold || 0)
  if (current <= 0) {
    return <span className="rounded-full bg-red-100 px-2.5 py-1 text-xs font-semibold text-red-700">Out of stock</span>
  }
  if (current <= threshold) {
    return <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-700">Low stock</span>
  }
  return <span className="rounded-full bg-green-100 px-2.5 py-1 text-xs font-semibold text-green-700">In stock</span>
}

export default function Products() {
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [activeFilter, setActiveFilter] = useState('all')
  const [reloadKey, setReloadKey] = useState(0)

  const [productModalOpen, setProductModalOpen] = useState(false)
  const [editingProduct, setEditingProduct] = useState(null)
  const [productForm, setProductForm] = useState(EMPTY_PRODUCT)
  const [productError, setProductError] = useState('')
  const [savingProduct, setSavingProduct] = useState(false)

  const [stockTarget, setStockTarget] = useState(null)
  const [stockAction, setStockAction] = useState('receive')
  const [stockForm, setStockForm] = useState(EMPTY_MOVEMENT)
  const [stockError, setStockError] = useState('')
  const [savingStock, setSavingStock] = useState(false)

  const [historyProduct, setHistoryProduct] = useState(null)
  const [movements, setMovements] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')

  const loadProducts = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const response = await api.get('/products', {
        params: { search: search.trim(), active: activeFilter }
      })
      setProducts(response.data)
    } catch (err) {
      setLoadError(err.response?.data?.error || 'Could not load products. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [activeFilter, search])

  useEffect(() => {
    loadProducts()
  }, [loadProducts, reloadKey])

  useEffect(() => {
    if (!historyProduct) return undefined
    let cancelled = false
    setHistoryLoading(true)
    setHistoryError('')
    api.get(`/products/${historyProduct.id}/movements`)
      .then((response) => {
        if (!cancelled) setMovements(response.data)
      })
      .catch((err) => {
        if (!cancelled) setHistoryError(err.response?.data?.error || 'Could not load stock history.')
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false)
      })
    return () => { cancelled = true }
  }, [historyProduct])

  const openCreate = () => {
    setEditingProduct(null)
    setProductForm({ ...EMPTY_PRODUCT })
    setProductError('')
    setProductModalOpen(true)
  }

  const openEdit = (product) => {
    setEditingProduct(product)
    setProductForm({
      name: product.name,
      sku: product.sku,
      description: product.description || '',
      unit_of_measure: product.unit_of_measure,
      cost_price: product.cost_price,
      selling_price: product.selling_price,
      low_stock_threshold: product.low_stock_threshold
    })
    setProductError('')
    setProductModalOpen(true)
  }

  const saveProduct = async (event) => {
    event.preventDefault()
    setSavingProduct(true)
    setProductError('')
    try {
      if (editingProduct) {
        await api.put(`/products/${editingProduct.id}`, productForm)
      } else {
        await api.post('/products', productForm)
      }
      setProductModalOpen(false)
      setReloadKey((key) => key + 1)
    } catch (err) {
      setProductError(err.response?.data?.error || 'Could not save this product.')
    } finally {
      setSavingProduct(false)
    }
  }

  const toggleActive = async (product) => {
    setActionError('')
    try {
      await api.patch(`/products/${product.id}/status`, { is_active: !product.is_active })
      setReloadKey((key) => key + 1)
    } catch (err) {
      setActionError(err.response?.data?.error || 'Could not update product status.')
    }
  }

  const openStockAction = (product, action) => {
    setStockTarget(product)
    setStockAction(action)
    setStockForm({ ...EMPTY_MOVEMENT })
    setStockError('')
  }

  const saveStockAction = async (event) => {
    event.preventDefault()
    if (!stockTarget) return
    setSavingStock(true)
    setStockError('')
    try {
      const endpoint = stockAction === 'receive' ? 'receive' : 'adjust'
      const body = {
        ...stockForm,
        [stockAction === 'receive' ? 'quantity' : 'quantity_delta']:
          stockAction === 'receive' ? stockForm.quantity : stockForm.quantity_delta
      }
      delete body[stockAction === 'receive' ? 'quantity_delta' : 'quantity']
      await api.post(`/products/${stockTarget.id}/${endpoint}`, body)
      setStockTarget(null)
      setReloadKey((key) => key + 1)
    } catch (err) {
      setStockError(err.response?.data?.error || 'Could not record this stock movement.')
    } finally {
      setSavingStock(false)
    }
  }

  const handleSearch = (event) => {
    event.preventDefault()
    setSearch(searchInput)
  }

  const renderActions = (product) => (
    <div className="flex flex-wrap gap-2">
      <button onClick={() => openEdit(product)} className="text-blue-700 hover:underline">Edit</button>
      <button onClick={() => openStockAction(product, 'receive')} className="text-green-700 hover:underline">Receive</button>
      <button onClick={() => openStockAction(product, 'adjust')} className="text-amber-700 hover:underline">Adjust</button>
      <button onClick={() => setHistoryProduct(product)} className="text-purple-700 hover:underline">History</button>
      <button onClick={() => toggleActive(product)} className="text-gray-600 hover:underline">
        {product.is_active ? 'Deactivate' : 'Activate'}
      </button>
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200 px-4 sm:px-6 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <Link to="/" className="text-xl sm:text-2xl font-bold text-blue-600">Invoxa</Link>
        <div className="flex flex-wrap gap-4 text-sm font-medium text-gray-600">
          <Link to="/dashboard" className="hover:text-blue-600">Dashboard</Link>
          <Link to="/clients" className="hover:text-blue-600">Clients</Link>
          <Link to="/products" className="text-blue-600">Products</Link>
          <Link to="/suppliers" className="hover:text-blue-600">Suppliers</Link>
          <Link to="/purchasing" className="hover:text-blue-600">Purchasing</Link>
          <Link to="/sales-orders" className="hover:text-blue-600">Sales Orders</Link>
          <Link to="/expenses" className="hover:text-blue-600">Expenses</Link>
          <Link to="/invoices" className="hover:text-blue-600">Invoices</Link>
        </div>
        <button
          onClick={() => { sessionStorage.clear(); window.location.href = '/login' }}
          className="text-sm text-red-500 hover:underline self-start sm:self-auto"
        >
          Logout
        </button>
      </nav>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-800">Products & Inventory</h1>
            <p className="text-sm text-gray-500 mt-1">Manage your catalogue and stock levels.</p>
          </div>
          <button
            onClick={openCreate}
            className="w-full sm:w-auto rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
          >
            + Add product
          </button>
        </div>

        {actionError && <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{actionError}</div>}

        <section className="mb-5 rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
          <form onSubmit={handleSearch} className="grid grid-cols-1 sm:grid-cols-[1fr_180px_auto] gap-3">
            <label className="sr-only" htmlFor="product-search">Search products</label>
            <input
              id="product-search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search product name, SKU or description"
              className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <label className="sr-only" htmlFor="product-status-filter">Product status</label>
            <select
              id="product-status-filter"
              value={activeFilter}
              onChange={(event) => setActiveFilter(event.target.value)}
              className="rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="all">All products</option>
              <option value="true">Active</option>
              <option value="false">Inactive</option>
            </select>
            <button className="rounded-lg bg-gray-800 px-5 py-2.5 text-sm font-semibold text-white hover:bg-gray-700">Search</button>
          </form>
        </section>

        <section className="overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm">
          {loading ? (
            <div role="status" className="py-20 text-center text-gray-500">Loading products…</div>
          ) : loadError ? (
            <div role="alert" className="p-8 text-center">
              <p className="text-sm text-red-700">{loadError}</p>
              <button onClick={() => setReloadKey((key) => key + 1)} className="mt-3 text-sm font-medium text-blue-700 hover:underline">Try again</button>
            </div>
          ) : products.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <p className="text-lg font-semibold text-gray-700">No products found</p>
              <p className="mt-1 text-sm text-gray-500">Add a product or change your search filters.</p>
              <button onClick={openCreate} className="mt-4 text-sm font-semibold text-blue-700 hover:underline">+ Add product</button>
            </div>
          ) : (
            <>
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full min-w-[1050px] text-left text-sm">
                  <thead className="border-b border-gray-100 bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                    <tr>
                      <th className="px-5 py-4">Product</th>
                      <th className="px-5 py-4">SKU</th>
                      <th className="px-5 py-4">Prices</th>
                      <th className="px-5 py-4">Stock</th>
                      <th className="px-5 py-4">Status</th>
                      <th className="px-5 py-4">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {products.map((product) => (
                      <tr key={product.id} className="align-top hover:bg-gray-50">
                        <td className="px-5 py-4">
                          <div className="font-semibold text-gray-800">{product.name}</div>
                          <div className="mt-1 text-xs text-gray-500">{product.description || 'No description'} · {product.unit_of_measure}</div>
                        </td>
                        <td className="px-5 py-4 font-mono text-xs text-gray-700">{product.sku}</td>
                        <td className="px-5 py-4 text-xs leading-6 text-gray-600">
                          <div>Cost {money(product.cost_price)}</div>
                          <div>Sell {money(product.selling_price)}</div>
                        </td>
                        <td className="px-5 py-4">
                          <div className="font-semibold text-gray-800">{quantity(product.current_stock)} {product.unit_of_measure}</div>
                          <div className="mt-2"><StockBadge product={product} /></div>
                          <div className="mt-1 text-xs text-gray-400">Low at {quantity(product.low_stock_threshold)}</div>
                        </td>
                        <td className="px-5 py-4">
                          <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${product.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                            {product.is_active ? 'Active' : 'Inactive'}
                          </span>
                        </td>
                        <td className="px-5 py-4">{renderActions(product)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="divide-y divide-gray-100 md:hidden">
                {products.map((product) => (
                  <article key={product.id} className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h2 className="font-semibold text-gray-800">{product.name}</h2>
                        <p className="mt-1 font-mono text-xs text-gray-500">{product.sku}</p>
                      </div>
                      <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${product.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                        {product.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                    {product.description && <p className="mt-2 text-sm text-gray-500">{product.description}</p>}
                    <div className="mt-3 grid grid-cols-2 gap-2 text-sm text-gray-600">
                      <div>Cost <span className="font-medium text-gray-800">{money(product.cost_price)}</span></div>
                      <div>Sell <span className="font-medium text-gray-800">{money(product.selling_price)}</span></div>
                      <div>Stock <span className="font-medium text-gray-800">{quantity(product.current_stock)} {product.unit_of_measure}</span></div>
                      <div><StockBadge product={product} /></div>
                    </div>
                    <div className="mt-4">{renderActions(product)}</div>
                  </article>
                ))}
              </div>
            </>
          )}
        </section>
      </main>

      {productModalOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 px-4 py-8">
          <div role="dialog" aria-modal="true" aria-labelledby="product-dialog-title" className="my-auto w-full max-w-2xl rounded-2xl bg-white p-5 shadow-xl sm:p-7">
            <h2 id="product-dialog-title" className="text-xl font-bold text-gray-800">{editingProduct ? 'Edit product' : 'Add product'}</h2>
            {productError && <div role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{productError}</div>}
            <form onSubmit={saveProduct} className="mt-5 space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className="text-sm font-medium text-gray-700">Product name *
                  <input required maxLength={255} value={productForm.name} onChange={(event) => setProductForm({ ...productForm, name: event.target.value })} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5" />
                </label>
                <label className="text-sm font-medium text-gray-700">SKU / product code *
                  <input required maxLength={100} value={productForm.sku} onChange={(event) => setProductForm({ ...productForm, sku: event.target.value })} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 uppercase" />
                </label>
                <label className="text-sm font-medium text-gray-700">Unit of measurement *
                  <input required maxLength={50} value={productForm.unit_of_measure} onChange={(event) => setProductForm({ ...productForm, unit_of_measure: event.target.value })} placeholder="each, kg, litre" className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5" />
                </label>
                <label className="text-sm font-medium text-gray-700">Cost price (KES) *
                  <input required type="number" min="0" step="0.01" value={productForm.cost_price} onChange={(event) => setProductForm({ ...productForm, cost_price: event.target.value })} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5" />
                </label>
                <label className="text-sm font-medium text-gray-700">Selling price (KES) *
                  <input required type="number" min="0" step="0.01" value={productForm.selling_price} onChange={(event) => setProductForm({ ...productForm, selling_price: event.target.value })} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5" />
                </label>
                <label className="text-sm font-medium text-gray-700">Low-stock threshold *
                  <input required type="number" min="0" step="0.001" value={productForm.low_stock_threshold} onChange={(event) => setProductForm({ ...productForm, low_stock_threshold: event.target.value })} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5" />
                </label>
              </div>
              <label className="block text-sm font-medium text-gray-700">Description
                <textarea maxLength={10000} rows={3} value={productForm.description} onChange={(event) => setProductForm({ ...productForm, description: event.target.value })} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5" />
              </label>
              <p className="rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-800">
                {editingProduct
                  ? `Current stock: ${quantity(editingProduct.current_stock)} ${editingProduct.unit_of_measure}. Use stock actions to change it.`
                  : 'New products start at zero stock. Receive stock after saving the product.'}
              </p>
              <div className="flex flex-col-reverse gap-3 pt-1 sm:flex-row sm:justify-end">
                <button type="button" onClick={() => setProductModalOpen(false)} className="rounded-lg bg-gray-100 px-5 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-200">Cancel</button>
                <button disabled={savingProduct} className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
                  {savingProduct ? 'Saving…' : editingProduct ? 'Save changes' : 'Create product'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {stockTarget && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 px-4 py-8">
          <div role="dialog" aria-modal="true" aria-labelledby="stock-dialog-title" className="my-auto w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl sm:p-7">
            <h2 id="stock-dialog-title" className="text-xl font-bold text-gray-800">
              {stockAction === 'receive' ? 'Receive stock' : 'Adjust stock'}
            </h2>
            <p className="mt-1 text-sm text-gray-500">{stockTarget.name} · current stock {quantity(stockTarget.current_stock)} {stockTarget.unit_of_measure}</p>
            {stockError && <div role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{stockError}</div>}
            <form onSubmit={saveStockAction} className="mt-5 space-y-4">
              <label className="block text-sm font-medium text-gray-700">
                {stockAction === 'receive' ? `Quantity received (${stockTarget.unit_of_measure}) *` : `Quantity change (${stockTarget.unit_of_measure}) *`}
                <input
                  required
                  type="number"
                  min={stockAction === 'receive' ? '0.001' : undefined}
                  step="0.001"
                  value={stockAction === 'receive' ? stockForm.quantity : stockForm.quantity_delta}
                  onChange={(event) => setStockForm({
                    ...stockForm,
                    [stockAction === 'receive' ? 'quantity' : 'quantity_delta']: event.target.value
                  })}
                  placeholder={stockAction === 'receive' ? 'e.g. 12' : 'e.g. 5 or -2'}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5"
                />
              </label>
              {stockAction === 'adjust' && <p className="-mt-2 text-xs text-gray-500">Use a negative value to reduce stock. Stock cannot fall below zero.</p>}
              <label className="block text-sm font-medium text-gray-700">Reference
                <input maxLength={100} value={stockForm.reference} onChange={(event) => setStockForm({ ...stockForm, reference: event.target.value })} placeholder="Delivery note or count reference" className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5" />
              </label>
              <label className="block text-sm font-medium text-gray-700">Notes
                <textarea maxLength={10000} rows={3} value={stockForm.notes} onChange={(event) => setStockForm({ ...stockForm, notes: event.target.value })} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5" />
              </label>
              <div className="flex flex-col-reverse gap-3 pt-1 sm:flex-row sm:justify-end">
                <button type="button" onClick={() => setStockTarget(null)} className="rounded-lg bg-gray-100 px-5 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-200">Cancel</button>
                <button disabled={savingStock} className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
                  {savingStock ? 'Saving…' : stockAction === 'receive' ? 'Record receipt' : 'Save adjustment'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {historyProduct && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 px-4 py-8">
          <div role="dialog" aria-modal="true" aria-labelledby="history-dialog-title" className="my-auto w-full max-w-4xl rounded-2xl bg-white p-5 shadow-xl sm:p-7">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="history-dialog-title" className="text-xl font-bold text-gray-800">Stock movement history</h2>
                <p className="mt-1 text-sm text-gray-500">{historyProduct.name} · {historyProduct.sku}</p>
              </div>
              <button onClick={() => setHistoryProduct(null)} aria-label="Close history" className="rounded-lg px-3 py-1 text-2xl leading-none text-gray-500 hover:bg-gray-100">×</button>
            </div>
            {historyLoading ? (
              <div role="status" className="py-14 text-center text-gray-500">Loading stock history…</div>
            ) : historyError ? (
              <div role="alert" className="mt-5 rounded-lg bg-red-50 p-3 text-sm text-red-700">{historyError}</div>
            ) : movements.length === 0 ? (
              <div className="py-14 text-center text-sm text-gray-500">No stock movements have been recorded.</div>
            ) : (
              <div className="mt-5 overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead className="border-b bg-gray-50 text-xs uppercase text-gray-500">
                    <tr>
                      <th className="px-3 py-3">Date</th>
                      <th className="px-3 py-3">Type</th>
                      <th className="px-3 py-3">Change</th>
                      <th className="px-3 py-3">Before → after</th>
                      <th className="px-3 py-3">Reference / notes</th>
                      <th className="px-3 py-3">Recorded by</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {movements.map((movement) => (
                      <tr key={movement.id}>
                        <td className="whitespace-nowrap px-3 py-3 text-gray-600">{new Date(movement.created_at).toLocaleString()}</td>
                        <td className="px-3 py-3 capitalize text-gray-700">{movement.movement_type}</td>
                        <td className={`px-3 py-3 font-semibold ${Number(movement.quantity_delta) < 0 ? 'text-red-700' : 'text-green-700'}`}>
                          {Number(movement.quantity_delta) > 0 ? '+' : ''}{quantity(movement.quantity_delta)}
                        </td>
                        <td className="px-3 py-3 text-gray-700">{quantity(movement.quantity_before)} → {quantity(movement.quantity_after)}</td>
                        <td className="px-3 py-3 text-gray-600">
                          {movement.reference && <div>{movement.reference}</div>}
                          {movement.notes && <div className="text-xs text-gray-400">{movement.notes}</div>}
                        </td>
                        <td className="px-3 py-3 font-mono text-xs text-gray-500">{movement.created_by || 'Unknown'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="mt-5 flex justify-end">
              <button onClick={() => setHistoryProduct(null)} className="rounded-lg bg-gray-100 px-5 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-200">Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

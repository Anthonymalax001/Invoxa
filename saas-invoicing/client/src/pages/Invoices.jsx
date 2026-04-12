import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import api from '../api'

export default function Invoices() {
  const [invoices, setInvoices] = useState([])
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({
    client_id: '',
    due_date: '',
    tax_rate: 16,
    notes: '',
    items: [{ description: '', quantity: 1, unit_price: '' }]
  })

  const [mpesaModal, setMpesaModal] = useState(false)
  const [mpesaInvoice, setMpesaInvoice] = useState(null)
  const [mpesaPhone, setMpesaPhone] = useState('')
  const [mpesaLoading, setMpesaLoading] = useState(false)
  const [mpesaMessage, setMpesaMessage] = useState('')

  useEffect(() => {
    fetchData()
  }, [])

  const fetchData = async () => {
    try {
      const [invRes, cliRes] = await Promise.all([
        api.get('/invoices'),
        api.get('/clients')
      ])
      setInvoices(invRes.data)
      setClients(cliRes.data)
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  const handleFormChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value })
  }

  const handleItemChange = (index, e) => {
    const updated = [...form.items]
    updated[index][e.target.name] = e.target.value
    setForm({ ...form, items: updated })
  }

  const addItem = () => {
    setForm({
      ...form,
      items: [...form.items, { description: '', quantity: 1, unit_price: '' }]
    })
  }

  const removeItem = (index) => {
    if (form.items.length === 1) return
    const updated = form.items.filter((_, i) => i !== index)
    setForm({ ...form, items: updated })
  }

  const getSubtotal = () => {
    return form.items.reduce((sum, item) => {
      return sum + (parseFloat(item.quantity) || 0) * (parseFloat(item.unit_price) || 0)
    }, 0)
  }

  const getTax = () => (getSubtotal() * parseFloat(form.tax_rate || 0)) / 100
  const getTotal = () => getSubtotal() + getTax()

  const openCreate = () => {
    setForm({
      client_id: '',
      due_date: '',
      tax_rate: 16,
      notes: '',
      items: [{ description: '', quantity: 1, unit_price: '' }]
    })
    setError('')
    setShowForm(true)
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    const items = form.items.map(item => ({
      description: item.description,
      quantity: parseFloat(item.quantity),
      unit_price: parseFloat(item.unit_price)
    }))
    try {
      await api.post('/invoices', { ...form, items })
      setShowForm(false)
      fetchData()
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create invoice')
    }
  }

  const handleStatusChange = async (id, status) => {
    try {
      await api.patch(`/invoices/${id}/status`, { status })
      fetchData()
    } catch (err) {
      console.error(err)
    }
  }

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this invoice?')) return
    try {
      await api.delete(`/invoices/${id}`)
      fetchData()
    } catch (err) {
      console.error(err)
    }
  }

  const handleMpesa = (inv) => {
    setMpesaInvoice(inv)
    setMpesaPhone('')
    setMpesaMessage('')
    setMpesaModal(true)
  }

  const submitMpesa = async () => {
    if (!mpesaPhone) return
    setMpesaLoading(true)
    setMpesaMessage('')
    try {
      const res = await api.post('/payments/request', {
        invoice_id: mpesaInvoice.id,
        phone_number: mpesaPhone
      })
      setMpesaMessage(res.data.message)
    } catch (err) {
      setMpesaMessage(err.response?.data?.error || 'M-Pesa request failed')
    } finally {
      setMpesaLoading(false)
    }
  }

  const downloadPDF = async (inv) => {
    try {
      const res = await api.get(`/invoices/${inv.id}/pdf`, {
        responseType: 'blob'
      })
      const url = window.URL.createObjectURL(new Blob([res.data]))
      const link = document.createElement('a')
      link.href = url
      link.setAttribute('download', `${inv.invoice_number}.pdf`)
      document.body.appendChild(link)
      link.click()
      link.remove()
    } catch (err) {
      console.error('PDF error:', err)
      alert('Failed to generate PDF')
    }
  }

  const statusColor = (status) => {
    switch (status) {
      case 'paid': return 'bg-green-100 text-green-700'
      case 'sent': return 'bg-blue-100 text-blue-700'
      case 'overdue': return 'bg-red-100 text-red-700'
      default: return 'bg-gray-100 text-gray-600'
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">

      {/* Navbar */}
      <nav className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-8">
          <Link to="/" className="text-2xl font-bold text-blue-600">Invoxa</Link>
          <div className="flex gap-6 text-sm font-medium text-gray-600">
            <Link to="/dashboard" className="hover:text-blue-600">Dashboard</Link>
            <Link to="/clients" className="hover:text-blue-600">Clients</Link>
            <Link to="/invoices" className="text-blue-600">Invoices</Link>
          </div>
        </div>
        <button
          onClick={() => { localStorage.clear(); window.location.href = '/login' }}
          className="text-sm text-red-500 hover:underline"
        >
          Logout
        </button>
      </nav>

      <div className="max-w-6xl mx-auto px-6 py-8">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-2xl font-bold text-gray-800">Invoices</h2>
            <p className="text-gray-500 text-sm mt-1">Create and manage invoices</p>
          </div>
          <button
            onClick={openCreate}
            className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-5 py-2.5 rounded-lg transition"
          >
            + New Invoice
          </button>
        </div>

        {/* Create Invoice Modal */}
        {showForm && (
          <div className="fixed inset-0 bg-black bg-opacity-40 flex items-start justify-center z-50 px-4 py-8 overflow-y-auto">
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl p-8 my-auto">
              <h3 className="text-lg font-semibold text-gray-800 mb-6">
                Create New Invoice
              </h3>

              {error && (
                <div className="mb-4 bg-red-50 border border-red-200 text-red-600 text-sm rounded-lg px-4 py-3">
                  {error}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-5">

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Client *
                  </label>
                  <select
                    name="client_id"
                    value={form.client_id}
                    onChange={handleFormChange}
                    required
                    className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">Select a client</option>
                    {clients.map(c => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Due Date
                    </label>
                    <input
                      type="date"
                      name="due_date"
                      value={form.due_date}
                      onChange={handleFormChange}
                      className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Tax Rate (%)
                    </label>
                    <input
                      type="number"
                      name="tax_rate"
                      value={form.tax_rate}
                      onChange={handleFormChange}
                      min="0"
                      max="100"
                      className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Items *
                  </label>
                  <div className="space-y-3">
                    {form.items.map((item, index) => (
                      <div key={index} className="flex gap-2 items-start">
                        <input
                          type="text"
                          name="description"
                          value={item.description}
                          onChange={(e) => handleItemChange(index, e)}
                          required
                          placeholder="Description"
                          className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                        <input
                          type="number"
                          name="quantity"
                          value={item.quantity}
                          onChange={(e) => handleItemChange(index, e)}
                          required
                          min="1"
                          placeholder="Qty"
                          className="w-16 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                        <input
                          type="number"
                          name="unit_price"
                          value={item.unit_price}
                          onChange={(e) => handleItemChange(index, e)}
                          required
                          min="0"
                          placeholder="Price"
                          className="w-28 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                        <button
                          type="button"
                          onClick={() => removeItem(index)}
                          className="text-red-400 hover:text-red-600 text-lg font-bold px-1"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={addItem}
                    className="mt-3 text-sm text-blue-600 hover:underline"
                  >
                    + Add item
                  </button>
                </div>

                <div className="bg-gray-50 rounded-xl p-4 space-y-2 text-sm">
                  <div className="flex justify-between text-gray-500">
                    <span>Subtotal</span>
                    <span>KES {getSubtotal().toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-gray-500">
                    <span>VAT ({form.tax_rate}%)</span>
                    <span>KES {getTax().toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between font-bold text-gray-800 border-t border-gray-200 pt-2">
                    <span>Total</span>
                    <span>KES {getTotal().toLocaleString()}</span>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Notes
                  </label>
                  <textarea
                    name="notes"
                    value={form.notes}
                    onChange={handleFormChange}
                    placeholder="Payment instructions, thank you note..."
                    rows={2}
                    className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div className="flex gap-3 pt-2">
                  <button
                    type="submit"
                    className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2.5 rounded-lg transition"
                  >
                    Create Invoice
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowForm(false)}
                    className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold py-2.5 rounded-lg transition"
                  >
                    Cancel
                  </button>
                </div>

              </form>
            </div>
          </div>
        )}

        {/* M-Pesa Modal */}
        {mpesaModal && (
          <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50 px-4">
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-8">
              <h3 className="text-lg font-semibold text-gray-800 mb-1">
                Pay via M-Pesa
              </h3>
              <p className="text-sm text-gray-500 mb-6">
                {mpesaInvoice?.invoice_number} — KES {parseFloat(mpesaInvoice?.total).toLocaleString()}
              </p>

              {mpesaMessage ? (
                <div className={`text-sm rounded-lg px-4 py-3 mb-4 ${
                  mpesaMessage.includes('failed') || mpesaMessage.includes('error')
                    ? 'bg-red-50 border border-red-200 text-red-700'
                    : 'bg-green-50 border border-green-200 text-green-700'
                }`}>
                  {mpesaMessage}
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Customer phone number
                    </label>
                    <input
                      type="tel"
                      value={mpesaPhone}
                      onChange={(e) => setMpesaPhone(e.target.value)}
                      placeholder="e.g. 0712345678"
                      className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                    />
                    <p className="text-xs text-gray-400 mt-1">
                      Customer will get an STK push on this number
                    </p>
                  </div>
                  <button
                    onClick={submitMpesa}
                    disabled={mpesaLoading || !mpesaPhone}
                    className="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-2.5 rounded-lg transition disabled:opacity-50"
                  >
                    {mpesaLoading ? 'Sending STK Push...' : 'Send M-Pesa Request'}
                  </button>
                </div>
              )}

              <button
                onClick={() => setMpesaModal(false)}
                className="w-full mt-3 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold py-2.5 rounded-lg transition"
              >
                Close
              </button>
            </div>
          </div>
        )}

        {/* Invoices Table */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100">
          {loading ? (
            <div className="text-center py-20 text-gray-400">Loading...</div>
          ) : invoices.length === 0 ? (
            <div className="text-center py-20 text-gray-400">
              <p className="text-4xl mb-2">📄</p>
              <p className="font-medium">No invoices yet</p>
              <p className="text-sm mt-1">Create your first invoice to get started</p>
              <button
                onClick={openCreate}
                className="mt-4 bg-blue-600 text-white text-sm px-5 py-2 rounded-lg hover:bg-blue-700"
              >
                + New Invoice
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-400 border-b border-gray-100">
                    <th className="px-6 py-4 font-medium">Invoice #</th>
                    <th className="px-6 py-4 font-medium">Client</th>
                    <th className="px-6 py-4 font-medium">Amount</th>
                    <th className="px-6 py-4 font-medium">Status</th>
                    <th className="px-6 py-4 font-medium">Due Date</th>
                    <th className="px-6 py-4 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {invoices.map((inv) => (
                    <tr key={inv.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 font-medium text-gray-800">
                        {inv.invoice_number}
                      </td>
                      <td className="px-6 py-4 text-gray-600">{inv.client_name}</td>
                      <td className="px-6 py-4 font-medium text-gray-800">
                        KES {parseFloat(inv.total).toLocaleString()}
                      </td>
                      <td className="px-6 py-4">
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${statusColor(inv.status)}`}>
                          {inv.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-gray-400">
                        {inv.due_date
                          ? new Date(inv.due_date).toLocaleDateString()
                          : '—'}
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex gap-2 flex-wrap">
                          {inv.status !== 'paid' && (
                            <button
                              onClick={() => handleStatusChange(inv.id, 'paid')}
                              className="text-green-600 hover:underline text-xs font-medium"
                            >
                              Mark Paid
                            </button>
                          )}
                          {inv.status === 'draft' && (
                            <button
                              onClick={() => handleStatusChange(inv.id, 'sent')}
                              className="text-blue-600 hover:underline text-xs font-medium"
                            >
                              Mark Sent
                            </button>
                          )}
                          {inv.status !== 'paid' && (
                            <button
                              onClick={() => handleMpesa(inv)}
                              className="text-orange-500 hover:underline text-xs font-medium"
                            >
                              M-Pesa
                            </button>
                          )}
                          <button
                            onClick={() => downloadPDF(inv)}
                            className="text-purple-600 hover:underline text-xs font-medium"
                          >
                            PDF
                          </button>
                          <button
                            onClick={() => handleDelete(inv.id)}
                            className="text-red-500 hover:underline text-xs font-medium"
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
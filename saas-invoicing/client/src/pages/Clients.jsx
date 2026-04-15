import { useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import api from '../api'

export default function Clients() {
  const navigate = useNavigate()

  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState({ name: '', email: '', phone: '', address: '' })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetchClients()
  }, [])

  const fetchClients = async () => {
    try {
      const res = await api.get('/clients')
      setClients(res.data)
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  const openCreate = () => {
    setEditing(null)
    setForm({ name: '', email: '', phone: '', address: '' })
    setError('')
    setShowModal(true)
  }

  const openEdit = (client) => {
    setEditing(client)
    setForm({
      name: client.name,
      email: client.email || '',
      phone: client.phone || '',
      address: client.address || ''
    })
    setError('')
    setShowModal(true)
  }

  // ✅ PHONE VALIDATION (strict 10 digits)
  const handleChange = (e) => {
    const { name, value } = e.target

    if (name === 'phone') {
      const numbersOnly = value.replace(/\D/g, '').slice(0, 10)
      setForm({ ...form, phone: numbersOnly })
    } else {
      setForm({ ...form, [name]: value })
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')

    if (form.phone && form.phone.length !== 10) {
      return setError('Phone number must be exactly 10 digits')
    }

    setSaving(true)
    try {
      if (editing) {
        await api.put(`/clients/${editing.id}`, form)
      } else {
        await api.post('/clients', form)
      }
      setShowModal(false)
      fetchClients()
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save client')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this client?')) return
    try {
      await api.delete(`/clients/${id}`)
      fetchClients()
    } catch (err) {
      alert('Failed to delete client')
    }
  }

  // ✅ FIX logout (sessionStorage, not localStorage)
  const handleLogout = () => {
    sessionStorage.clear()
    navigate('/login')
  }

  return (
    <div className="min-h-screen bg-gray-50">

      {/* Navbar */}
      <nav className="bg-white border-b border-gray-200 px-4 sm:px-6 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        
        <div className="flex items-center justify-between w-full sm:w-auto">
          <Link to="/" className="text-xl sm:text-2xl font-bold text-blue-600">
            Invoxa
          </Link>
        </div>

        <div className="flex gap-4 text-sm font-medium text-gray-600">
          <Link to="/dashboard" className="hover:text-blue-600">Dashboard</Link>
          <Link to="/clients" className="text-blue-600">Clients</Link>
          <Link to="/invoices" className="hover:text-blue-600">Invoices</Link>
        </div>

        <button
          onClick={handleLogout}
          className="text-sm text-red-500 hover:underline self-start sm:self-auto"
        >
          Logout
        </button>
      </nav>

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
          <div>
            <h2 className="text-xl sm:text-2xl font-bold text-gray-800">Clients</h2>
            <p className="text-gray-500 text-sm mt-1">Manage your business clients</p>
          </div>

          <button
            onClick={openCreate}
            className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-5 py-2.5 rounded-lg transition w-full sm:w-auto"
          >
            + Add Client
          </button>
        </div>

        {/* Table */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-x-auto">
          {loading ? (
            <div className="text-center py-20 text-gray-400">Loading...</div>
          ) : clients.length === 0 ? (
            <div className="text-center py-20 text-gray-400">
              <p className="text-4xl mb-3">👥</p>
              <p className="font-medium">No clients yet</p>
              <button
                onClick={openCreate}
                className="mt-4 text-sm text-blue-600 hover:underline"
              >
                Add a client
              </button>
            </div>
          ) : (
            <table className="w-full text-sm min-w-[600px]">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr className="text-left text-gray-400">
                  <th className="px-4 sm:px-6 py-4">Name</th>
                  <th className="px-4 sm:px-6 py-4">Email</th>
                  <th className="px-4 sm:px-6 py-4">Phone</th>
                  <th className="px-4 sm:px-6 py-4">Address</th>
                  <th className="px-4 sm:px-6 py-4">Actions</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-gray-50">
                {clients.map((client) => (
                  <tr key={client.id} className="hover:bg-gray-50">
                    <td className="px-4 sm:px-6 py-4 font-medium text-gray-800">
                      {client.name}
                    </td>
                    <td className="px-4 sm:px-6 py-4 text-gray-500">
                      {client.email || '—'}
                    </td>
                    <td className="px-4 sm:px-6 py-4 text-gray-500">
                      {client.phone || '—'}
                    </td>
                    <td className="px-4 sm:px-6 py-4 text-gray-500">
                      {client.address || '—'}
                    </td>
                    <td className="px-4 sm:px-6 py-4">
                      <button onClick={() => openEdit(client)} className="text-blue-600 text-xs mr-3">
                        Edit
                      </button>
                      <button onClick={() => handleDelete(client.id)} className="text-red-500 text-xs">
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">

            <h3 className="text-lg font-semibold mb-4">
              {editing ? 'Edit Client' : 'Add Client'}
            </h3>

            {error && (
              <div className="mb-3 text-red-500 text-sm">{error}</div>
            )}

            <form onSubmit={handleSubmit} className="space-y-3">

              <input name="name" value={form.name} onChange={handleChange} placeholder="Name" required className="w-full border p-2 rounded" />
              <input name="email" value={form.email} onChange={handleChange} placeholder="Email" className="w-full border p-2 rounded" />

              <input
                type="tel"
                name="phone"
                value={form.phone}
                onChange={handleChange}
                placeholder="0712345678"
                maxLength={10}
                inputMode="numeric"
                className="w-full border p-2 rounded"
              />

              <input name="address" value={form.address} onChange={handleChange} placeholder="Address" className="w-full border p-2 rounded" />

              <div className="flex gap-2">
                <button type="button" onClick={() => setShowModal(false)} className="flex-1 border p-2 rounded">
                  Cancel
                </button>
                <button type="submit" className="flex-1 bg-blue-600 text-white p-2 rounded">
                  {saving ? 'Saving...' : 'Save'}
                </button>
              </div>

            </form>
          </div>
        </div>
      )}
    </div>
  )
}
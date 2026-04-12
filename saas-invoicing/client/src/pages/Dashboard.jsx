import { useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import api from '../api'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer
} from 'recharts'

export default function Dashboard() {
  const navigate = useNavigate()
  const user = JSON.parse(localStorage.getItem('user') || '{}')
  const tenant = JSON.parse(localStorage.getItem('tenant') || '{}')

  const [invoices, setInvoices] = useState([])
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
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
    fetchData()
  }, [])

  const handleLogout = () => {
    localStorage.clear()
    navigate('/login')
  }

  const totalRevenue = invoices
    .filter(i => i.status === 'paid')
    .reduce((sum, i) => sum + parseFloat(i.total), 0)

  const totalPending = invoices
    .filter(i => i.status === 'sent')
    .reduce((sum, i) => sum + parseFloat(i.total), 0)

  const totalOverdue = invoices.filter(i => i.status === 'overdue').length
  const totalClients = clients.length

  const chartData = () => {
    const months = []
    for (let i = 5; i >= 0; i--) {
      const date = new Date()
      date.setMonth(date.getMonth() - i)
      const label = date.toLocaleString('default', { month: 'short' })
      const month = date.getMonth()
      const year = date.getFullYear()
      const total = invoices
        .filter(inv => {
          const d = new Date(inv.created_at)
          return d.getMonth() === month && d.getFullYear() === year && inv.status === 'paid'
        })
        .reduce((sum, inv) => sum + parseFloat(inv.total), 0)
      months.push({ month: label, revenue: total })
    }
    return months
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
            <Link to="/dashboard" className="text-blue-600">Dashboard</Link>
            <Link to="/clients" className="hover:text-blue-600">Clients</Link>
            <Link to="/invoices" className="hover:text-blue-600">Invoices</Link>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-500">{tenant.name}</span>
          <button
            onClick={handleLogout}
            className="text-sm text-red-500 hover:underline"
          >
            Logout
          </button>
        </div>
      </nav>

      <div className="max-w-6xl mx-auto px-6 py-8">

        <div className="mb-8">
          <h2 className="text-2xl font-bold text-gray-800">
            Welcome back, {user.name} 👋
          </h2>
          <p className="text-gray-500 mt-1">
            Here's what's happening with your business today.
          </p>
        </div>

        {loading ? (
          <div className="text-center py-20 text-gray-400">Loading...</div>
        ) : (
          <>
            {/* Stat Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">

              <div className="bg-white rounded-2xl shadow-sm p-6 border border-gray-100">
                <p className="text-sm text-gray-500">Total Revenue</p>
                <p className="text-2xl font-bold text-gray-800 mt-1">
                  KES {totalRevenue.toLocaleString()}
                </p>
                <p className="text-xs text-green-600 mt-1">From paid invoices</p>
              </div>

              <div className="bg-white rounded-2xl shadow-sm p-6 border border-gray-100">
                <p className="text-sm text-gray-500">Pending Payment</p>
                <p className="text-2xl font-bold text-gray-800 mt-1">
                  KES {totalPending.toLocaleString()}
                </p>
                <p className="text-xs text-blue-600 mt-1">Awaiting payment</p>
              </div>

              <div className="bg-white rounded-2xl shadow-sm p-6 border border-gray-100">
                <p className="text-sm text-gray-500">Overdue Invoices</p>
                <p className="text-2xl font-bold text-red-500 mt-1">{totalOverdue}</p>
                <p className="text-xs text-red-400 mt-1">Needs attention</p>
              </div>

              <div className="bg-white rounded-2xl shadow-sm p-6 border border-gray-100">
                <p className="text-sm text-gray-500">Total Clients</p>
                <p className="text-2xl font-bold text-gray-800 mt-1">{totalClients}</p>
                <p className="text-xs text-gray-400 mt-1">Active clients</p>
              </div>

            </div>

            {/* Chart */}
            <div className="bg-white rounded-2xl shadow-sm p-6 border border-gray-100 mb-8">
              <h3 className="text-lg font-semibold text-gray-700 mb-4">
                Revenue — Last 6 Months
              </h3>
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={chartData()}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip
                    formatter={(value) => [`KES ${value.toLocaleString()}`, 'Revenue']}
                  />
                  <Bar dataKey="revenue" fill="#2563eb" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Recent Invoices */}
            <div className="bg-white rounded-2xl shadow-sm p-6 border border-gray-100">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-gray-700">Recent Invoices</h3>
                <Link to="/invoices" className="text-sm text-blue-600 hover:underline">
                  View all
                </Link>
              </div>

              {invoices.length === 0 ? (
                <div className="text-center py-10 text-gray-400">
                  <p className="text-4xl mb-2">📄</p>
                  <p>No invoices yet.</p>
                  <Link
                    to="/invoices"
                    className="mt-3 inline-block text-sm text-blue-600 hover:underline"
                  >
                    Create your first invoice
                  </Link>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-gray-400 border-b border-gray-100">
                        <th className="pb-3 font-medium">Invoice</th>
                        <th className="pb-3 font-medium">Client</th>
                        <th className="pb-3 font-medium">Amount</th>
                        <th className="pb-3 font-medium">Status</th>
                        <th className="pb-3 font-medium">Date</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {invoices.slice(0, 5).map((inv) => (
                        <tr key={inv.id} className="hover:bg-gray-50">
                          <td className="py-3 font-medium text-gray-700">
                            {inv.invoice_number}
                          </td>
                          <td className="py-3 text-gray-600">{inv.client_name}</td>
                          <td className="py-3 text-gray-800 font-medium">
                            KES {parseFloat(inv.total).toLocaleString()}
                          </td>
                          <td className="py-3">
                            <span className={`px-2 py-1 rounded-full text-xs font-medium ${statusColor(inv.status)}`}>
                              {inv.status}
                            </span>
                          </td>
                          <td className="py-3 text-gray-400">
                            {new Date(inv.created_at).toLocaleDateString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
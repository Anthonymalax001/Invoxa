import { useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import api from '../api'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer
} from 'recharts'

export default function Dashboard() {
  const navigate = useNavigate()

  // ✅ FIX: use sessionStorage instead of localStorage
  const user = JSON.parse(sessionStorage.getItem('user') || '{}')
  const tenant = JSON.parse(sessionStorage.getItem('tenant') || '{}')

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

  // remove stuck overlays
  useEffect(() => {
    document.body.style.overflow = 'auto'
    document.body.style.pointerEvents = 'auto'
  }, [])

  const handleLogout = () => {
    sessionStorage.clear() // ✅ FIX
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
          return (
            d.getMonth() === month &&
            d.getFullYear() === year &&
            inv.status === 'paid'
          )
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
      <nav className="bg-white border-b border-gray-200 px-4 sm:px-6 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        
        <div className="flex items-center justify-between w-full sm:w-auto">
          <Link to="/" className="text-xl sm:text-2xl font-bold text-blue-600">
            Invoxa
          </Link>
        </div>

        <div className="flex flex-wrap gap-4 text-sm font-medium text-gray-600">
          <Link to="/dashboard" className="text-blue-600">Dashboard</Link>
          <Link to="/clients" className="hover:text-blue-600">Clients</Link>
          <Link to="/invoices" className="hover:text-blue-600">Invoices</Link>
        </div>

        {/* ✅ FIX: fallback text */}
        <div className="flex items-center justify-between sm:justify-end gap-4">
          <span className="text-xs sm:text-sm text-gray-500 truncate max-w-[120px] sm:max-w-none">
            {tenant?.name || 'Business'}
          </span>
          <button
            onClick={handleLogout}
            className="text-xs sm:text-sm text-red-500 hover:underline"
          >
            Logout
          </button>
        </div>

      </nav>

      {/* Main */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8">

        <div className="mb-6 sm:mb-8">
          <h2 className="text-xl sm:text-2xl font-bold text-gray-800">
            {/* ✅ FIX: fallback name */}
            Welcome back, {user?.name || 'User'} 👋
          </h2>
          <p className="text-gray-500 mt-1 text-sm sm:text-base">
            Here's what's happening with your business today.
          </p>
        </div>

        {loading ? (
          <div className="text-center py-20 text-gray-400">Loading...</div>
        ) : (
          <>
            {/* Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6 mb-6 sm:mb-8">

              <div className="bg-white rounded-xl sm:rounded-2xl shadow-sm p-4 sm:p-6 border">
                <p className="text-xs sm:text-sm text-gray-500">Total Revenue</p>
                <p className="text-xl sm:text-2xl font-bold mt-1">
                  KES {totalRevenue.toLocaleString()}
                </p>
              </div>

              <div className="bg-white rounded-xl sm:rounded-2xl shadow-sm p-4 sm:p-6 border">
                <p className="text-xs sm:text-sm text-gray-500">Pending</p>
                <p className="text-xl sm:text-2xl font-bold mt-1">
                  KES {totalPending.toLocaleString()}
                </p>
              </div>

              <div className="bg-white rounded-xl sm:rounded-2xl shadow-sm p-4 sm:p-6 border">
                <p className="text-xs sm:text-sm text-gray-500">Overdue</p>
                <p className="text-xl sm:text-2xl font-bold text-red-500 mt-1">
                  {totalOverdue}
                </p>
              </div>

              <div className="bg-white rounded-xl sm:rounded-2xl shadow-sm p-4 sm:p-6 border">
                <p className="text-xs sm:text-sm text-gray-500">Clients</p>
                <p className="text-xl sm:text-2xl font-bold mt-1">
                  {totalClients}
                </p>
              </div>

            </div>

            {/* Chart */}
            <div className="bg-white rounded-xl sm:rounded-2xl shadow-sm p-4 sm:p-6 mb-6 sm:mb-8">
              <h3 className="text-base sm:text-lg font-semibold mb-4">
                Revenue — Last 6 Months
              </h3>

              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={chartData()}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="month" />
                  <YAxis />
                  <Tooltip />
                  <Bar dataKey="revenue" fill="#2563eb" />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Table */}
            <div className="bg-white rounded-xl sm:rounded-2xl shadow-sm p-4 sm:p-6">
              <div className="flex justify-between mb-4">
                <h3 className="text-base sm:text-lg font-semibold">
                  Recent Invoices
                </h3>
                <Link to="/invoices" className="text-sm text-blue-600">
                  View all
                </Link>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[600px]">
                  <thead>
                    <tr className="text-left text-gray-400">
                      <th>Invoice</th>
                      <th>Client</th>
                      <th>Amount</th>
                      <th>Status</th>
                      <th>Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.slice(0, 5).map((inv) => (
                      <tr key={inv.id}>
                        <td>{inv.invoice_number}</td>
                        <td>{inv.client_name}</td>
                        <td>KES {parseFloat(inv.total).toLocaleString()}</td>
                        <td>
                          <span className={`px-2 py-1 text-xs rounded ${statusColor(inv.status)}`}>
                            {inv.status}
                          </span>
                        </td>
                        <td>{new Date(inv.created_at).toLocaleDateString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

            </div>

          </>
        )}
      </div>
    </div>
  )
}
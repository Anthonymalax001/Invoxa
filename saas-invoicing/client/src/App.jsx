import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useEffect } from 'react'
import Landing from './pages/Landing'
import Login from './pages/Login'
import Register from './pages/Register'
import Dashboard from './pages/Dashboard'
import Clients from './pages/Clients'
import Invoices from './pages/Invoices'
import Products from './pages/Products'
import Suppliers from './pages/Suppliers'
import Purchasing from './pages/Purchasing'
import SalesOrders from './pages/SalesOrders'
import Expenses from './pages/Expenses'
import SupplierBills from './pages/SupplierBills'
import FinancialReports from './pages/FinancialReports'
import BankReconciliation from './pages/BankReconciliation'
import AccountingPeriods from './pages/AccountingPeriods'
import OpeningBalances from './pages/OpeningBalances'
import Employees from './pages/Employees'
import Attendance from './pages/Attendance'
import Leave from './pages/Leave'
import Payroll from './pages/Payroll'

const PrivateRoute = ({ children }) => {
  const token = sessionStorage.getItem('token')
  return token ? children : <Navigate to="/login" replace />
}

const PublicRoute = ({ children }) => {
  const token = sessionStorage.getItem('token')
  return !token ? children : <Navigate to="/dashboard" replace />
}

export default function App() {

  useEffect(() => {
    let timeout

    const logout = () => {
      sessionStorage.clear()
      window.location.href = '/login'
    }

    const resetTimer = () => {
      clearTimeout(timeout)
      timeout = setTimeout(logout, 15 * 60 * 1000) // ⏱ 15 minutes inactivity
    }

    window.addEventListener('mousemove', resetTimer)
    window.addEventListener('keydown', resetTimer)
    window.addEventListener('click', resetTimer)
    window.addEventListener('scroll', resetTimer)

    // start timer immediately
    resetTimer()

    return () => {
      clearTimeout(timeout)
      window.removeEventListener('mousemove', resetTimer)
      window.removeEventListener('keydown', resetTimer)
      window.removeEventListener('click', resetTimer)
      window.removeEventListener('scroll', resetTimer)
    }
  }, [])

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<PublicRoute><Login /></PublicRoute>} />
        <Route path="/register" element={<PublicRoute><Register /></PublicRoute>} />
        <Route path="/dashboard" element={<PrivateRoute><Dashboard /></PrivateRoute>} />
        <Route path="/clients" element={<PrivateRoute><Clients /></PrivateRoute>} />
        <Route path="/invoices" element={<PrivateRoute><Invoices /></PrivateRoute>} />
        <Route path="/products" element={<PrivateRoute><Products /></PrivateRoute>} />
        <Route path="/suppliers" element={<PrivateRoute><Suppliers /></PrivateRoute>} />
        <Route path="/supplier-bills" element={<PrivateRoute><SupplierBills /></PrivateRoute>} />
        <Route path="/financial-reports" element={<PrivateRoute><FinancialReports /></PrivateRoute>} />
        <Route path="/bank-reconciliation" element={<PrivateRoute><BankReconciliation /></PrivateRoute>} />
        <Route path="/accounting-periods" element={<PrivateRoute><AccountingPeriods /></PrivateRoute>} />
        <Route path="/opening-balances" element={<PrivateRoute><OpeningBalances /></PrivateRoute>} />
        <Route path="/employees" element={<PrivateRoute><Employees /></PrivateRoute>} />
        <Route path="/attendance" element={<PrivateRoute><Attendance /></PrivateRoute>} />
        <Route path="/leave" element={<PrivateRoute><Leave /></PrivateRoute>} />
        <Route path="/payroll" element={<PrivateRoute><Payroll /></PrivateRoute>} />
        <Route path="/purchasing" element={<PrivateRoute><Purchasing /></PrivateRoute>} />
        <Route path="/sales-orders" element={<PrivateRoute><SalesOrders /></PrivateRoute>} />
        <Route path="/expenses" element={<PrivateRoute><Expenses /></PrivateRoute>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

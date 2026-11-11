import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import api from '../api'

const localDate = () => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

export default function Invoices() {
  const [invoices, setInvoices] = useState([])
  const [clients, setClients] = useState([])
  const [taxProfiles, setTaxProfiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({
    client_id: '',
    due_date: '',
    tax_profile_id: '',
    notes: '',
    items: [{ description: '', quantity: 1, unit_price: '' }]
  })

  const [mpesaModal, setMpesaModal] = useState(false)
  const [mpesaInvoice, setMpesaInvoice] = useState(null)
  const [mpesaPhone, setMpesaPhone] = useState('')
  const [mpesaLoading, setMpesaLoading] = useState(false)
  const [mpesaMessage, setMpesaMessage] = useState('')
  const [receipts, setReceipts] = useState([])
  const [receiptsLoading, setReceiptsLoading] = useState(false)
  const [receiptsError, setReceiptsError] = useState('')
  const [mpesaPayments, setMpesaPayments] = useState([])
  const [mpesaPaymentsError, setMpesaPaymentsError] = useState('')
  const [reconcilePayment, setReconcilePayment] = useState(null)
  const [reconcileDate, setReconcileDate] = useState(localDate())
  const [reconcileHistory, setReconcileHistory] = useState([])
  const [reconcileResult, setReconcileResult] = useState(null)
  const [reconcileError, setReconcileError] = useState('')
  const [reconcileBusy, setReconcileBusy] = useState(false)
  const [receiptModal, setReceiptModal] = useState(false)
  const [receiptSaving, setReceiptSaving] = useState(false)
  const [receiptFormError, setReceiptFormError] = useState('')
  const [receiptForm, setReceiptForm] = useState({
    customer_id: '', amount: '', currency: 'KES', payment_method: 'bank_transfer',
    receipt_reference: '', payment_date: localDate()
  })
  const [receiptAccounts, setReceiptAccounts] = useState([])
  const [receiptPeriods, setReceiptPeriods] = useState([])
  const [receiptDetail, setReceiptDetail] = useState(null)
  const [receiptDetailLoading, setReceiptDetailLoading] = useState(false)
  const [receiptActionError, setReceiptActionError] = useState('')
  const [receiptActionLoading, setReceiptActionLoading] = useState(false)
  const [receiptCashAccount, setReceiptCashAccount] = useState('')
  const [receiptPeriod, setReceiptPeriod] = useState('')
  const [receiptReason, setReceiptReason] = useState('')
  const [receiptOutstanding, setReceiptOutstanding] = useState([])
  const [allocationAmounts, setAllocationAmounts] = useState({})
  const [allocationLoading, setAllocationLoading] = useState(false)

  useEffect(() => {
    fetchData()
  }, [])

  const requestKey = () => {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID()
    return `receipt-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
  }

  const loadReceipts = async () => {
    setReceiptsLoading(true)
    try {
      const res = await api.get('/payments/receipts')
      setReceipts(res.data)
      setReceiptsError('')
    } catch (err) {
      setReceiptsError(err.response?.data?.error || 'Receipt history is unavailable')
    } finally {
      setReceiptsLoading(false)
    }
  }

  const loadMpesaPayments = async () => {
    try {
      const res = await api.get('/payments')
      setMpesaPayments(res.data.filter((payment) => payment.mpesa_checkout_id))
      setMpesaPaymentsError('')
    } catch (err) {
      setMpesaPaymentsError(err.response?.data?.error || 'M-Pesa request history is unavailable')
    }
  }

  const loadReceiptOptions = async () => {
    const [accountsRes, periodsRes] = await Promise.all([
      api.get('/accounting/accounts', { params: { active: 'true' } }),
      api.get('/accounting/periods')
    ])
    const cashAccounts = accountsRes.data.filter((account) => account.account_type === 'asset')
    const openPeriods = periodsRes.data.filter((period) => period.status === 'open')
    setReceiptAccounts(cashAccounts)
    setReceiptPeriods(openPeriods)
    setReceiptCashAccount((current) => current || cashAccounts[0]?.id || '')
    setReceiptPeriod((current) => current || openPeriods[0]?.id || '')
  }

  const fetchData = async () => {
    try {
      const [invRes, cliRes, taxRes] = await Promise.all([
        api.get('/invoices'),
        api.get('/clients'),
        api.get('/accounting/tax-profiles', { params: { active: 'true' } })
      ])
      setInvoices(invRes.data)
      setClients(cliRes.data)
      setTaxProfiles(taxRes.data)
      await Promise.all([loadReceipts(), loadMpesaPayments()])
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

  const selectedProfile = taxProfiles.find((profile) => profile.id === form.tax_profile_id)
  const getTax = () => {
    const amount = getSubtotal()
    const rate = Number(selectedProfile?.tax_rate || 0)
    return selectedProfile?.calculation_method === 'inclusive'
      ? amount * rate / (100 + rate)
      : amount * rate / 100
  }
  const getDisplaySubtotal = () => selectedProfile?.calculation_method === 'inclusive'
    ? getSubtotal() - getTax()
    : getSubtotal()
  const getTotal = () => selectedProfile?.calculation_method === 'inclusive'
    ? getSubtotal()
    : getSubtotal() + getTax()

  const openCreate = () => {
    setForm({
      client_id: '',
      due_date: '',
      tax_profile_id: '',
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
      quantity: String(item.quantity).trim(),
      unit_price: String(item.unit_price).trim()
    }))
    try {
      await api.post('/invoices', { ...form, items })
      setShowForm(false)
      fetchData()
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create invoice')
    }
  }

  const handleFinalize = async (invoice) => {
    if (!window.confirm(`Issue ${invoice.invoice_number} and post it to the accounting ledger? This cannot be undone; corrections require an approved reversal.`)) return
    try {
      await api.post(`/invoices/${invoice.id}/finalize`, {})
      await fetchData()
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to issue invoice')
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
      await loadMpesaPayments()
    } catch (err) {
      setMpesaMessage(err.response?.data?.error || 'M-Pesa request failed')
    } finally {
      setMpesaLoading(false)
    }
  }

  const openMpesaReconciliation = async (payment) => {
    setReconcilePayment(payment)
    setReconcileDate(localDate())
    setReconcileResult(null)
    setReconcileError('')
    try {
      const response = await api.get(`/payments/${payment.id}/mpesa/reconciliation`)
      setReconcileHistory(response.data)
    } catch (err) {
      setReconcileHistory([])
      setReconcileError(err.response?.data?.error || 'Reconciliation history is unavailable')
    }
  }

  const runMpesaReconciliation = async (event) => {
    event.preventDefault()
    if (!reconcilePayment) return
    setReconcileBusy(true)
    setReconcileError('')
    try {
      const response = await api.post(`/payments/${reconcilePayment.id}/mpesa/reconcile`, {
        payment_date: reconcileDate
      }, { headers: { 'Idempotency-Key': requestKey() } })
      setReconcileResult(response.data)
      const history = await api.get(`/payments/${reconcilePayment.id}/mpesa/reconciliation`)
      setReconcileHistory(history.data)
      await Promise.all([loadReceipts(), loadMpesaPayments()])
    } catch (err) {
      setReconcileError(err.response?.data?.error || 'Could not query the M-Pesa transaction')
    } finally {
      setReconcileBusy(false)
    }
  }

  const openReceiptModal = async () => {
    setReceiptForm({
      customer_id: '', amount: '', currency: 'KES', payment_method: 'bank_transfer',
      receipt_reference: '', payment_date: localDate()
    })
    setReceiptFormError('')
    setReceiptModal(true)
    try {
      await loadReceiptOptions()
    } catch (err) {
      setReceiptFormError(err.response?.data?.error || 'Could not load accounting accounts and periods')
    }
  }

  const submitReceipt = async (event) => {
    event.preventDefault()
    setReceiptSaving(true)
    setReceiptFormError('')
    try {
      const result = await api.post('/payments/receipts', receiptForm, {
        headers: { 'Idempotency-Key': requestKey() }
      })
      setReceiptModal(false)
      await loadReceipts()
      await openReceiptDetails(result.data.receipt.id)
    } catch (err) {
      setReceiptFormError(err.response?.data?.error || 'Could not record receipt')
    } finally {
      setReceiptSaving(false)
    }
  }

  const openReceiptDetails = async (receiptId) => {
    setReceiptDetailLoading(true)
    setReceiptActionError('')
    setReceiptOutstanding([])
    setAllocationAmounts({})
    try {
      const res = await api.get(`/payments/receipts/${receiptId}`)
      setReceiptDetail(res.data)
      setReceiptReason('')
      setReceiptPeriod((current) => current || receiptPeriods.find((period) => period.status === 'open')?.id || '')
      if (!receiptAccounts.length || !receiptPeriods.length) {
        try {
          await loadReceiptOptions()
        } catch (optionsError) {
          setReceiptActionError(optionsError.response?.data?.error || 'Could not load accounting accounts and periods')
        }
      }
      if (res.data.status === 'verified') {
        const outstanding = await api.get('/payments/receipts/outstanding-invoices', {
          params: { customer_id: res.data.customer_id }
        })
        setReceiptOutstanding(outstanding.data)
      }
    } catch (err) {
      setReceiptActionError(err.response?.data?.error || 'Could not load receipt details')
    } finally {
      setReceiptDetailLoading(false)
    }
  }

  const verifyReceipt = async () => {
    if (!receiptDetail || !receiptCashAccount || !receiptPeriod) return
    setReceiptActionLoading(true)
    setReceiptActionError('')
    try {
      await api.post(`/payments/receipts/${receiptDetail.id}/verify`, {
        cash_account_id: receiptCashAccount,
        accounting_period_id: receiptPeriod
      }, { headers: { 'Idempotency-Key': requestKey() } })
      await loadReceipts()
      await openReceiptDetails(receiptDetail.id)
    } catch (err) {
      setReceiptActionError(err.response?.data?.error || 'Could not verify receipt')
    } finally {
      setReceiptActionLoading(false)
    }
  }

  const failReceipt = async () => {
    if (!receiptDetail || !receiptReason.trim()) return
    setReceiptActionLoading(true)
    setReceiptActionError('')
    try {
      await api.post(`/payments/receipts/${receiptDetail.id}/fail`, { reason: receiptReason })
      await loadReceipts()
      await openReceiptDetails(receiptDetail.id)
    } catch (err) {
      setReceiptActionError(err.response?.data?.error || 'Could not mark receipt failed')
    } finally {
      setReceiptActionLoading(false)
    }
  }

  const allocateReceipt = async () => {
    if (!receiptDetail) return
    const allocations = receiptOutstanding
      .map((invoice) => ({ invoice_id: invoice.id, amount: String(allocationAmounts[invoice.id] || '').trim() }))
      .filter((item) => item.amount)
    if (!allocations.length) {
      setReceiptActionError('Enter an allocation amount for at least one invoice')
      return
    }
    setAllocationLoading(true)
    setReceiptActionError('')
    try {
      await api.post(`/payments/receipts/${receiptDetail.id}/allocate`, { allocations }, {
        headers: { 'Idempotency-Key': requestKey() }
      })
      await fetchData()
      await openReceiptDetails(receiptDetail.id)
    } catch (err) {
      setReceiptActionError(err.response?.data?.error || 'Could not allocate receipt')
    } finally {
      setAllocationLoading(false)
    }
  }

  const reverseReceipt = async () => {
    if (!receiptDetail || !receiptPeriod || !receiptReason.trim()) return
    if (!window.confirm('Reverse this verified receipt in the accounting ledger? The receipt history will be retained.')) return
    setReceiptActionLoading(true)
    setReceiptActionError('')
    try {
      await api.post(`/payments/receipts/${receiptDetail.id}/reverse`, {
        accounting_period_id: receiptPeriod,
        reversal_date: localDate(),
        reason: receiptReason
      }, { headers: { 'Idempotency-Key': requestKey() } })
      await fetchData()
      await openReceiptDetails(receiptDetail.id)
    } catch (err) {
      setReceiptActionError(err.response?.data?.error || 'Could not reverse receipt')
    } finally {
      setReceiptActionLoading(false)
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
            <Link to="/products" className="hover:text-blue-600">Products</Link>
            <Link to="/suppliers" className="hover:text-blue-600">Suppliers</Link>
            <Link to="/purchasing" className="hover:text-blue-600">Purchasing</Link>
            <Link to="/sales-orders" className="hover:text-blue-600">Sales Orders</Link>
            <Link to="/expenses" className="hover:text-blue-600">Expenses</Link>
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
          <div className="flex gap-3">
            <button
              onClick={openReceiptModal}
              className="bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold px-5 py-2.5 rounded-lg transition"
            >
              + Record Receipt
            </button>
            <button
              onClick={openCreate}
              className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-5 py-2.5 rounded-lg transition"
            >
              + New Invoice
            </button>
          </div>
        </div>

        <section className="bg-white rounded-2xl shadow-sm border border-gray-100 mb-6">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-gray-800">Customer receipts</h3>
              <p className="text-xs text-gray-500 mt-1">Recorded receipts remain pending until an authorized user verifies them.</p>
            </div>
            <button onClick={loadReceipts} className="text-sm text-blue-600 hover:underline">Refresh</button>
          </div>
          {receiptsError && <p className="px-6 py-4 text-sm text-red-600">{receiptsError}</p>}
          {receiptsLoading ? (
            <div className="text-center py-8 text-gray-400">Loading receipt history...</div>
          ) : receipts.length === 0 ? (
            <div className="text-center py-8 text-gray-400 text-sm">No receipts recorded yet</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-gray-400 border-b border-gray-100">
                  <th className="px-6 py-3 font-medium">Reference</th>
                  <th className="px-6 py-3 font-medium">Customer</th>
                  <th className="px-6 py-3 font-medium">Date</th>
                  <th className="px-6 py-3 font-medium">Amount</th>
                  <th className="px-6 py-3 font-medium">Status</th>
                  <th className="px-6 py-3 font-medium">Allocated / Unallocated</th>
                  <th className="px-6 py-3 font-medium">History</th>
                </tr></thead>
                <tbody className="divide-y divide-gray-50">
                  {receipts.map((receipt) => (
                    <tr key={receipt.id} className="hover:bg-gray-50">
                      <td className="px-6 py-3 font-medium text-gray-800">{receipt.receipt_reference || receipt.id.slice(0, 8)}</td>
                      <td className="px-6 py-3 text-gray-600">{clients.find((client) => client.id === receipt.customer_id)?.name || 'Customer'}</td>
                      <td className="px-6 py-3 text-gray-500">{String(receipt.payment_date).slice(0, 10)}</td>
                      <td className="px-6 py-3 font-medium">{receipt.currency} {Number(receipt.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                      <td className="px-6 py-3"><span className={`px-2 py-1 rounded-full text-xs font-medium ${receipt.status === 'verified' ? 'bg-green-100 text-green-700' : receipt.status === 'failed' ? 'bg-red-100 text-red-700' : receipt.status === 'reversed' ? 'bg-gray-200 text-gray-700' : 'bg-amber-100 text-amber-700'}`}>{receipt.status}</span></td>
                      <td className="px-6 py-3 text-gray-600">{receipt.status === 'verified'
                        ? `${Number(receipt.allocated_amount).toFixed(2)} / ${Number(receipt.unallocated_amount).toFixed(2)} ${receipt.currency}`
                        : '—'}</td>
                      <td className="px-6 py-3"><button onClick={() => openReceiptDetails(receipt.id)} className="text-blue-600 hover:underline text-xs font-medium">Details</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="bg-white rounded-2xl shadow-sm border border-gray-100 mb-6">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-gray-800">M-Pesa request reconciliation</h3>
              <p className="text-xs text-gray-500 mt-1">STK acceptance and public callbacks do not confirm payment. An administrator can query Daraja and review the resulting pending receipt.</p>
            </div>
            <button onClick={loadMpesaPayments} className="text-sm text-blue-600 hover:underline">Refresh</button>
          </div>
          {mpesaPaymentsError && <p role="alert" className="px-6 py-4 text-sm text-red-600">{mpesaPaymentsError}</p>}
          {mpesaPayments.length === 0 ? (
            <p className="px-6 py-7 text-center text-sm text-gray-500">No M-Pesa requests with checkout identifiers.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-gray-400 border-b border-gray-100">
                  <th className="px-6 py-3 font-medium">Invoice</th>
                  <th className="px-6 py-3 font-medium">Checkout request</th>
                  <th className="px-6 py-3 font-medium">Amount</th>
                  <th className="px-6 py-3 font-medium">Request state</th>
                  <th className="px-6 py-3 font-medium">Action</th>
                </tr></thead>
                <tbody className="divide-y divide-gray-50">
                  {mpesaPayments.map((payment) => (
                    <tr key={payment.id}>
                      <td className="px-6 py-3">{payment.invoice_number || payment.invoice_id}</td>
                      <td className="px-6 py-3 font-mono text-xs">{payment.mpesa_checkout_id}</td>
                      <td className="px-6 py-3">KES {Number(payment.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                      <td className="px-6 py-3">{payment.status}</td>
                      <td className="px-6 py-3"><button onClick={() => openMpesaReconciliation(payment)} className="text-blue-700 hover:underline">Review status</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {reconcilePayment && (
          <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center">
            <section role="dialog" aria-modal="true" aria-labelledby="mpesa-reconcile-title" className="my-6 max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
              <h3 id="mpesa-reconcile-title" className="text-lg font-semibold text-gray-900">Reconcile M-Pesa request</h3>
              <p className="mt-2 text-sm text-gray-600">{reconcilePayment.invoice_number} · KES {Number(reconcilePayment.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })} · {reconcilePayment.mpesa_checkout_id}</p>
              <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">The server will query Daraja using this saved checkout ID. Enter the transaction date confirmed from the provider statement. A successful query creates a pending receipt only; an authorized user must still review evidence, select the posting account and period, and verify it before accounting changes.</p>
              {reconcileError && <p role="alert" className="mt-3 rounded bg-red-50 p-3 text-sm text-red-700">{reconcileError}</p>}
              {reconcileResult && <div className="mt-3 rounded border border-blue-100 bg-blue-50 p-3 text-sm text-blue-900"><p className="font-medium">{reconcileResult.message}</p><p className="mt-1">Provider result: {reconcileResult.reconciliation.outcome}{reconcileResult.reconciliation.provider_result_code == null ? '' : ` (${reconcileResult.reconciliation.provider_result_code})`}</p>{reconcileResult.receipt?.id && <button className="mt-2 text-blue-700 underline" onClick={() => { setReconcilePayment(null); openReceiptDetails(reconcileResult.receipt.id) }}>Open pending receipt</button>}</div>}
              <form onSubmit={runMpesaReconciliation} className="mt-4 flex flex-wrap items-end gap-3">
                <label className="text-sm">Provider transaction date<input required type="date" value={reconcileDate} onChange={(event) => setReconcileDate(event.target.value)} className="mt-1 block rounded border px-3 py-2" /></label>
                <button disabled={reconcileBusy} className="rounded bg-green-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{reconcileBusy ? 'Querying Daraja…' : 'Query provider status'}</button>
                <button type="button" onClick={() => setReconcilePayment(null)} className="rounded border px-4 py-2 text-sm">Close</button>
              </form>
              <div className="mt-6">
                <h4 className="mb-2 font-semibold text-gray-800">Reconciliation audit history</h4>
                {reconcileHistory.length === 0 ? <p className="text-sm text-gray-500">No provider query outcomes recorded yet.</p> : <ul className="divide-y rounded border">{reconcileHistory.map((item) => <li key={item.id} className="flex flex-wrap justify-between gap-2 p-3 text-sm"><span>{item.outcome}{item.provider_result_code == null ? '' : ` · provider code ${item.provider_result_code}`} · {item.payment_date}</span><span className="text-gray-500">{new Date(item.created_at).toLocaleString()}</span></li>)}</ul>}
              </div>
            </section>
          </div>
        )}

        {receiptModal && (
          <div className="fixed inset-0 bg-black bg-opacity-40 flex items-start justify-center z-50 px-4 py-8 overflow-y-auto">
            <form onSubmit={submitReceipt} className="bg-white rounded-2xl shadow-xl w-full max-w-xl p-8 my-auto space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-gray-800">Record customer receipt</h3>
                <p className="text-sm text-gray-500 mt-1">Saving creates a pending receipt. It does not confirm cash or post a journal.</p>
              </div>
              {receiptFormError && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">{receiptFormError}</div>}
              <label className="block text-sm font-medium text-gray-700">Customer
                <select required value={receiptForm.customer_id} onChange={(event) => setReceiptForm({ ...receiptForm, customer_id: event.target.value })} className="mt-1 w-full border border-gray-300 rounded-lg px-4 py-2.5">
                  <option value="">Select a customer</option>
                  {clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
                </select>
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-sm font-medium text-gray-700">Amount (KES)
                  <input required type="number" min="0.01" step="0.01" value={receiptForm.amount} onChange={(event) => setReceiptForm({ ...receiptForm, amount: event.target.value })} className="mt-1 w-full border border-gray-300 rounded-lg px-4 py-2.5" />
                </label>
                <label className="block text-sm font-medium text-gray-700">Payment date
                  <input required type="date" value={receiptForm.payment_date} onChange={(event) => setReceiptForm({ ...receiptForm, payment_date: event.target.value })} className="mt-1 w-full border border-gray-300 rounded-lg px-4 py-2.5" />
                </label>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-sm font-medium text-gray-700">Payment method
                  <select value={receiptForm.payment_method} onChange={(event) => setReceiptForm({ ...receiptForm, payment_method: event.target.value })} className="mt-1 w-full border border-gray-300 rounded-lg px-4 py-2.5">
                    <option value="bank_transfer">Bank transfer</option><option value="cash">Cash</option><option value="card">Card</option><option value="cheque">Cheque</option><option value="mpesa">M-Pesa</option><option value="other">Other</option>
                  </select>
                </label>
                <label className="block text-sm font-medium text-gray-700">Receipt reference
                  <input maxLength="150" value={receiptForm.receipt_reference} onChange={(event) => setReceiptForm({ ...receiptForm, receipt_reference: event.target.value })} className="mt-1 w-full border border-gray-300 rounded-lg px-4 py-2.5" />
                </label>
              </div>
              <p className="text-xs text-gray-500">Receipt posting is currently KES-only and requires a tenant-configured open accounting period and cash/bank asset account.</p>
              <div className="flex gap-3 pt-2">
                <button type="submit" disabled={receiptSaving || !clients.length} className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold py-2.5 rounded-lg disabled:opacity-50">{receiptSaving ? 'Saving...' : 'Save pending receipt'}</button>
                <button type="button" onClick={() => setReceiptModal(false)} className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold py-2.5 rounded-lg">Cancel</button>
              </div>
            </form>
          </div>
        )}

        {receiptDetail && (
          <div className="fixed inset-0 bg-black bg-opacity-40 flex items-start justify-center z-50 px-4 py-8 overflow-y-auto">
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl p-6 my-auto">
              <div className="flex items-start justify-between gap-4 mb-5">
                <div>
                  <h3 className="text-lg font-semibold text-gray-800">Receipt {receiptDetail.receipt_reference || receiptDetail.id.slice(0, 8)}</h3>
                  <p className="text-sm text-gray-500">{clients.find((client) => client.id === receiptDetail.customer_id)?.name || 'Customer'} · {receiptDetail.payment_method} · {String(receiptDetail.payment_date).slice(0, 10)}</p>
                </div>
                <button onClick={() => setReceiptDetail(null)} className="text-gray-500 hover:text-gray-800">Close</button>
              </div>
              {receiptDetailLoading ? <p className="py-8 text-center text-gray-400">Loading receipt...</p> : <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
                  <div className="rounded-lg bg-gray-50 p-3"><p className="text-xs text-gray-500">Status</p><p className="font-semibold capitalize">{receiptDetail.status}</p></div>
                  <div className="rounded-lg bg-gray-50 p-3"><p className="text-xs text-gray-500">Receipt amount</p><p className="font-semibold">{receiptDetail.currency} {Number(receiptDetail.amount).toFixed(2)}</p></div>
                  <div className="rounded-lg bg-gray-50 p-3"><p className="text-xs text-gray-500">Allocated</p><p className="font-semibold">{receiptDetail.currency} {Number(receiptDetail.allocated_amount).toFixed(2)}</p></div>
                  <div className="rounded-lg bg-gray-50 p-3"><p className="text-xs text-gray-500">Unallocated</p><p className="font-semibold">{receiptDetail.currency} {Number(receiptDetail.unallocated_amount).toFixed(2)}</p></div>
                </div>
                {receiptDetail.journal_entry_id && <p className="text-xs text-gray-500 mb-2">Receipt journal: {receiptDetail.journal_entry_id}</p>}
                {receiptDetail.reversal_journal_entry_id && <p className="text-xs text-gray-500 mb-2">Reversal journal: {receiptDetail.reversal_journal_entry_id}</p>}
                {receiptDetail.failure_reason && <p className="text-sm text-red-700 mb-3">Failure: {receiptDetail.failure_reason}</p>}
                {receiptDetail.reversal_reason && <p className="text-sm text-red-700 mb-3">Reversal reason: {receiptDetail.reversal_reason}</p>}
                {receiptActionError && <div className="mb-4 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">{receiptActionError}</div>}
                {receiptDetail.status === 'pending' && <div className="border border-amber-200 bg-amber-50 rounded-xl p-4 mb-5 space-y-3">
                  <p className="text-sm text-amber-900">Confirm the payment evidence before posting. Verification debits the selected cash/bank asset and credits receivables.</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="text-sm font-medium text-gray-700">Cash/bank asset account
                      <select value={receiptCashAccount} onChange={(event) => setReceiptCashAccount(event.target.value)} className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2">
                        <option value="">Select an asset account</option>{receiptAccounts.map((account) => <option key={account.id} value={account.id}>{account.account_code} · {account.name}</option>)}
                      </select>
                    </label>
                    <label className="text-sm font-medium text-gray-700">Open accounting period
                      <select value={receiptPeriod} onChange={(event) => setReceiptPeriod(event.target.value)} className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2">
                        <option value="">Select an open period</option>{receiptPeriods.map((period) => <option key={period.id} value={period.id}>{period.name} ({String(period.starts_on).slice(0, 10)} to {String(period.ends_on).slice(0, 10)})</option>)}
                      </select>
                    </label>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={verifyReceipt} disabled={receiptActionLoading || !receiptCashAccount || !receiptPeriod} className="bg-emerald-600 text-white text-sm px-4 py-2 rounded-lg disabled:opacity-50">{receiptActionLoading ? 'Posting...' : 'Verify & post'}</button>
                    <input value={receiptReason} onChange={(event) => setReceiptReason(event.target.value)} maxLength="1800" placeholder="Failure reason" className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                    <button onClick={failReceipt} disabled={receiptActionLoading || !receiptReason.trim()} className="bg-gray-100 text-gray-700 text-sm px-4 py-2 rounded-lg disabled:opacity-50">Mark failed</button>
                  </div>
                </div>}
                {receiptDetail.status === 'verified' && <div className="border border-gray-200 rounded-xl p-4 mb-5">
                  <h4 className="font-semibold text-gray-800 mb-3">Allocate to outstanding invoices</h4>
                  {receiptOutstanding.length === 0 ? <p className="text-sm text-gray-500">No posted outstanding invoices are available for this customer. The unallocated amount remains on the receipt.</p> : <div className="space-y-2 max-h-56 overflow-y-auto">
                    {receiptOutstanding.map((invoice) => <div key={invoice.id} className="grid grid-cols-[1fr_130px_140px] gap-3 items-center text-sm border-b border-gray-100 pb-2">
                      <div><p className="font-medium text-gray-800">{invoice.invoice_number}</p><p className="text-xs text-gray-500">Outstanding {invoice.currency} {Number(invoice.outstanding_amount).toFixed(2)}</p></div>
                      <input type="number" min="0.01" max={invoice.outstanding_amount} step="0.01" value={allocationAmounts[invoice.id] || ''} onChange={(event) => setAllocationAmounts({ ...allocationAmounts, [invoice.id]: event.target.value })} placeholder="Amount" className="border border-gray-300 rounded-lg px-3 py-2" />
                      <span className="text-xs text-gray-500">of {invoice.currency} {Number(invoice.total).toFixed(2)}</span>
                    </div>)}
                    <button onClick={allocateReceipt} disabled={allocationLoading} className="mt-2 bg-blue-600 hover:bg-blue-700 text-white text-sm px-4 py-2 rounded-lg disabled:opacity-50">{allocationLoading ? 'Allocating...' : 'Allocate selected amounts'}</button>
                  </div>}
                </div>}
                {receiptDetail.status === 'verified' && <div className="border border-red-200 bg-red-50 rounded-xl p-4 mb-5 space-y-3">
                  <p className="text-sm text-red-900">A reversal posts a linked journal and retains this receipt and its allocations for audit history.</p>
                  <div className="flex gap-2 flex-wrap">
                    <select value={receiptPeriod} onChange={(event) => setReceiptPeriod(event.target.value)} className="flex-1 min-w-48 border border-gray-300 rounded-lg px-3 py-2 text-sm">
                      <option value="">Select open reversal period</option>{receiptPeriods.map((period) => <option key={period.id} value={period.id}>{period.name}</option>)}
                    </select>
                    <input value={receiptReason} onChange={(event) => setReceiptReason(event.target.value)} maxLength="1800" placeholder="Reversal reason" className="flex-1 min-w-48 border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                    <button onClick={reverseReceipt} disabled={receiptActionLoading || !receiptReason.trim() || !receiptPeriod} className="bg-red-600 text-white text-sm px-4 py-2 rounded-lg disabled:opacity-50">Reverse receipt</button>
                  </div>
                </div>}
                <div className="grid gap-5 md:grid-cols-2">
                  <div><h4 className="font-semibold text-gray-800 mb-2">Allocation history</h4>{receiptDetail.allocations.length === 0 ? <p className="text-sm text-gray-500">No allocations yet.</p> : <ul className="space-y-1 text-sm">{receiptDetail.allocations.map((allocation) => <li key={allocation.id} className="flex justify-between gap-3"><span>{allocation.invoice_number}{allocation.effective ? '' : ' (reversed)'}</span><span>{receiptDetail.currency} {Number(allocation.amount).toFixed(2)}</span></li>)}</ul>}</div>
                  <div><h4 className="font-semibold text-gray-800 mb-2">Receipt history</h4>{receiptDetail.events.map((event) => <p key={event.id} className="text-xs text-gray-500 mb-1"><span className="capitalize">{event.event_type}</span> · {new Date(event.created_at).toLocaleString()}</p>)}</div>
                </div>
              </>}
            </div>
          </div>
        )}

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

                <div className="grid gap-4 sm:grid-cols-2">
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
                  <label className="block text-sm font-medium text-gray-700 mb-1">Tax profile *
                    <select name="tax_profile_id" value={form.tax_profile_id} onChange={handleFormChange} required className="mt-1 w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                      <option value="">Select a configured profile</option>
                      {taxProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.tax_rate}% · {profile.calculation_method}</option>)}
                    </select>
                  </label>
                </div>
                <p className="-mt-3 text-xs text-gray-500">Tax treatment must be configured and confirmed by your accountant. New invoices are KES-only; the server calculates all totals.</p>

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
                    <span>KES {getDisplaySubtotal().toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-gray-500">
                    <span>{selectedProfile?.name || 'Tax'}{selectedProfile ? ` (${selectedProfile.tax_rate}%)` : ''}{selectedProfile?.calculation_method === 'inclusive' ? ' included' : ''}</span>
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
                    disabled={!taxProfiles.length}
                    className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2.5 rounded-lg transition"
                  >
                    Save Draft
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
                          {inv.status === 'draft' && (
                            <button
                              onClick={() => handleFinalize(inv)}
                              className="text-blue-600 hover:underline text-xs font-medium"
                            >
                              Issue &amp; Post
                            </button>
                          )}
                          {['sent', 'overdue'].includes(inv.status) && (
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
                          {inv.status === 'draft' && <button onClick={() => handleDelete(inv.id)} className="text-red-500 hover:underline text-xs font-medium">Delete</button>}
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

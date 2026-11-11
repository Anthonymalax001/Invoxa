import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../api'

const today = () => new Date().toISOString().slice(0, 10)
const requestKey = () => globalThis.crypto?.randomUUID?.() || `payables-${Date.now()}-${Math.random().toString(36).slice(2)}`
const emptyLine = () => ({ description: '', quantity: '1', unit_price: '0.00', tax_rate: '0.00', account_id: '', purchase_order_item_id: '', receipt_id: '', purchase_order_receipt_item_id: '' })
const emptyBill = () => ({ supplier_id: '', supplier_invoice_number: '', bill_date: today(), due_date: today(), currency: 'KES', purchase_order_id: '', notes: '', lines: [emptyLine()] })
const money = (value, currency = 'KES') => `${currency} ${Number(value || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const dateLabel = (value) => value ? new Date(`${String(value).slice(0, 10)}T00:00:00`).toLocaleDateString('en-KE') : '—'
const messageOf = (error, fallback) => error.response?.data?.error || fallback

function Nav() {
  return (
    <nav className="flex gap-5 overflow-x-auto whitespace-nowrap text-sm font-medium text-gray-600">
      <Link to="/dashboard" className="hover:text-blue-600">Dashboard</Link>
      <Link to="/suppliers" className="hover:text-blue-600">Suppliers</Link>
      <Link to="/purchasing" className="hover:text-blue-600">Purchasing</Link>
      <Link to="/supplier-bills" className="text-blue-600">Supplier bills</Link>
      <Link to="/expenses" className="hover:text-blue-600">Expenses</Link>
      <Link to="/invoices" className="hover:text-blue-600">Invoices</Link>
    </nav>
  )
}

function Status({ value }) {
  const colors = {
    draft: 'bg-gray-100 text-gray-700', submitted: 'bg-blue-100 text-blue-700',
    approved: 'bg-amber-100 text-amber-800', partially_paid: 'bg-violet-100 text-violet-800',
    paid: 'bg-green-100 text-green-700', overdue: 'bg-red-100 text-red-700',
    cancelled: 'bg-gray-100 text-gray-500', reversed: 'bg-rose-100 text-rose-700',
    pending: 'bg-amber-100 text-amber-800', verified: 'bg-green-100 text-green-700', failed: 'bg-red-100 text-red-700'
  }
  return <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${colors[value] || 'bg-gray-100 text-gray-700'}`}>{String(value || '').replaceAll('_', ' ')}</span>
}

export default function SupplierBills() {
  const [bills, setBills] = useState([])
  const [payments, setPayments] = useState([])
  const [suppliers, setSuppliers] = useState([])
  const [accounts, setAccounts] = useState([])
  const [periods, setPeriods] = useState([])
  const [orders, setOrders] = useState([])
  const [orderDetails, setOrderDetails] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [pageError, setPageError] = useState('')
  const [search, setSearch] = useState('')
  const [supplierFilter, setSupplierFilter] = useState('')
  const [billOpen, setBillOpen] = useState(false)
  const [editingBill, setEditingBill] = useState(null)
  const [billRequestId, setBillRequestId] = useState('')
  const [billForm, setBillForm] = useState(emptyBill)
  const [billError, setBillError] = useState('')
  const [actionError, setActionError] = useState('')
  const [approvalBill, setApprovalBill] = useState(null)
  const [approvalForm, setApprovalForm] = useState({ payable_account_id: '', accounting_period_id: '', entry_date: '' })
  const [paymentOpen, setPaymentOpen] = useState(false)
  const [paymentRequestId, setPaymentRequestId] = useState('')
  const [paymentForm, setPaymentForm] = useState({ supplier_id: '', payment_date: today(), payment_method: 'bank_transfer', payment_reference: '', notes: '', allocations: [] })
  const [paymentError, setPaymentError] = useState('')
  const [verificationPayment, setVerificationPayment] = useState(null)
  const [verifyForm, setVerifyForm] = useState({ cash_account_id: '', accounting_period_id: '' })
  const [reverseTarget, setReverseTarget] = useState(null)
  const [reverseForm, setReverseForm] = useState({ accounting_period_id: '', reversal_date: today(), reason: '' })
  const [selectedBill, setSelectedBill] = useState(null)

  const activeSuppliers = useMemo(() => suppliers.filter((supplier) => supplier.is_active), [suppliers])
  const debitAccounts = useMemo(() => accounts.filter((account) => account.is_active && ['asset', 'expense'].includes(account.account_type) && account.normal_balance === 'debit'), [accounts])
  const payableAccounts = useMemo(() => accounts.filter((account) => account.is_active && account.account_type === 'liability' && account.normal_balance === 'credit'), [accounts])
  const cashAccounts = useMemo(() => accounts.filter((account) => account.is_active && account.account_type === 'asset' && account.normal_balance === 'debit'), [accounts])
  const openPeriods = useMemo(() => periods.filter((period) => period.status === 'open'), [periods])

  const load = useCallback(async () => {
    setLoading(true)
    setPageError('')
    try {
      const [billResponse, paymentResponse, supplierResponse, accountResponse, periodResponse, orderResponse] = await Promise.all([
        api.get('/supplier-bills', { params: { search, supplier_id: supplierFilter || undefined } }),
        api.get('/supplier-bills/payments', { params: { supplier_id: supplierFilter || undefined } }),
        api.get('/suppliers', { params: { active: 'true' } }),
        api.get('/accounting/accounts', { params: { active: 'true' } }),
        api.get('/accounting/periods'),
        api.get('/purchase-orders')
      ])
      setBills(billResponse.data)
      setPayments(paymentResponse.data)
      setSuppliers(supplierResponse.data)
      setAccounts(accountResponse.data)
      setPeriods(periodResponse.data)
      setOrders(orderResponse.data.filter((order) => ['ordered', 'partially_received', 'received'].includes(order.status)))
    } catch (error) {
      setPageError(messageOf(error, 'Could not load supplier payable records.'))
    } finally {
      setLoading(false)
    }
  }, [search, supplierFilter])

  useEffect(() => { load() }, [load])

  const openCreate = () => {
    setEditingBill(null)
    setBillRequestId(requestKey())
    setBillForm(emptyBill())
    setOrderDetails(null)
    setBillError('')
    setBillOpen(true)
  }

  const loadOrderDetails = async (orderId) => {
    if (!orderId) { setOrderDetails(null); return }
    try {
      const response = await api.get(`/purchase-orders/${orderId}`)
      setOrderDetails(response.data)
    } catch (error) {
      setBillError(messageOf(error, 'Could not load purchase order lines.'))
      setOrderDetails(null)
    }
  }

  const openEdit = async (bill) => {
    setBillError('')
    setEditingBill(bill)
    setBillRequestId(requestKey())
    setBillForm({
      supplier_id: bill.supplier_id,
      supplier_invoice_number: bill.supplier_invoice_number,
      bill_date: String(bill.bill_date).slice(0, 10),
      due_date: String(bill.due_date).slice(0, 10),
      currency: bill.currency.trim(),
      purchase_order_id: bill.purchase_order_id || '',
      notes: bill.notes || '',
      lines: bill.lines.map((line) => ({
        description: line.description, quantity: String(line.quantity), unit_price: String(line.unit_price),
        tax_rate: String(line.tax_rate), account_id: line.account_id,
        purchase_order_item_id: line.purchase_order_item_id || '', receipt_id: line.receipt_id || '',
        purchase_order_receipt_item_id: line.purchase_order_receipt_item_id || ''
      }))
    })
    setBillOpen(true)
    if (bill.purchase_order_id) await loadOrderDetails(bill.purchase_order_id)
  }

  const openBillDetails = async (bill) => {
    try {
      const response = await api.get(`/supplier-bills/${bill.id}`)
      setSelectedBill(response.data)
      setActionError('')
    } catch (error) {
      setPageError(messageOf(error, 'Could not load supplier bill history.'))
    }
  }

  const updateLine = (index, key, value) => setBillForm((current) => ({
    ...current,
    lines: current.lines.map((line, lineIndex) => lineIndex === index ? {
      ...line, [key]: value,
      ...(key === 'purchase_order_item_id' ? { receipt_id: '', purchase_order_receipt_item_id: '' } : {})
    } : line)
  }))

  const saveBill = async (event) => {
    event.preventDefault()
    setBusy(true)
    setBillError('')
    try {
      const payload = {
        ...billForm,
        purchase_order_id: billForm.purchase_order_id || null,
        lines: billForm.lines.map((line) => ({
          ...line,
          purchase_order_item_id: line.purchase_order_item_id || null,
          receipt_id: line.receipt_id || null,
          purchase_order_receipt_item_id: line.purchase_order_receipt_item_id || null
        }))
      }
      const headers = { 'Idempotency-Key': billRequestId || requestKey() }
      if (editingBill) await api.put(`/supplier-bills/${editingBill.id}`, payload, { headers })
      else await api.post('/supplier-bills', payload, { headers })
      setBillOpen(false)
      setEditingBill(null)
      setBillRequestId('')
      await load()
    } catch (error) {
      setBillError(messageOf(error, 'Could not save supplier bill.'))
    } finally {
      setBusy(false)
    }
  }

  const runBillAction = async (bill, action, payload = {}, key = false) => {
    setBusy(true)
    setActionError('')
    try {
      const config = key ? { headers: { 'Idempotency-Key': requestKey() } } : undefined
      await api.post(`/supplier-bills/${bill.id}/${action}`, payload, config)
      setApprovalBill(null)
      setReverseTarget(null)
      setSelectedBill(null)
      await load()
    } catch (error) {
      setActionError(messageOf(error, `Could not ${action} supplier bill.`))
    } finally {
      setBusy(false)
    }
  }

  const prepareApproval = (bill) => {
    setApprovalBill(bill)
    setApprovalForm({ payable_account_id: payableAccounts[0]?.id || '', accounting_period_id: openPeriods[0]?.id || '', entry_date: String(bill.bill_date).slice(0, 10) })
    setActionError('')
  }

  const cancelBill = (bill) => {
    const reason = window.prompt(`Reason for cancelling ${bill.bill_number}:`)
    if (reason?.trim()) runBillAction(bill, 'cancel', { reason: reason.trim() })
  }

  const startPayment = (bill) => {
    setPaymentRequestId(requestKey())
    setPaymentForm({
      supplier_id: bill.supplier_id, payment_date: today(), payment_method: 'bank_transfer',
      payment_reference: '', notes: '', allocations: [{ bill_id: bill.id, amount: bill.balance_due }]
    })
    setPaymentError('')
    setPaymentOpen(true)
  }

  const paymentBills = bills.filter((bill) => bill.supplier_id === paymentForm.supplier_id &&
    ['approved', 'partially_paid', 'overdue'].includes(bill.status) && Number(bill.balance_due) > 0 &&
    (!paymentForm.allocations[0]?.bill_id || bill.currency.trim() === bills.find((row) => row.id === paymentForm.allocations[0].bill_id)?.currency.trim()))
  const paymentCurrency = bills.find((bill) => bill.id === paymentForm.allocations[0]?.bill_id)?.currency.trim() || 'KES'
  const allocationTotal = paymentForm.allocations.reduce((sum, allocation) => sum + Math.round(Number(allocation.amount || 0) * 100), 0)

  const createPayment = async (event) => {
    event.preventDefault()
    setBusy(true)
    setPaymentError('')
    try {
      const firstBill = paymentBills.find((bill) => bill.id === paymentForm.allocations[0]?.bill_id) || bills.find((bill) => bill.id === paymentForm.allocations[0]?.bill_id)
      if (!firstBill) throw new Error('Choose at least one outstanding supplier bill.')
      await api.post('/supplier-bills/payments', {
        supplier_id: paymentForm.supplier_id,
        amount: (allocationTotal / 100).toFixed(2), currency: firstBill.currency.trim(),
        payment_date: paymentForm.payment_date, payment_method: paymentForm.payment_method,
        payment_reference: paymentForm.payment_reference, notes: paymentForm.notes,
        allocations: paymentForm.allocations.map((allocation) => ({ bill_id: allocation.bill_id, amount: allocation.amount }))
      }, { headers: { 'Idempotency-Key': paymentRequestId || requestKey() } })
      setPaymentOpen(false)
      setPaymentRequestId('')
      await load()
    } catch (error) {
      setPaymentError(messageOf(error, error.message || 'Could not record supplier payment.'))
    } finally {
      setBusy(false)
    }
  }

  const prepareVerification = (payment) => {
    setVerificationPayment(payment)
    setVerifyForm({ cash_account_id: cashAccounts[0]?.id || '', accounting_period_id: openPeriods[0]?.id || '' })
    setActionError('')
  }

  const verifyPayment = async (event) => {
    event.preventDefault()
    if (!verificationPayment || !window.confirm('Confirm that bank, cash or payment-provider evidence has been checked. This posts the payment to the ledger.')) return
    setBusy(true)
    setActionError('')
    try {
      await api.post(`/supplier-bills/payments/${verificationPayment.id}/verify`, verifyForm)
      setVerificationPayment(null)
      await load()
    } catch (error) {
      setActionError(messageOf(error, 'Could not verify supplier payment.'))
    } finally {
      setBusy(false)
    }
  }

  const openPaymentReversal = (payment) => {
    setReverseTarget({ type: 'payment', record: payment })
    setReverseForm({ accounting_period_id: openPeriods[0]?.id || '', reversal_date: today(), reason: '' })
    setActionError('')
  }

  const openBillReversal = (bill) => {
    setReverseTarget({ type: 'bill', record: bill })
    setReverseForm({ accounting_period_id: openPeriods[0]?.id || '', reversal_date: today(), reason: '' })
    setActionError('')
  }

  const reverseRecord = async (event) => {
    event.preventDefault()
    if (!reverseTarget) return
    setBusy(true)
    setActionError('')
    try {
      const path = reverseTarget.type === 'payment'
        ? `/supplier-bills/payments/${reverseTarget.record.id}/reverse`
        : `/supplier-bills/${reverseTarget.record.id}/reverse`
      await api.post(path, reverseForm, { headers: { 'Idempotency-Key': requestKey() } })
      setReverseTarget(null)
      setSelectedBill(null)
      await load()
    } catch (error) {
      setActionError(messageOf(error, 'Could not reverse supplier transaction.'))
    } finally {
      setBusy(false)
    }
  }

  const failPayment = async (payment) => {
    const reason = window.prompt('Reason the supplier payment failed:')
    if (!reason?.trim()) return
    setBusy(true)
    setActionError('')
    try {
      await api.post(`/supplier-bills/payments/${payment.id}/fail`, { reason })
      await load()
    } catch (error) {
      setActionError(messageOf(error, 'Could not mark supplier payment failed.'))
    } finally {
      setBusy(false)
    }
  }

  const changeOrder = async (orderId) => {
    setBillForm((current) => ({ ...current, purchase_order_id: orderId, lines: current.lines.map((line) => ({ ...line, purchase_order_item_id: '', receipt_id: '', purchase_order_receipt_item_id: '' })) }))
    await loadOrderDetails(orderId)
  }

  const previewTotals = billForm.lines.reduce((totals, line) => {
    const subtotal = Math.round(Number(line.quantity || 0) * Number(line.unit_price || 0) * 100) / 100
    const tax = Math.round(subtotal * Number(line.tax_rate || 0)) / 100
    totals.subtotal += subtotal
    totals.tax += tax
    return totals
  }, { subtotal: 0, tax: 0 })

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
          <div><p className="text-sm font-semibold uppercase tracking-wide text-blue-600">Supplier accounting</p><h1 className="mt-1 text-2xl font-bold text-gray-900">Supplier bills and payments</h1><p className="mt-1 text-sm text-gray-500">Review supplier invoices, approve liabilities and record evidenced payments.</p></div>
          <button onClick={openCreate} disabled={!activeSuppliers.length} className="rounded-lg bg-blue-600 px-4 py-2.5 font-semibold text-white hover:bg-blue-700 disabled:opacity-50">Create supplier bill</button>
        </div>

        <p className="mb-5 rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-900">Purchase orders and goods receipts are reference links only; they do not create bills or payments. Taxed bills remain unpostable until an input-tax account mapping is approved. Accounting posting is currently limited to the tenant base currency.</p>
        <p className="-mt-3 mb-5 text-xs text-gray-500">A different administrator must approve each bill and verify each payment from external evidence.</p>
        {pageError && <p role="alert" className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{pageError}</p>}

        <section className="mb-7 rounded-xl border bg-white p-4 shadow-sm sm:p-5">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row">
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search bill, supplier invoice or supplier" className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2.5 outline-none focus:border-blue-500" />
            <select value={supplierFilter} onChange={(event) => setSupplierFilter(event.target.value)} className="rounded-lg border border-gray-300 px-3 py-2.5"><option value="">All suppliers</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.business_name}</option>)}</select>
          </div>
          {loading ? <p className="py-8 text-center text-gray-500">Loading supplier bills…</p> : bills.length === 0 ? <p className="py-8 text-center text-gray-500">No supplier bills match this view.</p> : (
            <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm">
              <thead className="border-b text-xs uppercase text-gray-500"><tr><th className="py-3 pr-3">Bill</th><th className="py-3 pr-3">Supplier</th><th className="py-3 pr-3">Dates</th><th className="py-3 pr-3">Total</th><th className="py-3 pr-3">Outstanding</th><th className="py-3 pr-3">Status</th><th className="py-3">Actions</th></tr></thead>
              <tbody className="divide-y">{bills.map((bill) => <tr key={bill.id}>
                <td className="py-3 pr-3"><button onClick={() => openBillDetails(bill)} className="font-semibold text-blue-700 hover:underline">{bill.bill_number}</button><div className="text-xs text-gray-500">Supplier invoice {bill.supplier_invoice_number}</div></td>
                <td className="py-3 pr-3">{bill.supplier_name}</td>
                <td className="py-3 pr-3">{dateLabel(bill.bill_date)}<div className="text-xs text-gray-500">Due {dateLabel(bill.due_date)}</div></td>
                <td className="py-3 pr-3">{money(bill.total, bill.currency.trim())}</td>
                <td className="py-3 pr-3 font-medium">{money(bill.balance_due, bill.currency.trim())}</td>
                <td className="py-3 pr-3"><Status value={bill.status} /></td>
                <td className="py-3"><div className="flex flex-wrap gap-2">
                  {bill.status === 'draft' && <button onClick={() => openEdit(bill)} className="rounded border px-2 py-1 text-xs">Edit</button>}
                  {bill.status === 'draft' && <button onClick={() => runBillAction(bill, 'submit')} disabled={busy} className="rounded border border-blue-200 px-2 py-1 text-xs text-blue-700">Submit</button>}
                  {bill.status === 'submitted' && <button onClick={() => prepareApproval(bill)} className="rounded border border-green-200 px-2 py-1 text-xs text-green-700">Approve</button>}
                  {['draft', 'submitted'].includes(bill.status) && <button onClick={() => cancelBill(bill)} disabled={busy} className="rounded border px-2 py-1 text-xs text-red-700">Cancel</button>}
                  {['approved', 'partially_paid', 'overdue'].includes(bill.status) && Number(bill.balance_due) > 0 && <button onClick={() => startPayment(bill)} className="rounded border border-violet-200 px-2 py-1 text-xs text-violet-700">Record payment</button>}
                  {bill.status === 'approved' && Number(bill.paid_amount) === 0 && <button onClick={() => openBillReversal(bill)} className="rounded border px-2 py-1 text-xs text-red-700">Reverse</button>}
                </div></td>
              </tr>)}</tbody>
            </table></div>
          )}
        </section>

        <section className="rounded-xl border bg-white p-4 shadow-sm sm:p-5">
          <div className="mb-4"><h2 className="text-lg font-bold text-gray-900">Supplier payment history</h2><p className="text-sm text-gray-500">Pending records do not reduce outstanding balances until verified and posted.</p></div>
          {payments.length === 0 ? <p className="py-6 text-center text-gray-500">No supplier payments have been recorded.</p> : <div className="overflow-x-auto"><table className="w-full min-w-[800px] text-left text-sm"><thead className="border-b text-xs uppercase text-gray-500"><tr><th className="py-3 pr-3">Payment</th><th className="py-3 pr-3">Supplier</th><th className="py-3 pr-3">Date / reference</th><th className="py-3 pr-3">Amount</th><th className="py-3 pr-3">Status</th><th className="py-3">Actions</th></tr></thead><tbody className="divide-y">{payments.map((payment) => <tr key={payment.id}><td className="py-3 pr-3 font-semibold">{payment.payment_number}</td><td className="py-3 pr-3">{payment.supplier_name}</td><td className="py-3 pr-3">{dateLabel(payment.payment_date)}<div className="text-xs text-gray-500">{payment.payment_reference}</div></td><td className="py-3 pr-3">{money(payment.amount, payment.currency.trim())}</td><td className="py-3 pr-3"><Status value={payment.status} /></td><td className="py-3"><div className="flex gap-2">{payment.status === 'pending' && <><button onClick={() => prepareVerification(payment)} className="rounded border border-green-200 px-2 py-1 text-xs text-green-700">Verify and post</button><button onClick={() => failPayment(payment)} className="rounded border px-2 py-1 text-xs text-red-700">Mark failed</button></>}{payment.status === 'verified' && <button onClick={() => openPaymentReversal(payment)} className="rounded border px-2 py-1 text-xs text-red-700">Reverse</button>}</div></td></tr>)}</tbody></table></div>}
        </section>
      </main>

      {billOpen && <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"><section role="dialog" aria-modal="true" aria-labelledby="bill-title" className="max-h-[94vh] w-full max-w-5xl overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl sm:p-6">
        <div className="mb-5 flex items-start justify-between"><div><h2 id="bill-title" className="text-xl font-bold">{editingBill ? `Edit ${editingBill.bill_number}` : 'Create supplier bill'}</h2><p className="mt-1 text-sm text-gray-500">Enter the supplier invoice and choose a debit account for each line.</p></div><button onClick={() => setBillOpen(false)} aria-label="Close" className="rounded px-2 py-1 text-gray-500 hover:bg-gray-100">✕</button></div>
        {billError && <p role="alert" className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{billError}</p>}
        {debitAccounts.length === 0 && <p className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">Create an active debit expense or asset account before entering bill lines.</p>}
        <form onSubmit={saveBill} className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="text-sm">Supplier<select required value={billForm.supplier_id} onChange={(event) => setBillForm({ ...billForm, supplier_id: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2"><option value="">Choose supplier</option>{activeSuppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.business_name}</option>)}</select></label>
            <label className="text-sm">Supplier invoice number<input required maxLength="150" value={billForm.supplier_invoice_number} onChange={(event) => setBillForm({ ...billForm, supplier_invoice_number: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
            <label className="text-sm">Currency<input required maxLength="3" value={billForm.currency} onChange={(event) => setBillForm({ ...billForm, currency: event.target.value.toUpperCase() })} className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
            <label className="text-sm">Bill date<input type="date" required value={billForm.bill_date} onChange={(event) => setBillForm({ ...billForm, bill_date: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
            <label className="text-sm">Due date<input type="date" required value={billForm.due_date} onChange={(event) => setBillForm({ ...billForm, due_date: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
            <label className="text-sm">Purchase order (optional)<select value={billForm.purchase_order_id} onChange={(event) => changeOrder(event.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2"><option value="">No PO link</option>{orders.filter((order) => !billForm.supplier_id || order.supplier_id === billForm.supplier_id).map((order) => <option key={order.id} value={order.id}>{order.purchase_order_number} · {order.supplier_name}</option>)}</select></label>
          </div>
          <div className="space-y-3">{billForm.lines.map((line, index) => <div key={index} className="rounded-lg border bg-gray-50 p-3">
            <div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-semibold">Line {index + 1}</h3>{billForm.lines.length > 1 && <button type="button" onClick={() => setBillForm({ ...billForm, lines: billForm.lines.filter((_, lineIndex) => lineIndex !== index) })} className="text-xs text-red-700">Remove</button>}</div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <label className="text-sm lg:col-span-2">Description<input required maxLength="1000" value={line.description} onChange={(event) => updateLine(index, 'description', event.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
              <label className="text-sm">Quantity<input required type="number" min="0.001" step="0.001" value={line.quantity} onChange={(event) => updateLine(index, 'quantity', event.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
              <label className="text-sm">Unit price<input required type="number" min="0" step="0.01" value={line.unit_price} onChange={(event) => updateLine(index, 'unit_price', event.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
              <label className="text-sm">Tax rate %<input required type="number" min="0" max="100" step="0.01" value={line.tax_rate} onChange={(event) => updateLine(index, 'tax_rate', event.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
              <label className="text-sm sm:col-span-2">Debit account<select required value={line.account_id} onChange={(event) => updateLine(index, 'account_id', event.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2"><option value="">Choose expense or asset account</option>{debitAccounts.map((account) => <option key={account.id} value={account.id}>{account.account_code} · {account.name} ({account.account_type})</option>)}</select></label>
              {billForm.purchase_order_id && <label className="text-sm sm:col-span-2">PO line (optional)<select value={line.purchase_order_item_id} onChange={(event) => updateLine(index, 'purchase_order_item_id', event.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2"><option value="">No PO line link</option>{orderDetails?.items?.map((item) => <option key={item.id} value={item.id}>{item.product_name} · ordered {item.quantity_ordered}</option>)}</select></label>}
              {line.purchase_order_item_id && <label className="text-sm sm:col-span-2">Received goods line (optional)<select value={line.purchase_order_receipt_item_id} onChange={(event) => {
                const item = orderDetails?.receipts?.flatMap((receipt) => receipt.items.map((receiptItem) => ({ ...receiptItem, receipt_id: receipt.id }))).find((receiptItem) => receiptItem.id === event.target.value)
                setBillForm((current) => ({ ...current, lines: current.lines.map((currentLine, lineIndex) => lineIndex === index ? { ...currentLine, receipt_id: item?.receipt_id || '', purchase_order_receipt_item_id: item?.id || '' } : currentLine) }))
              }} className="mt-1 w-full rounded-lg border px-3 py-2"><option value="">No goods receipt link</option>{orderDetails?.receipts?.flatMap((receipt) => receipt.items.filter((item) => item.purchase_order_item_id === line.purchase_order_item_id).map((item) => <option key={item.id} value={item.id}>{dateLabel(receipt.received_at)} · qty {item.received_quantity}</option>))}</select></label>}
            </div>
          </div>)}<button type="button" onClick={() => setBillForm({ ...billForm, lines: [...billForm.lines, emptyLine()] })} className="rounded-lg border px-3 py-2 text-sm font-medium text-blue-700">Add bill line</button></div>
          <div className="flex flex-wrap justify-end gap-5 rounded-lg bg-gray-50 p-3 text-sm"><span>Subtotal <strong>{money(previewTotals.subtotal, billForm.currency)}</strong></span><span>Tax <strong>{money(previewTotals.tax, billForm.currency)}</strong></span><span>Total <strong>{money(previewTotals.subtotal + previewTotals.tax, billForm.currency)}</strong></span></div>
          <label className="block text-sm">Notes<textarea maxLength="2000" value={billForm.notes} onChange={(event) => setBillForm({ ...billForm, notes: event.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2" rows="2" /></label>
          <p className="text-xs text-gray-500">Tax is calculated per line and included in the bill total. Posting tax requires an approved input-tax account mapping. Foreign currency is stored on drafts but posting requires the tenant base currency.</p>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setBillOpen(false)} className="rounded-lg border px-4 py-2">Close</button><button disabled={busy || !debitAccounts.length} className="rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white disabled:opacity-60">{busy ? 'Saving…' : editingBill ? 'Save draft' : 'Create draft'}</button></div>
        </form>
      </section></div>}

      {approvalBill && <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"><section role="dialog" aria-modal="true" aria-labelledby="approve-title" className="w-full max-w-xl rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl"><h2 id="approve-title" className="text-xl font-bold">Approve and post {approvalBill.bill_number}</h2><p className="my-3 text-sm text-gray-600">Approval posts debits to the bill line accounts and a credit to accounts payable. A different administrator must approve the bill.</p>{actionError && <p role="alert" className="mb-3 rounded bg-red-50 p-3 text-sm text-red-700">{actionError}</p>}<form onSubmit={(event) => { event.preventDefault(); runBillAction(approvalBill, 'approve', approvalForm) }} className="space-y-3"><label className="block text-sm">Accounts payable account<select required value={approvalForm.payable_account_id} onChange={(event) => setApprovalForm({ ...approvalForm, payable_account_id: event.target.value })} className="mt-1 w-full rounded border p-2"><option value="">Choose liability credit account</option>{payableAccounts.map((account) => <option key={account.id} value={account.id}>{account.account_code} · {account.name}</option>)}</select></label><label className="block text-sm">Open accounting period<select required value={approvalForm.accounting_period_id} onChange={(event) => setApprovalForm({ ...approvalForm, accounting_period_id: event.target.value })} className="mt-1 w-full rounded border p-2"><option value="">Choose period</option>{openPeriods.map((period) => <option key={period.id} value={period.id}>{period.name} ({period.starts_on} – {period.ends_on})</option>)}</select></label><label className="block text-sm">Accounting date<input required type="date" value={approvalForm.entry_date} onChange={(event) => setApprovalForm({ ...approvalForm, entry_date: event.target.value })} className="mt-1 w-full rounded border p-2" /></label><div className="flex justify-end gap-2 pt-2"><button type="button" onClick={() => setApprovalBill(null)} className="rounded border px-3 py-2">Cancel</button><button disabled={busy || !payableAccounts.length || !openPeriods.length} className="rounded bg-green-700 px-4 py-2 font-semibold text-white disabled:opacity-60">Approve and post</button></div></form></section></div>}

      {paymentOpen && <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"><section role="dialog" aria-modal="true" aria-labelledby="payment-title" className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl"><h2 id="payment-title" className="text-xl font-bold">Record supplier payment</h2><p className="my-2 text-sm text-gray-600">The payment will remain pending and will not change bill balances until evidence is verified and a journal is posted.</p>{paymentError && <p role="alert" className="mb-3 rounded bg-red-50 p-3 text-sm text-red-700">{paymentError}</p>}<form onSubmit={createPayment} className="space-y-3"><label className="block text-sm">Supplier<select required value={paymentForm.supplier_id} onChange={(event) => setPaymentForm({ ...paymentForm, supplier_id: event.target.value, allocations: [] })} className="mt-1 w-full rounded border p-2"><option value="">Choose supplier</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.business_name}</option>)}</select></label><label className="block text-sm">Payment date<input required type="date" value={paymentForm.payment_date} onChange={(event) => setPaymentForm({ ...paymentForm, payment_date: event.target.value })} className="mt-1 w-full rounded border p-2" /></label><div className="space-y-2"><h3 className="text-sm font-semibold">Bill allocations</h3>{paymentForm.allocations.map((allocation, index) => <div key={index} className="grid gap-2 sm:grid-cols-[1fr_150px_auto]"><select required value={allocation.bill_id} onChange={(event) => setPaymentForm({ ...paymentForm, allocations: paymentForm.allocations.map((item, row) => row === index ? { ...item, bill_id: event.target.value } : item) })} className="rounded border p-2"><option value="">Choose outstanding bill</option>{paymentBills.map((bill) => <option key={bill.id} value={bill.id}>{bill.bill_number} · due {money(bill.balance_due, bill.currency.trim())}</option>)}</select><input required aria-label="Allocation amount" type="number" min="0.01" step="0.01" value={allocation.amount} onChange={(event) => setPaymentForm({ ...paymentForm, allocations: paymentForm.allocations.map((item, row) => row === index ? { ...item, amount: event.target.value } : item) })} className="rounded border p-2" />{paymentForm.allocations.length > 1 && <button type="button" onClick={() => setPaymentForm({ ...paymentForm, allocations: paymentForm.allocations.filter((_, row) => row !== index) })} className="text-xs text-red-700">Remove</button>}</div>)}<button type="button" onClick={() => setPaymentForm({ ...paymentForm, allocations: [...paymentForm.allocations, { bill_id: '', amount: '' }] })} className="text-sm font-medium text-blue-700">Allocate to another bill</button></div><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Method<select value={paymentForm.payment_method} onChange={(event) => setPaymentForm({ ...paymentForm, payment_method: event.target.value })} className="mt-1 w-full rounded border p-2">{['bank_transfer', 'cash', 'card', 'cheque', 'mpesa', 'other'].map((method) => <option key={method} value={method}>{method.replaceAll('_', ' ')}</option>)}</select></label><label className="text-sm">Reference<input required maxLength="255" value={paymentForm.payment_reference} onChange={(event) => setPaymentForm({ ...paymentForm, payment_reference: event.target.value })} className="mt-1 w-full rounded border p-2" /></label></div><label className="block text-sm">Notes<textarea maxLength="2000" value={paymentForm.notes} onChange={(event) => setPaymentForm({ ...paymentForm, notes: event.target.value })} className="mt-1 w-full rounded border p-2" rows="2" /></label><p className="text-sm font-semibold">Payment amount: {money(allocationTotal / 100, 'KES')}</p><div className="flex justify-end gap-2"><button type="button" onClick={() => setPaymentOpen(false)} className="rounded border px-3 py-2">Cancel</button><button disabled={busy || !paymentForm.allocations.length} className="rounded bg-blue-600 px-4 py-2 font-semibold text-white disabled:opacity-60">{busy ? 'Recording…' : 'Record pending payment'}</button></div></form></section></div>}

      {verificationPayment && <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"><section role="dialog" aria-modal="true" aria-labelledby="verify-title" className="w-full max-w-xl rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl"><h2 id="verify-title" className="text-xl font-bold">Verify {verificationPayment.payment_number}</h2><p className="my-3 text-sm text-gray-600">Check the external payment evidence and choose the cash or bank account and posting period.</p>{actionError && <p role="alert" className="mb-3 rounded bg-red-50 p-3 text-sm text-red-700">{actionError}</p>}<form onSubmit={verifyPayment} className="space-y-3"><label className="block text-sm">Cash/bank account<select required value={verifyForm.cash_account_id} onChange={(event) => setVerifyForm({ ...verifyForm, cash_account_id: event.target.value })} className="mt-1 w-full rounded border p-2"><option value="">Choose asset account</option>{cashAccounts.map((account) => <option key={account.id} value={account.id}>{account.account_code} · {account.name}</option>)}</select></label><label className="block text-sm">Accounting period<select required value={verifyForm.accounting_period_id} onChange={(event) => setVerifyForm({ ...verifyForm, accounting_period_id: event.target.value })} className="mt-1 w-full rounded border p-2"><option value="">Choose period</option>{openPeriods.map((period) => <option key={period.id} value={period.id}>{period.name} ({period.starts_on} – {period.ends_on})</option>)}</select></label><div className="flex justify-end gap-2"><button type="button" onClick={() => setVerificationPayment(null)} className="rounded border px-3 py-2">Cancel</button><button disabled={busy || !cashAccounts.length || !openPeriods.length} className="rounded bg-green-700 px-4 py-2 font-semibold text-white disabled:opacity-60">Confirm evidence and post</button></div></form></section></div>}

      {reverseTarget && <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"><section role="dialog" aria-modal="true" aria-labelledby="reverse-title" className="w-full max-w-xl rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl"><h2 id="reverse-title" className="text-xl font-bold">Reverse {reverseTarget.type} {reverseTarget.record.bill_number || reverseTarget.record.payment_number}</h2><p className="my-2 text-sm text-gray-600">The original financial record remains in the audit history.</p>{actionError && <p role="alert" className="mb-3 rounded bg-red-50 p-3 text-sm text-red-700">{actionError}</p>}<form onSubmit={reverseRecord} className="space-y-3"><label className="block text-sm">Open accounting period<select required value={reverseForm.accounting_period_id} onChange={(event) => setReverseForm({ ...reverseForm, accounting_period_id: event.target.value })} className="mt-1 w-full rounded border p-2"><option value="">Choose period</option>{openPeriods.map((period) => <option key={period.id} value={period.id}>{period.name}</option>)}</select></label><label className="block text-sm">Reversal date<input required type="date" value={reverseForm.reversal_date} onChange={(event) => setReverseForm({ ...reverseForm, reversal_date: event.target.value })} className="mt-1 w-full rounded border p-2" /></label><label className="block text-sm">Reason<textarea required maxLength="1800" value={reverseForm.reason} onChange={(event) => setReverseForm({ ...reverseForm, reason: event.target.value })} className="mt-1 w-full rounded border p-2" /></label><div className="flex justify-end gap-2"><button type="button" onClick={() => setReverseTarget(null)} className="rounded border px-3 py-2">Cancel</button><button disabled={busy} className="rounded bg-red-700 px-4 py-2 font-semibold text-white">Create reversal</button></div></form></section></div>}

      {selectedBill && <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"><section role="dialog" aria-modal="true" aria-labelledby="history-title" className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl"><div className="mb-4 flex justify-between"><div><p className="text-sm text-blue-600">Supplier account history</p><h2 id="history-title" className="text-xl font-bold">{selectedBill.bill_number} · {selectedBill.supplier_name}</h2><p className="text-sm text-gray-500">{selectedBill.supplier_invoice_number} · outstanding {money(selectedBill.balance_due, selectedBill.currency.trim())}</p></div><button onClick={() => setSelectedBill(null)} aria-label="Close" className="rounded px-2 py-1 text-gray-500">✕</button></div>{actionError && <p role="alert" className="mb-3 rounded bg-red-50 p-3 text-sm text-red-700">{actionError}</p>}<h3 className="mb-2 font-semibold">Bill lines</h3><div className="overflow-x-auto"><table className="mb-5 w-full text-left text-sm"><thead className="border-b text-gray-500"><tr><th className="py-2">Description</th><th className="py-2">Quantity × price</th><th className="py-2">Account</th><th className="py-2">Total</th></tr></thead><tbody>{selectedBill.lines.map((line) => <tr key={line.id} className="border-b"><td className="py-2">{line.description}{line.product_name && <div className="text-xs text-gray-500">PO item {line.product_name}</div>}</td><td className="py-2">{line.quantity} × {line.unit_price}</td><td className="py-2">{line.account_code} · {line.account_name}</td><td className="py-2">{money(line.line_total, selectedBill.currency.trim())}</td></tr>)}</tbody></table></div><h3 className="mb-2 font-semibold">Payment allocations</h3>{selectedBill.payments.length === 0 ? <p className="mb-4 text-sm text-gray-500">No supplier payments recorded for this bill.</p> : <ul className="mb-5 divide-y rounded border">{selectedBill.payments.map((payment) => <li key={payment.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm"><span>{payment.payment_number} · {dateLabel(payment.payment_date)} · {payment.payment_reference}</span><span>{money(payment.allocated_amount, payment.currency.trim())} <Status value={payment.status} /></span></li>)}</ul>}<h3 className="mb-2 font-semibold">Audit history</h3>{selectedBill.events.length === 0 ? <p className="text-sm text-gray-500">No history entries.</p> : <ul className="divide-y rounded border">{selectedBill.events.map((item) => <li key={item.id} className="flex flex-wrap justify-between gap-2 p-3 text-sm"><span className="font-medium">{item.event_type}</span><span className="text-gray-500">{dateLabel(item.created_at)}</span></li>)}</ul>}</section></div>}
    </div>
  )
}

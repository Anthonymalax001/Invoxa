
require('dotenv').config()

const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const morgan = require('morgan')
const ACCESS_LOG_FORMAT = require('./utils/accessLogging')

const authRoutes = require('./routes/auth')
const clientRoutes = require('./routes/clients')
const invoiceRoutes = require('./routes/invoices')
const productRoutes = require('./routes/products')
const supplierRoutes = require('./routes/suppliers')
const purchaseOrderRoutes = require('./routes/purchaseOrders')
const salesOrderRoutes = require('./routes/salesOrders')
const paymentRoutes = require('./routes/payments')
const expenseRoutes = require('./routes/expenses')
const accountingRoutes = require('./routes/accounting')
const supplierBillRoutes = require('./routes/supplierBills')
const bankReconciliationRoutes = require('./routes/bankReconciliation')
const employeeRoutes = require('./routes/employees')
const attendanceRoutes = require('./routes/attendance')
const leaveRoutes = require('./routes/leave')
const payrollRoutes = require('./routes/payroll')
const { logSafeError } = require('./utils/errorLogging')

const app = express()

app.use(helmet())

const allowedOrigins = [
  'http://localhost:5173',
  'https://invoxa1.vercel.app',
  'https://invoxa-neon.vercel.app'
]

function isAllowedVercelPreviewOrigin(origin) {
  try {
    const url = new URL(origin)
    return url.protocol === 'https:' &&
      /^invoxa-[a-z0-9]+-anthonymalax001s-projects\.vercel\.app$/.test(url.hostname)
  } catch {
    return false
  }
}

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin) || isAllowedVercelPreviewOrigin(origin)) {
      callback(null, true)
    } else {
      const error = new Error('Not allowed by CORS')
      error.code = 'CORS_ORIGIN_DENIED'
      callback(error)
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key']
}))

app.use(morgan(ACCESS_LOG_FORMAT))
// Bank statement CSV is sent as JSON text with a route-specific limit.
app.use('/api/accounting/bank-reconciliation', express.json({ limit: '2mb' }))
app.use(express.json())

app.use('/api/auth', authRoutes)
app.use('/api/clients', clientRoutes)
app.use('/api/invoices', invoiceRoutes)
app.use('/api/products', productRoutes)
app.use('/api/suppliers', supplierRoutes)
app.use('/api/purchase-orders', purchaseOrderRoutes)
app.use('/api/sales-orders', salesOrderRoutes)
app.use('/api/payments', paymentRoutes)
app.use('/api/expenses', expenseRoutes)
app.use('/api/accounting', accountingRoutes)
app.use('/api/accounting/bank-reconciliation', bankReconciliationRoutes)
app.use('/api/supplier-bills', supplierBillRoutes)
app.use('/api/employees', employeeRoutes)
app.use('/api/attendance', attendanceRoutes)
app.use('/api/leave', leaveRoutes)
app.use('/api/payroll', payrollRoutes)

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' })
})

app.get('/', (req, res) => {
  res.send('Invoxa API is running 🚀')
})

app.use((err, req, res, next) => {
  const isMalformedJson = err.type === 'entity.parse.failed' && err.status === 400
  const isOversizedBody = err.type === 'entity.too.large'
  const status = isMalformedJson ? 400 : isOversizedBody ? 413 : 500
  const errorStatus = err.statusCode || err.status
  const isRoutineRequestFailure = isMalformedJson || err.code === 'CORS_ORIGIN_DENIED' ||
    (Number.isInteger(errorStatus) && errorStatus >= 400 && errorStatus < 500)
  logSafeError('HTTP request failed', err, {
    includeFrames: !isRoutineRequestFailure,
    method: req.method,
    route: req.route?.path,
    status
  })
  res.status(status).json({
    error: isMalformedJson ? 'Request body contains invalid JSON' :
      isOversizedBody ? 'Request body is too large' : 'Something went wrong'
  })
})

const PORT = process.env.PORT || 5000

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`)
  })
}

module.exports = app

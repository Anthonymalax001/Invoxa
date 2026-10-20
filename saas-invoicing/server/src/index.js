
require('dotenv').config()

const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const morgan = require('morgan')

const authRoutes = require('./routes/auth')
const clientRoutes = require('./routes/clients')
const invoiceRoutes = require('./routes/invoices')
const productRoutes = require('./routes/products')
const supplierRoutes = require('./routes/suppliers')
const purchaseOrderRoutes = require('./routes/purchaseOrders')
const salesOrderRoutes = require('./routes/salesOrders')
const paymentRoutes = require('./routes/payments')
const expenseRoutes = require('./routes/expenses')

const app = express()

app.use(helmet())

const allowedOrigins = [
  'http://localhost:5173',
  'https://invoxa1.vercel.app',
  'https://invoxa-neon.vercel.app'
]

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true)
    } else {
      callback(new Error('Not allowed by CORS'))
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key']
}))

app.use(morgan('dev'))
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

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' })
})

app.get('/', (req, res) => {
  res.send('Invoxa API is running 🚀')
})

app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(500).json({ error: 'Something went wrong' })
})

const PORT = process.env.PORT || 5000

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})

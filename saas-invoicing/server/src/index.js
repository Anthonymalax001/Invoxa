require('dotenv').config()

const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const morgan = require('morgan')

const authRoutes = require('./routes/auth')
const clientRoutes = require('./routes/clients')
const invoiceRoutes = require('./routes/invoices')
const paymentRoutes = require('./routes/payments')

const app = express()

app.use(helmet())

// CORS - allow local development and deployed Vercel frontend
app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://invoxa-neon.vercel.app'
  ],
  credentials: true
}))

app.use(morgan('dev'))
app.use(express.json())

// Routes
app.use('/api/auth', authRoutes)
app.use('/api/clients', clientRoutes)
app.use('/api/invoices', invoiceRoutes)
app.use('/api/payments', paymentRoutes)

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Server is running'
  })
})

// Root route
app.get('/', (req, res) => {
  res.send('Invoxa API is running 🚀')
})

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(500).json({
    error: 'Something went wrong'
  })
})

const PORT = process.env.PORT || 5000

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
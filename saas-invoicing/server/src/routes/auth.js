require('dotenv').config()
const express = require('express')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const pool = require('../config/db')

const router = express.Router()

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { businessName, email, password, phone } = req.body

  if (!businessName || !email || !password) {
    return res.status(400).json({ error: 'All fields are required' })
  }

  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const exists = await client.query(
      'SELECT id FROM users WHERE email = $1', [email]
    )
    if (exists.rows.length > 0) {
      return res.status(400).json({ error: 'Email already registered' })
    }

    const tenantResult = await client.query(
      `INSERT INTO tenants (name, email, phone) VALUES ($1, $2, $3) RETURNING id`,
      [businessName, email, phone || null]
    )
    const tenantId = tenantResult.rows[0].id

    const passwordHash = await bcrypt.hash(password, 12)
    const userResult = await client.query(
      `INSERT INTO users (tenant_id, name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, 'admin') RETURNING id, name, email, role`,
      [tenantId, businessName, email, passwordHash]
    )
    const user = userResult.rows[0]

    await client.query('COMMIT')

    const token = jwt.sign(
      { userId: user.id, tenantId, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    )

    res.status(201).json({
      message: 'Account created successfully',
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      tenant: { id: tenantId, name: businessName }
    })

  } catch (err) {
    await client.query('ROLLBACK')
    console.error(err)
    res.status(500).json({ error: 'Registration failed' })
  } finally {
    client.release()
  }
})

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' })
  }

  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.email, u.password_hash, u.role, u.tenant_id,
              t.name AS business_name
       FROM users u JOIN tenants t ON u.tenant_id = t.id
       WHERE u.email = $1`,
      [email]
    )

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    const user = result.rows[0]
    const valid = await bcrypt.compare(password, user.password_hash)

    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    const token = jwt.sign(
      { userId: user.id, tenantId: user.tenant_id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    )

    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      tenant: { id: user.tenant_id, name: user.business_name }
    })

  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Login failed' })
  }
})

module.exports = router
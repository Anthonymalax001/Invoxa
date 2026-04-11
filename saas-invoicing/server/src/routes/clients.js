const express = require('express')
const pool = require('../config/db')
const auth = require('../middleware/auth')

const router = express.Router()

router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM clients WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [req.user.tenantId]
    )
    res.json(result.rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch clients' })
  }
})

router.get('/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM clients WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.user.tenantId]
    )
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found' })
    }
    res.json(result.rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch client' })
  }
})

router.post('/', auth, async (req, res) => {
  const { name, email, phone, address } = req.body
  if (!name) {
    return res.status(400).json({ error: 'Client name is required' })
  }
  try {
    const result = await pool.query(
      `INSERT INTO clients (tenant_id, name, email, phone, address)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.user.tenantId, name, email || null, phone || null, address || null]
    )
    res.status(201).json(result.rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to create client' })
  }
})

router.put('/:id', auth, async (req, res) => {
  const { name, email, phone, address } = req.body
  try {
    const result = await pool.query(
      `UPDATE clients SET name=$1, email=$2, phone=$3, address=$4
       WHERE id=$5 AND tenant_id=$6 RETURNING *`,
      [name, email || null, phone || null, address || null, req.params.id, req.user.tenantId]
    )
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found' })
    }
    res.json(result.rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to update client' })
  }
})

router.delete('/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM clients WHERE id=$1 AND tenant_id=$2 RETURNING id`,
      [req.params.id, req.user.tenantId]
    )
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found' })
    }
    res.json({ message: 'Client deleted successfully' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to delete client' })
  }
})

module.exports = router
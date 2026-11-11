const { validate: isUuid } = require('uuid')
const pool = require('../config/db')
const { logSafeError } = require('../utils/errorLogging')

const PERMISSION_ROLES = Object.freeze({
  'accounting:read': null,
  'accounting:manage-settings': ['admin'],
  'accounting:manage-accounts': ['admin'],
  'accounting:manage-periods': ['admin'],
  'accounting:close-periods': ['admin'],
  'accounting:reverse-journals': ['admin'],
  'accounting:manage-invoice-tax': ['admin'],
  'accounting:issue-invoices': ['admin'],
  'accounting:manage-receipts': ['admin'],
  'accounting:manage-payables': ['admin'],
  'accounting:manage-bank-reconciliation': ['admin'],
  'accounting:manage-opening-balances': ['admin'],
  'hr:read': ['admin'],
  'hr:manage-employees': ['admin']
})

function requireAccountingPermission(permission) {
  return async (req, res, next) => {
    const user = req.user
    if (!user || !isUuid(user.userId) || !isUuid(user.tenantId) ||
        typeof user.role !== 'string' || user.role.length === 0 || user.role.trim() !== user.role) {
      return res.status(401).json({ error: 'Authenticated user and tenant identities are required' })
    }

    if (!Object.hasOwn(PERMISSION_ROLES, permission)) {
      return res.status(403).json({ error: 'Accounting permission denied' })
    }

    let identity
    try {
      identity = await pool.query(
        'SELECT role FROM users WHERE id = $1 AND tenant_id = $2',
        [user.userId, user.tenantId]
      )
    } catch (error) {
      logSafeError('Accounting authorization lookup failed', error)
      return res.status(500).json({ error: 'Failed to verify accounting access' })
    }
    if (identity.rowCount !== 1 || identity.rows[0].role !== user.role) {
      return res.status(401).json({ error: 'Invalid or expired accounting identity' })
    }

    const allowedRoles = PERMISSION_ROLES[permission]
    if (allowedRoles && !allowedRoles.includes(user.role)) {
      return res.status(403).json({ error: 'Accounting administrator access required' })
    }

    return next()
  }
}

module.exports = { requireAccountingPermission }

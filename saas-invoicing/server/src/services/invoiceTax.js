const { validate: isUuid } = require('uuid')
const {
  httpError,
  validationError
} = require('../utils/accounting')
const { normalizeTaxProfileRow } = require('../utils/invoiceTax')

async function loadTaxProfile(client, tenantId, profileId, effectiveDate, { requireActive = true } = {}) {
  if (!isUuid(profileId)) throw validationError('A valid tax profile is required')
  const result = await client.query(
    `SELECT id, tenant_id, profile_key, name, version, tax_rate,
            calculation_method, rounding_method, effective_from::text,
            effective_to::text, requires_tax_payable, tax_payable_account_id,
            is_active, created_by, created_at
     FROM accounting_tax_profiles
     WHERE tenant_id = $1 AND id = $2
     FOR SHARE`,
    [tenantId, profileId]
  )
  if (result.rowCount !== 1) throw httpError(404, 'Tax profile not found')
  const profile = normalizeTaxProfileRow(result.rows[0])
  if (requireActive && !profile.is_active) throw httpError(409, 'Tax profile is inactive')
  if (effectiveDate && (effectiveDate < String(profile.effective_from).slice(0, 10) ||
      (profile.effective_to && effectiveDate > String(profile.effective_to).slice(0, 10)))) {
    throw httpError(409, 'Tax profile is not effective on the selected date')
  }
  if (profile.requires_tax_payable) {
    const account = await client.query(
      `SELECT account_type, is_active FROM accounting_accounts
       WHERE tenant_id = $1 AND id = $2 FOR SHARE`,
      [tenantId, profile.tax_payable_account_id]
    )
    if (account.rowCount !== 1 || account.rows[0].account_type !== 'liability' || !account.rows[0].is_active) {
      throw httpError(409, 'Tax profile requires an active liability tax payable account')
    }
  }
  return profile
}

async function loadTaxProfileBySnapshot(client, tenantId, snapshot) {
  const result = await client.query(
    `SELECT id, tenant_id, profile_key, name, version, tax_rate,
            calculation_method, rounding_method, effective_from::text,
            effective_to::text, requires_tax_payable, tax_payable_account_id,
            is_active, created_by, created_at
     FROM accounting_tax_profiles
     WHERE tenant_id = $1 AND id = $2 AND version = $3
     FOR SHARE`,
    [tenantId, snapshot.tax_profile_id, snapshot.profile_version]
  )
  if (result.rowCount !== 1) throw httpError(409, 'Invoice tax profile snapshot is unavailable')
  const profile = normalizeTaxProfileRow(result.rows[0])
  const keys = ['profile_key', 'profile_name', 'tax_rate', 'calculation_method', 'rounding_method',
    'requires_tax_payable', 'tax_payable_account_id']
  if (keys.some((key) => String(profile[key === 'profile_name' ? 'name' : key] ?? '') !== String(snapshot[key] ?? ''))) {
    throw httpError(409, 'Invoice tax profile no longer matches its saved snapshot')
  }
  if (!snapshot.issued_at && !profile.is_active) {
    throw httpError(409, 'Saved tax profile is inactive; select an active profile before issuance')
  }
  if (snapshot.issued_on) {
    const issueDate = String(snapshot.issued_on).slice(0, 10)
    if (issueDate < String(profile.effective_from).slice(0, 10) ||
        (profile.effective_to && issueDate > String(profile.effective_to).slice(0, 10))) {
      throw httpError(409, 'Saved tax profile is not effective on the invoice issue date')
    }
  }
  return profile
}

async function saveTaxSnapshot(client, { tenantId, sourceType, sourceId, profile, totals, userId }) {
  const result = await client.query(
    `INSERT INTO accounting_invoice_tax_snapshots
       (tenant_id, source_type, source_id, tax_profile_id, profile_version,
        profile_key, profile_name, tax_rate, calculation_method, rounding_method,
        requires_tax_payable, tax_payable_account_id, subtotal, tax_amount, total, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (tenant_id, source_type, source_id) DO UPDATE
       SET tax_profile_id = EXCLUDED.tax_profile_id,
           profile_version = EXCLUDED.profile_version,
           profile_key = EXCLUDED.profile_key,
           profile_name = EXCLUDED.profile_name,
           tax_rate = EXCLUDED.tax_rate,
           calculation_method = EXCLUDED.calculation_method,
           rounding_method = EXCLUDED.rounding_method,
           requires_tax_payable = EXCLUDED.requires_tax_payable,
           tax_payable_account_id = EXCLUDED.tax_payable_account_id,
           subtotal = EXCLUDED.subtotal,
           tax_amount = EXCLUDED.tax_amount,
           total = EXCLUDED.total,
           created_by = EXCLUDED.created_by
       WHERE accounting_invoice_tax_snapshots.issued_at IS NULL
     RETURNING id`,
    [tenantId, sourceType, sourceId, profile.id, profile.version, profile.profile_key,
      profile.name, profile.tax_rate, profile.calculation_method, profile.rounding_method,
      profile.requires_tax_payable, profile.tax_payable_account_id,
      totals.subtotal, totals.tax_amount, totals.total, userId]
  )
  if (result.rowCount !== 1) throw httpError(409, 'Issued invoice tax snapshots cannot be changed')
  return result.rows[0].id
}

async function copySalesOrderTaxSnapshot(client, tenantId, orderId, invoiceId, userId) {
  const source = await client.query(
    `SELECT tax_profile_id, profile_version, profile_key, profile_name, tax_rate,
            calculation_method, rounding_method, requires_tax_payable,
            tax_payable_account_id, subtotal, tax_amount, total
     FROM accounting_invoice_tax_snapshots
     WHERE tenant_id = $1 AND source_type = 'sales_order' AND source_id = $2
     FOR SHARE`,
    [tenantId, orderId]
  )
  if (source.rowCount !== 1) throw httpError(409, 'Sales order has no validated tax snapshot')
  const snapshot = source.rows[0]
  const profile = {
    ...snapshot,
    id: snapshot.tax_profile_id,
    name: snapshot.profile_name,
    version: snapshot.profile_version
  }
  return saveTaxSnapshot(client, {
    tenantId, sourceType: 'invoice', sourceId: invoiceId, profile,
    totals: { subtotal: snapshot.subtotal, tax_amount: snapshot.tax_amount, total: snapshot.total }, userId
  })
}

module.exports = {
  copySalesOrderTaxSnapshot,
  loadTaxProfile,
  loadTaxProfileBySnapshot,
  saveTaxSnapshot
}

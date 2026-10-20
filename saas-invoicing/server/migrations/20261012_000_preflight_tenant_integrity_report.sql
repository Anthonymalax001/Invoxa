-- Invoxa Phase 1, Step 1: read-only tenant integrity preflight report.
--
-- Purpose:
--   Inspect existing production data before adding migrations, constraints, or
--   tenant-security code changes. This file intentionally performs no writes.
--
-- Safety:
--   - Runs inside a READ ONLY transaction.
--   - Uses SELECT statements plus transaction/session settings.
--   - Uses one catalog-only DO guard to stop before anomaly checks if the
--     expected schema is missing.
--   - Ends with ROLLBACK.
--   - Does not create, update, delete, lock tables for write, or add constraints.
--
-- Expected tables and columns are based on current backend query usage:
--   tenants(id, name, email, phone)
--   users(id, tenant_id, name, email, password_hash, role)
--   clients(id, tenant_id, name, email, phone, address, created_at)
--   invoices(id, tenant_id, client_id, invoice_number, due_date, subtotal,
--            tax_rate, tax_amount, total, notes, status, created_at)
--   invoice_items(invoice_id, description, quantity, unit_price, amount)
--   payments(id, tenant_id, invoice_id, amount, phone_number,
--            mpesa_checkout_id, mpesa_receipt, status, created_at)

BEGIN READ ONLY;

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';
SET LOCAL idle_in_transaction_session_timeout = '5min';
-- Do not silently audit a policy-filtered subset of rows. If an applicable RLS
-- policy would filter a report query, PostgreSQL raises an error instead.
SET LOCAL row_security = off;

-- 1. Confirm expected tables are visible to unqualified application queries.
WITH expected_tables(table_name) AS (
  VALUES
    ('tenants'),
    ('users'),
    ('clients'),
    ('invoices'),
    ('invoice_items'),
    ('payments')
)
SELECT
  'expected_tables' AS report_section,
  e.table_name,
  CASE WHEN c.oid IS NULL THEN 'missing' ELSE 'present' END AS status,
  n.nspname AS resolved_schema,
  c.relname AS resolved_relation,
  c.relkind AS relation_kind
FROM expected_tables e
LEFT JOIN pg_catalog.pg_class c
  ON c.oid = to_regclass(e.table_name)
LEFT JOIN pg_catalog.pg_namespace n
  ON n.oid = c.relnamespace
ORDER BY e.table_name;

-- 2. Confirm expected columns and runtime data types from pg_catalog.
WITH expected_columns(table_name, column_name) AS (
  VALUES
    ('tenants', 'id'),
    ('tenants', 'name'),
    ('tenants', 'email'),
    ('tenants', 'phone'),
    ('users', 'id'),
    ('users', 'tenant_id'),
    ('users', 'name'),
    ('users', 'email'),
    ('users', 'password_hash'),
    ('users', 'role'),
    ('clients', 'id'),
    ('clients', 'tenant_id'),
    ('clients', 'name'),
    ('clients', 'email'),
    ('clients', 'phone'),
    ('clients', 'address'),
    ('clients', 'created_at'),
    ('invoices', 'id'),
    ('invoices', 'tenant_id'),
    ('invoices', 'client_id'),
    ('invoices', 'invoice_number'),
    ('invoices', 'due_date'),
    ('invoices', 'subtotal'),
    ('invoices', 'tax_rate'),
    ('invoices', 'tax_amount'),
    ('invoices', 'total'),
    ('invoices', 'notes'),
    ('invoices', 'status'),
    ('invoices', 'created_at'),
    ('invoice_items', 'invoice_id'),
    ('invoice_items', 'description'),
    ('invoice_items', 'quantity'),
    ('invoice_items', 'unit_price'),
    ('invoice_items', 'amount'),
    ('payments', 'id'),
    ('payments', 'tenant_id'),
    ('payments', 'invoice_id'),
    ('payments', 'amount'),
    ('payments', 'phone_number'),
    ('payments', 'mpesa_checkout_id'),
    ('payments', 'mpesa_receipt'),
    ('payments', 'status'),
    ('payments', 'created_at')
)
SELECT
  'expected_columns_and_types' AS report_section,
  e.table_name,
  e.column_name,
  CASE
    WHEN cls.oid IS NULL THEN 'table_missing'
    WHEN a.attname IS NULL THEN 'column_missing'
    ELSE 'present'
  END AS status,
  n.nspname AS resolved_schema,
  cls.relname AS resolved_relation,
  pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
  CASE
    WHEN a.attname IS NULL THEN NULL
    WHEN a.attnotnull THEN 'NO'
    ELSE 'YES'
  END AS is_nullable
FROM expected_columns e
LEFT JOIN pg_catalog.pg_class cls
  ON cls.oid = to_regclass(e.table_name)
LEFT JOIN pg_catalog.pg_namespace n
  ON n.oid = cls.relnamespace
LEFT JOIN pg_catalog.pg_attribute a
  ON a.attrelid = cls.oid
 AND a.attname = e.column_name
 AND a.attnum > 0
 AND NOT a.attisdropped
ORDER BY e.table_name, a.attnum NULLS LAST, e.column_name;

-- 2b. Confirm join-key type assumptions used by the source code and this report.
WITH expected_pairs(
  relationship,
  left_table,
  left_column,
  right_table,
  right_column
) AS (
  VALUES
    ('users.tenant_id -> tenants.id', 'users', 'tenant_id', 'tenants', 'id'),
    ('clients.tenant_id -> tenants.id', 'clients', 'tenant_id', 'tenants', 'id'),
    ('invoices.tenant_id -> tenants.id', 'invoices', 'tenant_id', 'tenants', 'id'),
    ('invoices.client_id -> clients.id', 'invoices', 'client_id', 'clients', 'id'),
    ('payments.tenant_id -> tenants.id', 'payments', 'tenant_id', 'tenants', 'id'),
    ('payments.invoice_id -> invoices.id', 'payments', 'invoice_id', 'invoices', 'id'),
    ('invoice_items.invoice_id -> invoices.id', 'invoice_items', 'invoice_id', 'invoices', 'id')
),
pair_columns AS (
  SELECT
    p.relationship,
    la.atttypid AS left_type_oid,
    ra.atttypid AS right_type_oid,
    pg_catalog.format_type(la.atttypid, la.atttypmod) AS left_type,
    pg_catalog.format_type(ra.atttypid, ra.atttypmod) AS right_type
  FROM expected_pairs p
  LEFT JOIN pg_catalog.pg_class lc
    ON lc.oid = to_regclass(p.left_table)
  LEFT JOIN pg_catalog.pg_attribute la
    ON la.attrelid = lc.oid
   AND la.attname = p.left_column
   AND la.attnum > 0
   AND NOT la.attisdropped
  LEFT JOIN pg_catalog.pg_class rc
    ON rc.oid = to_regclass(p.right_table)
  LEFT JOIN pg_catalog.pg_attribute ra
    ON ra.attrelid = rc.oid
   AND ra.attname = p.right_column
   AND ra.attnum > 0
   AND NOT ra.attisdropped
)
SELECT
  'join_key_type_assumptions' AS report_section,
  relationship,
  left_type,
  right_type,
  CASE
    WHEN left_type_oid IS NULL OR right_type_oid IS NULL THEN 'missing_schema'
    WHEN left_type_oid = right_type_oid THEN 'same_type'
    ELSE 'different_type_review_before_constraints'
  END AS status
FROM pair_columns
ORDER BY relationship;

-- 2c. Stop before direct anomaly checks if the expected schema is incomplete.
--     Without this guard, PostgreSQL would raise a generic "relation/column does
--     not exist" error later because the checks intentionally mirror application
--     table usage.
DO $$
DECLARE
  missing_objects text;
BEGIN
  WITH expected_tables(table_name) AS (
    VALUES
      ('tenants'),
      ('users'),
      ('clients'),
      ('invoices'),
      ('invoice_items'),
      ('payments')
  ),
  expected_columns(table_name, column_name) AS (
    VALUES
      ('tenants', 'id'),
      ('tenants', 'name'),
      ('tenants', 'email'),
      ('tenants', 'phone'),
      ('users', 'id'),
      ('users', 'tenant_id'),
      ('users', 'name'),
      ('users', 'email'),
      ('users', 'password_hash'),
      ('users', 'role'),
      ('clients', 'id'),
      ('clients', 'tenant_id'),
      ('clients', 'name'),
      ('clients', 'email'),
      ('clients', 'phone'),
      ('clients', 'address'),
      ('clients', 'created_at'),
      ('invoices', 'id'),
      ('invoices', 'tenant_id'),
      ('invoices', 'client_id'),
      ('invoices', 'invoice_number'),
      ('invoices', 'due_date'),
      ('invoices', 'subtotal'),
      ('invoices', 'tax_rate'),
      ('invoices', 'tax_amount'),
      ('invoices', 'total'),
      ('invoices', 'notes'),
      ('invoices', 'status'),
      ('invoices', 'created_at'),
      ('invoice_items', 'invoice_id'),
      ('invoice_items', 'description'),
      ('invoice_items', 'quantity'),
      ('invoice_items', 'unit_price'),
      ('invoice_items', 'amount'),
      ('payments', 'id'),
      ('payments', 'tenant_id'),
      ('payments', 'invoice_id'),
      ('payments', 'amount'),
      ('payments', 'phone_number'),
      ('payments', 'mpesa_checkout_id'),
      ('payments', 'mpesa_receipt'),
      ('payments', 'status'),
      ('payments', 'created_at')
  ),
  missing AS (
    SELECT 'table ' || quote_ident(t.table_name) AS object_name
    FROM expected_tables t
    WHERE to_regclass(t.table_name) IS NULL
    UNION ALL
    SELECT 'column ' || quote_ident(c.table_name) || '.' || quote_ident(c.column_name)
    FROM expected_columns c
    LEFT JOIN pg_catalog.pg_class cls
      ON cls.oid = to_regclass(c.table_name)
    LEFT JOIN pg_catalog.pg_attribute a
      ON a.attrelid = cls.oid
     AND a.attname = c.column_name
     AND a.attnum > 0
     AND NOT a.attisdropped
    WHERE cls.oid IS NULL
       OR a.attname IS NULL
  )
  SELECT string_agg(object_name, ', ' ORDER BY object_name)
    INTO missing_objects
  FROM missing;

  IF missing_objects IS NOT NULL THEN
    RAISE EXCEPTION
      'Preflight aborted: missing expected schema object(s): %',
      missing_objects
      USING HINT = 'Review expected_tables and expected_columns_and_types above. The anomaly checks require the schema currently assumed by the backend source code.';
  END IF;
END;
$$;

-- 3. Summary counts. Any non-zero count should be reviewed before constraints
--    or tenant-security code changes are deployed.
SELECT 'null_users_tenant_id' AS issue_key, COUNT(*) AS issue_count
FROM users
WHERE tenant_id IS NULL
UNION ALL
SELECT 'null_clients_tenant_id', COUNT(*)
FROM clients
WHERE tenant_id IS NULL
UNION ALL
SELECT 'null_invoices_tenant_id', COUNT(*)
FROM invoices
WHERE tenant_id IS NULL
UNION ALL
SELECT 'null_invoices_client_id', COUNT(*)
FROM invoices
WHERE client_id IS NULL
UNION ALL
SELECT 'null_payments_tenant_id', COUNT(*)
FROM payments
WHERE tenant_id IS NULL
UNION ALL
SELECT 'null_payments_invoice_id', COUNT(*)
FROM payments
WHERE invoice_id IS NULL
UNION ALL
SELECT 'null_invoice_items_invoice_id', COUNT(*)
FROM invoice_items
WHERE invoice_id IS NULL
UNION ALL
SELECT 'orphan_users_missing_tenant', COUNT(*)
FROM users u
LEFT JOIN tenants t ON t.id = u.tenant_id
WHERE u.tenant_id IS NOT NULL
  AND t.id IS NULL
UNION ALL
SELECT 'orphan_clients_missing_tenant', COUNT(*)
FROM clients c
LEFT JOIN tenants t ON t.id = c.tenant_id
WHERE c.tenant_id IS NOT NULL
  AND t.id IS NULL
UNION ALL
SELECT 'orphan_invoices_missing_tenant', COUNT(*)
FROM invoices i
LEFT JOIN tenants t ON t.id = i.tenant_id
WHERE i.tenant_id IS NOT NULL
  AND t.id IS NULL
UNION ALL
SELECT 'orphan_invoices_missing_client', COUNT(*)
FROM invoices i
LEFT JOIN clients c ON c.id = i.client_id
WHERE i.client_id IS NOT NULL
  AND c.id IS NULL
UNION ALL
SELECT 'orphan_payments_missing_tenant', COUNT(*)
FROM payments p
LEFT JOIN tenants t ON t.id = p.tenant_id
WHERE p.tenant_id IS NOT NULL
  AND t.id IS NULL
UNION ALL
SELECT 'orphan_payments_missing_invoice', COUNT(*)
FROM payments p
LEFT JOIN invoices i ON i.id = p.invoice_id
WHERE p.invoice_id IS NOT NULL
  AND i.id IS NULL
UNION ALL
SELECT 'orphan_invoice_items_missing_invoice', COUNT(*)
FROM invoice_items ii
LEFT JOIN invoices i ON i.id = ii.invoice_id
WHERE ii.invoice_id IS NOT NULL
  AND i.id IS NULL
UNION ALL
SELECT 'cross_tenant_invoice_client', COUNT(*)
FROM invoices i
JOIN clients c ON c.id = i.client_id
WHERE i.tenant_id IS NOT NULL
  AND c.tenant_id IS NOT NULL
  AND i.tenant_id <> c.tenant_id
UNION ALL
SELECT 'cross_tenant_payment_invoice', COUNT(*)
FROM payments p
JOIN invoices i ON i.id = p.invoice_id
WHERE p.tenant_id IS NOT NULL
  AND i.tenant_id IS NOT NULL
  AND p.tenant_id <> i.tenant_id
UNION ALL
SELECT 'duplicate_tenant_invoice_numbers', COUNT(*)
FROM (
  SELECT tenant_id, invoice_number
  FROM invoices
  WHERE tenant_id IS NOT NULL
    AND invoice_number IS NOT NULL
  GROUP BY tenant_id, invoice_number
  HAVING COUNT(*) > 1
) duplicates
UNION ALL
SELECT 'duplicate_non_null_mpesa_checkout_ids', COUNT(*)
FROM (
  SELECT mpesa_checkout_id
  FROM payments
  WHERE mpesa_checkout_id IS NOT NULL
  GROUP BY mpesa_checkout_id
  HAVING COUNT(*) > 1
) duplicates
ORDER BY issue_key;

-- 4. Null tenant IDs in tenant-owned tables.
SELECT
  'null_users_tenant_id' AS report_section,
  id::text AS row_id,
  email,
  role
FROM users
WHERE tenant_id IS NULL
ORDER BY id::text
LIMIT 50;

SELECT
  'null_clients_tenant_id' AS report_section,
  id::text AS row_id,
  name,
  email,
  phone,
  created_at
FROM clients
WHERE tenant_id IS NULL
ORDER BY created_at DESC NULLS LAST, id::text
LIMIT 50;

SELECT
  'null_invoices_tenant_id' AS report_section,
  id::text AS row_id,
  client_id::text,
  invoice_number,
  status,
  total,
  created_at
FROM invoices
WHERE tenant_id IS NULL
ORDER BY created_at DESC NULLS LAST, id::text
LIMIT 50;

SELECT
  'null_invoices_client_id' AS report_section,
  id::text AS row_id,
  tenant_id::text,
  invoice_number,
  status,
  total,
  created_at
FROM invoices
WHERE client_id IS NULL
ORDER BY created_at DESC NULLS LAST, id::text
LIMIT 50;

SELECT
  'null_payments_tenant_id' AS report_section,
  id::text AS row_id,
  invoice_id::text,
  amount,
  status,
  mpesa_checkout_id,
  created_at
FROM payments
WHERE tenant_id IS NULL
ORDER BY created_at DESC NULLS LAST, id::text
LIMIT 50;

SELECT
  'null_payments_invoice_id' AS report_section,
  id::text AS row_id,
  tenant_id::text,
  amount,
  status,
  mpesa_checkout_id,
  created_at
FROM payments
WHERE invoice_id IS NULL
ORDER BY created_at DESC NULLS LAST, id::text
LIMIT 50;

SELECT
  'null_invoice_items_invoice_id' AS report_section,
  description,
  quantity,
  unit_price,
  amount
FROM invoice_items
WHERE invoice_id IS NULL
ORDER BY description NULLS LAST
LIMIT 50;

-- 5. Orphan records.
SELECT
  'orphan_users_missing_tenant' AS report_section,
  u.id::text AS user_id,
  u.tenant_id::text AS missing_tenant_id,
  u.email,
  u.role
FROM users u
LEFT JOIN tenants t ON t.id = u.tenant_id
WHERE u.tenant_id IS NOT NULL
  AND t.id IS NULL
ORDER BY u.id::text
LIMIT 50;

SELECT
  'orphan_clients_missing_tenant' AS report_section,
  c.id::text AS client_id,
  c.tenant_id::text AS missing_tenant_id,
  c.name,
  c.email,
  c.phone,
  c.created_at
FROM clients c
LEFT JOIN tenants t ON t.id = c.tenant_id
WHERE c.tenant_id IS NOT NULL
  AND t.id IS NULL
ORDER BY c.created_at DESC NULLS LAST, c.id::text
LIMIT 50;

SELECT
  'orphan_invoices_missing_tenant' AS report_section,
  i.id::text AS invoice_id,
  i.tenant_id::text AS missing_tenant_id,
  i.client_id::text,
  i.invoice_number,
  i.status,
  i.total,
  i.created_at
FROM invoices i
LEFT JOIN tenants t ON t.id = i.tenant_id
WHERE i.tenant_id IS NOT NULL
  AND t.id IS NULL
ORDER BY i.created_at DESC NULLS LAST, i.id::text
LIMIT 50;

SELECT
  'orphan_invoices_missing_client' AS report_section,
  i.id::text AS invoice_id,
  i.tenant_id::text,
  i.client_id::text AS missing_client_id,
  i.invoice_number,
  i.status,
  i.total,
  i.created_at
FROM invoices i
LEFT JOIN clients c ON c.id = i.client_id
WHERE i.client_id IS NOT NULL
  AND c.id IS NULL
ORDER BY i.created_at DESC NULLS LAST, i.id::text
LIMIT 50;

SELECT
  'orphan_payments_missing_tenant' AS report_section,
  p.id::text AS payment_id,
  p.tenant_id::text AS missing_tenant_id,
  p.invoice_id::text,
  p.amount,
  p.status,
  p.mpesa_checkout_id,
  p.created_at
FROM payments p
LEFT JOIN tenants t ON t.id = p.tenant_id
WHERE p.tenant_id IS NOT NULL
  AND t.id IS NULL
ORDER BY p.created_at DESC NULLS LAST, p.id::text
LIMIT 50;

SELECT
  'orphan_payments_missing_invoice' AS report_section,
  p.id::text AS payment_id,
  p.tenant_id::text,
  p.invoice_id::text AS missing_invoice_id,
  p.amount,
  p.status,
  p.mpesa_checkout_id,
  p.created_at
FROM payments p
LEFT JOIN invoices i ON i.id = p.invoice_id
WHERE p.invoice_id IS NOT NULL
  AND i.id IS NULL
ORDER BY p.created_at DESC NULLS LAST, p.id::text
LIMIT 50;

SELECT
  'orphan_invoice_items_missing_invoice' AS report_section,
  ii.invoice_id::text AS missing_invoice_id,
  COUNT(*) AS item_count
FROM invoice_items ii
LEFT JOIN invoices i ON i.id = ii.invoice_id
WHERE ii.invoice_id IS NOT NULL
  AND i.id IS NULL
GROUP BY ii.invoice_id
ORDER BY item_count DESC, ii.invoice_id::text
LIMIT 50;

-- 6. Cross-tenant relationships.
SELECT
  'cross_tenant_invoice_client' AS report_section,
  i.id::text AS invoice_id,
  i.tenant_id::text AS invoice_tenant_id,
  i.client_id::text,
  c.tenant_id::text AS client_tenant_id,
  i.invoice_number,
  i.status,
  i.total,
  i.created_at
FROM invoices i
JOIN clients c ON c.id = i.client_id
WHERE i.tenant_id IS NOT NULL
  AND c.tenant_id IS NOT NULL
  AND i.tenant_id <> c.tenant_id
ORDER BY i.created_at DESC NULLS LAST, i.id::text
LIMIT 50;

SELECT
  'cross_tenant_payment_invoice' AS report_section,
  p.id::text AS payment_id,
  p.tenant_id::text AS payment_tenant_id,
  p.invoice_id::text,
  i.tenant_id::text AS invoice_tenant_id,
  i.invoice_number,
  p.amount,
  p.status,
  p.mpesa_checkout_id,
  p.created_at
FROM payments p
JOIN invoices i ON i.id = p.invoice_id
WHERE p.tenant_id IS NOT NULL
  AND i.tenant_id IS NOT NULL
  AND p.tenant_id <> i.tenant_id
ORDER BY p.created_at DESC NULLS LAST, p.id::text
LIMIT 50;

-- 7. Duplicate keys that should be made unique after cleanup.
SELECT
  'duplicate_tenant_invoice_numbers' AS report_section,
  tenant_id::text,
  invoice_number,
  COUNT(*) AS duplicate_count,
  (array_agg(id::text ORDER BY created_at, id::text))[1:20] AS sample_invoice_ids
FROM invoices
WHERE tenant_id IS NOT NULL
  AND invoice_number IS NOT NULL
GROUP BY tenant_id, invoice_number
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC, tenant_id::text, invoice_number
LIMIT 50;

SELECT
  'duplicate_non_null_mpesa_checkout_ids' AS report_section,
  mpesa_checkout_id,
  COUNT(*) AS duplicate_count,
  (array_agg(id::text ORDER BY created_at, id::text))[1:20] AS sample_payment_ids,
  (array_agg(DISTINCT tenant_id::text ORDER BY tenant_id::text))[1:20] AS tenant_ids,
  (array_agg(DISTINCT invoice_id::text ORDER BY invoice_id::text))[1:20] AS invoice_ids
FROM payments
WHERE mpesa_checkout_id IS NOT NULL
GROUP BY mpesa_checkout_id
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC, mpesa_checkout_id
LIMIT 50;

ROLLBACK;

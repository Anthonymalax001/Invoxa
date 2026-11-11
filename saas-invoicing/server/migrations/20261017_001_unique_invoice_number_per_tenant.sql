-- Enforce tenant-scoped invoice-number uniqueness after existing duplicates
-- have been reviewed and safely resolved.
--
-- This migration intentionally aborts before adding the constraint if any
-- duplicate (tenant_id, invoice_number) pair remains. Do not bypass that guard.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.invoices
    WHERE tenant_id IS NULL OR invoice_number IS NULL
  ) THEN
    RAISE EXCEPTION
      'Cannot add tenant-scoped invoice-number uniqueness while tenant_id or invoice_number is NULL';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.invoices
    GROUP BY tenant_id, invoice_number
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot add tenant-scoped invoice-number uniqueness while duplicate tenant/invoice-number pairs exist'
      USING HINT = 'Review the duplicate report and resolve conflicts through an approved, audited business process before retrying.';
  END IF;
END;
$$;

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_tenant_id_invoice_number_key
  UNIQUE (tenant_id, invoice_number);

COMMIT;

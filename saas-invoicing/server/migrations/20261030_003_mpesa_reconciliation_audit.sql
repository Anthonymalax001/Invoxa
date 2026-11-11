BEGIN;

-- The legacy payments table has no repository-owned DDL. This migration only
-- records tenant-scoped Daraja query outcomes and deliberately stores its
-- payment key as text, with no assumed type or FK to that table.
DO $$
DECLARE
  required_column text;
BEGIN
  IF to_regclass('public.tenants') IS NULL OR to_regclass('public.payments') IS NULL
     OR to_regclass('public.customer_receipts') IS NULL THEN
    RAISE EXCEPTION 'M-Pesa reconciliation requires tenants, payments, and customer_receipts';
  END IF;

  FOREACH required_column IN ARRAY ARRAY['id', 'tenant_id', 'invoice_id', 'amount', 'mpesa_checkout_id', 'status'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = 'public.payments'::regclass AND attname = required_column
        AND attnum > 0 AND NOT attisdropped
    ) THEN
      RAISE EXCEPTION 'M-Pesa reconciliation requires payments.%', required_column;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.tenants'::regclass AND attname = 'id'
      AND atttypid = 'uuid'::regtype AND attnum > 0 AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'M-Pesa reconciliation requires tenants.id to be UUID';
  END IF;
END;
$$;

CREATE TABLE public.mpesa_payment_reconciliation_audit (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  payment_id text NOT NULL,
  checkout_request_id character varying(150) NOT NULL,
  payment_date date NOT NULL,
  outcome character varying(24) NOT NULL,
  provider_result_code character varying(32),
  receipt_id uuid,
  idempotency_key character varying(100) NOT NULL,
  payload_hash character(64) NOT NULL,
  actor_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT mpesa_reconciliation_outcome_check
    CHECK (outcome IN ('provider_success', 'provider_success_blocked_period', 'provider_success_blocked_invoice',
      'provider_non_success', 'inconclusive', 'query_failed', 'conflicting_result')),
  CONSTRAINT mpesa_reconciliation_hash_check CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT mpesa_reconciliation_result_code_check
    CHECK (provider_result_code IS NULL OR provider_result_code ~ '^-?[0-9]{1,20}$'),
  CONSTRAINT mpesa_reconciliation_receipt_state_check
    CHECK ((outcome = 'provider_success' AND receipt_id IS NOT NULL)
      OR (outcome <> 'provider_success' AND receipt_id IS NULL)),
  CONSTRAINT mpesa_reconciliation_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT mpesa_reconciliation_tenant_idempotency_unique UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT mpesa_reconciliation_receipt_fk
    FOREIGN KEY (tenant_id, receipt_id)
    REFERENCES public.customer_receipts (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX mpesa_reconciliation_payment_history_idx
  ON public.mpesa_payment_reconciliation_audit (tenant_id, payment_id, created_at DESC);
CREATE UNIQUE INDEX mpesa_reconciliation_checkout_success_uq
  ON public.mpesa_payment_reconciliation_audit (tenant_id, checkout_request_id)
  WHERE outcome = 'provider_success';

CREATE FUNCTION public.mpesa_payment_reconciliation_audit_guard_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'M-Pesa reconciliation audit history is immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER mpesa_payment_reconciliation_audit_immutable
BEFORE UPDATE OR DELETE ON public.mpesa_payment_reconciliation_audit
FOR EACH ROW EXECUTE FUNCTION public.mpesa_payment_reconciliation_audit_guard_mutation();

COMMIT;

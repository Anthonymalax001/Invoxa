-- Durable request reservations and transition history for Daraja STK Push.
-- The legacy payments table has no repository-owned DDL. IDs referencing it
-- and invoices are therefore text, with no guessed FK or identifier type.
-- Forward-only. Review the authoritative deployed schema before applying.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$
DECLARE
  required_column text;
BEGIN
  IF to_regclass('public.tenants') IS NULL OR to_regclass('public.payments') IS NULL THEN
    RAISE EXCEPTION 'M-Pesa STK idempotency requires public.tenants and public.payments';
  END IF;

  FOREACH required_column IN ARRAY ARRAY['id', 'tenant_id', 'invoice_id', 'amount', 'phone_number', 'mpesa_checkout_id', 'status'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute
      WHERE attrelid = 'public.payments'::regclass AND attname = required_column
        AND attnum > 0 AND NOT attisdropped
    ) THEN
      RAISE EXCEPTION 'M-Pesa STK idempotency requires payments.%', required_column;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.tenants'::regclass AND attname = 'id'
      AND atttypid = 'uuid'::regtype AND attnum > 0 AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_attribute a
      ON a.attrelid = i.indrelid AND a.attname = 'id'
     AND a.attnum > 0 AND NOT a.attisdropped
    WHERE i.indrelid = 'public.tenants'::regclass
      AND i.indisunique AND i.indisvalid AND i.indisready
      AND i.indpred IS NULL AND i.indexprs IS NULL
      AND i.indnkeyatts = 1 AND i.indkey[0] = a.attnum
  ) THEN
    RAISE EXCEPTION 'M-Pesa STK idempotency requires tenants.id to be UUID with a valid unique key';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.payments'::regclass AND attname = 'tenant_id'
      AND atttypid = 'uuid'::regtype AND attnum > 0 AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
    WHERE a.attrelid = 'public.payments'::regclass AND a.attname = 'amount'
      AND t.typcategory = 'N' AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION 'M-Pesa STK idempotency requires payments.tenant_id UUID and an exact numeric payments.amount';
  END IF;

  IF to_regprocedure('uuid_generate_v4()') IS NULL THEN
    RAISE EXCEPTION 'M-Pesa STK idempotency requires uuid_generate_v4()';
  END IF;

  IF to_regclass('public.mpesa_stk_initiation_requests') IS NOT NULL
     OR to_regclass('public.mpesa_stk_initiation_events') IS NOT NULL THEN
    RAISE EXCEPTION 'M-Pesa STK idempotency tables already exist; inspect schema before applying';
  END IF;
END;
$$;

CREATE TABLE public.mpesa_stk_initiation_requests (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  idempotency_key character varying(100) NOT NULL,
  payload_hash character(64) NOT NULL,
  invoice_id text NOT NULL,
  invoice_number text NOT NULL,
  amount numeric(20,2) NOT NULL,
  currency character(3) NOT NULL,
  -- Needed to repair a persisted provider response without sending another
  -- prompt. Cleared after local payment-row persistence or when no checkout
  -- identifier was received and the outcome is ambiguous.
  phone_number character varying(32),
  request_status character varying(24) NOT NULL,
  provider_checkout_request_id character varying(150),
  merchant_request_id character varying(150),
  payment_id text,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT mpesa_stk_request_key_not_blank CHECK (btrim(idempotency_key) <> ''),
  CONSTRAINT mpesa_stk_request_hash_check CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT mpesa_stk_request_amount_check CHECK (amount > 0),
  CONSTRAINT mpesa_stk_request_currency_check CHECK (currency = 'KES'),
  CONSTRAINT mpesa_stk_request_status_check
    CHECK (request_status IN ('reserved', 'outcome_unknown', 'provider_accepted', 'payment_recorded')),
  CONSTRAINT mpesa_stk_request_provider_id_check
    CHECK (provider_checkout_request_id IS NULL OR provider_checkout_request_id ~ '^[A-Za-z0-9_-]{1,150}$'),
  CONSTRAINT mpesa_stk_request_merchant_id_check
    CHECK (merchant_request_id IS NULL OR merchant_request_id ~ '^[A-Za-z0-9_-]{1,150}$'),
  CONSTRAINT mpesa_stk_request_recorded_fields_check
    CHECK (request_status <> 'payment_recorded' OR (provider_checkout_request_id IS NOT NULL AND payment_id IS NOT NULL)),
  CONSTRAINT mpesa_stk_request_tenant_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT mpesa_stk_request_tenant_key_unique UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX mpesa_stk_request_period_status_idx
  ON public.mpesa_stk_initiation_requests (tenant_id, created_at, request_status);

CREATE TABLE public.mpesa_stk_initiation_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  event_type character varying(32) NOT NULL,
  from_status character varying(24),
  to_status character varying(24) NOT NULL,
  checkout_request_id character varying(150),
  merchant_request_id character varying(150),
  payment_id text,
  actor_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT mpesa_stk_event_type_check
    CHECK (event_type IN ('reserved', 'provider_accepted', 'outcome_unknown', 'payment_recorded')),
  CONSTRAINT mpesa_stk_event_request_fk
    FOREIGN KEY (tenant_id, request_id)
    REFERENCES public.mpesa_stk_initiation_requests (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX mpesa_stk_event_history_idx
  ON public.mpesa_stk_initiation_events (tenant_id, request_id, created_at, id);

CREATE FUNCTION public.mpesa_stk_initiation_events_guard_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'M-Pesa STK initiation events are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER mpesa_stk_initiation_events_immutable
BEFORE UPDATE OR DELETE ON public.mpesa_stk_initiation_events
FOR EACH ROW EXECUTE FUNCTION public.mpesa_stk_initiation_events_guard_mutation();

COMMIT;

-- Enforce one active STK request per tenant invoice and preserve explicit
-- terminal resolution evidence. This extends the proposed 20261031_002 schema.
-- Review the original request-state migration and authoritative deployed DDL
-- before applying. This migration has not been executed.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$
DECLARE
  active_duplicate_count bigint;
  duplicate_payment_count bigint;
BEGIN
  IF to_regclass('public.mpesa_stk_initiation_requests') IS NULL
     OR to_regclass('public.mpesa_stk_initiation_events') IS NULL THEN
    RAISE EXCEPTION 'M-Pesa invoice reservations require migration 20261031_002_mpesa_stk_initiation_idempotency.sql';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.mpesa_stk_initiation_requests'::regclass
      AND conname = 'mpesa_stk_request_status_check'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.mpesa_stk_initiation_events'::regclass
      AND conname = 'mpesa_stk_event_type_check'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.mpesa_stk_initiation_requests'::regclass
      AND conname = 'mpesa_stk_request_recorded_fields_check'
  ) THEN
    RAISE EXCEPTION 'M-Pesa reservation migration requires the named request and event status checks from migration 20261031_002';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.mpesa_stk_initiation_requests'::regclass
      AND attname = 'tenant_id' AND atttypid = 'uuid'::regtype
      AND attnum > 0 AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.mpesa_stk_initiation_requests'::regclass
      AND attname = 'invoice_id' AND atttypid = 'text'::regtype
      AND attnum > 0 AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.mpesa_stk_initiation_requests'::regclass
      AND attname = 'payment_id' AND atttypid = 'text'::regtype
      AND attnum > 0 AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'M-Pesa invoice reservations require UUID tenant_id and text invoice_id/payment_id on the request table';
  END IF;

  SELECT count(*) INTO active_duplicate_count
  FROM (
    SELECT tenant_id, invoice_id
    FROM public.mpesa_stk_initiation_requests
    WHERE request_status IN ('reserved', 'outcome_unknown', 'provider_accepted', 'reference_recovered', 'payment_recorded', 'provider_succeeded')
    GROUP BY tenant_id, invoice_id
    HAVING count(*) > 1
  ) duplicates;
  IF active_duplicate_count > 0 THEN
    RAISE EXCEPTION 'M-Pesa reservation migration found % tenant invoices with multiple active requests; investigate before applying', active_duplicate_count;
  END IF;

  SELECT count(*) INTO duplicate_payment_count
  FROM (
    SELECT tenant_id, payment_id
    FROM public.mpesa_stk_initiation_requests
    WHERE payment_id IS NOT NULL
    GROUP BY tenant_id, payment_id
    HAVING count(*) > 1
  ) duplicates;
  IF duplicate_payment_count > 0 THEN
    RAISE EXCEPTION 'M-Pesa reservation migration found % payment IDs linked to multiple requests; investigate before applying', duplicate_payment_count;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.mpesa_stk_initiation_requests
    WHERE request_status NOT IN ('reserved', 'outcome_unknown', 'provider_accepted', 'payment_recorded')
  ) THEN
    RAISE EXCEPTION 'M-Pesa reservation migration found request states outside the original status domain; investigate before applying';
  END IF;

  IF to_regclass('public.mpesa_stk_one_active_request_per_invoice_uq') IS NOT NULL
     OR to_regclass('public.mpesa_stk_one_request_per_payment_uq') IS NOT NULL THEN
    RAISE EXCEPTION 'M-Pesa reservation indexes already exist; inspect schema before applying';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.mpesa_stk_initiation_events'::regclass
      AND attname = 'details' AND attnum > 0 AND NOT attisdropped
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.mpesa_stk_initiation_requests'::regclass
      AND conname = 'mpesa_stk_provider_rejection_fields_check'
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.mpesa_stk_initiation_events'::regclass
      AND conname = 'mpesa_stk_event_details_object_check'
  ) THEN
    RAISE EXCEPTION 'M-Pesa reservation details or state checks already exist; inspect schema before applying';
  END IF;
END;
$$;

ALTER TABLE public.mpesa_stk_initiation_events
  ADD COLUMN details jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.mpesa_stk_initiation_requests
  DROP CONSTRAINT mpesa_stk_request_status_check,
  ADD CONSTRAINT mpesa_stk_request_status_check
    CHECK (request_status IN (
      'reserved', 'outcome_unknown', 'provider_accepted', 'reference_recovered', 'payment_recorded',
      'provider_rejected', 'provider_succeeded', 'resolved_no_collection'
    )),
  DROP CONSTRAINT mpesa_stk_request_recorded_fields_check,
  ADD CONSTRAINT mpesa_stk_request_recorded_fields_check
    CHECK (request_status NOT IN ('payment_recorded', 'provider_succeeded') OR
      (provider_checkout_request_id IS NOT NULL AND payment_id IS NOT NULL)),
  ADD CONSTRAINT mpesa_stk_provider_rejection_fields_check
    CHECK (request_status <> 'provider_rejected' OR provider_checkout_request_id IS NULL);

ALTER TABLE public.mpesa_stk_initiation_events
  DROP CONSTRAINT mpesa_stk_event_type_check,
  ADD CONSTRAINT mpesa_stk_event_type_check
    CHECK (event_type IN (
      'reserved', 'provider_accepted', 'outcome_unknown', 'reference_recovered', 'payment_recorded',
      'provider_rejected', 'provider_succeeded',
      'admin_resolved_not_accepted', 'admin_resolved_failed', 'admin_resolved_cancelled'
    )),
  ADD CONSTRAINT mpesa_stk_event_details_object_check
    CHECK (jsonb_typeof(details) = 'object');

CREATE UNIQUE INDEX mpesa_stk_one_active_request_per_invoice_uq
  ON public.mpesa_stk_initiation_requests (tenant_id, invoice_id)
  WHERE request_status IN ('reserved', 'outcome_unknown', 'provider_accepted', 'reference_recovered', 'payment_recorded', 'provider_succeeded');

CREATE UNIQUE INDEX mpesa_stk_one_request_per_payment_uq
  ON public.mpesa_stk_initiation_requests (tenant_id, payment_id)
  WHERE payment_id IS NOT NULL;

COMMIT;

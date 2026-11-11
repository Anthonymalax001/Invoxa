-- Additive audit history for explicitly confirmed accounting period closes.
-- Review this migration against the deployed schema before applying it.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.accounting_periods') IS NULL THEN
    RAISE EXCEPTION 'Accounting period close audit requires public.accounting_periods';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'accounting_periods' AND column_name = 'tenant_id'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'accounting_periods' AND column_name = 'id'
  ) THEN
    RAISE EXCEPTION 'Accounting period close audit requires tenant-scoped period identifiers';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.accounting_periods'::regclass
      AND conname = 'accounting_periods_tenant_id_id_unique' AND contype = 'u'
  ) THEN
    RAISE EXCEPTION 'Accounting period close audit requires accounting_periods_tenant_id_id_unique';
  END IF;
END;
$$;

CREATE TABLE public.accounting_period_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  accounting_period_id uuid NOT NULL,
  event_type character varying(20) NOT NULL,
  outcome character varying(12) NOT NULL,
  actor_id uuid NOT NULL,
  reason character varying(1800) NOT NULL,
  idempotency_key character varying(100) NOT NULL,
  payload_hash character(64) NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT accounting_period_events_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT accounting_period_events_period_fk FOREIGN KEY (tenant_id, accounting_period_id)
    REFERENCES public.accounting_periods (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT accounting_period_events_tenant_key_unique UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT accounting_period_events_type_check CHECK (event_type = 'close'),
  CONSTRAINT accounting_period_events_outcome_check CHECK (outcome IN ('blocked', 'closed')),
  CONSTRAINT accounting_period_events_actor_check CHECK (actor_id IS NOT NULL),
  CONSTRAINT accounting_period_events_reason_check CHECK (btrim(reason) <> ''),
  CONSTRAINT accounting_period_events_key_check CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  CONSTRAINT accounting_period_events_hash_check CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT accounting_period_events_details_check CHECK (jsonb_typeof(details) = 'object')
);

CREATE INDEX accounting_period_events_history_idx
  ON public.accounting_period_events (tenant_id, accounting_period_id, created_at DESC, id DESC);

CREATE FUNCTION public.accounting_period_events_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Accounting period close audit events are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER accounting_period_events_immutable
BEFORE UPDATE OR DELETE ON public.accounting_period_events
FOR EACH ROW EXECUTE FUNCTION public.accounting_period_events_immutable();

COMMIT;

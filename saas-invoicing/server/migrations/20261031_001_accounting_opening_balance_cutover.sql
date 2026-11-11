-- Controlled, tenant-scoped opening-balance drafts and immutable cutover history.
-- Additive only. Review against approved schema evidence before applying; never
-- run against production as part of this implementation task.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$
DECLARE
  required_table text;
  required_constraint text;
BEGIN
  FOREACH required_table IN ARRAY ARRAY[
    'tenants', 'accounting_periods', 'accounting_accounts',
    'accounting_posting_events', 'accounting_journal_entries', 'accounting_journal_lines'
  ] LOOP
    IF to_regclass('public.' || required_table) IS NULL THEN
      RAISE EXCEPTION 'Opening-balance cutover requires public.%', required_table;
    END IF;
  END LOOP;
  IF to_regprocedure('uuid_generate_v4()') IS NULL THEN
    RAISE EXCEPTION 'Opening-balance cutover requires uuid_generate_v4()';
  END IF;
  FOREACH required_constraint IN ARRAY ARRAY[
    'accounting_periods_tenant_id_id_unique', 'accounting_accounts_tenant_id_id_unique',
    'accounting_journal_entries_tenant_id_id_unique'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conname = required_constraint AND contype = 'u'
        AND conrelid = to_regclass(CASE required_constraint
          WHEN 'accounting_periods_tenant_id_id_unique' THEN 'public.accounting_periods'
          WHEN 'accounting_accounts_tenant_id_id_unique' THEN 'public.accounting_accounts'
          ELSE 'public.accounting_journal_entries' END)
    ) THEN
      RAISE EXCEPTION 'Opening-balance cutover requires unique constraint %', required_constraint;
    END IF;
  END LOOP;
  IF to_regclass('public.accounting_opening_balance_batches') IS NOT NULL
     OR to_regclass('public.accounting_opening_balance_lines') IS NOT NULL
     OR to_regclass('public.accounting_opening_balance_events') IS NOT NULL THEN
    RAISE EXCEPTION 'Opening-balance cutover objects already exist; inspect before retrying';
  END IF;
END;
$$;

CREATE TABLE public.accounting_opening_balance_batches (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  accounting_period_id uuid NOT NULL,
  effective_date date NOT NULL,
  description character varying(2000) NOT NULL,
  status character varying(10) NOT NULL DEFAULT 'draft',
  idempotency_key character varying(100) NOT NULL,
  payload_hash character(64) NOT NULL,
  journal_entry_id uuid,
  reversal_journal_entry_id uuid,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_by uuid,
  approved_at timestamp with time zone,
  approval_reason character varying(1800),
  cancelled_by uuid,
  cancelled_at timestamp with time zone,
  cancellation_reason character varying(1800),
  reversed_by uuid,
  reversed_at timestamp with time zone,
  reversal_reason character varying(1800),
  CONSTRAINT accounting_opening_balance_batches_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT accounting_opening_balance_batches_tenant_key_unique UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT accounting_opening_balance_batches_period_fk FOREIGN KEY (tenant_id, accounting_period_id)
    REFERENCES public.accounting_periods (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT accounting_opening_balance_batches_journal_fk FOREIGN KEY (tenant_id, journal_entry_id)
    REFERENCES public.accounting_journal_entries (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT accounting_opening_balance_batches_reversal_fk FOREIGN KEY (tenant_id, reversal_journal_entry_id)
    REFERENCES public.accounting_journal_entries (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT accounting_opening_balance_batches_hash_check CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT accounting_opening_balance_batches_key_check CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  CONSTRAINT accounting_opening_balance_batches_text_check CHECK (btrim(description) <> ''),
  CONSTRAINT accounting_opening_balance_batches_status_check CHECK (status IN ('draft', 'posted', 'cancelled', 'reversed')),
  CONSTRAINT accounting_opening_balance_batches_state_check CHECK (
    (status = 'draft' AND journal_entry_id IS NULL AND reversal_journal_entry_id IS NULL
      AND approved_by IS NULL AND approved_at IS NULL AND approval_reason IS NULL
      AND cancelled_by IS NULL AND cancelled_at IS NULL AND cancellation_reason IS NULL
      AND reversed_by IS NULL AND reversed_at IS NULL AND reversal_reason IS NULL)
    OR
    (status = 'posted' AND journal_entry_id IS NOT NULL AND reversal_journal_entry_id IS NULL
      AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND approval_reason IS NOT NULL AND btrim(approval_reason) <> ''
      AND cancelled_by IS NULL AND cancelled_at IS NULL AND cancellation_reason IS NULL
      AND reversed_by IS NULL AND reversed_at IS NULL AND reversal_reason IS NULL)
    OR
    (status = 'cancelled' AND journal_entry_id IS NULL AND reversal_journal_entry_id IS NULL
      AND approved_by IS NULL AND approved_at IS NULL AND approval_reason IS NULL
      AND cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL AND cancellation_reason IS NOT NULL AND btrim(cancellation_reason) <> ''
      AND reversed_by IS NULL AND reversed_at IS NULL AND reversal_reason IS NULL)
    OR
    (status = 'reversed' AND journal_entry_id IS NOT NULL AND reversal_journal_entry_id IS NOT NULL
      AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND approval_reason IS NOT NULL AND btrim(approval_reason) <> ''
      AND cancelled_by IS NULL AND cancelled_at IS NULL AND cancellation_reason IS NULL
      AND reversed_by IS NOT NULL AND reversed_at IS NOT NULL AND reversal_reason IS NOT NULL AND btrim(reversal_reason) <> '')
  )
);

-- A tenant may retain cancelled/reversed history, but may have only one live
-- or posted cutover. A replacement after reversal must use the same cutoff.
CREATE UNIQUE INDEX accounting_opening_balance_one_active_cutover_per_tenant_uq
  ON public.accounting_opening_balance_batches (tenant_id)
  WHERE status IN ('draft', 'posted');

CREATE TABLE public.accounting_opening_balance_lines (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  line_number integer NOT NULL,
  account_id uuid NOT NULL,
  description character varying(255),
  debit numeric(20,6) NOT NULL DEFAULT 0,
  credit numeric(20,6) NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT accounting_opening_balance_lines_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT accounting_opening_balance_lines_batch_line_unique UNIQUE (tenant_id, batch_id, line_number),
  CONSTRAINT accounting_opening_balance_lines_batch_account_unique UNIQUE (tenant_id, batch_id, account_id),
  CONSTRAINT accounting_opening_balance_lines_batch_fk FOREIGN KEY (tenant_id, batch_id)
    REFERENCES public.accounting_opening_balance_batches (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT accounting_opening_balance_lines_account_fk FOREIGN KEY (tenant_id, account_id)
    REFERENCES public.accounting_accounts (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT accounting_opening_balance_lines_number_check CHECK (line_number > 0),
  CONSTRAINT accounting_opening_balance_lines_amount_check CHECK (
    debit >= 0 AND credit >= 0 AND ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
  )
);

CREATE TABLE public.accounting_opening_balance_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  event_type character varying(20) NOT NULL,
  actor_id uuid NOT NULL,
  reason character varying(1800) NOT NULL,
  idempotency_key character varying(100) NOT NULL,
  payload_hash character(64) NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT accounting_opening_balance_events_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT accounting_opening_balance_events_batch_fk FOREIGN KEY (tenant_id, batch_id)
    REFERENCES public.accounting_opening_balance_batches (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT accounting_opening_balance_events_tenant_key_unique UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT accounting_opening_balance_events_type_check
    CHECK (event_type IN ('draft_created', 'posted', 'cancelled', 'reversed')),
  CONSTRAINT accounting_opening_balance_events_reason_check CHECK (btrim(reason) <> ''),
  CONSTRAINT accounting_opening_balance_events_hash_check CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT accounting_opening_balance_events_details_check CHECK (jsonb_typeof(details) = 'object')
);

CREATE INDEX accounting_opening_balance_events_history_idx
  ON public.accounting_opening_balance_events (tenant_id, batch_id, created_at, id);

CREATE FUNCTION public.accounting_opening_balance_batch_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  line_count bigint;
  debit_total numeric;
  credit_total numeric;
  journal_status character varying(10);
  journal_source_type character varying(50);
  journal_source_id uuid;
  journal_event_type character varying(50);
  journal_period_id uuid;
  journal_entry_date date;
  reversal_status character varying(10);
  reversal_of_entry_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Opening-balance cutovers are retained for audit history' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Opening-balance cutovers must start as drafts' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.accounting_opening_balance_batches prior
      WHERE prior.tenant_id = NEW.tenant_id AND prior.status = 'reversed'
        AND prior.effective_date IS DISTINCT FROM NEW.effective_date
    ) THEN
      RAISE EXCEPTION 'A replacement opening balance after reversal must use the original cutover effective date'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'draft' AND NEW.status IN ('posted', 'cancelled') THEN
    IF (to_jsonb(NEW) - ARRAY['status', 'journal_entry_id', 'approved_by', 'approved_at', 'approval_reason',
                              'cancelled_by', 'cancelled_at', 'cancellation_reason'])
       IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['status', 'journal_entry_id', 'approved_by', 'approved_at', 'approval_reason',
                              'cancelled_by', 'cancelled_at', 'cancellation_reason']) THEN
      RAISE EXCEPTION 'Opening-balance draft contents are immutable' USING ERRCODE = '55000';
    END IF;
    IF NEW.status = 'posted' THEN
      IF NEW.journal_entry_id IS NULL OR NEW.approved_by IS NULL OR NEW.approved_at IS NULL
         OR NEW.approval_reason IS NULL OR NEW.cancelled_by IS NOT NULL
         OR NEW.approved_by = NEW.created_by THEN
        RAISE EXCEPTION 'Posting an opening balance requires linked journal and approval details' USING ERRCODE = '23514';
      END IF;
      SELECT status, source_type, source_id, event_type, accounting_period_id, entry_date
        INTO journal_status, journal_source_type, journal_source_id, journal_event_type,
             journal_period_id, journal_entry_date
      FROM public.accounting_journal_entries
      WHERE tenant_id = NEW.tenant_id AND id = NEW.journal_entry_id;
      IF NOT FOUND OR journal_status IS DISTINCT FROM 'posted'
         OR journal_source_type IS DISTINCT FROM 'opening_balance_cutover'
         OR journal_source_id IS DISTINCT FROM NEW.id OR journal_event_type IS DISTINCT FROM 'opening_balance'
         OR journal_period_id IS DISTINCT FROM NEW.accounting_period_id
         OR journal_entry_date IS DISTINCT FROM NEW.effective_date THEN
        RAISE EXCEPTION 'Opening-balance cutover must link its posted journal for the same tenant, period, date, and source'
          USING ERRCODE = '23514';
      END IF;
      SELECT count(*), COALESCE(sum(debit), 0), COALESCE(sum(credit), 0)
        INTO line_count, debit_total, credit_total
      FROM public.accounting_opening_balance_lines
      WHERE tenant_id = NEW.tenant_id AND batch_id = NEW.id;
      IF line_count < 2 OR debit_total <> credit_total THEN
        RAISE EXCEPTION 'Opening-balance lines must be present and exactly balanced' USING ERRCODE = '23514';
      END IF;
    ELSE
      IF NEW.journal_entry_id IS NOT NULL OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL
         OR NEW.approval_reason IS NOT NULL OR NEW.cancelled_by IS NULL OR NEW.cancelled_at IS NULL
         OR NEW.cancellation_reason IS NULL THEN
        RAISE EXCEPTION 'Cancelling a draft requires an actor, timestamp, and reason' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'posted' AND NEW.status = 'reversed' THEN
    IF (to_jsonb(NEW) - ARRAY['status', 'reversal_journal_entry_id', 'reversed_by', 'reversed_at', 'reversal_reason'])
       IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['status', 'reversal_journal_entry_id', 'reversed_by', 'reversed_at', 'reversal_reason']) THEN
      RAISE EXCEPTION 'Posted opening-balance details are immutable' USING ERRCODE = '55000';
    END IF;
    IF NEW.reversal_journal_entry_id IS NULL OR NEW.reversed_by IS NULL OR NEW.reversed_at IS NULL
       OR NEW.reversal_reason IS NULL THEN
      RAISE EXCEPTION 'Reversing an opening balance requires linked reversal and audit details' USING ERRCODE = '23514';
    END IF;
    SELECT status, reversal_of_entry_id INTO reversal_status, reversal_of_entry_id
    FROM public.accounting_journal_entries
    WHERE tenant_id = NEW.tenant_id AND id = NEW.reversal_journal_entry_id;
    IF NOT FOUND OR reversal_status IS DISTINCT FROM 'posted'
       OR reversal_of_entry_id IS DISTINCT FROM OLD.journal_entry_id THEN
      RAISE EXCEPTION 'Opening-balance reversal must link its posted reversal journal'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Opening-balance cutovers allow only draft, post, cancel, and reversal transitions'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER accounting_opening_balance_batch_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.accounting_opening_balance_batches
FOR EACH ROW EXECUTE FUNCTION public.accounting_opening_balance_batch_guard();

CREATE FUNCTION public.accounting_opening_balance_audit_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected_event character varying(20);
  expected_actor uuid;
  expected_reason character varying(1800);
  expected_key character varying(100);
BEGIN
  IF NEW.status = 'draft' THEN
    expected_event := 'draft_created';
    expected_actor := NEW.created_by;
    expected_reason := NEW.description;
    expected_key := NEW.idempotency_key;
  ELSIF NEW.status = 'posted' THEN
    expected_event := 'posted';
    expected_actor := NEW.approved_by;
    expected_reason := NEW.approval_reason;
  ELSIF NEW.status = 'cancelled' THEN
    expected_event := 'cancelled';
    expected_actor := NEW.cancelled_by;
    expected_reason := NEW.cancellation_reason;
  ELSIF NEW.status = 'reversed' THEN
    expected_event := 'reversed';
    expected_actor := NEW.reversed_by;
    expected_reason := NEW.reversal_reason;
  ELSE
    RAISE EXCEPTION 'Unknown opening-balance audit state' USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.accounting_opening_balance_events event
    WHERE event.tenant_id = NEW.tenant_id AND event.batch_id = NEW.id
      AND event.event_type = expected_event AND event.actor_id = expected_actor
      AND event.reason = expected_reason
      AND (expected_key IS NULL OR event.idempotency_key = expected_key)
  ) THEN
    RAISE EXCEPTION 'Opening-balance state change requires its append-only audit event'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER accounting_opening_balance_audit_guard
AFTER INSERT OR UPDATE ON public.accounting_opening_balance_batches
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.accounting_opening_balance_audit_guard();

CREATE FUNCTION public.accounting_opening_balance_line_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_tenant uuid;
  target_batch uuid;
  prior_batch_status character varying(10);
  batch_status character varying(10);
  v_account_type character varying(12);
  v_account_active boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_tenant := OLD.tenant_id;
    target_batch := OLD.batch_id;
  ELSE
    target_tenant := NEW.tenant_id;
    target_batch := NEW.batch_id;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT status INTO prior_batch_status FROM public.accounting_opening_balance_batches
    WHERE tenant_id = OLD.tenant_id AND id = OLD.batch_id FOR SHARE;
    IF prior_batch_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'Opening-balance lines are immutable after draft cancellation or posting' USING ERRCODE = '55000';
    END IF;
  END IF;
  SELECT status INTO batch_status FROM public.accounting_opening_balance_batches
  WHERE tenant_id = target_tenant AND id = target_batch FOR SHARE;
  IF batch_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Opening-balance lines are immutable after draft cancellation or posting' USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT a.account_type, a.is_active INTO v_account_type, v_account_active
    FROM public.accounting_accounts a
    WHERE tenant_id = NEW.tenant_id AND id = NEW.account_id FOR SHARE;
    IF NOT FOUND OR NOT v_account_active OR v_account_type NOT IN ('asset', 'liability', 'equity') THEN
      RAISE EXCEPTION 'Opening-balance lines require active same-tenant balance-sheet accounts' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_opening_balance_line_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.accounting_opening_balance_lines
FOR EACH ROW EXECUTE FUNCTION public.accounting_opening_balance_line_guard();

CREATE FUNCTION public.accounting_opening_balance_events_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Opening-balance cutover events are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER accounting_opening_balance_events_immutable
BEFORE UPDATE OR DELETE ON public.accounting_opening_balance_events
FOR EACH ROW EXECUTE FUNCTION public.accounting_opening_balance_events_immutable();

COMMIT;

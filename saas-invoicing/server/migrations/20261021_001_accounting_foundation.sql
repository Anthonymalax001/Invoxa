-- Additive tenant-scoped accounting foundation. No historical business rows are posted.
-- Requires the existing tenants(id) UUID key and uuid_generate_v4().
-- Apply only after review on a disposable PostgreSQL snapshot.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$
BEGIN
  IF to_regclass('public.tenants') IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('public.tenants') AND attname = 'id'
      AND atttypid = 'uuid'::regtype AND attnum > 0 AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'Accounting requires public.tenants.id with UUID type';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_attribute a
      ON a.attrelid = i.indrelid AND a.attname = 'id'
     AND a.attnum > 0 AND NOT a.attisdropped
    WHERE i.indrelid = to_regclass('public.tenants')
      AND i.indisunique AND i.indisvalid AND i.indisready AND i.indimmediate
      AND i.indpred IS NULL AND i.indexprs IS NULL
      AND i.indnkeyatts = 1 AND i.indkey[0] = a.attnum
  ) THEN
    RAISE EXCEPTION 'Accounting requires a valid unique key on tenants.id';
  END IF;

  IF to_regprocedure('uuid_generate_v4()') IS NULL THEN
    RAISE EXCEPTION 'Accounting requires uuid_generate_v4()';
  END IF;
END;
$$;

CREATE TABLE public.accounting_settings (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE RESTRICT,
  base_currency character varying(3) NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT accounting_settings_currency_check
    CHECK (base_currency ~ '^[A-Z]{3}$')
);

CREATE TABLE public.accounting_periods (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  name character varying(100) NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  status character varying(10) NOT NULL DEFAULT 'open',
  created_by uuid NOT NULL,
  closed_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at timestamp with time zone,
  CONSTRAINT accounting_periods_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT accounting_periods_tenant_name_unique UNIQUE (tenant_id, name),
  CONSTRAINT accounting_periods_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT accounting_periods_dates_check CHECK (starts_on <= ends_on),
  CONSTRAINT accounting_periods_status_check CHECK (status IN ('open', 'closed')),
  CONSTRAINT accounting_periods_close_audit_check CHECK (
    (status = 'open' AND closed_by IS NULL AND closed_at IS NULL) OR
    (status = 'closed' AND closed_by IS NOT NULL AND closed_at IS NOT NULL)
  )
);

CREATE INDEX accounting_periods_tenant_dates_idx
  ON public.accounting_periods (tenant_id, starts_on, ends_on);

CREATE TABLE public.accounting_accounts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  account_code character varying(30) NOT NULL,
  name character varying(150) NOT NULL,
  account_type character varying(12) NOT NULL,
  normal_balance character varying(6) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  is_system boolean NOT NULL DEFAULT false,
  system_key character varying(50),
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT accounting_accounts_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT accounting_accounts_tenant_code_unique UNIQUE (tenant_id, account_code),
  CONSTRAINT accounting_accounts_code_not_blank CHECK (btrim(account_code) <> ''),
  CONSTRAINT accounting_accounts_code_uppercase CHECK (account_code = upper(account_code)),
  CONSTRAINT accounting_accounts_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT accounting_accounts_type_check
    CHECK (account_type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  CONSTRAINT accounting_accounts_normal_balance_check
    CHECK (normal_balance IN ('debit', 'credit')),
  CONSTRAINT accounting_accounts_system_key_check CHECK (
    (is_system = false AND system_key IS NULL) OR
    (is_system = true AND system_key IS NOT NULL AND btrim(system_key) <> '')
  )
);

CREATE UNIQUE INDEX accounting_accounts_tenant_system_key_unique_idx
  ON public.accounting_accounts (tenant_id, system_key) WHERE system_key IS NOT NULL;
CREATE INDEX accounting_accounts_tenant_type_active_idx
  ON public.accounting_accounts (tenant_id, account_type, is_active, account_code);

CREATE TABLE public.accounting_posting_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  idempotency_key character varying(100) NOT NULL,
  payload_hash character(64) NOT NULL,
  source_type character varying(50) NOT NULL,
  source_id uuid,
  source_reference character varying(255),
  event_type character varying(50) NOT NULL,
  status character varying(12) NOT NULL DEFAULT 'processing',
  journal_entry_id uuid,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at timestamp with time zone,
  CONSTRAINT accounting_posting_events_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT accounting_posting_events_tenant_key_unique UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT accounting_posting_events_hash_check CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT accounting_posting_events_key_not_blank CHECK (btrim(idempotency_key) <> ''),
  CONSTRAINT accounting_posting_events_types_not_blank CHECK (
    btrim(source_type) <> '' AND btrim(event_type) <> ''
  ),
  CONSTRAINT accounting_posting_events_status_check CHECK (status IN ('processing', 'posted')),
  CONSTRAINT accounting_posting_events_completion_check CHECK (
    (status = 'processing' AND journal_entry_id IS NULL AND completed_at IS NULL) OR
    (status = 'posted' AND journal_entry_id IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX accounting_posting_events_source_unique_idx
  ON public.accounting_posting_events (tenant_id, source_type, source_id, event_type)
  WHERE source_id IS NOT NULL;
CREATE INDEX accounting_posting_events_tenant_created_idx
  ON public.accounting_posting_events (tenant_id, created_at DESC);

CREATE FUNCTION public.accounting_guard_posting_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'processing' THEN
      RAISE EXCEPTION 'Posting events must be created in processing state'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'posted' THEN
    RAISE EXCEPTION 'Completed posting events are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_posting_events_immutable
BEFORE INSERT OR UPDATE OR DELETE ON public.accounting_posting_events
FOR EACH ROW EXECUTE FUNCTION public.accounting_guard_posting_event_mutation();

CREATE TABLE public.accounting_journal_entries (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  accounting_period_id uuid NOT NULL,
  entry_date date NOT NULL,
  description text NOT NULL,
  status character varying(10) NOT NULL DEFAULT 'draft',
  functional_currency character varying(3) NOT NULL,
  source_type character varying(50) NOT NULL,
  source_id uuid,
  source_reference character varying(255),
  event_type character varying(50) NOT NULL,
  posting_event_id uuid NOT NULL,
  reversal_of_entry_id uuid,
  reversal_reason text,
  created_by uuid NOT NULL,
  posted_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  posted_at timestamp with time zone,
  CONSTRAINT accounting_journal_entries_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT accounting_journal_entries_tenant_event_unique UNIQUE (tenant_id, posting_event_id),
  CONSTRAINT accounting_journal_entries_period_fk
    FOREIGN KEY (tenant_id, accounting_period_id)
    REFERENCES public.accounting_periods (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT accounting_journal_entries_event_fk
    FOREIGN KEY (tenant_id, posting_event_id)
    REFERENCES public.accounting_posting_events (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT accounting_journal_entries_reversal_fk
    FOREIGN KEY (tenant_id, reversal_of_entry_id)
    REFERENCES public.accounting_journal_entries (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT accounting_journal_entries_description_not_blank CHECK (btrim(description) <> ''),
  CONSTRAINT accounting_journal_entries_status_check CHECK (status IN ('draft', 'posted')),
  CONSTRAINT accounting_journal_entries_currency_check
    CHECK (functional_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT accounting_journal_entries_types_not_blank CHECK (
    btrim(source_type) <> '' AND btrim(event_type) <> ''
  ),
  CONSTRAINT accounting_journal_entries_reversal_check CHECK (
    (reversal_of_entry_id IS NULL AND reversal_reason IS NULL) OR
    (reversal_of_entry_id IS NOT NULL AND reversal_reason IS NOT NULL AND btrim(reversal_reason) <> '')
  ),
  CONSTRAINT accounting_journal_entries_post_audit_check CHECK (
    (status = 'draft' AND posted_by IS NULL AND posted_at IS NULL) OR
    (status = 'posted' AND posted_by IS NOT NULL AND posted_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX accounting_journal_entries_one_reversal_idx
  ON public.accounting_journal_entries (tenant_id, reversal_of_entry_id)
  WHERE reversal_of_entry_id IS NOT NULL;
CREATE INDEX accounting_journal_entries_tenant_date_idx
  ON public.accounting_journal_entries (tenant_id, entry_date DESC, id DESC)
  WHERE status = 'posted';
CREATE INDEX accounting_journal_entries_tenant_period_idx
  ON public.accounting_journal_entries (tenant_id, accounting_period_id, entry_date);
CREATE INDEX accounting_journal_entries_source_idx
  ON public.accounting_journal_entries (tenant_id, source_type, source_id, event_type);

CREATE FUNCTION public.accounting_guard_settings_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM public.accounting_journal_entries
      WHERE tenant_id = OLD.tenant_id LIMIT 1
    ) OR EXISTS (
      SELECT 1 FROM public.accounting_periods
      WHERE tenant_id = OLD.tenant_id LIMIT 1
    ) THEN
      RAISE EXCEPTION 'Accounting settings cannot be removed after periods or journals exist'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.tenant_id <> NEW.tenant_id THEN
    RAISE EXCEPTION 'Accounting settings cannot move between tenants'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.base_currency <> NEW.base_currency AND EXISTS (
    SELECT 1 FROM public.accounting_journal_entries
    WHERE tenant_id = OLD.tenant_id LIMIT 1
  ) THEN
    RAISE EXCEPTION 'Accounting currency cannot change after journal entries exist'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_settings_currency_immutable_after_posting
BEFORE UPDATE OR DELETE ON public.accounting_settings
FOR EACH ROW EXECUTE FUNCTION public.accounting_guard_settings_mutation();

ALTER TABLE public.accounting_posting_events
  ADD CONSTRAINT accounting_posting_events_journal_fk
  FOREIGN KEY (tenant_id, journal_entry_id)
  REFERENCES public.accounting_journal_entries (tenant_id, id) ON DELETE RESTRICT;

CREATE FUNCTION public.accounting_assert_posting_event_completed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_status character varying(12);
  current_journal_entry_id uuid;
BEGIN
  SELECT status, journal_entry_id
    INTO current_status, current_journal_entry_id
  FROM public.accounting_posting_events
  WHERE tenant_id = NEW.tenant_id AND id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF current_status <> 'posted' OR current_journal_entry_id IS NULL THEN
    RAISE EXCEPTION 'Posting events must complete in the same transaction as their journal'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.accounting_journal_entries j
    WHERE j.tenant_id = NEW.tenant_id
      AND j.id = current_journal_entry_id
      AND j.status = 'posted'
      AND j.posting_event_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'A completed posting event must reference its posted journal'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER accounting_posting_event_completion_check
AFTER INSERT OR UPDATE ON public.accounting_posting_events
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.accounting_assert_posting_event_completed();

CREATE TABLE public.accounting_journal_lines (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  journal_entry_id uuid NOT NULL,
  line_number integer NOT NULL,
  account_id uuid NOT NULL,
  description character varying(255),
  debit numeric(20,6) NOT NULL DEFAULT 0,
  credit numeric(20,6) NOT NULL DEFAULT 0,
  transaction_currency character varying(3),
  transaction_amount numeric(20,6),
  exchange_rate numeric(20,10),
  exchange_rate_source character varying(100),
  exchange_rate_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT accounting_journal_lines_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT accounting_journal_lines_entry_number_unique UNIQUE (tenant_id, journal_entry_id, line_number),
  CONSTRAINT accounting_journal_lines_entry_fk
    FOREIGN KEY (tenant_id, journal_entry_id)
    REFERENCES public.accounting_journal_entries (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT accounting_journal_lines_account_fk
    FOREIGN KEY (tenant_id, account_id)
    REFERENCES public.accounting_accounts (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT accounting_journal_lines_number_check CHECK (line_number > 0),
  CONSTRAINT accounting_journal_lines_amounts_check CHECK (
    debit >= 0 AND credit >= 0 AND ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
  ),
  CONSTRAINT accounting_journal_lines_currency_check CHECK (
    transaction_currency IS NULL OR transaction_currency ~ '^[A-Z]{3}$'
  ),
  CONSTRAINT accounting_journal_lines_conversion_check CHECK (
    (transaction_currency IS NULL AND transaction_amount IS NULL AND exchange_rate IS NULL
      AND exchange_rate_source IS NULL AND exchange_rate_at IS NULL) OR
    (transaction_currency IS NOT NULL AND transaction_amount IS NOT NULL AND transaction_amount > 0
      AND exchange_rate IS NOT NULL AND exchange_rate > 0
      AND exchange_rate_source IS NOT NULL AND btrim(exchange_rate_source) <> ''
      AND exchange_rate_at IS NOT NULL)
  )
);

CREATE INDEX accounting_journal_lines_account_history_idx
  ON public.accounting_journal_lines (tenant_id, account_id, journal_entry_id, line_number);

CREATE FUNCTION public.accounting_prevent_overlapping_periods()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM 1 FROM public.accounting_settings
  WHERE tenant_id = NEW.tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Accounting settings must be configured before periods are created'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.accounting_periods p
    WHERE p.tenant_id = NEW.tenant_id AND p.id <> NEW.id
      AND daterange(p.starts_on, p.ends_on, '[]') && daterange(NEW.starts_on, NEW.ends_on, '[]')
  ) THEN
    RAISE EXCEPTION 'Accounting periods for a tenant may not overlap'
      USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_periods_no_overlap
BEFORE INSERT OR UPDATE OF tenant_id, starts_on, ends_on ON public.accounting_periods
FOR EACH ROW EXECUTE FUNCTION public.accounting_prevent_overlapping_periods();

CREATE FUNCTION public.accounting_guard_period_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'closed' AND NEW.status = 'open' THEN
    RAISE EXCEPTION 'Closed accounting periods cannot be reopened'
      USING ERRCODE = '55000';
  END IF;

  IF (OLD.starts_on <> NEW.starts_on OR OLD.ends_on <> NEW.ends_on) AND EXISTS (
    SELECT 1 FROM public.accounting_journal_entries j
    WHERE j.tenant_id = OLD.tenant_id AND j.accounting_period_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'Accounting period dates cannot change after journal entries exist'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_periods_guard_mutation
BEFORE UPDATE ON public.accounting_periods
FOR EACH ROW EXECUTE FUNCTION public.accounting_guard_period_mutation();

CREATE FUNCTION public.accounting_guard_journal_entry_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Journal entries must be assembled as drafts before posting'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'posted' THEN
    RAISE EXCEPTION 'Posted journal entries are immutable; create a reversal'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_journal_entries_immutable
BEFORE INSERT OR UPDATE OR DELETE ON public.accounting_journal_entries
FOR EACH ROW EXECUTE FUNCTION public.accounting_guard_journal_entry_mutation();

CREATE FUNCTION public.accounting_guard_journal_line_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_tenant uuid;
  target_entry uuid;
  parent_status character varying(10);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT status INTO parent_status FROM public.accounting_journal_entries
    WHERE tenant_id = OLD.tenant_id AND id = OLD.journal_entry_id FOR SHARE;
    IF parent_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'Lines of posted journals are immutable; create a reversal'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    target_tenant := OLD.tenant_id;
    target_entry := OLD.journal_entry_id;
  ELSE
    target_tenant := NEW.tenant_id;
    target_entry := NEW.journal_entry_id;
  END IF;

  SELECT status INTO parent_status FROM public.accounting_journal_entries
  WHERE tenant_id = target_tenant AND id = target_entry FOR SHARE;
  IF parent_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Lines of posted journals are immutable; create a reversal'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_journal_lines_immutable
BEFORE INSERT OR UPDATE OR DELETE ON public.accounting_journal_lines
FOR EACH ROW EXECUTE FUNCTION public.accounting_guard_journal_line_mutation();

CREATE FUNCTION public.accounting_assert_posted_journal_balanced()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_tenant uuid;
  target_entry uuid;
  entry_row record;
  line_count bigint;
  debit_total numeric;
  credit_total numeric;
BEGIN
  IF TG_TABLE_NAME = 'accounting_journal_entries' THEN
    IF TG_OP = 'DELETE' THEN
      target_tenant := OLD.tenant_id;
      target_entry := OLD.id;
    ELSE
      target_tenant := NEW.tenant_id;
      target_entry := NEW.id;
    END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN
      target_tenant := OLD.tenant_id;
      target_entry := OLD.journal_entry_id;
    ELSE
      target_tenant := NEW.tenant_id;
      target_entry := NEW.journal_entry_id;
    END IF;
  END IF;

  SELECT * INTO entry_row FROM public.accounting_journal_entries
  WHERE tenant_id = target_tenant AND id = target_entry;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF entry_row.status <> 'posted' THEN RETURN NULL; END IF;

  SELECT count(*), COALESCE(sum(debit), 0), COALESCE(sum(credit), 0)
    INTO line_count, debit_total, credit_total
  FROM public.accounting_journal_lines
  WHERE tenant_id = target_tenant AND journal_entry_id = target_entry;
  IF line_count < 2 OR debit_total <> credit_total THEN
    RAISE EXCEPTION 'Posted journal must have at least two lines and equal debits and credits'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.accounting_settings s
    WHERE s.tenant_id = target_tenant AND s.base_currency = entry_row.functional_currency
  ) THEN
    RAISE EXCEPTION 'Journal functional currency must match tenant accounting settings'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.accounting_periods p
    WHERE p.tenant_id = target_tenant AND p.id = entry_row.accounting_period_id
      AND p.status = 'open' AND entry_row.entry_date BETWEEN p.starts_on AND p.ends_on
  ) THEN
    RAISE EXCEPTION 'Journal date must belong to an open accounting period'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.accounting_posting_events e
    WHERE e.tenant_id = target_tenant AND e.id = entry_row.posting_event_id
      AND e.status = 'posted' AND e.journal_entry_id = entry_row.id
      AND e.source_type = entry_row.source_type
      AND e.source_id IS NOT DISTINCT FROM entry_row.source_id
      AND e.source_reference IS NOT DISTINCT FROM entry_row.source_reference
      AND e.event_type = entry_row.event_type
  ) THEN
    RAISE EXCEPTION 'Posted journal must have its completed posting event'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.accounting_journal_lines l
    JOIN public.accounting_accounts a
      ON a.tenant_id = l.tenant_id AND a.id = l.account_id
    WHERE l.tenant_id = target_tenant AND l.journal_entry_id = target_entry
      AND NOT a.is_active
  ) THEN
    RAISE EXCEPTION 'Posted journal lines must use active accounts'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.accounting_journal_lines l
    WHERE l.tenant_id = target_tenant AND l.journal_entry_id = target_entry
      AND l.transaction_currency IS NOT NULL
      AND (round(l.transaction_amount * l.exchange_rate, 6) <> l.debit + l.credit
        OR (l.transaction_currency = entry_row.functional_currency AND l.exchange_rate <> 1))
  ) THEN
    RAISE EXCEPTION 'Journal line base amount does not match its recorded currency conversion'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER accounting_journal_entry_balance_check
AFTER INSERT OR UPDATE ON public.accounting_journal_entries
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.accounting_assert_posted_journal_balanced();

COMMIT;

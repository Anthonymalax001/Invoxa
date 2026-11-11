-- Additive metadata foundation for a future classified cash-flow statement.
-- No existing account or journal-line classification is inferred or backfilled.
-- Apply only after review; this migration is intentionally not executed here.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$
BEGIN
  IF to_regclass('public.accounting_accounts') IS NULL OR
     to_regclass('public.accounting_journal_entries') IS NULL OR
     to_regclass('public.accounting_journal_lines') IS NULL THEN
    RAISE EXCEPTION 'Cash-flow metadata requires the accounting accounts, journal entries, and journal lines tables';
  END IF;

  IF to_regprocedure('uuid_generate_v4()') IS NULL THEN
    RAISE EXCEPTION 'Cash-flow metadata requires uuid_generate_v4()';
  END IF;
END;
$$;

CREATE TABLE public.accounting_cash_flow_account_classifications (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  role character varying(20) NOT NULL,
  effective_from date NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT accounting_cash_flow_account_classifications_tenant_id_id_unique
    UNIQUE (tenant_id, id),
  CONSTRAINT accounting_cash_flow_account_classifications_account_fk
    FOREIGN KEY (tenant_id, account_id)
    REFERENCES public.accounting_accounts (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT accounting_cash_flow_account_classifications_role_check
    CHECK (role IN ('cash_equivalent', 'not_cash'))
);

CREATE INDEX accounting_cash_flow_account_classifications_asof_idx
  ON public.accounting_cash_flow_account_classifications
    (tenant_id, account_id, effective_from DESC, created_at DESC, id DESC);

CREATE TABLE public.accounting_cash_flow_line_classifications (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  journal_line_id uuid NOT NULL,
  activity character varying(24) NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT accounting_cash_flow_line_classifications_tenant_id_id_unique
    UNIQUE (tenant_id, id),
  CONSTRAINT accounting_cash_flow_line_classifications_line_fk
    FOREIGN KEY (tenant_id, journal_line_id)
    REFERENCES public.accounting_journal_lines (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT accounting_cash_flow_line_classifications_activity_check
    CHECK (activity IN ('operating', 'investing', 'financing', 'non_cash_transfer'))
);

CREATE INDEX accounting_cash_flow_line_classifications_latest_idx
  ON public.accounting_cash_flow_line_classifications
    (tenant_id, journal_line_id, created_at DESC, id DESC);

CREATE FUNCTION public.accounting_guard_cash_flow_metadata_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Cash-flow classifications are audit records and cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  RAISE EXCEPTION 'Cash-flow classifications are audit records and cannot be updated; add a correction record'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER accounting_cash_flow_account_classifications_immutable
BEFORE UPDATE OR DELETE ON public.accounting_cash_flow_account_classifications
FOR EACH ROW EXECUTE FUNCTION public.accounting_guard_cash_flow_metadata_mutation();

CREATE TRIGGER accounting_cash_flow_line_classifications_immutable
BEFORE UPDATE OR DELETE ON public.accounting_cash_flow_line_classifications
FOR EACH ROW EXECUTE FUNCTION public.accounting_guard_cash_flow_metadata_mutation();

CREATE FUNCTION public.accounting_validate_cash_flow_line_classification()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  line_account_id uuid;
  journal_date date;
  journal_status character varying(10);
  account_type character varying(12);
  account_role character varying(20);
BEGIN
  SELECT l.account_id, j.entry_date, j.status
    INTO line_account_id, journal_date, journal_status
  FROM public.accounting_journal_lines l
  JOIN public.accounting_journal_entries j
    ON j.tenant_id = l.tenant_id AND j.id = l.journal_entry_id
  WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.journal_line_id;

  IF NOT FOUND OR journal_status <> 'posted' THEN
    RAISE EXCEPTION 'Cash-flow activity can only classify a line from a posted journal'
      USING ERRCODE = '23514';
  END IF;

  SELECT a.account_type INTO account_type
  FROM public.accounting_accounts a
  WHERE a.tenant_id = NEW.tenant_id AND a.id = line_account_id;

  IF account_type <> 'asset' THEN
    RAISE EXCEPTION 'Cash-flow activity can only classify an asset account line'
      USING ERRCODE = '23514';
  END IF;

  SELECT c.role INTO account_role
  FROM public.accounting_cash_flow_account_classifications c
  WHERE c.tenant_id = NEW.tenant_id AND c.account_id = line_account_id
    AND c.effective_from <= journal_date
  ORDER BY c.effective_from DESC, c.created_at DESC, c.id DESC
  LIMIT 1;

  IF account_role IS DISTINCT FROM 'cash_equivalent' THEN
    RAISE EXCEPTION 'Cash-flow activity requires an account classified as a cash equivalent on the journal date'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_cash_flow_line_classification_validate
BEFORE INSERT ON public.accounting_cash_flow_line_classifications
FOR EACH ROW EXECUTE FUNCTION public.accounting_validate_cash_flow_line_classification();

COMMIT;

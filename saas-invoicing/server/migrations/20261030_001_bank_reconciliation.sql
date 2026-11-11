-- Additive bank reconciliation schema. No account is classified or enabled by
-- this migration; a tenant administrator must explicitly designate each
-- eligible account after reviewing its chart-of-accounts setup.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$
BEGIN
  IF to_regclass('public.tenants') IS NULL
     OR to_regclass('public.accounting_settings') IS NULL
     OR to_regclass('public.accounting_accounts') IS NULL
     OR to_regclass('public.accounting_journal_entries') IS NULL
     OR to_regclass('public.accounting_journal_lines') IS NULL THEN
    RAISE EXCEPTION 'Bank reconciliation requires the tenant and accounting foundation tables';
  END IF;
  IF to_regprocedure('uuid_generate_v4()') IS NULL THEN
    RAISE EXCEPTION 'Bank reconciliation requires uuid_generate_v4()';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = to_regclass('public.accounting_accounts')
      AND conname = 'accounting_accounts_tenant_id_id_unique' AND contype = 'u'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = to_regclass('public.accounting_journal_entries')
      AND conname = 'accounting_journal_entries_tenant_id_id_unique' AND contype = 'u'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = to_regclass('public.accounting_journal_lines')
      AND conname = 'accounting_journal_lines_tenant_id_id_unique' AND contype = 'u'
  ) THEN
    RAISE EXCEPTION 'Bank reconciliation requires tenant-scoped account, journal and line keys';
  END IF;
END;
$$;

CREATE TABLE public.bank_reconciliation_accounts (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL,
  bank_label character varying(150) NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT bank_reconciliation_accounts_tenant_account_unique UNIQUE (tenant_id, account_id),
  CONSTRAINT bank_reconciliation_accounts_account_fk
    FOREIGN KEY (tenant_id, account_id)
    REFERENCES public.accounting_accounts (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT bank_reconciliation_accounts_label_check CHECK (btrim(bank_label) <> '')
);

CREATE FUNCTION public.bank_reconciliation_validate_account()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  selected_type character varying(12);
  selected_normal_balance character varying(6);
  selected_active boolean;
BEGIN
  SELECT account_type, normal_balance, is_active
    INTO selected_type, selected_normal_balance, selected_active
  FROM public.accounting_accounts
  WHERE tenant_id = NEW.tenant_id AND id = NEW.account_id
  FOR SHARE;
  IF NOT FOUND OR NOT selected_active OR selected_type <> 'asset' OR selected_normal_balance <> 'debit' THEN
    RAISE EXCEPTION 'A reconciliation account must be an active tenant debit-normal asset account explicitly designated by an administrator'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER bank_reconciliation_accounts_validate
BEFORE INSERT ON public.bank_reconciliation_accounts
FOR EACH ROW EXECUTE FUNCTION public.bank_reconciliation_validate_account();

CREATE FUNCTION public.bank_reconciliation_accounts_guard_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Bank reconciliation account designations are retained as audit records'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER bank_reconciliation_accounts_immutable
BEFORE UPDATE OR DELETE ON public.bank_reconciliation_accounts
FOR EACH ROW EXECUTE FUNCTION public.bank_reconciliation_accounts_guard_mutation();

CREATE TABLE public.bank_reconciliation_import_batches (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  bank_account_id uuid NOT NULL,
  file_name character varying(180) NOT NULL,
  file_sha256 character(64) NOT NULL,
  idempotency_key character varying(100) NOT NULL,
  currency character(3) NOT NULL,
  statement_start_date date NOT NULL,
  statement_end_date date NOT NULL,
  statement_opening_balance numeric(20,6) NOT NULL,
  statement_closing_balance numeric(20,6) NOT NULL,
  row_count integer NOT NULL,
  reconciliation_status character varying(12) NOT NULL DEFAULT 'open',
  imported_by uuid NOT NULL,
  imported_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reconciled_by uuid,
  reconciled_at timestamp with time zone,
  reopened_by uuid,
  reopened_at timestamp with time zone,
  CONSTRAINT bank_reconciliation_import_batches_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT bank_reconciliation_import_batches_account_fk
    FOREIGN KEY (tenant_id, bank_account_id)
    REFERENCES public.bank_reconciliation_accounts (tenant_id, account_id) ON DELETE RESTRICT,
  CONSTRAINT bank_reconciliation_import_batches_hash_check CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT bank_reconciliation_import_batches_key_check CHECK (btrim(idempotency_key) <> ''),
  CONSTRAINT bank_reconciliation_import_batches_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT bank_reconciliation_import_batches_dates_check CHECK (statement_start_date <= statement_end_date),
  CONSTRAINT bank_reconciliation_import_batches_rows_check CHECK (row_count BETWEEN 1 AND 5000),
  CONSTRAINT bank_reconciliation_import_batches_status_check CHECK (reconciliation_status IN ('open', 'reconciled')),
  CONSTRAINT bank_reconciliation_import_batches_reconciled_check CHECK (
    (reconciled_by IS NULL AND reconciled_at IS NULL) OR
    (reconciled_by IS NOT NULL AND reconciled_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX bank_reconciliation_import_batches_tenant_key_unique
  ON public.bank_reconciliation_import_batches (tenant_id, idempotency_key);
CREATE UNIQUE INDEX bank_reconciliation_import_batches_file_unique
  ON public.bank_reconciliation_import_batches (tenant_id, bank_account_id, file_sha256);
CREATE INDEX bank_reconciliation_import_batches_history_idx
  ON public.bank_reconciliation_import_batches (tenant_id, bank_account_id, imported_at DESC, id DESC);

CREATE FUNCTION public.bank_reconciliation_import_batches_guard_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Bank reconciliation import history cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.bank_account_id IS DISTINCT FROM OLD.bank_account_id
     OR NEW.file_name IS DISTINCT FROM OLD.file_name OR NEW.file_sha256 IS DISTINCT FROM OLD.file_sha256
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.statement_start_date IS DISTINCT FROM OLD.statement_start_date
     OR NEW.statement_end_date IS DISTINCT FROM OLD.statement_end_date
     OR NEW.statement_opening_balance IS DISTINCT FROM OLD.statement_opening_balance
     OR NEW.statement_closing_balance IS DISTINCT FROM OLD.statement_closing_balance
     OR NEW.row_count IS DISTINCT FROM OLD.row_count OR NEW.imported_by IS DISTINCT FROM OLD.imported_by
     OR NEW.imported_at IS DISTINCT FROM OLD.imported_at THEN
    RAISE EXCEPTION 'Imported statement data is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.reconciliation_status IS DISTINCT FROM OLD.reconciliation_status AND NOT (
      (OLD.reconciliation_status = 'open' AND NEW.reconciliation_status = 'reconciled') OR
      (OLD.reconciliation_status = 'reconciled' AND NEW.reconciliation_status = 'open')
    ) THEN
    RAISE EXCEPTION 'Reconciliation status changes must follow the audited open/reconciled workflow'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.reconciliation_status = OLD.reconciliation_status AND (
      NEW.reconciled_by IS DISTINCT FROM OLD.reconciled_by OR
      NEW.reconciled_at IS DISTINCT FROM OLD.reconciled_at OR
      NEW.reopened_by IS DISTINCT FROM OLD.reopened_by OR
      NEW.reopened_at IS DISTINCT FROM OLD.reopened_at
    ) THEN
    RAISE EXCEPTION 'Reconciliation audit fields may only change during a status transition'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.reconciliation_status = 'open' AND NEW.reconciliation_status = 'reconciled' AND (
      NEW.reconciled_by IS NULL OR NEW.reconciled_at IS NULL OR
      NEW.reopened_by IS DISTINCT FROM OLD.reopened_by OR NEW.reopened_at IS DISTINCT FROM OLD.reopened_at
    ) THEN
    RAISE EXCEPTION 'Completing a reconciliation requires reconciled-by audit fields'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.reconciliation_status = 'reconciled' AND NEW.reconciliation_status = 'open' AND (
      NEW.reopened_by IS NULL OR NEW.reopened_at IS NULL OR
      NEW.reconciled_by IS DISTINCT FROM OLD.reconciled_by OR NEW.reconciled_at IS DISTINCT FROM OLD.reconciled_at
    ) THEN
    RAISE EXCEPTION 'Reopening a reconciliation requires reopened-by audit fields'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER bank_reconciliation_import_batches_immutable
BEFORE UPDATE OR DELETE ON public.bank_reconciliation_import_batches
FOR EACH ROW EXECUTE FUNCTION public.bank_reconciliation_import_batches_guard_mutation();

CREATE TABLE public.bank_reconciliation_statement_transactions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  import_batch_id uuid NOT NULL,
  bank_account_id uuid NOT NULL,
  row_number integer NOT NULL,
  transaction_date date NOT NULL,
  bank_reference character varying(255),
  description character varying(500) NOT NULL,
  debit numeric(20,6) NOT NULL DEFAULT 0,
  credit numeric(20,6) NOT NULL DEFAULT 0,
  running_balance numeric(20,6),
  fingerprint character varying(64) NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT bank_reconciliation_statement_transactions_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT bank_reconciliation_statement_transactions_row_unique UNIQUE (tenant_id, import_batch_id, row_number),
  CONSTRAINT bank_reconciliation_statement_transactions_fingerprint_unique
    UNIQUE (tenant_id, bank_account_id, fingerprint),
  CONSTRAINT bank_reconciliation_statement_transactions_batch_fk
    FOREIGN KEY (tenant_id, import_batch_id)
    REFERENCES public.bank_reconciliation_import_batches (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT bank_reconciliation_statement_transactions_account_fk
    FOREIGN KEY (tenant_id, bank_account_id)
    REFERENCES public.bank_reconciliation_accounts (tenant_id, account_id) ON DELETE RESTRICT,
  CONSTRAINT bank_reconciliation_statement_transactions_row_check CHECK (row_number > 1),
  CONSTRAINT bank_reconciliation_statement_transactions_fingerprint_check CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT bank_reconciliation_statement_transactions_amounts_check CHECK (
    debit >= 0 AND credit >= 0 AND ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
  )
);

CREATE INDEX bank_reconciliation_statement_transactions_date_idx
  ON public.bank_reconciliation_statement_transactions (tenant_id, import_batch_id, transaction_date, row_number);
CREATE INDEX bank_reconciliation_statement_transactions_account_date_idx
  ON public.bank_reconciliation_statement_transactions (tenant_id, bank_account_id, transaction_date);

CREATE FUNCTION public.bank_reconciliation_statement_transactions_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Imported bank statement transactions are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER bank_reconciliation_statement_transactions_immutable
BEFORE UPDATE OR DELETE ON public.bank_reconciliation_statement_transactions
FOR EACH ROW EXECUTE FUNCTION public.bank_reconciliation_statement_transactions_immutable();

CREATE TABLE public.bank_reconciliation_matches (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  import_batch_id uuid NOT NULL,
  statement_transaction_id uuid NOT NULL,
  bank_account_id uuid NOT NULL,
  journal_entry_id uuid NOT NULL,
  journal_line_id uuid NOT NULL,
  status character varying(12) NOT NULL DEFAULT 'matched',
  matched_by uuid NOT NULL,
  matched_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  unmatched_by uuid,
  unmatched_at timestamp with time zone,
  unmatch_reason text,
  CONSTRAINT bank_reconciliation_matches_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT bank_reconciliation_matches_batch_fk
    FOREIGN KEY (tenant_id, import_batch_id)
    REFERENCES public.bank_reconciliation_import_batches (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT bank_reconciliation_matches_transaction_fk
    FOREIGN KEY (tenant_id, statement_transaction_id)
    REFERENCES public.bank_reconciliation_statement_transactions (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT bank_reconciliation_matches_account_fk
    FOREIGN KEY (tenant_id, bank_account_id)
    REFERENCES public.bank_reconciliation_accounts (tenant_id, account_id) ON DELETE RESTRICT,
  CONSTRAINT bank_reconciliation_matches_journal_fk
    FOREIGN KEY (tenant_id, journal_entry_id)
    REFERENCES public.accounting_journal_entries (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT bank_reconciliation_matches_line_fk
    FOREIGN KEY (tenant_id, journal_line_id)
    REFERENCES public.accounting_journal_lines (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT bank_reconciliation_matches_status_check CHECK (status IN ('matched', 'unmatched')),
  CONSTRAINT bank_reconciliation_matches_unmatch_audit_check CHECK (
    (status = 'matched' AND unmatched_by IS NULL AND unmatched_at IS NULL AND unmatch_reason IS NULL) OR
    (status = 'unmatched' AND unmatched_by IS NOT NULL AND unmatched_at IS NOT NULL
      AND unmatch_reason IS NOT NULL AND btrim(unmatch_reason) <> '')
  )
);

CREATE UNIQUE INDEX bank_reconciliation_matches_one_active_transaction
  ON public.bank_reconciliation_matches (tenant_id, statement_transaction_id)
  WHERE status = 'matched';
CREATE UNIQUE INDEX bank_reconciliation_matches_one_active_journal_line
  ON public.bank_reconciliation_matches (tenant_id, journal_line_id)
  WHERE status = 'matched';
CREATE INDEX bank_reconciliation_matches_batch_status_idx
  ON public.bank_reconciliation_matches (tenant_id, import_batch_id, status);

CREATE FUNCTION public.bank_reconciliation_matches_validate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  batch_account uuid;
  batch_currency character(3);
  batch_status character varying(12);
  transaction_account uuid;
  statement_debit numeric(20,6);
  statement_credit numeric(20,6);
  journal_account uuid;
  journal_status character varying(10);
  journal_currency character varying(3);
  line_debit numeric(20,6);
  line_credit numeric(20,6);
  account_type character varying(12);
  normal_balance character varying(6);
  account_active boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT reconciliation_status INTO batch_status
      FROM public.bank_reconciliation_import_batches
      WHERE tenant_id = NEW.tenant_id AND id = NEW.import_batch_id
      FOR SHARE;
    IF NOT FOUND OR batch_status <> 'open' THEN
      RAISE EXCEPTION 'Reopen the reconciliation before releasing a match'
        USING ERRCODE = '23514';
    END IF;
    IF OLD.status <> 'matched' OR NEW.status <> 'unmatched'
       OR NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.import_batch_id IS DISTINCT FROM OLD.import_batch_id
       OR NEW.statement_transaction_id IS DISTINCT FROM OLD.statement_transaction_id
       OR NEW.bank_account_id IS DISTINCT FROM OLD.bank_account_id
       OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id
       OR NEW.journal_line_id IS DISTINCT FROM OLD.journal_line_id
       OR NEW.matched_by IS DISTINCT FROM OLD.matched_by OR NEW.matched_at IS DISTINCT FROM OLD.matched_at
       OR NEW.unmatched_by IS NULL OR NEW.unmatched_at IS NULL
       OR NEW.unmatch_reason IS NULL OR btrim(NEW.unmatch_reason) = '' THEN
      RAISE EXCEPTION 'A reconciliation match may only be released through an audited unmatch action'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  SELECT b.bank_account_id, b.currency, b.reconciliation_status,
         t.bank_account_id, t.debit, t.credit
    INTO batch_account, batch_currency, batch_status,
         transaction_account, statement_debit, statement_credit
  FROM public.bank_reconciliation_import_batches b
  JOIN public.bank_reconciliation_statement_transactions t
    ON t.tenant_id = b.tenant_id AND t.import_batch_id = b.id
  WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.import_batch_id
    AND t.id = NEW.statement_transaction_id
  FOR SHARE OF b;
  IF NOT FOUND OR batch_account <> NEW.bank_account_id OR transaction_account <> NEW.bank_account_id
     OR batch_status <> 'open' THEN
    RAISE EXCEPTION 'A reconciliation match requires an open tenant-owned statement transaction and bank account'
      USING ERRCODE = '23514';
  END IF;

  SELECT j.status, j.functional_currency, l.account_id, l.debit, l.credit,
         a.account_type, a.normal_balance, a.is_active
    INTO journal_status, journal_currency, journal_account, line_debit, line_credit,
         account_type, normal_balance, account_active
  FROM public.accounting_journal_entries j
  JOIN public.accounting_journal_lines l
    ON l.tenant_id = j.tenant_id AND l.journal_entry_id = j.id
  JOIN public.accounting_accounts a
    ON a.tenant_id = l.tenant_id AND a.id = l.account_id
  WHERE j.tenant_id = NEW.tenant_id AND j.id = NEW.journal_entry_id
    AND l.id = NEW.journal_line_id
  FOR SHARE OF j, l, a;
  IF NOT FOUND OR journal_status <> 'posted' OR journal_currency <> batch_currency
     OR journal_account <> NEW.bank_account_id OR account_type <> 'asset'
     OR normal_balance <> 'debit' OR NOT account_active THEN
    RAISE EXCEPTION 'A bank reconciliation match requires a posted same-currency line on the active selected bank account'
      USING ERRCODE = '23514';
  END IF;
  IF (statement_credit > 0 AND (line_debit <> statement_credit OR line_credit <> 0)) OR
     (statement_debit > 0 AND (line_credit <> statement_debit OR line_debit <> 0)) THEN
    RAISE EXCEPTION 'Statement and posted journal amounts or directions do not match exactly'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER bank_reconciliation_matches_validate
BEFORE INSERT OR UPDATE ON public.bank_reconciliation_matches
FOR EACH ROW EXECUTE FUNCTION public.bank_reconciliation_matches_validate();

-- A completed statement is a closed accounting cutoff. Journals dated on or
-- before that cutoff must wait until an administrator reopens the affected
-- reconciliation. This protects the saved reconciliation from later postings
-- and reversals that would silently change its book balance.
CREATE FUNCTION public.bank_reconciliation_guard_reconciled_cutoff()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'posted' AND NEW.status = 'posted' AND EXISTS (
    SELECT 1
    FROM public.accounting_journal_lines l
    JOIN public.bank_reconciliation_accounts a
      ON a.tenant_id = l.tenant_id AND a.account_id = l.account_id
    JOIN public.bank_reconciliation_import_batches b
      ON b.tenant_id = a.tenant_id AND b.bank_account_id = a.account_id
    WHERE l.tenant_id = NEW.tenant_id AND l.journal_entry_id = NEW.id
      AND b.reconciliation_status = 'reconciled'
      AND NEW.entry_date <= b.statement_end_date
  ) THEN
    RAISE EXCEPTION 'Reopen the bank reconciliation before posting to this account at or before its reconciled cutoff'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER bank_reconciliation_reconciled_cutoff_guard
BEFORE UPDATE OF status ON public.accounting_journal_entries
FOR EACH ROW EXECUTE FUNCTION public.bank_reconciliation_guard_reconciled_cutoff();

CREATE TABLE public.bank_reconciliation_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  bank_account_id uuid NOT NULL,
  import_batch_id uuid,
  statement_transaction_id uuid,
  event_type character varying(30) NOT NULL,
  actor_id uuid NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT bank_reconciliation_events_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT bank_reconciliation_events_account_fk
    FOREIGN KEY (tenant_id, bank_account_id)
    REFERENCES public.bank_reconciliation_accounts (tenant_id, account_id) ON DELETE RESTRICT,
  CONSTRAINT bank_reconciliation_events_batch_fk
    FOREIGN KEY (tenant_id, import_batch_id)
    REFERENCES public.bank_reconciliation_import_batches (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT bank_reconciliation_events_transaction_fk
    FOREIGN KEY (tenant_id, statement_transaction_id)
    REFERENCES public.bank_reconciliation_statement_transactions (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT bank_reconciliation_events_type_check CHECK (
    event_type IN ('account_enabled', 'imported', 'matched', 'unmatched', 'reconciled', 'reopened', 'adjustment_posted')
  )
);

CREATE INDEX bank_reconciliation_events_batch_history_idx
  ON public.bank_reconciliation_events (tenant_id, import_batch_id, created_at, id);

CREATE FUNCTION public.bank_reconciliation_events_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Bank reconciliation audit events are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER bank_reconciliation_events_immutable
BEFORE UPDATE OR DELETE ON public.bank_reconciliation_events
FOR EACH ROW EXECUTE FUNCTION public.bank_reconciliation_events_immutable();

COMMIT;

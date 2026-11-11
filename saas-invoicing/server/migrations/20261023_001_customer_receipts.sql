-- Add an auditable customer-receipt workflow without changing the legacy
-- payments table. This migration fails closed if the existing customer and
-- invoice keys or financial columns do not match the observed application
-- contract. It must be reviewed against authoritative schema evidence before
-- deployment; it has not been run against any database.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$
DECLARE
  required_column record;
BEGIN
  IF to_regclass('public.tenants') IS NULL
     OR to_regclass('public.clients') IS NULL
     OR to_regclass('public.invoices') IS NULL
     OR to_regclass('public.accounting_settings') IS NULL
     OR to_regclass('public.accounting_periods') IS NULL
     OR to_regclass('public.accounting_accounts') IS NULL
     OR to_regclass('public.accounting_invoice_mappings') IS NULL
     OR to_regclass('public.accounting_invoice_tax_snapshots') IS NULL
     OR to_regclass('public.accounting_journal_entries') IS NULL THEN
    RAISE EXCEPTION 'Customer receipts require tenants, clients, invoices, and the accounting foundation/configuration';
  END IF;
  IF to_regprocedure('uuid_generate_v4()') IS NULL THEN
    RAISE EXCEPTION 'Customer receipts require uuid_generate_v4()';
  END IF;

  FOR required_column IN
    SELECT * FROM (VALUES
      ('tenants', 'id', 'uuid'),
      ('clients', 'id', 'uuid'),
      ('clients', 'tenant_id', 'uuid'),
      ('invoices', 'id', 'uuid'),
      ('invoices', 'tenant_id', 'uuid'),
      ('invoices', 'client_id', 'uuid')
    ) AS required(table_name, column_name, udt_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = required_column.table_name
        AND c.column_name = required_column.column_name
        AND c.udt_name = required_column.udt_name
        AND c.is_nullable = 'NO'
    ) THEN
      RAISE EXCEPTION 'Customer receipts require public.%.% to be NOT NULL %',
        required_column.table_name, required_column.column_name, required_column.udt_name;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = 'invoices'
      AND c.column_name = 'total' AND c.data_type = 'numeric'
      AND c.numeric_scale = 2 AND c.is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'Customer receipts require public.invoices.total to be NOT NULL numeric with scale 2';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = 'invoices'
      AND c.column_name = 'status' AND c.udt_name IN ('varchar', 'text', 'bpchar')
  ) THEN
    RAISE EXCEPTION 'Customer receipts require a text-compatible public.invoices.status column';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = 'invoices'
      AND c.column_name = 'invoice_number' AND c.udt_name IN ('varchar', 'text', 'bpchar')
  ) THEN
    RAISE EXCEPTION 'Customer receipts require a text-compatible public.invoices.invoice_number column';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = 'invoices'
      AND c.column_name = 'due_date' AND c.udt_name = 'date'
  ) THEN
    RAISE EXCEPTION 'Customer receipts require a date-compatible public.invoices.due_date column';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = to_regclass('public.accounting_accounts')
      AND conname = 'accounting_accounts_tenant_id_id_unique' AND contype = 'u'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = to_regclass('public.accounting_periods')
      AND conname = 'accounting_periods_tenant_id_id_unique' AND contype = 'u'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = to_regclass('public.accounting_journal_entries')
      AND conname = 'accounting_journal_entries_tenant_id_id_unique' AND contype = 'u'
  ) THEN
    RAISE EXCEPTION 'Customer receipts require tenant-scoped accounting account, period, and journal keys';
  END IF;
END;
$$;

-- These unique indexes provide tenant-scoped FK targets. Existing core tables
-- are otherwise left unchanged; duplicate legacy keys make this migration fail.
CREATE UNIQUE INDEX IF NOT EXISTS customer_receipts_clients_scope_uq
  ON public.clients (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS customer_receipts_invoices_scope_uq
  ON public.invoices (tenant_id, id);

CREATE TABLE public.customer_receipts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL,
  amount numeric(20,2) NOT NULL,
  currency character(3) NOT NULL,
  payment_method character varying(20) NOT NULL,
  receipt_reference character varying(150),
  payment_date date NOT NULL,
  status character varying(12) NOT NULL DEFAULT 'pending',
  idempotency_key character varying(100) NOT NULL,
  payload_hash character(64) NOT NULL,
  verification_idempotency_key character varying(100),
  verification_payload_hash character(64),
  cash_account_id uuid,
  accounting_period_id uuid,
  journal_entry_id uuid,
  verified_by uuid,
  verified_at timestamp with time zone,
  failure_reason text,
  failed_by uuid,
  failed_at timestamp with time zone,
  reversal_idempotency_key character varying(100),
  reversal_payload_hash character(64),
  reversal_journal_entry_id uuid,
  reversal_reason text,
  reversed_by uuid,
  reversed_at timestamp with time zone,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT customer_receipts_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT customer_receipts_tenant_idempotency_unique UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT customer_receipts_amount_check CHECK (amount > 0),
  CONSTRAINT customer_receipts_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT customer_receipts_method_check
    CHECK (payment_method IN ('cash', 'bank_transfer', 'card', 'cheque', 'mpesa', 'other')),
  CONSTRAINT customer_receipts_hash_check CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT customer_receipts_verification_hash_check CHECK (
    verification_payload_hash IS NULL OR verification_payload_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT customer_receipts_reversal_hash_check CHECK (
    reversal_payload_hash IS NULL OR reversal_payload_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT customer_receipts_status_check CHECK (status IN ('pending', 'verified', 'failed', 'reversed')),
  CONSTRAINT customer_receipts_audit_state_check CHECK (
    (status = 'pending' AND verification_idempotency_key IS NULL AND verification_payload_hash IS NULL
      AND cash_account_id IS NULL AND accounting_period_id IS NULL AND journal_entry_id IS NULL
      AND verified_by IS NULL AND verified_at IS NULL AND failure_reason IS NULL AND failed_by IS NULL
      AND failed_at IS NULL AND reversal_idempotency_key IS NULL AND reversal_payload_hash IS NULL
      AND reversal_journal_entry_id IS NULL AND reversal_reason IS NULL AND reversed_by IS NULL AND reversed_at IS NULL)
    OR
    (status = 'verified' AND verification_idempotency_key IS NOT NULL AND verification_payload_hash IS NOT NULL
      AND cash_account_id IS NOT NULL AND accounting_period_id IS NOT NULL AND journal_entry_id IS NOT NULL
      AND verified_by IS NOT NULL AND verified_at IS NOT NULL AND failure_reason IS NULL AND failed_by IS NULL
      AND failed_at IS NULL AND reversal_idempotency_key IS NULL AND reversal_payload_hash IS NULL
      AND reversal_journal_entry_id IS NULL AND reversal_reason IS NULL AND reversed_by IS NULL AND reversed_at IS NULL)
    OR
    (status = 'failed' AND verification_idempotency_key IS NULL AND verification_payload_hash IS NULL
      AND cash_account_id IS NULL AND accounting_period_id IS NULL AND journal_entry_id IS NULL
      AND verified_by IS NULL AND verified_at IS NULL AND failure_reason IS NOT NULL AND btrim(failure_reason) <> ''
      AND failed_by IS NOT NULL AND failed_at IS NOT NULL AND reversal_idempotency_key IS NULL
      AND reversal_payload_hash IS NULL AND reversal_journal_entry_id IS NULL AND reversal_reason IS NULL
      AND reversed_by IS NULL AND reversed_at IS NULL)
    OR
    (status = 'reversed' AND verification_idempotency_key IS NOT NULL AND verification_payload_hash IS NOT NULL
      AND cash_account_id IS NOT NULL AND accounting_period_id IS NOT NULL AND journal_entry_id IS NOT NULL
      AND verified_by IS NOT NULL AND verified_at IS NOT NULL AND failure_reason IS NULL AND failed_by IS NULL
      AND failed_at IS NULL AND reversal_idempotency_key IS NOT NULL AND reversal_payload_hash IS NOT NULL
      AND reversal_journal_entry_id IS NOT NULL AND reversal_reason IS NOT NULL AND btrim(reversal_reason) <> ''
      AND reversed_by IS NOT NULL AND reversed_at IS NOT NULL)
  ),
  CONSTRAINT customer_receipts_customer_fk
    FOREIGN KEY (tenant_id, customer_id)
    REFERENCES public.clients (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT customer_receipts_cash_account_fk
    FOREIGN KEY (tenant_id, cash_account_id)
    REFERENCES public.accounting_accounts (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT customer_receipts_period_fk
    FOREIGN KEY (tenant_id, accounting_period_id)
    REFERENCES public.accounting_periods (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT customer_receipts_journal_fk
    FOREIGN KEY (tenant_id, journal_entry_id)
    REFERENCES public.accounting_journal_entries (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT customer_receipts_reversal_journal_fk
    FOREIGN KEY (tenant_id, reversal_journal_entry_id)
    REFERENCES public.accounting_journal_entries (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX customer_receipts_tenant_customer_created_idx
  ON public.customer_receipts (tenant_id, customer_id, created_at DESC);
CREATE INDEX customer_receipts_tenant_status_created_idx
  ON public.customer_receipts (tenant_id, status, created_at DESC);
CREATE UNIQUE INDEX customer_receipts_verification_idempotency_unique_idx
  ON public.customer_receipts (tenant_id, verification_idempotency_key)
  WHERE verification_idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX customer_receipts_reversal_idempotency_unique_idx
  ON public.customer_receipts (tenant_id, reversal_idempotency_key)
  WHERE reversal_idempotency_key IS NOT NULL;

CREATE TABLE public.customer_receipt_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  event_type character varying(20) NOT NULL,
  actor_id uuid NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT customer_receipt_events_type_check
    CHECK (event_type IN ('recorded', 'verified', 'failed', 'allocated', 'reversed')),
  CONSTRAINT customer_receipt_events_receipt_fk
    FOREIGN KEY (tenant_id, receipt_id)
    REFERENCES public.customer_receipts (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX customer_receipt_events_receipt_created_idx
  ON public.customer_receipt_events (tenant_id, receipt_id, created_at, id);

CREATE TABLE public.customer_receipt_allocation_batches (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  idempotency_key character varying(100) NOT NULL,
  payload_hash character(64) NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT customer_receipt_allocation_batches_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT customer_receipt_allocation_batches_tenant_key_unique UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT customer_receipt_allocation_batches_hash_check CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT customer_receipt_allocation_batches_receipt_fk
    FOREIGN KEY (tenant_id, receipt_id)
    REFERENCES public.customer_receipts (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.customer_receipt_allocations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  amount numeric(20,2) NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT customer_receipt_allocations_amount_check CHECK (amount > 0),
  CONSTRAINT customer_receipt_allocations_one_invoice_per_batch_unique
    UNIQUE (tenant_id, batch_id, invoice_id),
  CONSTRAINT customer_receipt_allocations_receipt_fk
    FOREIGN KEY (tenant_id, receipt_id)
    REFERENCES public.customer_receipts (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT customer_receipt_allocations_batch_fk
    FOREIGN KEY (tenant_id, batch_id)
    REFERENCES public.customer_receipt_allocation_batches (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT customer_receipt_allocations_invoice_fk
    FOREIGN KEY (tenant_id, invoice_id)
    REFERENCES public.invoices (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT customer_receipt_allocations_customer_fk
    FOREIGN KEY (tenant_id, customer_id)
    REFERENCES public.clients (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX customer_receipt_allocations_tenant_invoice_idx
  ON public.customer_receipt_allocations (tenant_id, invoice_id);
CREATE INDEX customer_receipt_allocations_tenant_receipt_idx
  ON public.customer_receipt_allocations (tenant_id, receipt_id);

CREATE FUNCTION public.customer_receipt_allocation_batches_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Customer receipt allocation batches are retained for audit history'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER customer_receipt_allocation_batches_immutable
BEFORE UPDATE OR DELETE ON public.customer_receipt_allocation_batches
FOR EACH ROW EXECUTE FUNCTION public.customer_receipt_allocation_batches_immutable();

CREATE FUNCTION public.customer_receipts_guard_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Customer receipts are retained for audit history'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.id IS DISTINCT FROM NEW.id OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR OLD.customer_id IS DISTINCT FROM NEW.customer_id OR OLD.amount IS DISTINCT FROM NEW.amount
     OR OLD.currency IS DISTINCT FROM NEW.currency OR OLD.payment_method IS DISTINCT FROM NEW.payment_method
     OR OLD.receipt_reference IS DISTINCT FROM NEW.receipt_reference OR OLD.payment_date IS DISTINCT FROM NEW.payment_date
     OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key OR OLD.payload_hash IS DISTINCT FROM NEW.payload_hash
     OR OLD.created_by IS DISTINCT FROM NEW.created_by OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'Customer receipt source details are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'pending' AND NEW.status = 'verified'
     AND NEW.failure_reason IS NULL AND NEW.failed_by IS NULL AND NEW.failed_at IS NULL
     AND NEW.reversal_idempotency_key IS NULL AND NEW.reversal_payload_hash IS NULL
     AND NEW.reversal_journal_entry_id IS NULL AND NEW.reversal_reason IS NULL
     AND NEW.reversed_by IS NULL AND NEW.reversed_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'pending' AND NEW.status = 'failed'
     AND NEW.verification_idempotency_key IS NULL AND NEW.verification_payload_hash IS NULL
     AND NEW.cash_account_id IS NULL AND NEW.accounting_period_id IS NULL AND NEW.journal_entry_id IS NULL
     AND NEW.verified_by IS NULL AND NEW.verified_at IS NULL
     AND NEW.reversal_idempotency_key IS NULL AND NEW.reversal_payload_hash IS NULL
     AND NEW.reversal_journal_entry_id IS NULL AND NEW.reversal_reason IS NULL
     AND NEW.reversed_by IS NULL AND NEW.reversed_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'verified' AND NEW.status = 'reversed'
     AND OLD.verification_idempotency_key IS NOT DISTINCT FROM NEW.verification_idempotency_key
     AND OLD.verification_payload_hash IS NOT DISTINCT FROM NEW.verification_payload_hash
     AND OLD.cash_account_id IS NOT DISTINCT FROM NEW.cash_account_id
     AND OLD.accounting_period_id IS NOT DISTINCT FROM NEW.accounting_period_id
     AND OLD.journal_entry_id IS NOT DISTINCT FROM NEW.journal_entry_id
     AND OLD.verified_by IS NOT DISTINCT FROM NEW.verified_by
     AND OLD.verified_at IS NOT DISTINCT FROM NEW.verified_at
     AND NEW.failure_reason IS NULL AND NEW.failed_by IS NULL AND NEW.failed_at IS NULL THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Customer receipt status changes must follow pending, verified, failed, and reversed transitions'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER customer_receipts_guard_mutation
BEFORE UPDATE OR DELETE ON public.customer_receipts
FOR EACH ROW EXECUTE FUNCTION public.customer_receipts_guard_mutation();

CREATE FUNCTION public.customer_receipt_events_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Customer receipt events are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER customer_receipt_events_immutable
BEFORE UPDATE OR DELETE ON public.customer_receipt_events
FOR EACH ROW EXECUTE FUNCTION public.customer_receipt_events_immutable();

CREATE FUNCTION public.customer_receipt_allocations_guard_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  receipt_row public.customer_receipts%ROWTYPE;
  invoice_row record;
  receipt_allocated numeric(20,2);
  invoice_allocated numeric(20,2);
BEGIN
  SELECT * INTO receipt_row
  FROM public.customer_receipts AS receipt
  WHERE receipt.tenant_id = NEW.tenant_id AND receipt.id = NEW.receipt_id
  FOR UPDATE OF receipt;
  IF NOT FOUND OR receipt_row.status <> 'verified' THEN
    RAISE EXCEPTION 'Only verified receipts may be allocated'
      USING ERRCODE = '23514';
  END IF;
  IF receipt_row.customer_id <> NEW.customer_id THEN
    RAISE EXCEPTION 'Receipt allocation customer does not match the receipt'
      USING ERRCODE = '23514';
  END IF;

  SELECT i.client_id, i.total, i.status, snapshot.total AS snapshot_total,
         journal.functional_currency AS invoice_currency
  INTO invoice_row
  FROM public.invoices i
  JOIN public.accounting_invoice_tax_snapshots snapshot
    ON snapshot.tenant_id = i.tenant_id AND snapshot.source_type = 'invoice'
   AND snapshot.source_id = i.id AND snapshot.issued_at IS NOT NULL
  JOIN public.accounting_journal_entries journal
    ON journal.tenant_id = snapshot.tenant_id AND journal.id = snapshot.journal_entry_id
   AND journal.status = 'posted'
  WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.invoice_id
  FOR UPDATE;
  IF NOT FOUND OR invoice_row.client_id <> NEW.customer_id
     OR invoice_row.status NOT IN ('sent', 'overdue')
     OR invoice_row.total <> invoice_row.snapshot_total
     OR invoice_row.invoice_currency <> receipt_row.currency THEN
    RAISE EXCEPTION 'Only a posted, currency-compatible invoice for this customer may be allocated'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(sum(a.amount), 0) INTO receipt_allocated
  FROM public.customer_receipt_allocations a
  JOIN public.customer_receipts r ON r.tenant_id = a.tenant_id AND r.id = a.receipt_id
  WHERE a.tenant_id = NEW.tenant_id AND a.receipt_id = NEW.receipt_id
    AND r.status = 'verified';
  IF receipt_allocated + NEW.amount > receipt_row.amount THEN
    RAISE EXCEPTION 'Allocation exceeds the available receipt balance'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(sum(a.amount), 0) INTO invoice_allocated
  FROM public.customer_receipt_allocations a
  JOIN public.customer_receipts r ON r.tenant_id = a.tenant_id AND r.id = a.receipt_id
  WHERE a.tenant_id = NEW.tenant_id AND a.invoice_id = NEW.invoice_id
    AND r.status = 'verified';
  IF invoice_allocated + NEW.amount > invoice_row.total THEN
    RAISE EXCEPTION 'Allocation exceeds the invoice outstanding balance'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER customer_receipt_allocations_guard_insert
BEFORE INSERT ON public.customer_receipt_allocations
FOR EACH ROW EXECUTE FUNCTION public.customer_receipt_allocations_guard_insert();

CREATE FUNCTION public.customer_receipt_allocations_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Customer receipt allocations are retained for audit history'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER customer_receipt_allocations_immutable
BEFORE UPDATE OR DELETE ON public.customer_receipt_allocations
FOR EACH ROW EXECUTE FUNCTION public.customer_receipt_allocations_immutable();

COMMIT;

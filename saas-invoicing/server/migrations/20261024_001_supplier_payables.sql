-- Add tenant-scoped supplier bills, approvals, payments, allocations, and audit history.
-- Supplier bills are separate from purchase orders, goods receipts, and expenses.
-- This migration is additive and must be reviewed against the approved schema before use.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$
BEGIN
  IF to_regclass('public.tenants') IS NULL
     OR to_regclass('public.suppliers') IS NULL
     OR to_regclass('public.purchase_orders') IS NULL
     OR to_regclass('public.purchase_order_items') IS NULL
     OR to_regclass('public.purchase_order_receipts') IS NULL
     OR to_regclass('public.purchase_order_receipt_items') IS NULL
     OR to_regclass('public.accounting_settings') IS NULL
     OR to_regclass('public.accounting_periods') IS NULL
     OR to_regclass('public.accounting_accounts') IS NULL
     OR to_regclass('public.accounting_journal_entries') IS NULL THEN
    RAISE EXCEPTION 'Supplier payables requires the tenant-scoped purchasing and accounting migrations';
  END IF;

  IF to_regclass('public.supplier_bills') IS NOT NULL
     OR to_regclass('public.supplier_bill_lines') IS NOT NULL
     OR to_regclass('public.supplier_bill_events') IS NOT NULL
     OR to_regclass('public.supplier_payments') IS NOT NULL
     OR to_regclass('public.supplier_payment_allocations') IS NOT NULL
     OR to_regclass('public.supplier_payment_events') IS NOT NULL THEN
    RAISE EXCEPTION 'Supplier payables objects already exist; inspect the schema before retrying';
  END IF;

  IF to_regprocedure('uuid_generate_v4()') IS NULL THEN
    RAISE EXCEPTION 'Cannot create supplier payables: uuid_generate_v4() is unavailable';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.suppliers'::regclass
      AND conname = 'suppliers_tenant_id_id_unique' AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (tenant_id, id)'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.purchase_orders'::regclass
      AND conname = 'purchase_orders_tenant_id_id_unique' AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (tenant_id, id)'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.purchase_order_items'::regclass
      AND conname = 'purchase_order_items_tenant_order_product_unique' AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (tenant_id, purchase_order_id, id, product_id)'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.purchase_order_receipts'::regclass
      AND conname = 'purchase_order_receipts_order_id_unique' AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (tenant_id, purchase_order_id, id)'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.purchase_order_receipt_items'::regclass
      AND conname = 'purchase_order_receipt_items_once_per_line' AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (tenant_id, purchase_order_id, receipt_id, purchase_order_item_id)'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.accounting_accounts'::regclass
      AND conname = 'accounting_accounts_tenant_id_id_unique' AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (tenant_id, id)'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.accounting_periods'::regclass
      AND conname = 'accounting_periods_tenant_id_id_unique' AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (tenant_id, id)'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.accounting_journal_entries'::regclass
      AND conname = 'accounting_journal_entries_tenant_id_id_unique' AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (tenant_id, id)'
  ) THEN
    RAISE EXCEPTION 'Supplier payables requires the repository tenant-scoped purchasing/accounting keys';
  END IF;
END;
$$;

-- This key lets a bill line reference the precise receipt line and its PO line
-- in one tenant-scoped foreign key. Existing uniqueness already prevents
-- duplicate receipt/order-line pairs; the extended key adds no new business rule.
CREATE UNIQUE INDEX supplier_payables_receipt_line_reference_key
  ON public.purchase_order_receipt_items
     (tenant_id, purchase_order_id, receipt_id, purchase_order_item_id, id, product_id);
CREATE UNIQUE INDEX supplier_payables_po_supplier_reference_key
  ON public.purchase_orders (tenant_id, id, supplier_id);

CREATE TABLE public.supplier_bills (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  supplier_id uuid NOT NULL,
  purchase_order_id uuid,
  bill_number character varying(50) NOT NULL,
  supplier_invoice_number character varying(150) NOT NULL,
  bill_date date NOT NULL,
  due_date date NOT NULL,
  currency character(3) NOT NULL,
  subtotal numeric(12,2) NOT NULL,
  tax_amount numeric(12,2) NOT NULL DEFAULT 0,
  total numeric(12,2) NOT NULL,
  notes text,
  status character varying(16) NOT NULL DEFAULT 'draft',
  payable_account_id uuid,
  journal_entry_id uuid,
  reversal_journal_entry_id uuid,
  idempotency_key character varying(100) NOT NULL,
  payload_hash character(64) NOT NULL,
  approval_payload_hash character(64),
  reversal_idempotency_key character varying(100),
  reversal_payload_hash character(64),
  reversal_reason character varying(1800),
  created_by uuid NOT NULL,
  submitted_by uuid,
  approved_by uuid,
  cancelled_by uuid,
  reversed_by uuid,
  submitted_at timestamp with time zone,
  approved_at timestamp with time zone,
  cancelled_at timestamp with time zone,
  reversed_at timestamp with time zone,
  cancellation_reason character varying(1800),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT supplier_bills_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT supplier_bills_tenant_supplier_id_unique UNIQUE (tenant_id, supplier_id, id),
  CONSTRAINT supplier_bills_tenant_po_supplier_id_unique UNIQUE (tenant_id, purchase_order_id, supplier_id, id),
  CONSTRAINT supplier_bills_tenant_number_unique UNIQUE (tenant_id, bill_number),
  CONSTRAINT supplier_bills_tenant_idempotency_unique UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT supplier_bills_number_not_blank CHECK (btrim(bill_number) <> ''),
  CONSTRAINT supplier_bills_supplier_invoice_not_blank CHECK (btrim(supplier_invoice_number) <> ''),
  CONSTRAINT supplier_bills_idempotency_not_blank CHECK (btrim(idempotency_key) <> ''),
  CONSTRAINT supplier_bills_payload_hash_check CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT supplier_bills_approval_hash_check CHECK (approval_payload_hash IS NULL OR approval_payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT supplier_bills_reversal_hash_check CHECK (reversal_payload_hash IS NULL OR reversal_payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT supplier_bills_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT supplier_bills_dates_check CHECK (due_date >= bill_date),
  CONSTRAINT supplier_bills_amounts_check CHECK (subtotal >= 0 AND tax_amount >= 0 AND total > 0 AND total = subtotal + tax_amount),
  CONSTRAINT supplier_bills_status_check CHECK (status IN ('draft', 'submitted', 'approved', 'cancelled', 'reversed')),
  CONSTRAINT supplier_bills_submission_audit_check CHECK (
    status NOT IN ('submitted', 'approved', 'reversed') OR submitted_by IS NOT NULL AND submitted_at IS NOT NULL
  ),
  CONSTRAINT supplier_bills_posting_audit_check CHECK (
    (status IN ('approved', 'reversed') AND payable_account_id IS NOT NULL
      AND journal_entry_id IS NOT NULL AND approval_payload_hash IS NOT NULL
      AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
    OR (status IN ('draft', 'submitted', 'cancelled') AND journal_entry_id IS NULL)
  ),
  CONSTRAINT supplier_bills_cancel_audit_check CHECK (status <> 'cancelled' OR cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL AND cancellation_reason IS NOT NULL),
  CONSTRAINT supplier_bills_reverse_audit_check CHECK (
    (status = 'reversed' AND reversal_journal_entry_id IS NOT NULL AND reversal_idempotency_key IS NOT NULL
      AND reversal_payload_hash IS NOT NULL AND reversal_reason IS NOT NULL AND reversed_by IS NOT NULL AND reversed_at IS NOT NULL)
    OR (status <> 'reversed' AND reversal_journal_entry_id IS NULL)
  ),
  CONSTRAINT supplier_bills_supplier_fk FOREIGN KEY (tenant_id, supplier_id)
    REFERENCES public.suppliers (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT supplier_bills_purchase_order_fk FOREIGN KEY (tenant_id, purchase_order_id, supplier_id)
    REFERENCES public.purchase_orders (tenant_id, id, supplier_id) ON DELETE RESTRICT,
  CONSTRAINT supplier_bills_payable_account_fk FOREIGN KEY (tenant_id, payable_account_id)
    REFERENCES public.accounting_accounts (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT supplier_bills_journal_fk FOREIGN KEY (tenant_id, journal_entry_id)
    REFERENCES public.accounting_journal_entries (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT supplier_bills_reversal_journal_fk FOREIGN KEY (tenant_id, reversal_journal_entry_id)
    REFERENCES public.accounting_journal_entries (tenant_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX supplier_bills_supplier_invoice_ci_unique_idx
  ON public.supplier_bills (tenant_id, supplier_id, lower(btrim(supplier_invoice_number)));
CREATE INDEX supplier_bills_supplier_history_idx
  ON public.supplier_bills (tenant_id, supplier_id, bill_date DESC, created_at DESC);
CREATE INDEX supplier_bills_status_due_idx
  ON public.supplier_bills (tenant_id, status, due_date);
CREATE INDEX supplier_bills_purchase_order_idx
  ON public.supplier_bills (tenant_id, purchase_order_id)
  WHERE purchase_order_id IS NOT NULL;

CREATE TABLE public.supplier_bill_lines (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  supplier_bill_id uuid NOT NULL,
  line_number integer NOT NULL,
  description character varying(1000) NOT NULL,
  quantity numeric(12,3) NOT NULL,
  unit_price numeric(12,2) NOT NULL,
  line_subtotal numeric(12,2) NOT NULL,
  tax_rate numeric(5,2) NOT NULL DEFAULT 0,
  tax_amount numeric(12,2) NOT NULL DEFAULT 0,
  line_total numeric(12,2) GENERATED ALWAYS AS (line_subtotal + tax_amount) STORED,
  account_id uuid NOT NULL,
  purchase_order_id uuid,
  purchase_order_item_id uuid,
  product_id uuid,
  receipt_id uuid,
  purchase_order_receipt_item_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT supplier_bill_lines_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT supplier_bill_lines_bill_line_unique UNIQUE (tenant_id, supplier_bill_id, line_number),
  CONSTRAINT supplier_bill_lines_values_check CHECK (
    line_number > 0 AND btrim(description) <> '' AND quantity > 0 AND unit_price >= 0
    AND line_subtotal = round(quantity * unit_price, 2)
    AND tax_rate >= 0 AND tax_rate <= 100
    AND tax_amount = round(line_subtotal * tax_rate / 100, 2)
  ),
  CONSTRAINT supplier_bill_lines_reference_shape_check CHECK (
    (purchase_order_id IS NULL AND purchase_order_item_id IS NULL AND product_id IS NULL
      AND receipt_id IS NULL AND purchase_order_receipt_item_id IS NULL)
    OR (purchase_order_id IS NOT NULL AND purchase_order_item_id IS NOT NULL AND product_id IS NOT NULL
      AND ((receipt_id IS NULL AND purchase_order_receipt_item_id IS NULL)
        OR (receipt_id IS NOT NULL AND purchase_order_receipt_item_id IS NOT NULL)))
  ),
  CONSTRAINT supplier_bill_lines_bill_fk FOREIGN KEY (tenant_id, supplier_id, supplier_bill_id)
    REFERENCES public.supplier_bills (tenant_id, supplier_id, id) ON DELETE RESTRICT,
  CONSTRAINT supplier_bill_lines_bill_po_fk FOREIGN KEY (tenant_id, purchase_order_id, supplier_id, supplier_bill_id)
    REFERENCES public.supplier_bills (tenant_id, purchase_order_id, supplier_id, id) ON DELETE RESTRICT,
  CONSTRAINT supplier_bill_lines_account_fk FOREIGN KEY (tenant_id, account_id)
    REFERENCES public.accounting_accounts (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT supplier_bill_lines_purchase_order_item_fk FOREIGN KEY
    (tenant_id, purchase_order_id, purchase_order_item_id, product_id)
    REFERENCES public.purchase_order_items (tenant_id, purchase_order_id, id, product_id) ON DELETE RESTRICT,
  CONSTRAINT supplier_bill_lines_receipt_item_fk FOREIGN KEY
    (tenant_id, purchase_order_id, receipt_id, purchase_order_item_id, purchase_order_receipt_item_id, product_id)
    REFERENCES public.purchase_order_receipt_items
      (tenant_id, purchase_order_id, receipt_id, purchase_order_item_id, id, product_id) ON DELETE RESTRICT
);

CREATE INDEX supplier_bill_lines_account_idx
  ON public.supplier_bill_lines (tenant_id, account_id);
CREATE INDEX supplier_bill_lines_po_line_idx
  ON public.supplier_bill_lines (tenant_id, purchase_order_id, purchase_order_item_id)
  WHERE purchase_order_item_id IS NOT NULL;

CREATE TABLE public.supplier_bill_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  supplier_bill_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  event_type character varying(30) NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT supplier_bill_events_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT supplier_bill_events_bill_fk FOREIGN KEY (tenant_id, supplier_bill_id)
    REFERENCES public.supplier_bills (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT supplier_bill_events_type_check CHECK (event_type IN ('created', 'updated', 'submitted', 'approved', 'cancelled', 'reversed'))
);
CREATE INDEX supplier_bill_events_history_idx
  ON public.supplier_bill_events (tenant_id, supplier_bill_id, created_at, id);

CREATE TABLE public.supplier_payments (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  payment_number character varying(50) NOT NULL,
  amount numeric(12,2) NOT NULL,
  currency character(3) NOT NULL,
  payment_date date NOT NULL,
  payment_method character varying(20) NOT NULL,
  payment_reference character varying(255) NOT NULL,
  notes text,
  status character varying(12) NOT NULL DEFAULT 'pending',
  cash_account_id uuid,
  journal_entry_id uuid,
  reversal_journal_entry_id uuid,
  idempotency_key character varying(100) NOT NULL,
  payload_hash character(64) NOT NULL,
  verification_payload_hash character(64),
  reversal_idempotency_key character varying(100),
  reversal_payload_hash character(64),
  reversal_reason character varying(1800),
  failure_reason character varying(1800),
  created_by uuid NOT NULL,
  verified_by uuid,
  failed_by uuid,
  reversed_by uuid,
  verified_at timestamp with time zone,
  failed_at timestamp with time zone,
  reversed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT supplier_payments_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT supplier_payments_tenant_supplier_id_unique UNIQUE (tenant_id, supplier_id, id),
  CONSTRAINT supplier_payments_tenant_number_unique UNIQUE (tenant_id, payment_number),
  CONSTRAINT supplier_payments_tenant_idempotency_unique UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT supplier_payments_number_not_blank CHECK (btrim(payment_number) <> ''),
  CONSTRAINT supplier_payments_reference_not_blank CHECK (btrim(payment_reference) <> ''),
  CONSTRAINT supplier_payments_amount_positive CHECK (amount > 0),
  CONSTRAINT supplier_payments_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT supplier_payments_method_check CHECK (payment_method IN ('cash', 'bank_transfer', 'card', 'cheque', 'mpesa', 'other')),
  CONSTRAINT supplier_payments_status_check CHECK (status IN ('pending', 'verified', 'failed', 'reversed')),
  CONSTRAINT supplier_payments_hashes_check CHECK (
    payload_hash ~ '^[0-9a-f]{64}$'
    AND (verification_payload_hash IS NULL OR verification_payload_hash ~ '^[0-9a-f]{64}$')
    AND (reversal_payload_hash IS NULL OR reversal_payload_hash ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT supplier_payments_verified_audit_check CHECK (
    (status IN ('verified', 'reversed') AND cash_account_id IS NOT NULL AND journal_entry_id IS NOT NULL
      AND verification_payload_hash IS NOT NULL AND verified_by IS NOT NULL AND verified_at IS NOT NULL)
    OR (status IN ('pending', 'failed') AND journal_entry_id IS NULL)
  ),
  CONSTRAINT supplier_payments_failed_audit_check CHECK (status <> 'failed' OR failed_by IS NOT NULL AND failed_at IS NOT NULL AND failure_reason IS NOT NULL),
  CONSTRAINT supplier_payments_reversal_audit_check CHECK (
    (status = 'reversed' AND reversal_journal_entry_id IS NOT NULL AND reversal_idempotency_key IS NOT NULL
      AND reversal_payload_hash IS NOT NULL AND reversal_reason IS NOT NULL AND reversed_by IS NOT NULL AND reversed_at IS NOT NULL)
    OR (status <> 'reversed' AND reversal_journal_entry_id IS NULL)
  ),
  CONSTRAINT supplier_payments_supplier_fk FOREIGN KEY (tenant_id, supplier_id)
    REFERENCES public.suppliers (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT supplier_payments_cash_account_fk FOREIGN KEY (tenant_id, cash_account_id)
    REFERENCES public.accounting_accounts (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT supplier_payments_journal_fk FOREIGN KEY (tenant_id, journal_entry_id)
    REFERENCES public.accounting_journal_entries (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT supplier_payments_reversal_journal_fk FOREIGN KEY (tenant_id, reversal_journal_entry_id)
    REFERENCES public.accounting_journal_entries (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX supplier_payments_supplier_history_idx
  ON public.supplier_payments (tenant_id, supplier_id, payment_date DESC, created_at DESC);
CREATE INDEX supplier_payments_status_date_idx
  ON public.supplier_payments (tenant_id, status, payment_date DESC);

CREATE TABLE public.supplier_payment_allocations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  supplier_payment_id uuid NOT NULL,
  supplier_bill_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT supplier_payment_allocations_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT supplier_payment_allocations_once_per_bill UNIQUE (tenant_id, supplier_payment_id, supplier_bill_id),
  CONSTRAINT supplier_payment_allocations_amount_positive CHECK (amount > 0),
  CONSTRAINT supplier_payment_allocations_payment_fk FOREIGN KEY (tenant_id, supplier_id, supplier_payment_id)
    REFERENCES public.supplier_payments (tenant_id, supplier_id, id) ON DELETE RESTRICT,
  CONSTRAINT supplier_payment_allocations_bill_fk FOREIGN KEY (tenant_id, supplier_id, supplier_bill_id)
    REFERENCES public.supplier_bills (tenant_id, supplier_id, id) ON DELETE RESTRICT
);

CREATE FUNCTION public.supplier_payables_validate_payment_allocation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_payment public.supplier_payments%ROWTYPE;
  v_bill public.supplier_bills%ROWTYPE;
BEGIN
  SELECT * INTO v_payment FROM public.supplier_payments
   WHERE tenant_id = NEW.tenant_id AND id = NEW.supplier_payment_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'supplier payment allocation references no payment' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_bill FROM public.supplier_bills
   WHERE tenant_id = NEW.tenant_id AND id = NEW.supplier_bill_id FOR SHARE;
  IF NOT FOUND OR v_payment.supplier_id <> NEW.supplier_id OR v_bill.supplier_id <> NEW.supplier_id THEN
    RAISE EXCEPTION 'supplier payment and bill must belong to the same tenant supplier' USING ERRCODE = '23514';
  END IF;
  IF v_payment.currency <> v_bill.currency OR v_bill.status <> 'approved' THEN
    RAISE EXCEPTION 'payment allocation requires an approved same-currency supplier bill' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER supplier_payment_allocations_validate
BEFORE INSERT ON public.supplier_payment_allocations
FOR EACH ROW EXECUTE FUNCTION public.supplier_payables_validate_payment_allocation();

CREATE INDEX supplier_payment_allocations_bill_idx
  ON public.supplier_payment_allocations (tenant_id, supplier_bill_id);

CREATE TABLE public.supplier_payment_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  supplier_payment_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  event_type character varying(20) NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT supplier_payment_events_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT supplier_payment_events_payment_fk FOREIGN KEY (tenant_id, supplier_payment_id)
    REFERENCES public.supplier_payments (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT supplier_payment_events_type_check CHECK (event_type IN ('created', 'verified', 'failed', 'reversed'))
);
CREATE INDEX supplier_payment_events_history_idx
  ON public.supplier_payment_events (tenant_id, supplier_payment_id, created_at, id);

CREATE FUNCTION public.supplier_payables_guard_immutable_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER supplier_bill_events_immutable
BEFORE UPDATE OR DELETE ON public.supplier_bill_events
FOR EACH ROW EXECUTE FUNCTION public.supplier_payables_guard_immutable_history();
CREATE TRIGGER supplier_payment_events_immutable
BEFORE UPDATE OR DELETE ON public.supplier_payment_events
FOR EACH ROW EXECUTE FUNCTION public.supplier_payables_guard_immutable_history();
CREATE TRIGGER supplier_payment_allocations_immutable
BEFORE UPDATE OR DELETE ON public.supplier_payment_allocations
FOR EACH ROW EXECUTE FUNCTION public.supplier_payables_guard_immutable_history();

CREATE FUNCTION public.supplier_payables_guard_bill_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' OR OLD.journal_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'submitted or posted supplier bills cannot be deleted' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.journal_entry_id IS NOT NULL THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
       OR NEW.purchase_order_id IS DISTINCT FROM OLD.purchase_order_id
       OR NEW.bill_number IS DISTINCT FROM OLD.bill_number
       OR NEW.supplier_invoice_number IS DISTINCT FROM OLD.supplier_invoice_number
       OR NEW.bill_date IS DISTINCT FROM OLD.bill_date
       OR NEW.due_date IS DISTINCT FROM OLD.due_date
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.subtotal IS DISTINCT FROM OLD.subtotal
       OR NEW.tax_amount IS DISTINCT FROM OLD.tax_amount
       OR NEW.total IS DISTINCT FROM OLD.total
       OR NEW.notes IS DISTINCT FROM OLD.notes
       OR NEW.payable_account_id IS DISTINCT FROM OLD.payable_account_id
       OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id
       OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
       OR NEW.approval_payload_hash IS DISTINCT FROM OLD.approval_payload_hash
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
       OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
       OR NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by
       OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
       OR NEW.cancellation_reason IS DISTINCT FROM OLD.cancellation_reason
       OR NEW.status <> 'reversed' OR OLD.status <> 'approved' THEN
      RAISE EXCEPTION 'posted supplier bills are immutable except for a linked reversal' USING ERRCODE = '55000';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.accounting_journal_entries journal
      WHERE journal.tenant_id = NEW.tenant_id AND journal.id = NEW.reversal_journal_entry_id
        AND journal.status = 'posted' AND journal.reversal_of_entry_id = OLD.journal_entry_id
    ) THEN
      RAISE EXCEPTION 'supplier bill reversal must reference a posted reversal journal' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.journal_entry_id IS NOT NULL THEN
    IF OLD.status <> 'submitted' OR NEW.status <> 'approved' OR NOT EXISTS (
      SELECT 1 FROM public.accounting_journal_entries journal
      WHERE journal.tenant_id = NEW.tenant_id AND journal.id = NEW.journal_entry_id
        AND journal.status = 'posted' AND journal.source_type = 'supplier_bill'
        AND journal.source_id = NEW.id AND journal.event_type = 'approve'
    ) THEN
      RAISE EXCEPTION 'supplier bill approval must reference its posted accounting journal' USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status NOT IN ('draft', 'submitted') THEN
    RAISE EXCEPTION 'cancelled supplier bills are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER supplier_bills_immutable_posting
BEFORE UPDATE OR DELETE ON public.supplier_bills
FOR EACH ROW EXECUTE FUNCTION public.supplier_payables_guard_bill_mutation();

CREATE FUNCTION public.supplier_payables_guard_bill_line_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_tenant_id uuid;
  v_bill_id uuid;
  v_journal_id uuid;
BEGIN
  v_tenant_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
  v_bill_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.supplier_bill_id ELSE NEW.supplier_bill_id END;
  SELECT journal_entry_id INTO v_journal_id FROM public.supplier_bills
   WHERE tenant_id = v_tenant_id AND id = v_bill_id;
  IF v_journal_id IS NOT NULL THEN
    RAISE EXCEPTION 'supplier bill lines cannot change after posting' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER supplier_bill_lines_immutable_posting
BEFORE UPDATE OR DELETE ON public.supplier_bill_lines
FOR EACH ROW EXECUTE FUNCTION public.supplier_payables_guard_bill_line_mutation();

CREATE FUNCTION public.supplier_payables_guard_payment_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'pending' OR OLD.journal_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'failed or posted supplier payments cannot be deleted' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.journal_entry_id IS NOT NULL THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
       OR NEW.payment_number IS DISTINCT FROM OLD.payment_number
       OR NEW.amount IS DISTINCT FROM OLD.amount
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.payment_date IS DISTINCT FROM OLD.payment_date
       OR NEW.payment_method IS DISTINCT FROM OLD.payment_method
       OR NEW.payment_reference IS DISTINCT FROM OLD.payment_reference
       OR NEW.notes IS DISTINCT FROM OLD.notes
       OR NEW.cash_account_id IS DISTINCT FROM OLD.cash_account_id
       OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
       OR NEW.verified_by IS DISTINCT FROM OLD.verified_by
       OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
       OR NEW.verification_payload_hash IS DISTINCT FROM OLD.verification_payload_hash
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.failed_by IS DISTINCT FROM OLD.failed_by
       OR NEW.failed_at IS DISTINCT FROM OLD.failed_at
       OR NEW.failure_reason IS DISTINCT FROM OLD.failure_reason
       OR NEW.status <> 'reversed' OR OLD.status <> 'verified' THEN
      RAISE EXCEPTION 'posted supplier payments are immutable except for a linked reversal' USING ERRCODE = '55000';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.accounting_journal_entries journal
      WHERE journal.tenant_id = NEW.tenant_id AND journal.id = NEW.reversal_journal_entry_id
        AND journal.status = 'posted' AND journal.reversal_of_entry_id = OLD.journal_entry_id
    ) THEN
      RAISE EXCEPTION 'supplier payment reversal must reference a posted reversal journal' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.journal_entry_id IS NOT NULL THEN
    IF OLD.status <> 'pending' OR NEW.status <> 'verified' OR NOT EXISTS (
      SELECT 1 FROM public.accounting_journal_entries journal
      WHERE journal.tenant_id = NEW.tenant_id AND journal.id = NEW.journal_entry_id
        AND journal.status = 'posted' AND journal.source_type = 'supplier_payment'
        AND journal.source_id = NEW.id AND journal.event_type = 'verify'
    ) THEN
      RAISE EXCEPTION 'supplier payment verification must reference its posted accounting journal' USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'failed supplier payments are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER supplier_payments_immutable_posting
BEFORE UPDATE OR DELETE ON public.supplier_payments
FOR EACH ROW EXECUTE FUNCTION public.supplier_payables_guard_payment_mutation();

CREATE FUNCTION public.supplier_payables_assert_bill_totals()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_tenant_id uuid;
  v_bill_id uuid;
  v_subtotal numeric(12,2);
  v_tax numeric(12,2);
  v_total numeric(12,2);
  v_line_subtotal numeric(12,2);
  v_line_tax numeric(12,2);
BEGIN
  IF TG_TABLE_NAME = 'supplier_bills' THEN
    v_tenant_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
    v_bill_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  ELSE
    v_tenant_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
    v_bill_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.supplier_bill_id ELSE NEW.supplier_bill_id END;
  END IF;
  SELECT subtotal, tax_amount, total INTO v_subtotal, v_tax, v_total
  FROM public.supplier_bills WHERE tenant_id = v_tenant_id AND id = v_bill_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(line_subtotal), 0), COALESCE(SUM(tax_amount), 0)
    INTO v_line_subtotal, v_line_tax
  FROM public.supplier_bill_lines WHERE tenant_id = v_tenant_id AND supplier_bill_id = v_bill_id;
  IF v_subtotal <> v_line_subtotal OR v_tax <> v_line_tax OR v_total <> v_line_subtotal + v_line_tax THEN
    RAISE EXCEPTION 'supplier bill totals must equal the sum of its lines' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER supplier_bills_totals_consistent
AFTER INSERT OR UPDATE ON public.supplier_bills
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.supplier_payables_assert_bill_totals();
CREATE CONSTRAINT TRIGGER supplier_bill_lines_totals_consistent
AFTER INSERT OR UPDATE OR DELETE ON public.supplier_bill_lines
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.supplier_payables_assert_bill_totals();

CREATE FUNCTION public.supplier_payables_assert_payment_allocations()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_tenant_id uuid;
  v_payment_id uuid;
  v_amount numeric(12,2);
  v_allocated numeric(12,2);
BEGIN
  IF TG_TABLE_NAME = 'supplier_payments' THEN
    v_tenant_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
    v_payment_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  ELSE
    v_tenant_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
    v_payment_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.supplier_payment_id ELSE NEW.supplier_payment_id END;
  END IF;
  SELECT amount INTO v_amount FROM public.supplier_payments
    WHERE tenant_id = v_tenant_id AND id = v_payment_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(amount), 0) INTO v_allocated FROM public.supplier_payment_allocations
    WHERE tenant_id = v_tenant_id AND supplier_payment_id = v_payment_id;
  IF v_amount <> v_allocated THEN
    RAISE EXCEPTION 'supplier payment allocations must equal the payment amount' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER supplier_payments_allocations_consistent
AFTER INSERT OR UPDATE ON public.supplier_payments
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.supplier_payables_assert_payment_allocations();
CREATE CONSTRAINT TRIGGER supplier_payment_allocations_total_consistent
AFTER INSERT OR UPDATE OR DELETE ON public.supplier_payment_allocations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.supplier_payables_assert_payment_allocations();

COMMIT;

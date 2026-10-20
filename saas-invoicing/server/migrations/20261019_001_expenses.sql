-- Tenant-scoped expense categories, draft records, and approval/payment history.
-- Depends on 20261018_002_suppliers_and_purchasing.sql for tenant-safe suppliers.
-- Forward-only. Review and test on a disposable database snapshot before applying.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$
BEGIN
  IF to_regclass('public.tenants') IS NULL OR to_regclass('public.suppliers') IS NULL THEN
    RAISE EXCEPTION 'Expenses require the existing tenant table and 20261018_002 suppliers migration';
  END IF;

  IF to_regclass('public.expense_categories') IS NOT NULL OR to_regclass('public.expenses') IS NOT NULL THEN
    RAISE EXCEPTION 'Expense tables already exist; inspect schema before retrying this migration';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('public.tenants') AND attname = 'id'
      AND atttypid = 'uuid'::regtype AND attnum > 0 AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_attribute a
      ON a.attrelid = i.indrelid AND a.attname = 'id'
     AND a.attnum > 0 AND NOT a.attisdropped
    WHERE i.indrelid = to_regclass('public.tenants')
      AND i.indisunique AND i.indisvalid AND i.indisready
      AND i.indpred IS NULL AND i.indexprs IS NULL
      AND i.indnkeyatts = 1 AND i.indkey[0] = a.attnum
  ) THEN
    RAISE EXCEPTION 'Expenses require tenants.id to be a UUID with a valid unique key';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = to_regclass('public.suppliers')
      AND conname = 'suppliers_tenant_id_id_unique' AND contype = 'u'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('public.suppliers') AND attname = 'tenant_id'
      AND atttypid = 'uuid'::regtype AND attnum > 0 AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('public.suppliers') AND attname = 'id'
      AND atttypid = 'uuid'::regtype AND attnum > 0 AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('public.suppliers') AND attname = 'business_name'
      AND attnum > 0 AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('public.suppliers') AND attname = 'is_active'
      AND atttypid = 'boolean'::regtype AND attnum > 0 AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'Expenses require tenant-safe supplier keys from 20261018_002';
  END IF;

  IF to_regprocedure('uuid_generate_v4()') IS NULL THEN
    RAISE EXCEPTION 'Cannot create expenses: uuid_generate_v4() is unavailable';
  END IF;
END;
$$;

CREATE TABLE public.expense_categories (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  name character varying(100) NOT NULL,
  description character varying(1000),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT expense_categories_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT expense_categories_tenant_id_unique UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX expense_categories_tenant_name_ci_unique_idx
  ON public.expense_categories (tenant_id, lower(btrim(name)));

CREATE TABLE public.expenses (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  expense_number character varying(50) NOT NULL,
  expense_date date NOT NULL,
  category_id uuid NOT NULL,
  supplier_id uuid,
  payee_name character varying(255),
  description character varying(2000) NOT NULL,
  amount numeric(12,2) NOT NULL,
  currency character(3) NOT NULL DEFAULT 'KES',
  payment_method character varying(20),
  payment_reference character varying(255),
  notes text,
  status character varying(16) NOT NULL DEFAULT 'draft',
  idempotency_key character varying(100),
  created_by uuid NOT NULL,
  approved_by uuid,
  paid_by uuid,
  cancelled_by uuid,
  approved_at timestamp without time zone,
  paid_at timestamp without time zone,
  cancelled_at timestamp without time zone,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT expenses_number_not_blank CHECK (btrim(expense_number) <> ''),
  CONSTRAINT expenses_description_not_blank CHECK (btrim(description) <> ''),
  CONSTRAINT expenses_amount_positive CHECK (amount > 0),
  CONSTRAINT expenses_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT expenses_status_check CHECK (status IN ('draft', 'approved', 'paid', 'cancelled')),
  CONSTRAINT expenses_payment_method_check
    CHECK (payment_method IS NULL OR payment_method IN ('cash', 'bank_transfer', 'card', 'mpesa', 'cheque', 'other')),
  CONSTRAINT expenses_payment_reference_not_blank
    CHECK (payment_reference IS NULL OR btrim(payment_reference) <> ''),
  CONSTRAINT expenses_approved_audit_check
    CHECK (status NOT IN ('approved', 'paid') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CONSTRAINT expenses_paid_audit_check
    CHECK (status <> 'paid' OR (paid_by IS NOT NULL AND paid_at IS NOT NULL AND payment_method IS NOT NULL)),
  CONSTRAINT expenses_cancelled_audit_check
    CHECK (status <> 'cancelled' OR (cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL)),
  CONSTRAINT expenses_tenant_number_unique UNIQUE (tenant_id, expense_number),
  CONSTRAINT expenses_tenant_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT expenses_category_tenant_fk
    FOREIGN KEY (tenant_id, category_id)
    REFERENCES public.expense_categories (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT expenses_supplier_tenant_fk
    FOREIGN KEY (tenant_id, supplier_id)
    REFERENCES public.suppliers (tenant_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX expenses_tenant_idempotency_unique_idx
  ON public.expenses (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX expenses_tenant_date_idx
  ON public.expenses (tenant_id, expense_date DESC, created_at DESC);
CREATE INDEX expenses_tenant_status_date_idx
  ON public.expenses (tenant_id, status, expense_date DESC);
CREATE INDEX expenses_tenant_category_date_idx
  ON public.expenses (tenant_id, category_id, expense_date DESC);
CREATE INDEX expenses_tenant_supplier_date_idx
  ON public.expenses (tenant_id, supplier_id, expense_date DESC)
  WHERE supplier_id IS NOT NULL;

COMMIT;

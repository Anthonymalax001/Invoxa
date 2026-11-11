-- Add tenant-scoped invoice tax configuration and immutable calculation snapshots.
-- Depends on 20261021_001_accounting_foundation.sql. Does not alter business tables
-- or post historical invoices. Apply once to a reviewed disposable snapshot first.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$
BEGIN
  IF to_regclass('public.tenants') IS NULL
     OR to_regclass('public.accounting_accounts') IS NULL
     OR to_regclass('public.accounting_journal_entries') IS NULL THEN
    RAISE EXCEPTION 'Invoice accounting configuration requires the accounting foundation and tenant tables';
  END IF;
  IF to_regprocedure('uuid_generate_v4()') IS NULL THEN
    RAISE EXCEPTION 'Invoice accounting configuration requires uuid_generate_v4()';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = to_regclass('public.accounting_accounts')
      AND conname = 'accounting_accounts_tenant_id_id_unique' AND contype = 'u'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = to_regclass('public.accounting_journal_entries')
      AND conname = 'accounting_journal_entries_tenant_id_id_unique' AND contype = 'u'
  ) THEN
    RAISE EXCEPTION 'Invoice accounting configuration requires tenant-scoped accounting account and journal keys';
  END IF;
END;
$$;

CREATE TABLE public.accounting_invoice_mappings (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE RESTRICT,
  receivables_account_id uuid NOT NULL,
  sales_revenue_account_id uuid NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT accounting_invoice_mappings_distinct_accounts_check
    CHECK (receivables_account_id <> sales_revenue_account_id),
  CONSTRAINT accounting_invoice_mappings_receivables_fk
    FOREIGN KEY (tenant_id, receivables_account_id)
    REFERENCES public.accounting_accounts (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT accounting_invoice_mappings_revenue_fk
    FOREIGN KEY (tenant_id, sales_revenue_account_id)
    REFERENCES public.accounting_accounts (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.accounting_tax_profiles (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  profile_key character varying(50) NOT NULL,
  name character varying(150) NOT NULL,
  version integer NOT NULL,
  tax_rate numeric(5,2) NOT NULL,
  calculation_method character varying(12) NOT NULL,
  rounding_method character varying(20) NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  requires_tax_payable boolean NOT NULL,
  tax_payable_account_id uuid,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT accounting_tax_profiles_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT accounting_tax_profiles_tenant_version_unique UNIQUE (tenant_id, profile_key, version),
  CONSTRAINT accounting_tax_profiles_profile_key_check CHECK (btrim(profile_key) <> ''),
  CONSTRAINT accounting_tax_profiles_name_check CHECK (btrim(name) <> ''),
  CONSTRAINT accounting_tax_profiles_version_check CHECK (version > 0),
  CONSTRAINT accounting_tax_profiles_rate_check CHECK (tax_rate >= 0 AND tax_rate <= 100),
  CONSTRAINT accounting_tax_profiles_method_check CHECK (calculation_method IN ('exclusive', 'inclusive')),
  CONSTRAINT accounting_tax_profiles_rounding_check CHECK (rounding_method IN ('invoice_total', 'line_item')),
  CONSTRAINT accounting_tax_profiles_date_check CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT accounting_tax_profiles_payable_check CHECK (
    (requires_tax_payable AND tax_payable_account_id IS NOT NULL) OR
    (NOT requires_tax_payable AND tax_payable_account_id IS NULL)
  ),
  CONSTRAINT accounting_tax_profiles_positive_tax_payable_check CHECK (tax_rate = 0 OR requires_tax_payable),
  CONSTRAINT accounting_tax_profiles_payable_fk
    FOREIGN KEY (tenant_id, tax_payable_account_id)
    REFERENCES public.accounting_accounts (tenant_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX accounting_tax_profiles_one_active_key_idx
  ON public.accounting_tax_profiles (tenant_id, profile_key)
  WHERE is_active;
CREATE INDEX accounting_tax_profiles_tenant_effective_idx
  ON public.accounting_tax_profiles (tenant_id, effective_from DESC, profile_key, version DESC);

CREATE FUNCTION public.accounting_guard_tax_profile_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Tax profile versions are retained for audit history'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR OLD.id IS DISTINCT FROM NEW.id
     OR OLD.profile_key IS DISTINCT FROM NEW.profile_key
     OR OLD.name IS DISTINCT FROM NEW.name
     OR OLD.version IS DISTINCT FROM NEW.version
     OR OLD.tax_rate IS DISTINCT FROM NEW.tax_rate
     OR OLD.calculation_method IS DISTINCT FROM NEW.calculation_method
     OR OLD.rounding_method IS DISTINCT FROM NEW.rounding_method
     OR OLD.effective_from IS DISTINCT FROM NEW.effective_from
     OR OLD.requires_tax_payable IS DISTINCT FROM NEW.requires_tax_payable
     OR OLD.tax_payable_account_id IS DISTINCT FROM NEW.tax_payable_account_id
     OR OLD.created_by IS DISTINCT FROM NEW.created_by
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'Tax profile versions are immutable; create a new version'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.is_active = false AND NEW.is_active = true THEN
    RAISE EXCEPTION 'Deactivated tax profile versions cannot be reactivated'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.effective_to IS DISTINCT FROM NEW.effective_to AND NOT (
    NEW.effective_to IS NOT NULL
    AND NEW.effective_to >= OLD.effective_from
    AND (OLD.effective_to IS NULL OR NEW.effective_to < OLD.effective_to)
    AND NEW.is_active = false
  ) THEN
    RAISE EXCEPTION 'Tax profile effective dates are immutable except when ending a version'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_tax_profiles_immutable
BEFORE UPDATE OR DELETE ON public.accounting_tax_profiles
FOR EACH ROW EXECUTE FUNCTION public.accounting_guard_tax_profile_mutation();

CREATE TABLE public.accounting_invoice_tax_snapshots (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  source_type character varying(20) NOT NULL,
  source_id uuid NOT NULL,
  tax_profile_id uuid NOT NULL,
  profile_version integer NOT NULL,
  profile_key character varying(50) NOT NULL,
  profile_name character varying(150) NOT NULL,
  tax_rate numeric(5,2) NOT NULL,
  calculation_method character varying(12) NOT NULL,
  rounding_method character varying(20) NOT NULL,
  requires_tax_payable boolean NOT NULL,
  tax_payable_account_id uuid,
  subtotal numeric(12,2) NOT NULL,
  tax_amount numeric(12,2) NOT NULL,
  total numeric(12,2) NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  issued_on date,
  issued_by uuid,
  issued_at timestamp with time zone,
  journal_entry_id uuid,
  CONSTRAINT accounting_invoice_tax_snapshots_tenant_source_unique
    UNIQUE (tenant_id, source_type, source_id),
  CONSTRAINT accounting_invoice_tax_snapshots_source_type_check
    CHECK (source_type IN ('invoice', 'sales_order')),
  CONSTRAINT accounting_invoice_tax_snapshots_version_check CHECK (profile_version > 0),
  CONSTRAINT accounting_invoice_tax_snapshots_rate_check CHECK (tax_rate >= 0 AND tax_rate <= 100),
  CONSTRAINT accounting_invoice_tax_snapshots_method_check CHECK (calculation_method IN ('exclusive', 'inclusive')),
  CONSTRAINT accounting_invoice_tax_snapshots_rounding_check CHECK (rounding_method IN ('invoice_total', 'line_item')),
  CONSTRAINT accounting_invoice_tax_snapshots_payable_check CHECK (
    (requires_tax_payable AND tax_payable_account_id IS NOT NULL) OR
    (NOT requires_tax_payable AND tax_payable_account_id IS NULL)
  ),
  CONSTRAINT accounting_invoice_tax_snapshots_amounts_check
    CHECK (subtotal >= 0 AND tax_amount >= 0 AND total >= 0),
  CONSTRAINT accounting_invoice_tax_snapshots_total_check CHECK (total = subtotal + tax_amount),
  CONSTRAINT accounting_invoice_tax_snapshots_issue_check CHECK (
    (issued_on IS NULL AND issued_by IS NULL AND issued_at IS NULL AND journal_entry_id IS NULL) OR
    (source_type = 'invoice' AND issued_on IS NOT NULL AND issued_by IS NOT NULL
      AND issued_at IS NOT NULL AND journal_entry_id IS NOT NULL)
  ),
  CONSTRAINT accounting_invoice_tax_snapshots_profile_fk
    FOREIGN KEY (tenant_id, tax_profile_id)
    REFERENCES public.accounting_tax_profiles (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT accounting_invoice_tax_snapshots_payable_fk
    FOREIGN KEY (tenant_id, tax_payable_account_id)
    REFERENCES public.accounting_accounts (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT accounting_invoice_tax_snapshots_journal_fk
    FOREIGN KEY (tenant_id, journal_entry_id)
    REFERENCES public.accounting_journal_entries (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX accounting_invoice_tax_snapshots_profile_idx
  ON public.accounting_invoice_tax_snapshots (tenant_id, tax_profile_id, profile_version);
CREATE INDEX accounting_invoice_tax_snapshots_journal_idx
  ON public.accounting_invoice_tax_snapshots (tenant_id, journal_entry_id)
  WHERE journal_entry_id IS NOT NULL;

CREATE FUNCTION public.accounting_guard_invoice_tax_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.issued_at IS NOT NULL THEN
      RAISE EXCEPTION 'Issued invoice tax snapshots are immutable'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.issued_at IS NOT NULL THEN
    RAISE EXCEPTION 'Issued invoice tax snapshots are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.issued_at IS NOT NULL AND (
    NEW.source_type <> 'invoice'
    OR NEW.issued_on IS NULL OR NEW.issued_by IS NULL OR NEW.journal_entry_id IS NULL
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.source_type IS DISTINCT FROM OLD.source_type
    OR NEW.source_id IS DISTINCT FROM OLD.source_id
    OR NEW.tax_profile_id IS DISTINCT FROM OLD.tax_profile_id
    OR NEW.profile_version IS DISTINCT FROM OLD.profile_version
    OR NEW.profile_key IS DISTINCT FROM OLD.profile_key
    OR NEW.profile_name IS DISTINCT FROM OLD.profile_name
    OR NEW.tax_rate IS DISTINCT FROM OLD.tax_rate
    OR NEW.calculation_method IS DISTINCT FROM OLD.calculation_method
    OR NEW.rounding_method IS DISTINCT FROM OLD.rounding_method
    OR NEW.requires_tax_payable IS DISTINCT FROM OLD.requires_tax_payable
    OR NEW.tax_payable_account_id IS DISTINCT FROM OLD.tax_payable_account_id
    OR NEW.subtotal IS DISTINCT FROM OLD.subtotal
    OR NEW.tax_amount IS DISTINCT FROM OLD.tax_amount
    OR NEW.total IS DISTINCT FROM OLD.total
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Invoice tax snapshot may only be finalized once without changing its calculation'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_invoice_tax_snapshots_immutable
BEFORE UPDATE OR DELETE ON public.accounting_invoice_tax_snapshots
FOR EACH ROW EXECUTE FUNCTION public.accounting_guard_invoice_tax_snapshot_mutation();

COMMIT;

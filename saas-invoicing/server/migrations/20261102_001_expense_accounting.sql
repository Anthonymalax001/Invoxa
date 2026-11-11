-- Connects existing tenant expense records to the accounting journal.
-- Requires 20261019_001_expenses.sql and 20261021_001_accounting_foundation.sql.
-- Forward-only and additive: legacy approved/paid expenses are not backfilled.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$
BEGIN
  IF to_regclass('public.accounting_settings') IS NULL
     OR to_regclass('public.accounting_accounts') IS NULL
     OR to_regclass('public.accounting_periods') IS NULL
     OR to_regclass('public.accounting_journal_entries') IS NULL
     OR to_regclass('public.expense_categories') IS NULL
     OR to_regclass('public.expenses') IS NULL THEN
    RAISE EXCEPTION 'Expense accounting requires the expense and accounting foundation migrations';
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
    RAISE EXCEPTION 'Expense accounting requires tenant-scoped account and journal keys';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('public.expenses')
      AND attname IN ('input_vat_amount', 'approval_journal_entry_id', 'payment_journal_entry_id')
      AND attnum > 0 AND NOT attisdropped
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('public.expense_categories')
      AND attname = 'accounting_account_id' AND attnum > 0 AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'Expense accounting columns already exist; inspect the partial migration before retrying';
  END IF;
END;
$$;

ALTER TABLE public.accounting_settings
  ADD COLUMN expense_payable_account_id uuid,
  ADD COLUMN input_vat_account_id uuid,
  ADD CONSTRAINT accounting_settings_expense_payable_account_fk
    FOREIGN KEY (tenant_id, expense_payable_account_id)
    REFERENCES public.accounting_accounts (tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT accounting_settings_input_vat_account_fk
    FOREIGN KEY (tenant_id, input_vat_account_id)
    REFERENCES public.accounting_accounts (tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE public.expense_categories
  ADD COLUMN accounting_account_id uuid,
  ADD CONSTRAINT expense_categories_account_tenant_fk
    FOREIGN KEY (tenant_id, accounting_account_id)
    REFERENCES public.accounting_accounts (tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE public.expenses
  ADD COLUMN input_vat_amount numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN input_vat_document_reference character varying(255),
  ADD COLUMN input_vat_recoverable boolean NOT NULL DEFAULT false,
  ADD COLUMN approved_payable_account_id uuid,
  ADD COLUMN approved_input_vat_account_id uuid,
  ADD COLUMN approval_journal_entry_id uuid,
  ADD COLUMN payment_date date,
  ADD COLUMN paid_cash_account_id uuid,
  ADD COLUMN payment_journal_entry_id uuid,
  ADD COLUMN approval_reversal_journal_entry_id uuid,
  ADD COLUMN payment_reversal_journal_entry_id uuid,
  ADD COLUMN cancellation_reason text,
  ADD COLUMN reversal_date date,
  ADD CONSTRAINT expenses_input_vat_amount_check
    CHECK (input_vat_amount >= 0 AND input_vat_amount <= amount),
  ADD CONSTRAINT expenses_input_vat_reference_check
    CHECK ((input_vat_amount = 0 AND input_vat_document_reference IS NULL)
        OR (input_vat_amount > 0 AND input_vat_document_reference IS NOT NULL
            AND btrim(input_vat_document_reference) <> '')),
  ADD CONSTRAINT expenses_input_vat_recoverable_check
    CHECK (NOT input_vat_recoverable OR input_vat_amount > 0),
  ADD CONSTRAINT expenses_approved_payable_account_fk
    FOREIGN KEY (tenant_id, approved_payable_account_id)
    REFERENCES public.accounting_accounts (tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT expenses_approved_input_vat_account_fk
    FOREIGN KEY (tenant_id, approved_input_vat_account_id)
    REFERENCES public.accounting_accounts (tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT expenses_paid_cash_account_fk
    FOREIGN KEY (tenant_id, paid_cash_account_id)
    REFERENCES public.accounting_accounts (tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT expenses_approval_journal_fk
    FOREIGN KEY (tenant_id, approval_journal_entry_id)
    REFERENCES public.accounting_journal_entries (tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT expenses_payment_journal_fk
    FOREIGN KEY (tenant_id, payment_journal_entry_id)
    REFERENCES public.accounting_journal_entries (tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT expenses_approval_reversal_journal_fk
    FOREIGN KEY (tenant_id, approval_reversal_journal_entry_id)
    REFERENCES public.accounting_journal_entries (tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT expenses_payment_reversal_journal_fk
    FOREIGN KEY (tenant_id, payment_reversal_journal_entry_id)
    REFERENCES public.accounting_journal_entries (tenant_id, id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX expenses_tenant_approval_journal_unique_idx
  ON public.expenses (tenant_id, approval_journal_entry_id)
  WHERE approval_journal_entry_id IS NOT NULL;
CREATE UNIQUE INDEX expenses_tenant_payment_journal_unique_idx
  ON public.expenses (tenant_id, payment_journal_entry_id)
  WHERE payment_journal_entry_id IS NOT NULL;
CREATE UNIQUE INDEX expenses_tenant_approval_reversal_unique_idx
  ON public.expenses (tenant_id, approval_reversal_journal_entry_id)
  WHERE approval_reversal_journal_entry_id IS NOT NULL;
CREATE UNIQUE INDEX expenses_tenant_payment_reversal_unique_idx
  ON public.expenses (tenant_id, payment_reversal_journal_entry_id)
  WHERE payment_reversal_journal_entry_id IS NOT NULL;

COMMIT;

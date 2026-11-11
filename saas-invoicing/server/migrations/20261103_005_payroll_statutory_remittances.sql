-- Phase 5 Step 4: statutory component metadata and remittance settlement.
BEGIN;

ALTER TABLE public.hr_payroll_components
  ADD COLUMN is_statutory boolean NOT NULL DEFAULT false,
  ADD COLUMN statutory_authority character varying(40),
  ADD COLUMN statutory_code character varying(40),
  ADD CONSTRAINT hr_payroll_components_statutory_metadata_check CHECK (
    (is_statutory = false AND statutory_authority IS NULL AND statutory_code IS NULL)
    OR (is_statutory = true AND statutory_authority IS NOT NULL AND statutory_code IS NOT NULL)
  );

ALTER TABLE public.hr_employee_compensation
  ADD COLUMN statutory_profile jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.hr_payroll_settings
  DROP CONSTRAINT hr_payroll_settings_accounts_fk,
  DROP CONSTRAINT hr_payroll_settings_employer_account_fk,
  DROP CONSTRAINT hr_payroll_settings_employer_payable_fk,
  DROP CONSTRAINT hr_payroll_settings_deduction_account_fk,
  DROP CONSTRAINT hr_payroll_settings_net_account_fk,
  DROP CONSTRAINT hr_payroll_settings_cash_account_fk,
  ADD CONSTRAINT hr_payroll_settings_accounts_fk FOREIGN KEY (tenant_id, salary_expense_account_id)
    REFERENCES public.accounting_accounts (tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT hr_payroll_settings_employer_account_fk FOREIGN KEY (tenant_id, employer_contribution_expense_account_id)
    REFERENCES public.accounting_accounts (tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT hr_payroll_settings_employer_payable_fk FOREIGN KEY (tenant_id, employer_contributions_payable_account_id)
    REFERENCES public.accounting_accounts (tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT hr_payroll_settings_deduction_account_fk FOREIGN KEY (tenant_id, employee_deductions_payable_account_id)
    REFERENCES public.accounting_accounts (tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT hr_payroll_settings_net_account_fk FOREIGN KEY (tenant_id, net_salary_payable_account_id)
    REFERENCES public.accounting_accounts (tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT hr_payroll_settings_cash_account_fk FOREIGN KEY (tenant_id, payroll_cash_account_id)
    REFERENCES public.accounting_accounts (tenant_id, id) ON DELETE RESTRICT;

CREATE TABLE public.hr_payroll_statutory_obligations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  payroll_run_id uuid NOT NULL,
  authority character varying(40) NOT NULL,
  statutory_code character varying(40) NOT NULL,
  employee_amount numeric(18,6) NOT NULL DEFAULT 0,
  employer_amount numeric(18,6) NOT NULL DEFAULT 0,
  employee_settled numeric(18,6) NOT NULL DEFAULT 0,
  employer_settled numeric(18,6) NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT hr_payroll_statutory_obligation_run_fk FOREIGN KEY (tenant_id, payroll_run_id)
    REFERENCES public.hr_payroll_runs (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT hr_payroll_statutory_obligation_tenant_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT hr_payroll_statutory_obligation_unique UNIQUE (tenant_id, payroll_run_id, authority, statutory_code),
  CONSTRAINT hr_payroll_statutory_obligation_amounts_check CHECK (
    employee_amount >= 0 AND employer_amount >= 0 AND employee_settled >= 0
    AND employer_settled >= 0 AND employee_settled <= employee_amount
    AND employer_settled <= employer_amount
  )
);

CREATE INDEX hr_payroll_statutory_obligations_lookup_idx
  ON public.hr_payroll_statutory_obligations (tenant_id, authority, created_at DESC);

CREATE TABLE public.hr_payroll_remittances (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  obligation_id uuid NOT NULL,
  payment_date date NOT NULL,
  amount numeric(18,6) NOT NULL,
  employee_amount numeric(18,6) NOT NULL DEFAULT 0,
  employer_amount numeric(18,6) NOT NULL DEFAULT 0,
  payment_reference character varying(120) NOT NULL,
  payment_account_id uuid NOT NULL,
  journal_entry_id uuid,
  idempotency_key character varying(100) NOT NULL,
  recorded_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT hr_payroll_remittance_obligation_fk FOREIGN KEY (tenant_id, obligation_id)
    REFERENCES public.hr_payroll_statutory_obligations (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT hr_payroll_remittance_account_fk FOREIGN KEY (tenant_id, payment_account_id)
    REFERENCES public.accounting_accounts (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT hr_payroll_remittance_amounts_check CHECK (
    amount > 0 AND employee_amount >= 0 AND employer_amount >= 0
    AND amount = employee_amount + employer_amount
  ),
  CONSTRAINT hr_payroll_remittance_reference_check CHECK (btrim(payment_reference) <> ''),
  CONSTRAINT hr_payroll_remittance_idempotency_unique UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX hr_payroll_remittances_obligation_idx
  ON public.hr_payroll_remittances (tenant_id, obligation_id, payment_date DESC);

ALTER TABLE public.hr_payroll_audit
  DROP CONSTRAINT hr_payroll_audit_action_check,
  ADD CONSTRAINT hr_payroll_audit_action_check CHECK (action IN ('created', 'calculated', 'approved', 'paid', 'remitted'));

COMMIT;

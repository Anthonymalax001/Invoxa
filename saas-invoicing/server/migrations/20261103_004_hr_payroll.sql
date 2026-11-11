-- Phase 5 Step 4: configurable tenant payroll.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$
BEGIN
  IF to_regclass('public.hr_employees') IS NULL OR to_regclass('public.accounting_accounts') IS NULL THEN
    RAISE EXCEPTION 'Payroll requires HR employees and accounting accounts';
  END IF;
END;
$$;

CREATE TABLE public.hr_payroll_settings (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE RESTRICT,
  currency character varying(3) NOT NULL DEFAULT 'KES',
  pay_frequency character varying(12) NOT NULL DEFAULT 'monthly',
  salary_expense_account_id uuid,
  employer_contribution_expense_account_id uuid,
  employer_contributions_payable_account_id uuid,
  employee_deductions_payable_account_id uuid,
  net_salary_payable_account_id uuid,
  payroll_cash_account_id uuid,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT hr_payroll_settings_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT hr_payroll_settings_frequency_check CHECK (pay_frequency IN ('weekly', 'biweekly', 'monthly')),
  CONSTRAINT hr_payroll_settings_accounts_fk FOREIGN KEY (salary_expense_account_id)
    REFERENCES public.accounting_accounts (id) ON DELETE RESTRICT,
  CONSTRAINT hr_payroll_settings_employer_account_fk FOREIGN KEY (employer_contribution_expense_account_id)
    REFERENCES public.accounting_accounts (id) ON DELETE RESTRICT,
  CONSTRAINT hr_payroll_settings_employer_payable_fk FOREIGN KEY (employer_contributions_payable_account_id)
    REFERENCES public.accounting_accounts (id) ON DELETE RESTRICT,
  CONSTRAINT hr_payroll_settings_deduction_account_fk FOREIGN KEY (employee_deductions_payable_account_id)
    REFERENCES public.accounting_accounts (id) ON DELETE RESTRICT,
  CONSTRAINT hr_payroll_settings_net_account_fk FOREIGN KEY (net_salary_payable_account_id)
    REFERENCES public.accounting_accounts (id) ON DELETE RESTRICT,
  CONSTRAINT hr_payroll_settings_cash_account_fk FOREIGN KEY (payroll_cash_account_id)
    REFERENCES public.accounting_accounts (id) ON DELETE RESTRICT
);

CREATE TABLE public.hr_payroll_components (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  code character varying(50) NOT NULL,
  name character varying(120) NOT NULL,
  component_kind character varying(22) NOT NULL,
  calculation_type character varying(12) NOT NULL,
  amount numeric(18,6) NOT NULL DEFAULT 0,
  base_component_code character varying(50),
  is_taxable boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  effective_from date NOT NULL,
  effective_to date,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT hr_payroll_components_tenant_code_unique UNIQUE (tenant_id, code),
  CONSTRAINT hr_payroll_components_kind_check CHECK (component_kind IN ('earning', 'deduction', 'employer_contribution')),
  CONSTRAINT hr_payroll_components_calculation_check CHECK (calculation_type IN ('fixed', 'percentage')),
  CONSTRAINT hr_payroll_components_amount_check CHECK (amount >= 0),
  CONSTRAINT hr_payroll_components_dates_check CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE TABLE public.hr_employee_compensation (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  pay_frequency character varying(12) NOT NULL,
  basic_salary numeric(18,6) NOT NULL,
  currency character varying(3) NOT NULL,
  notes text,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT hr_employee_compensation_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT hr_employee_compensation_employee_fk FOREIGN KEY (tenant_id, employee_id)
    REFERENCES public.hr_employees (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT hr_employee_compensation_frequency_check CHECK (pay_frequency IN ('weekly', 'biweekly', 'monthly')),
  CONSTRAINT hr_employee_compensation_salary_check CHECK (basic_salary >= 0),
  CONSTRAINT hr_employee_compensation_dates_check CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT hr_employee_compensation_currency_check CHECK (currency ~ '^[A-Z]{3}$')
);

CREATE INDEX hr_employee_compensation_lookup_idx
  ON public.hr_employee_compensation (tenant_id, employee_id, effective_from DESC);

CREATE TABLE public.hr_payroll_runs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  period_start date NOT NULL,
  period_end date NOT NULL,
  pay_frequency character varying(12) NOT NULL,
  status character varying(12) NOT NULL DEFAULT 'draft',
  currency character varying(3) NOT NULL,
  total_gross numeric(18,6) NOT NULL DEFAULT 0,
  total_employee_deductions numeric(18,6) NOT NULL DEFAULT 0,
  total_employer_contributions numeric(18,6) NOT NULL DEFAULT 0,
  total_net numeric(18,6) NOT NULL DEFAULT 0,
  accounting_period_id uuid,
  journal_entry_id uuid,
  idempotency_key character varying(100),
  approved_by uuid,
  approved_at timestamp with time zone,
  paid_by uuid,
  paid_at timestamp with time zone,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT hr_payroll_runs_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT hr_payroll_runs_unique_period UNIQUE (tenant_id, period_start, period_end, pay_frequency),
  CONSTRAINT hr_payroll_runs_dates_check CHECK (period_end >= period_start),
  CONSTRAINT hr_payroll_runs_status_check CHECK (status IN ('draft', 'calculated', 'approved', 'paid')),
  CONSTRAINT hr_payroll_runs_frequency_check CHECK (pay_frequency IN ('weekly', 'biweekly', 'monthly')),
  CONSTRAINT hr_payroll_runs_totals_check CHECK (total_gross >= 0 AND total_employee_deductions >= 0 AND total_employer_contributions >= 0 AND total_net >= 0),
  CONSTRAINT hr_payroll_runs_period_fk FOREIGN KEY (tenant_id, accounting_period_id)
    REFERENCES public.accounting_periods (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.hr_payroll_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  payroll_run_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  compensation_snapshot jsonb NOT NULL,
  component_snapshot jsonb NOT NULL,
  attendance_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  gross_pay numeric(18,6) NOT NULL DEFAULT 0,
  employee_deductions numeric(18,6) NOT NULL DEFAULT 0,
  employer_contributions numeric(18,6) NOT NULL DEFAULT 0,
  net_pay numeric(18,6) NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT hr_payroll_items_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT hr_payroll_items_run_fk FOREIGN KEY (tenant_id, payroll_run_id)
    REFERENCES public.hr_payroll_runs (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT hr_payroll_items_employee_fk FOREIGN KEY (tenant_id, employee_id)
    REFERENCES public.hr_employees (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT hr_payroll_items_unique UNIQUE (tenant_id, payroll_run_id, employee_id),
  CONSTRAINT hr_payroll_items_amounts_check CHECK (gross_pay >= 0 AND employee_deductions >= 0 AND employer_contributions >= 0 AND net_pay >= 0)
);

CREATE INDEX hr_payroll_items_employee_idx
  ON public.hr_payroll_items (tenant_id, employee_id, created_at DESC);

CREATE TABLE public.hr_payroll_audit (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  payroll_run_id uuid NOT NULL,
  action character varying(12) NOT NULL,
  changed_by uuid NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT hr_payroll_audit_run_fk FOREIGN KEY (tenant_id, payroll_run_id)
    REFERENCES public.hr_payroll_runs (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT hr_payroll_audit_action_check CHECK (action IN ('created', 'calculated', 'approved', 'paid'))
);

CREATE INDEX hr_payroll_audit_lookup_idx
  ON public.hr_payroll_audit (tenant_id, payroll_run_id, created_at DESC);

COMMIT;

-- Phase 5 Step 3: tenant-scoped leave types, balances, applications and audit history.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$
BEGIN
  IF to_regclass('public.hr_employees') IS NULL THEN
    RAISE EXCEPTION 'Leave management requires hr_employees';
  END IF;
END;
$$;

CREATE TABLE public.hr_leave_types (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  code character varying(40) NOT NULL,
  name character varying(120) NOT NULL,
  annual_entitlement numeric(8,2),
  allow_negative boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  is_system boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT hr_leave_types_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT hr_leave_types_code_unique UNIQUE (tenant_id, code),
  CONSTRAINT hr_leave_types_code_check CHECK (code ~ '^[a-z][a-z0-9_-]{1,39}$'),
  CONSTRAINT hr_leave_types_name_check CHECK (btrim(name) <> ''),
  CONSTRAINT hr_leave_types_entitlement_check CHECK (annual_entitlement IS NULL OR annual_entitlement >= 0)
);

CREATE INDEX hr_leave_types_tenant_active_idx
  ON public.hr_leave_types (tenant_id, is_active, lower(name));

CREATE TABLE public.hr_leave_balances (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL,
  leave_type_id uuid NOT NULL,
  leave_year integer NOT NULL,
  entitled_days numeric(8,2) NOT NULL DEFAULT 0,
  used_days numeric(8,2) NOT NULL DEFAULT 0,
  allow_negative boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT hr_leave_balances_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT hr_leave_balances_employee_fk FOREIGN KEY (tenant_id, employee_id)
    REFERENCES public.hr_employees (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT hr_leave_balances_type_fk FOREIGN KEY (tenant_id, leave_type_id)
    REFERENCES public.hr_leave_types (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT hr_leave_balances_unique UNIQUE (tenant_id, employee_id, leave_type_id, leave_year),
  CONSTRAINT hr_leave_balances_year_check CHECK (leave_year BETWEEN 2000 AND 2200),
  CONSTRAINT hr_leave_balances_days_check CHECK (entitled_days >= 0 AND used_days >= 0)
);

CREATE INDEX hr_leave_balances_employee_year_idx
  ON public.hr_leave_balances (tenant_id, employee_id, leave_year);

CREATE TABLE public.hr_leave_applications (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL,
  leave_type_id uuid NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  working_days numeric(8,2) NOT NULL,
  reason text NOT NULL,
  status character varying(10) NOT NULL DEFAULT 'pending',
  approved_by uuid,
  decision_at timestamp with time zone,
  rejection_reason text,
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT hr_leave_applications_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT hr_leave_applications_employee_fk FOREIGN KEY (tenant_id, employee_id)
    REFERENCES public.hr_employees (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT hr_leave_applications_type_fk FOREIGN KEY (tenant_id, leave_type_id)
    REFERENCES public.hr_leave_types (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT hr_leave_applications_approver_fk FOREIGN KEY (tenant_id, approved_by)
    REFERENCES public.users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT hr_leave_applications_dates_check CHECK (end_date >= start_date),
  CONSTRAINT hr_leave_applications_days_check CHECK (working_days > 0),
  CONSTRAINT hr_leave_applications_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  CONSTRAINT hr_leave_applications_decision_check CHECK (
    (status IN ('approved', 'rejected') AND approved_by IS NOT NULL AND decision_at IS NOT NULL)
    OR (status IN ('pending', 'cancelled'))
  ),
  CONSTRAINT hr_leave_applications_reason_check CHECK (length(btrim(reason)) BETWEEN 1 AND 10000),
  CONSTRAINT hr_leave_applications_rejection_check CHECK (
    status <> 'rejected' OR (rejection_reason IS NOT NULL AND length(btrim(rejection_reason)) > 0)
  )
);

CREATE INDEX hr_leave_applications_filter_idx
  ON public.hr_leave_applications (tenant_id, status, start_date, end_date);
CREATE INDEX hr_leave_applications_employee_idx
  ON public.hr_leave_applications (tenant_id, employee_id, start_date DESC);
CREATE INDEX hr_leave_applications_type_idx
  ON public.hr_leave_applications (tenant_id, leave_type_id, status);

CREATE TABLE public.hr_leave_audit (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  application_id uuid NOT NULL,
  action character varying(12) NOT NULL,
  changed_by uuid NOT NULL,
  before_data jsonb,
  after_data jsonb,
  changed_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT hr_leave_audit_application_fk FOREIGN KEY (tenant_id, application_id)
    REFERENCES public.hr_leave_applications (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT hr_leave_audit_action_check CHECK (action IN ('created', 'approved', 'rejected', 'cancelled')),
  CONSTRAINT hr_leave_audit_snapshot_check CHECK (
    (action = 'created' AND before_data IS NULL AND after_data IS NOT NULL)
    OR (action <> 'created' AND before_data IS NOT NULL AND after_data IS NOT NULL)
  )
);

CREATE INDEX hr_leave_audit_lookup_idx
  ON public.hr_leave_audit (tenant_id, application_id, changed_at DESC);

CREATE FUNCTION public.hr_leave_audit_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Leave audit history is immutable';
END;
$$;

CREATE TRIGGER hr_leave_audit_immutable
BEFORE UPDATE OR DELETE ON public.hr_leave_audit
FOR EACH ROW EXECUTE FUNCTION public.hr_leave_audit_immutable();

INSERT INTO public.hr_leave_types
  (tenant_id, code, name, annual_entitlement, allow_negative, is_system, created_by)
SELECT t.id, defaults.code, defaults.name, NULL, false, true,
       COALESCE((SELECT u.id FROM public.users u WHERE u.tenant_id = t.id ORDER BY u.id LIMIT 1), uuid_generate_v4())
FROM public.tenants t
CROSS JOIN (VALUES
  ('annual', 'Annual leave'),
  ('sick', 'Sick leave'),
  ('maternity', 'Maternity leave'),
  ('paternity', 'Paternity leave'),
  ('unpaid', 'Unpaid leave')
) AS defaults(code, name)
ON CONFLICT (tenant_id, code) DO NOTHING;

COMMIT;

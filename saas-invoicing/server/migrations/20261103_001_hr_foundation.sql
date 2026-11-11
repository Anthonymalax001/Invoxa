-- Phase 5 Step 1: tenant-scoped HR foundation.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$
BEGIN
  IF to_regclass('public.tenants') IS NULL OR to_regprocedure('uuid_generate_v4()') IS NULL THEN
    RAISE EXCEPTION 'HR foundation requires tenants and uuid_generate_v4()';
  END IF;
END;
$$;

CREATE TABLE public.hr_departments (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  name character varying(120) NOT NULL,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT hr_departments_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT hr_departments_name_check CHECK (btrim(name) <> '')
);

CREATE UNIQUE INDEX hr_departments_tenant_name_unique
  ON public.hr_departments (tenant_id, lower(btrim(name)));

CREATE TABLE public.hr_employee_sequences (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE RESTRICT,
  next_value bigint NOT NULL DEFAULT 1,
  CONSTRAINT hr_employee_sequences_next_value_check CHECK (next_value > 0)
);

CREATE TABLE public.hr_employees (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  employee_number character varying(30) NOT NULL,
  first_name character varying(100) NOT NULL,
  middle_name character varying(100),
  last_name character varying(100) NOT NULL,
  work_email character varying(254),
  phone character varying(30),
  department_id uuid,
  job_title character varying(150),
  employment_type character varying(20) NOT NULL,
  employment_start_date date NOT NULL,
  employment_status character varying(12) NOT NULL DEFAULT 'active',
  reporting_manager_id uuid,
  notes text,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT hr_employees_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT hr_employees_tenant_number_unique UNIQUE (tenant_id, employee_number),
  CONSTRAINT hr_employees_number_check CHECK (employee_number ~ '^[A-Z0-9][A-Z0-9-]{1,29}$'),
  CONSTRAINT hr_employees_first_name_check CHECK (btrim(first_name) <> ''),
  CONSTRAINT hr_employees_last_name_check CHECK (btrim(last_name) <> ''),
  CONSTRAINT hr_employees_type_check CHECK (employment_type IN ('permanent', 'contract', 'temporary', 'intern', 'casual', 'consultant')),
  CONSTRAINT hr_employees_status_check CHECK (employment_status IN ('active', 'inactive', 'suspended', 'terminated')),
  CONSTRAINT hr_employees_department_fk FOREIGN KEY (tenant_id, department_id)
    REFERENCES public.hr_departments (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT hr_employees_manager_fk FOREIGN KEY (tenant_id, reporting_manager_id)
    REFERENCES public.hr_employees (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT hr_employees_not_self_manager CHECK (reporting_manager_id IS NULL OR reporting_manager_id <> id)
);

CREATE UNIQUE INDEX hr_employees_tenant_email_unique
  ON public.hr_employees (tenant_id, lower(work_email))
  WHERE work_email IS NOT NULL;
CREATE INDEX hr_employees_tenant_search_idx
  ON public.hr_employees (tenant_id, lower(last_name), lower(first_name));
CREATE INDEX hr_employees_tenant_department_idx
  ON public.hr_employees (tenant_id, department_id, employment_status);

CREATE FUNCTION public.hr_generate_employee_number()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  sequence_value bigint;
BEGIN
  IF NEW.employee_number IS NULL OR btrim(NEW.employee_number) = '' THEN
    INSERT INTO public.hr_employee_sequences (tenant_id, next_value)
    VALUES (NEW.tenant_id, 2)
    ON CONFLICT (tenant_id) DO UPDATE SET next_value = hr_employee_sequences.next_value + 1
    RETURNING next_value - 1 INTO sequence_value;
    NEW.employee_number := 'EMP-' || lpad(sequence_value::text, 6, '0');
  ELSE
    NEW.employee_number := upper(btrim(NEW.employee_number));
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hr_employees_generate_number
BEFORE INSERT ON public.hr_employees
FOR EACH ROW EXECUTE FUNCTION public.hr_generate_employee_number();

COMMIT;

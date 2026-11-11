-- Phase 5 Step 2: tenant-scoped attendance and audit history.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$
BEGIN
  IF to_regclass('public.hr_employees') IS NULL THEN
    RAISE EXCEPTION 'Attendance requires hr_employees';
  END IF;
END;
$$;

CREATE TABLE public.hr_attendance (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL,
  attendance_date date NOT NULL,
  clock_in time without time zone,
  clock_out time without time zone,
  attendance_status character varying(12) NOT NULL,
  working_minutes integer NOT NULL DEFAULT 0,
  overtime_minutes integer NOT NULL DEFAULT 0,
  notes text,
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT hr_attendance_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT hr_attendance_employee_fk FOREIGN KEY (tenant_id, employee_id)
    REFERENCES public.hr_employees (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT hr_attendance_daily_unique UNIQUE (tenant_id, employee_id, attendance_date),
  CONSTRAINT hr_attendance_status_check CHECK (attendance_status IN ('present', 'absent', 'late', 'half-day', 'on leave')),
  CONSTRAINT hr_attendance_minutes_check CHECK (working_minutes >= 0 AND overtime_minutes >= 0),
  CONSTRAINT hr_attendance_clock_order_check CHECK (clock_in IS NULL OR clock_out IS NULL OR clock_out >= clock_in),
  CONSTRAINT hr_attendance_clock_status_check CHECK (
    (attendance_status IN ('absent', 'on leave') AND clock_in IS NULL AND clock_out IS NULL)
    OR attendance_status IN ('present', 'late', 'half-day')
  ),
  CONSTRAINT hr_attendance_notes_check CHECK (notes IS NULL OR length(notes) <= 10000)
);

CREATE INDEX hr_attendance_tenant_date_idx
  ON public.hr_attendance (tenant_id, attendance_date DESC);
CREATE INDEX hr_attendance_tenant_employee_date_idx
  ON public.hr_attendance (tenant_id, employee_id, attendance_date DESC);
CREATE INDEX hr_attendance_tenant_status_idx
  ON public.hr_attendance (tenant_id, attendance_status, attendance_date DESC);

CREATE TABLE public.hr_attendance_audit (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  attendance_id uuid NOT NULL,
  action character varying(10) NOT NULL,
  changed_by uuid NOT NULL,
  before_data jsonb,
  after_data jsonb,
  changed_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT hr_attendance_audit_attendance_fk FOREIGN KEY (tenant_id, attendance_id)
    REFERENCES public.hr_attendance (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT hr_attendance_audit_action_check CHECK (action IN ('created', 'updated')),
  CONSTRAINT hr_attendance_audit_snapshot_check CHECK (
    (action = 'created' AND before_data IS NULL AND after_data IS NOT NULL)
    OR (action = 'updated' AND before_data IS NOT NULL AND after_data IS NOT NULL)
  )
);

CREATE INDEX hr_attendance_audit_lookup_idx
  ON public.hr_attendance_audit (tenant_id, attendance_id, changed_at DESC);

CREATE FUNCTION public.hr_attendance_audit_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Attendance audit history is immutable';
END;
$$;

CREATE TRIGGER hr_attendance_audit_immutable
BEFORE UPDATE OR DELETE ON public.hr_attendance_audit
FOR EACH ROW EXECUTE FUNCTION public.hr_attendance_audit_immutable();

CREATE FUNCTION public.hr_calculate_attendance_minutes()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  duration_minutes integer;
BEGIN
  IF NEW.clock_in IS NULL OR NEW.clock_out IS NULL THEN
    NEW.working_minutes := 0;
    NEW.overtime_minutes := 0;
  ELSE
    duration_minutes := floor(extract(epoch FROM (NEW.clock_out - NEW.clock_in)) / 60)::integer;
    IF duration_minutes < 0 THEN
      RAISE EXCEPTION 'Attendance clock-out cannot be before clock-in';
    END IF;
    NEW.working_minutes := duration_minutes;
    NEW.overtime_minutes := greatest(duration_minutes - 480, 0);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hr_attendance_calculate_minutes
BEFORE INSERT OR UPDATE OF clock_in, clock_out ON public.hr_attendance
FOR EACH ROW EXECUTE FUNCTION public.hr_calculate_attendance_minutes();

COMMIT;

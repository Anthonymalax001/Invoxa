-- SYNTHETIC TEST FIXTURE ONLY.
-- The repository has no authoritative DDL for legacy public.payments. These
-- columns and types satisfy migration preflights and the service SQL exercised
-- by mpesa-postgres.js. This table does not establish production compatibility.
CREATE TABLE public.payments (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  amount numeric(20,2) NOT NULL,
  phone_number character varying(32),
  mpesa_checkout_id character varying(150),
  status character varying(24) NOT NULL DEFAULT 'pending'
);

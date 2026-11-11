-- TEST FIXTURE ONLY.
-- The repository does not contain the original tenants/users/clients/invoices/
-- invoice_items DDL. These minimal tables satisfy only columns and joins
-- evidenced by application queries, the tenant-integrity preflight report,
-- and the Sales Order migration. They are not a statement of production schema.

CREATE TABLE public.tenants (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name character varying(255) NOT NULL,
  email character varying(255),
  phone character varying(50)
);

CREATE TABLE public.users (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  name character varying(255) NOT NULL,
  email character varying(255) NOT NULL,
  password_hash text NOT NULL,
  role character varying(50) NOT NULL,
  CONSTRAINT invoice_it_users_tenant_id_unique UNIQUE (tenant_id, id)
);

CREATE TABLE public.clients (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  name character varying(255) NOT NULL,
  email character varying(255),
  phone character varying(50),
  address text,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT invoice_it_clients_tenant_id_unique UNIQUE (tenant_id, id)
);

CREATE TABLE public.invoices (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  client_id uuid NOT NULL,
  invoice_number character varying(50) NOT NULL,
  due_date date,
  subtotal numeric(12,2) NOT NULL,
  tax_rate numeric(5,2) NOT NULL,
  tax_amount numeric(12,2) NOT NULL,
  total numeric(12,2) NOT NULL,
  notes text,
  status character varying(30) NOT NULL DEFAULT 'draft',
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT invoice_it_invoices_tenant_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT invoice_it_invoices_client_fk
    FOREIGN KEY (tenant_id, client_id)
    REFERENCES public.clients (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.invoice_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  description text NOT NULL,
  quantity numeric(10,2) NOT NULL,
  unit_price numeric(12,2) NOT NULL,
  amount numeric(12,2) NOT NULL
);

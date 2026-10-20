-- Tenant-scoped sales orders, fulfillment ledger links, and order invoices.
-- Depends on 20261018_001_products_and_stock_movements.sql.
-- Forward-only. Apply only to a reviewed disposable database snapshot first.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$
BEGIN
  IF to_regclass('public.tenants') IS NULL
     OR to_regclass('public.clients') IS NULL
     OR to_regclass('public.invoices') IS NULL
     OR to_regclass('public.invoice_items') IS NULL
     OR to_regclass('public.products') IS NULL
     OR to_regclass('public.stock_movements') IS NULL THEN
    RAISE EXCEPTION 'Sales orders require existing tenant, client, invoice, invoice item, product, and stock movement tables';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = to_regclass('public.products')
      AND conname = 'products_tenant_id_id_unique' AND contype = 'u'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = to_regclass('public.stock_movements')
      AND conname = 'stock_movements_type_check' AND contype = 'c'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = to_regclass('public.stock_movements')
      AND conname = 'stock_movements_product_tenant_fk' AND contype = 'f'
  ) THEN
    RAISE EXCEPTION 'Sales orders require the tenant-safe product and stock movement schema from 20261018_001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('public.invoices')
      AND attname = 'sales_order_id' AND attnum > 0 AND NOT attisdropped
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('public.stock_movements')
      AND attname = 'sales_order_fulfillment_item_id'
      AND attnum > 0 AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'Sales order link columns already exist; inspect the schema before retrying this migration';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('public.clients') AND attname = 'id'
      AND atttypid = 'uuid'::regtype AND attnum > 0 AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('public.clients') AND attname = 'tenant_id'
      AND atttypid = 'uuid'::regtype AND attnum > 0 AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('public.invoices') AND attname = 'id'
      AND atttypid = 'uuid'::regtype AND attnum > 0 AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('public.invoices') AND attname = 'tenant_id'
      AND atttypid = 'uuid'::regtype AND attnum > 0 AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('public.invoices') AND attname = 'client_id'
      AND atttypid = 'uuid'::regtype AND attnum > 0 AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('public.invoice_items') AND attname = 'invoice_id'
      AND atttypid = 'uuid'::regtype AND attnum > 0 AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'Sales order invoicing requires UUID clients.id/tenant_id and invoices/invoice_items join keys';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('public.invoices') AND attname = 'invoice_number'
      AND attnum > 0 AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('public.invoices') AND attname = 'due_date'
      AND attnum > 0 AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('public.invoices') AND attname = 'notes'
      AND attnum > 0 AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('public.invoices') AND attname = 'subtotal'
      AND atttypid = 'numeric'::regtype AND attnum > 0 AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('public.invoices') AND attname = 'tax_rate'
      AND atttypid = 'numeric'::regtype AND attnum > 0 AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('public.invoices') AND attname = 'tax_amount'
      AND atttypid = 'numeric'::regtype AND attnum > 0 AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('public.invoices') AND attname = 'total'
      AND atttypid = 'numeric'::regtype AND attnum > 0 AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'Sales order invoicing requires the invoice number and numeric totals used by the existing invoice route';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = to_regclass('public.invoice_items')
      AND a.attname = 'description' AND a.attnum > 0 AND NOT a.attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = to_regclass('public.invoice_items')
      AND a.attname = 'quantity' AND a.atttypid = 'numeric'::regtype
      AND pg_catalog.format_type(a.atttypid, a.atttypmod) = 'numeric(10,2)'
      AND a.attnum > 0 AND NOT a.attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('public.invoice_items') AND attname = 'unit_price'
      AND atttypid = 'numeric'::regtype AND attnum > 0 AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('public.invoice_items') AND attname = 'amount'
      AND atttypid = 'numeric'::regtype AND attnum > 0 AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'Sales order invoicing requires invoice item quantity numeric(10,2) and numeric price/amount columns';
  END IF;

  IF to_regprocedure('uuid_generate_v4()') IS NULL THEN
    RAISE EXCEPTION 'Cannot create sales order tables: uuid_generate_v4() is unavailable';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_attrdef d
      ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = to_regclass('public.invoices')
      AND a.attname = 'id' AND a.attnum > 0 AND NOT a.attisdropped
      AND pg_catalog.pg_get_expr(d.adbin, d.adrelid) LIKE '%uuid_generate_v4%'
  ) THEN
    RAISE EXCEPTION 'Sales order invoicing requires invoices.id to default to uuid_generate_v4()';
  END IF;

  IF EXISTS (SELECT 1 FROM public.clients WHERE id IS NULL OR tenant_id IS NULL) THEN
    RAISE EXCEPTION 'Cannot add the sales order client key while clients contain NULL IDs or tenant IDs';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.clients GROUP BY tenant_id, id HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot add the sales order client key while duplicate tenant/client pairs exist';
  END IF;
END;
$$;

-- Required target for composite tenant/client foreign keys. Existing client
-- rows are checked above; no client data is changed by this index.
CREATE UNIQUE INDEX clients_tenant_id_id_sales_fk_idx
  ON public.clients (tenant_id, id);

CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  client_id uuid NOT NULL,
  order_number character varying(50) NOT NULL,
  order_date date NOT NULL,
  expected_delivery_date date,
  status character varying(24) NOT NULL DEFAULT 'draft',
  subtotal numeric(12,2) NOT NULL DEFAULT 0,
  discount_total numeric(12,2) NOT NULL DEFAULT 0,
  tax_rate numeric(5,2) NOT NULL DEFAULT 0,
  tax_amount numeric(12,2) NOT NULL DEFAULT 0,
  total numeric(12,2) NOT NULL DEFAULT 0,
  notes text,
  created_by uuid,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT sales_orders_number_not_blank CHECK (btrim(order_number) <> ''),
  CONSTRAINT sales_orders_status_check
    CHECK (status IN ('draft', 'confirmed', 'partially_fulfilled', 'fulfilled', 'cancelled')),
  CONSTRAINT sales_orders_subtotal_nonnegative CHECK (subtotal >= 0),
  CONSTRAINT sales_orders_discount_nonnegative CHECK (discount_total >= 0),
  CONSTRAINT sales_orders_tax_rate_check CHECK (tax_rate >= 0 AND tax_rate <= 100),
  CONSTRAINT sales_orders_tax_amount_nonnegative CHECK (tax_amount >= 0),
  CONSTRAINT sales_orders_total_nonnegative CHECK (total >= 0),
  CONSTRAINT sales_orders_expected_date_check
    CHECK (expected_delivery_date IS NULL OR expected_delivery_date >= order_date),
  CONSTRAINT sales_orders_tenant_number_unique UNIQUE (tenant_id, order_number),
  CONSTRAINT sales_orders_tenant_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT sales_orders_tenant_client_unique UNIQUE (tenant_id, id, client_id),
  CONSTRAINT sales_orders_client_tenant_fk
    FOREIGN KEY (tenant_id, client_id)
    REFERENCES public.clients (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX sales_orders_tenant_created_idx
  ON public.sales_orders (tenant_id, created_at DESC);
CREATE INDEX sales_orders_tenant_status_idx
  ON public.sales_orders (tenant_id, status, created_at DESC);
CREATE INDEX sales_orders_client_history_idx
  ON public.sales_orders (tenant_id, client_id, order_date DESC, id DESC);

CREATE TABLE public.sales_order_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  sales_order_id uuid NOT NULL,
  product_id uuid NOT NULL,
  product_name character varying(255) NOT NULL,
  product_sku character varying(100) NOT NULL,
  -- Two decimal places match the existing invoice_items.quantity type.
  quantity_ordered numeric(10,2) NOT NULL,
  quantity_fulfilled numeric(10,2) NOT NULL DEFAULT 0,
  unit_price numeric(12,2) NOT NULL,
  discount_rate numeric(5,2) NOT NULL DEFAULT 0,
  discount_amount numeric(12,2) NOT NULL DEFAULT 0,
  line_subtotal numeric(12,2) NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT sales_order_items_quantity_check
    CHECK (quantity_ordered > 0 AND quantity_fulfilled >= 0 AND quantity_fulfilled <= quantity_ordered),
  CONSTRAINT sales_order_items_price_check CHECK (unit_price >= 0),
  CONSTRAINT sales_order_items_discount_rate_check CHECK (discount_rate >= 0 AND discount_rate <= 100),
  CONSTRAINT sales_order_items_discount_amount_check CHECK (discount_amount >= 0),
  CONSTRAINT sales_order_items_subtotal_check CHECK (line_subtotal >= 0),
  CONSTRAINT sales_order_items_tenant_order_id_unique UNIQUE (tenant_id, sales_order_id, id),
  CONSTRAINT sales_order_items_tenant_order_product_unique
    UNIQUE (tenant_id, sales_order_id, id, product_id),
  CONSTRAINT sales_order_items_order_fk
    FOREIGN KEY (tenant_id, sales_order_id)
    REFERENCES public.sales_orders (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT sales_order_items_product_fk
    FOREIGN KEY (tenant_id, product_id)
    REFERENCES public.products (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX sales_order_items_order_idx
  ON public.sales_order_items (tenant_id, sales_order_id, created_at, id);
CREATE INDEX sales_order_items_product_idx
  ON public.sales_order_items (tenant_id, product_id);

CREATE TABLE public.sales_order_fulfillments (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  sales_order_id uuid NOT NULL,
  idempotency_key character varying(100) NOT NULL,
  fulfilled_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fulfilled_by uuid,
  notes text,
  CONSTRAINT sales_order_fulfillments_key_not_blank CHECK (btrim(idempotency_key) <> ''),
  CONSTRAINT sales_order_fulfillments_tenant_order_id_unique
    UNIQUE (tenant_id, sales_order_id, id),
  CONSTRAINT sales_order_fulfillments_idempotency_unique
    UNIQUE (tenant_id, sales_order_id, idempotency_key),
  CONSTRAINT sales_order_fulfillments_order_fk
    FOREIGN KEY (tenant_id, sales_order_id)
    REFERENCES public.sales_orders (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX sales_order_fulfillments_history_idx
  ON public.sales_order_fulfillments (tenant_id, sales_order_id, fulfilled_at DESC, id DESC);

CREATE TABLE public.sales_order_fulfillment_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  sales_order_id uuid NOT NULL,
  fulfillment_id uuid NOT NULL,
  sales_order_item_id uuid NOT NULL,
  product_id uuid NOT NULL,
  fulfilled_quantity numeric(10,2) NOT NULL,
  CONSTRAINT sales_order_fulfillment_items_quantity_check CHECK (fulfilled_quantity > 0),
  CONSTRAINT sales_order_fulfillment_items_once_per_line
    UNIQUE (tenant_id, sales_order_id, fulfillment_id, sales_order_item_id),
  CONSTRAINT sales_order_fulfillment_items_tenant_product_id_unique
    UNIQUE (tenant_id, product_id, id),
  CONSTRAINT sales_order_fulfillment_items_fulfillment_fk
    FOREIGN KEY (tenant_id, sales_order_id, fulfillment_id)
    REFERENCES public.sales_order_fulfillments (tenant_id, sales_order_id, id) ON DELETE RESTRICT,
  CONSTRAINT sales_order_fulfillment_items_order_line_fk
    FOREIGN KEY (tenant_id, sales_order_id, sales_order_item_id, product_id)
    REFERENCES public.sales_order_items (tenant_id, sales_order_id, id, product_id) ON DELETE RESTRICT,
  CONSTRAINT sales_order_fulfillment_items_product_fk
    FOREIGN KEY (tenant_id, product_id)
    REFERENCES public.products (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX sales_order_fulfillment_items_history_idx
  ON public.sales_order_fulfillment_items (tenant_id, sales_order_id, fulfillment_id);

ALTER TABLE public.stock_movements
  ADD COLUMN sales_order_fulfillment_item_id uuid;

ALTER TABLE public.stock_movements
  ADD CONSTRAINT stock_movements_sales_fulfillment_fk
  FOREIGN KEY (tenant_id, product_id, sales_order_fulfillment_item_id)
  REFERENCES public.sales_order_fulfillment_items (tenant_id, product_id, id)
  ON DELETE RESTRICT;

CREATE UNIQUE INDEX stock_movements_sales_fulfillment_item_unique_idx
  ON public.stock_movements (tenant_id, sales_order_fulfillment_item_id)
  WHERE sales_order_fulfillment_item_id IS NOT NULL;

ALTER TABLE public.invoices
  ADD COLUMN sales_order_id uuid;

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_sales_order_client_tenant_fk
  FOREIGN KEY (tenant_id, sales_order_id, client_id)
  REFERENCES public.sales_orders (tenant_id, id, client_id)
  ON DELETE RESTRICT;

CREATE UNIQUE INDEX invoices_tenant_sales_order_unique_idx
  ON public.invoices (tenant_id, sales_order_id)
  WHERE sales_order_id IS NOT NULL;

COMMIT;

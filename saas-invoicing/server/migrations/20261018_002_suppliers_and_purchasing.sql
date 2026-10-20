-- Tenant-scoped suppliers, purchase orders, and goods receipts.
-- Depends on 20261018_001_products_and_stock_movements.sql.
-- Forward-only. Apply to a reviewed disposable snapshot before production.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$
BEGIN
  IF to_regclass('public.products') IS NULL
     OR to_regclass('public.stock_movements') IS NULL THEN
    RAISE EXCEPTION 'Apply 20261018_001_products_and_stock_movements.sql before purchasing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = to_regclass('public.products')
      AND conname = 'products_tenant_id_id_unique'
      AND contype = 'u'
  ) THEN
    RAISE EXCEPTION 'Purchasing requires products_tenant_id_id_unique from the inventory migration';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('public.products') AND attname = 'tenant_id'
      AND atttypid = 'uuid'::regtype AND attnum > 0 AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('public.products') AND attname = 'id'
      AND atttypid = 'uuid'::regtype AND attnum > 0 AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('public.products') AND attname = 'current_stock'
      AND atttypid = 'numeric'::regtype AND attnum > 0 AND NOT attisdropped
  ) OR EXISTS (
    SELECT required.attname
    FROM unnest(ARRAY['name', 'sku', 'is_active']) AS required(attname)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = to_regclass('public.products')
        AND a.attname = required.attname
        AND a.attnum > 0 AND NOT a.attisdropped
    )
  ) THEN
    RAISE EXCEPTION 'Purchasing requires products tenant_id/id UUIDs, current_stock numeric, and name/sku/is_active columns';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('public.stock_movements') AND attname = 'tenant_id'
      AND atttypid = 'uuid'::regtype AND attnum > 0 AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('public.stock_movements') AND attname = 'product_id'
      AND atttypid = 'uuid'::regtype AND attnum > 0 AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('public.stock_movements') AND attname = 'movement_type'
      AND attnum > 0 AND NOT attisdropped
  ) OR EXISTS (
    SELECT required.attname
    FROM unnest(ARRAY['quantity_delta', 'quantity_before', 'quantity_after', 'reference', 'notes', 'created_by']) AS required(attname)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = to_regclass('public.stock_movements')
        AND a.attname = required.attname
        AND a.attnum > 0 AND NOT a.attisdropped
    )
  ) THEN
    RAISE EXCEPTION 'Purchasing requires the tenant-scoped stock_movements schema';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = to_regclass('public.stock_movements')
      AND conname = 'stock_movements_type_check'
      AND contype = 'c'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = to_regclass('public.stock_movements')
      AND conname = 'stock_movements_product_tenant_fk'
      AND contype = 'f'
  ) THEN
    RAISE EXCEPTION 'Purchasing requires the inventory movement type check and tenant/product foreign key';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('public.stock_movements')
      AND attname = 'purchase_order_receipt_item_id'
      AND attnum > 0 AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'stock_movements.purchase_order_receipt_item_id already exists; review schema before proceeding';
  END IF;

  IF to_regprocedure('uuid_generate_v4()') IS NULL THEN
    RAISE EXCEPTION 'Cannot create purchasing tables: uuid_generate_v4() is unavailable';
  END IF;
END;
$$;

CREATE TABLE public.suppliers (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  business_name character varying(255) NOT NULL,
  contact_person character varying(255),
  email character varying(255),
  phone character varying(50),
  address text,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT suppliers_name_not_blank CHECK (btrim(business_name) <> ''),
  CONSTRAINT suppliers_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX suppliers_tenant_name_idx
  ON public.suppliers (tenant_id, lower(business_name));
CREATE INDEX suppliers_tenant_active_idx
  ON public.suppliers (tenant_id, is_active);

CREATE TABLE public.purchase_orders (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  supplier_id uuid NOT NULL,
  purchase_order_number character varying(50) NOT NULL,
  order_date date NOT NULL,
  expected_delivery_date date,
  status character varying(24) NOT NULL DEFAULT 'draft',
  subtotal numeric(12,2) NOT NULL DEFAULT 0,
  tax_rate numeric(5,2) NOT NULL DEFAULT 0,
  tax_amount numeric(12,2) NOT NULL DEFAULT 0,
  total numeric(12,2) NOT NULL DEFAULT 0,
  notes text,
  created_by uuid,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT purchase_orders_number_not_blank CHECK (btrim(purchase_order_number) <> ''),
  CONSTRAINT purchase_orders_status_check
    CHECK (status IN ('draft', 'ordered', 'partially_received', 'received', 'cancelled')),
  CONSTRAINT purchase_orders_subtotal_nonnegative CHECK (subtotal >= 0),
  CONSTRAINT purchase_orders_tax_rate_check CHECK (tax_rate >= 0 AND tax_rate <= 100),
  CONSTRAINT purchase_orders_tax_amount_nonnegative CHECK (tax_amount >= 0),
  CONSTRAINT purchase_orders_total_nonnegative CHECK (total >= 0),
  CONSTRAINT purchase_orders_expected_date_check
    CHECK (expected_delivery_date IS NULL OR expected_delivery_date >= order_date),
  CONSTRAINT purchase_orders_tenant_number_unique UNIQUE (tenant_id, purchase_order_number),
  CONSTRAINT purchase_orders_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT purchase_orders_supplier_tenant_fk
    FOREIGN KEY (tenant_id, supplier_id)
    REFERENCES public.suppliers (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX purchase_orders_tenant_created_idx
  ON public.purchase_orders (tenant_id, created_at DESC);
CREATE INDEX purchase_orders_tenant_status_idx
  ON public.purchase_orders (tenant_id, status, created_at DESC);
CREATE INDEX purchase_orders_supplier_history_idx
  ON public.purchase_orders (tenant_id, supplier_id, order_date DESC, id DESC);

CREATE TABLE public.purchase_order_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  purchase_order_id uuid NOT NULL,
  product_id uuid NOT NULL,
  product_name character varying(255) NOT NULL,
  product_sku character varying(100) NOT NULL,
  quantity_ordered numeric(12,3) NOT NULL,
  quantity_received numeric(12,3) NOT NULL DEFAULT 0,
  unit_cost numeric(12,2) NOT NULL,
  line_subtotal numeric(12,2) NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT purchase_order_items_quantity_check
    CHECK (quantity_ordered > 0 AND quantity_received >= 0 AND quantity_received <= quantity_ordered),
  CONSTRAINT purchase_order_items_unit_cost_check CHECK (unit_cost >= 0),
  CONSTRAINT purchase_order_items_line_subtotal_check CHECK (line_subtotal >= 0),
  CONSTRAINT purchase_order_items_tenant_order_id_unique UNIQUE (tenant_id, purchase_order_id, id),
  CONSTRAINT purchase_order_items_tenant_order_product_unique
    UNIQUE (tenant_id, purchase_order_id, id, product_id),
  CONSTRAINT purchase_order_items_order_fk
    FOREIGN KEY (tenant_id, purchase_order_id)
    REFERENCES public.purchase_orders (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT purchase_order_items_product_fk
    FOREIGN KEY (tenant_id, product_id)
    REFERENCES public.products (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX purchase_order_items_order_idx
  ON public.purchase_order_items (tenant_id, purchase_order_id, created_at, id);
CREATE INDEX purchase_order_items_product_idx
  ON public.purchase_order_items (tenant_id, product_id);

CREATE TABLE public.purchase_order_receipts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  purchase_order_id uuid NOT NULL,
  idempotency_key character varying(100) NOT NULL,
  received_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  received_by uuid,
  notes text,
  CONSTRAINT purchase_order_receipts_key_not_blank CHECK (btrim(idempotency_key) <> ''),
  CONSTRAINT purchase_order_receipts_order_id_unique UNIQUE (tenant_id, purchase_order_id, id),
  CONSTRAINT purchase_order_receipts_idempotency_unique
    UNIQUE (tenant_id, purchase_order_id, idempotency_key),
  CONSTRAINT purchase_order_receipts_order_fk
    FOREIGN KEY (tenant_id, purchase_order_id)
    REFERENCES public.purchase_orders (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX purchase_order_receipts_history_idx
  ON public.purchase_order_receipts (tenant_id, purchase_order_id, received_at DESC, id DESC);

CREATE TABLE public.purchase_order_receipt_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  purchase_order_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  purchase_order_item_id uuid NOT NULL,
  product_id uuid NOT NULL,
  received_quantity numeric(12,3) NOT NULL,
  unit_cost numeric(12,2) NOT NULL,
  line_total numeric(12,2) NOT NULL,
  CONSTRAINT purchase_order_receipt_items_values_check
    CHECK (received_quantity > 0 AND unit_cost >= 0 AND line_total >= 0),
  CONSTRAINT purchase_order_receipt_items_once_per_line
    UNIQUE (tenant_id, purchase_order_id, receipt_id, purchase_order_item_id),
  CONSTRAINT purchase_order_receipt_items_tenant_product_id_unique
    UNIQUE (tenant_id, product_id, id),
  CONSTRAINT purchase_order_receipt_items_receipt_fk
    FOREIGN KEY (tenant_id, purchase_order_id, receipt_id)
    REFERENCES public.purchase_order_receipts (tenant_id, purchase_order_id, id) ON DELETE RESTRICT,
  CONSTRAINT purchase_order_receipt_items_order_line_fk
    FOREIGN KEY (tenant_id, purchase_order_id, purchase_order_item_id, product_id)
    REFERENCES public.purchase_order_items (tenant_id, purchase_order_id, id, product_id) ON DELETE RESTRICT,
  CONSTRAINT purchase_order_receipt_items_product_fk
    FOREIGN KEY (tenant_id, product_id)
    REFERENCES public.products (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX purchase_order_receipt_items_receipt_idx
  ON public.purchase_order_receipt_items (tenant_id, receipt_id);
CREATE INDEX purchase_order_receipt_items_order_line_idx
  ON public.purchase_order_receipt_items (tenant_id, purchase_order_item_id);

-- Link each purchase receipt line to exactly one ledger movement. The new
-- nullable column leaves all existing manual and stock-adjustment rows intact.
ALTER TABLE public.stock_movements
  ADD COLUMN purchase_order_receipt_item_id uuid;

ALTER TABLE public.stock_movements
  ADD CONSTRAINT stock_movements_purchase_receipt_item_fk
  FOREIGN KEY (tenant_id, product_id, purchase_order_receipt_item_id)
  REFERENCES public.purchase_order_receipt_items (tenant_id, product_id, id)
  ON DELETE RESTRICT;

CREATE UNIQUE INDEX stock_movements_purchase_receipt_item_unique_idx
  ON public.stock_movements (tenant_id, purchase_order_receipt_item_id)
  WHERE purchase_order_receipt_item_id IS NOT NULL;

COMMIT;

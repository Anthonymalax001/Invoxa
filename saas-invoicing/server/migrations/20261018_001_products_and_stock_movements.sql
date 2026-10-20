-- Product catalogue and tenant-scoped stock ledger.
-- Forward-only migration. Review against a disposable database snapshot first.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

-- Check the existing tenant key and UUID generator before adding references.
-- The repository's integrity report confirms column types, but does not report
-- key constraints, so this migration verifies that tenants.id can be referenced.
DO $$
BEGIN
  IF to_regclass('public.tenants') IS NULL THEN
    RAISE EXCEPTION 'Cannot create products: public.tenants is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = to_regclass('public.tenants')
      AND a.attname = 'id'
      AND a.atttypid = 'uuid'::regtype
      AND a.attnum > 0
      AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION 'Cannot create products: public.tenants.id must exist as uuid';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_attribute a
      ON a.attrelid = i.indrelid
     AND a.attname = 'id'
     AND a.attnum > 0
     AND NOT a.attisdropped
    WHERE i.indrelid = to_regclass('public.tenants')
      AND i.indisunique
      AND i.indisvalid
      AND i.indisready
      AND i.indpred IS NULL
      AND i.indexprs IS NULL
      AND i.indnkeyatts = 1
      AND i.indkey[0] = a.attnum
  ) THEN
    RAISE EXCEPTION 'Cannot create products: public.tenants.id needs a valid single-column unique key';
  END IF;

  IF to_regprocedure('uuid_generate_v4()') IS NULL THEN
    RAISE EXCEPTION 'Cannot create products: uuid_generate_v4() is unavailable';
  END IF;
END;
$$;

CREATE TABLE public.products (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL
    REFERENCES public.tenants(id) ON DELETE RESTRICT,
  name character varying(255) NOT NULL,
  sku character varying(100) NOT NULL,
  description text,
  unit_of_measure character varying(50) NOT NULL DEFAULT 'each',
  cost_price numeric(12,2) NOT NULL DEFAULT 0,
  selling_price numeric(12,2) NOT NULL DEFAULT 0,
  current_stock numeric(12,3) NOT NULL DEFAULT 0,
  low_stock_threshold numeric(12,3) NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT products_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT products_sku_not_blank CHECK (btrim(sku) <> ''),
  CONSTRAINT products_unit_not_blank CHECK (btrim(unit_of_measure) <> ''),
  CONSTRAINT products_cost_price_nonnegative CHECK (cost_price >= 0),
  CONSTRAINT products_selling_price_nonnegative CHECK (selling_price >= 0),
  CONSTRAINT products_current_stock_nonnegative CHECK (current_stock >= 0),
  CONSTRAINT products_low_stock_threshold_nonnegative CHECK (low_stock_threshold >= 0),
  CONSTRAINT products_tenant_id_id_unique UNIQUE (tenant_id, id)
);

-- SKU uniqueness is case-insensitive and whitespace-normalized within each tenant.
CREATE UNIQUE INDEX products_tenant_sku_ci_unique_idx
  ON public.products (tenant_id, lower(btrim(sku)));

CREATE INDEX products_tenant_name_idx
  ON public.products (tenant_id, lower(name));

CREATE INDEX products_tenant_active_idx
  ON public.products (tenant_id, is_active);

CREATE TABLE public.stock_movements (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL
    REFERENCES public.tenants(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL,
  movement_type character varying(20) NOT NULL,
  quantity_delta numeric(12,3) NOT NULL,
  quantity_before numeric(12,3) NOT NULL,
  quantity_after numeric(12,3) NOT NULL,
  reference character varying(100),
  notes text,
  -- Auth JWTs provide userId. No users FK is assumed because repository schema
  -- evidence does not establish a users.id key constraint.
  created_by uuid,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT stock_movements_type_check
    CHECK (movement_type IN ('receipt', 'adjustment')),
  CONSTRAINT stock_movements_delta_nonzero CHECK (quantity_delta <> 0),
  CONSTRAINT stock_movements_before_nonnegative CHECK (quantity_before >= 0),
  CONSTRAINT stock_movements_after_nonnegative CHECK (quantity_after >= 0),
  CONSTRAINT stock_movements_receipt_positive
    CHECK (movement_type <> 'receipt' OR quantity_delta > 0),
  CONSTRAINT stock_movements_balance_check
    CHECK (quantity_after = quantity_before + quantity_delta),
  CONSTRAINT stock_movements_product_tenant_fk
    FOREIGN KEY (tenant_id, product_id)
    REFERENCES public.products (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX stock_movements_product_history_idx
  ON public.stock_movements (tenant_id, product_id, created_at DESC, id DESC);

COMMIT;

-- Perpetual inventory accounting with tenant-scoped weighted-average valuation.
-- Requires the inventory, purchasing, sales-order and accounting foundation migrations.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$
BEGIN
  IF to_regclass('public.products') IS NULL
     OR to_regclass('public.stock_movements') IS NULL
     OR to_regclass('public.purchase_order_receipt_items') IS NULL
     OR to_regclass('public.sales_order_fulfillment_items') IS NULL
     OR to_regclass('public.accounting_settings') IS NULL
     OR to_regclass('public.accounting_accounts') IS NULL
     OR to_regclass('public.accounting_periods') IS NULL
     OR to_regclass('public.accounting_journal_entries') IS NULL THEN
    RAISE EXCEPTION 'Inventory accounting requires inventory, purchasing, sales and accounting migrations';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.products'::regclass
      AND attname IN ('inventory_value', 'weighted_average_cost', 'inventory_valuation_status')
      AND attnum > 0 AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'Inventory accounting columns already exist; inspect the partial migration';
  END IF;
END;
$$;

ALTER TABLE public.accounting_settings
  ADD COLUMN inventory_asset_account_id uuid,
  ADD COLUMN inventory_cogs_account_id uuid,
  ADD COLUMN inventory_adjustment_account_id uuid,
  ADD COLUMN inventory_clearing_account_id uuid,
  ADD CONSTRAINT accounting_settings_inventory_asset_account_fk
    FOREIGN KEY (tenant_id, inventory_asset_account_id)
    REFERENCES public.accounting_accounts (tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT accounting_settings_inventory_cogs_account_fk
    FOREIGN KEY (tenant_id, inventory_cogs_account_id)
    REFERENCES public.accounting_accounts (tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT accounting_settings_inventory_adjustment_account_fk
    FOREIGN KEY (tenant_id, inventory_adjustment_account_id)
    REFERENCES public.accounting_accounts (tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT accounting_settings_inventory_clearing_account_fk
    FOREIGN KEY (tenant_id, inventory_clearing_account_id)
    REFERENCES public.accounting_accounts (tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE public.products
  ADD COLUMN weighted_average_cost numeric(12,6) NOT NULL DEFAULT 0,
  ADD COLUMN inventory_value numeric(18,6) NOT NULL DEFAULT 0,
  ADD COLUMN inventory_valuation_status character varying(12) NOT NULL
    DEFAULT CASE WHEN current_stock = 0 THEN 'valued' ELSE 'unvalued' END,
  ADD CONSTRAINT products_weighted_average_cost_check CHECK (weighted_average_cost >= 0),
  ADD CONSTRAINT products_inventory_value_check CHECK (inventory_value >= 0),
  ADD CONSTRAINT products_inventory_valuation_status_check
    CHECK (inventory_valuation_status IN ('valued', 'unvalued')),
  ADD CONSTRAINT products_inventory_valuation_consistency_check
    CHECK (inventory_valuation_status = 'unvalued' OR
      (current_stock = 0 AND inventory_value = 0 AND weighted_average_cost = 0)
      OR (current_stock > 0 AND inventory_value > 0 AND weighted_average_cost > 0));

ALTER TABLE public.stock_movements
  DROP CONSTRAINT stock_movements_type_check,
  ADD COLUMN unit_cost numeric(12,6),
  ADD COLUMN value_delta numeric(18,6),
  ADD COLUMN inventory_value_before numeric(18,6),
  ADD COLUMN inventory_value_after numeric(18,6),
  ADD COLUMN source_type character varying(50),
  ADD COLUMN source_id uuid,
  ADD COLUMN idempotency_key character varying(100),
  ADD COLUMN journal_entry_id uuid,
  ADD CONSTRAINT stock_movements_type_check
    CHECK (movement_type IN ('receipt', 'adjustment', 'sale', 'return')),
  ADD CONSTRAINT stock_movements_delta_check
    CHECK (quantity_delta <> 0 OR movement_type = 'opening'),
  ADD CONSTRAINT stock_movements_unit_cost_check
    CHECK (unit_cost IS NULL OR unit_cost >= 0),
  ADD CONSTRAINT stock_movements_value_delta_check
    CHECK (value_delta IS NULL OR value_delta <> 0),
  ADD CONSTRAINT stock_movements_inventory_values_check
    CHECK ((inventory_value_before IS NULL AND inventory_value_after IS NULL)
      OR (inventory_value_before >= 0 AND inventory_value_after >= 0)),
  ADD CONSTRAINT stock_movements_journal_fk
    FOREIGN KEY (tenant_id, journal_entry_id)
    REFERENCES public.accounting_journal_entries (tenant_id, id) ON DELETE RESTRICT;

CREATE INDEX stock_movements_inventory_journal_idx
  ON public.stock_movements (tenant_id, journal_entry_id)
  WHERE journal_entry_id IS NOT NULL;
CREATE UNIQUE INDEX stock_movements_inventory_source_unique_idx
  ON public.stock_movements (tenant_id, source_type, source_id)
  WHERE source_type IS NOT NULL AND source_id IS NOT NULL;

COMMIT;

-- Explicit opening-stock valuation support. Additive migration; requires
-- the perpetual inventory accounting migration.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;

DO $$
BEGIN
  IF to_regclass('public.accounting_settings') IS NULL
     OR to_regclass('public.products') IS NULL
     OR to_regclass('public.stock_movements') IS NULL THEN
    RAISE EXCEPTION 'Opening inventory valuation requires inventory accounting tables';
  END IF;
END;
$$;

ALTER TABLE public.accounting_settings
  ADD COLUMN inventory_opening_balance_account_id uuid,
  ADD CONSTRAINT accounting_settings_inventory_opening_balance_account_fk
    FOREIGN KEY (tenant_id, inventory_opening_balance_account_id)
    REFERENCES public.accounting_accounts (tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE public.stock_movements
  DROP CONSTRAINT stock_movements_type_check,
  DROP CONSTRAINT stock_movements_delta_nonzero,
  DROP CONSTRAINT stock_movements_value_delta_check,
  ADD CONSTRAINT stock_movements_type_check
    CHECK (movement_type IN ('receipt', 'adjustment', 'sale', 'return', 'opening')),
  ADD CONSTRAINT stock_movements_delta_check
    CHECK (quantity_delta <> 0 OR movement_type = 'opening'),
  ADD CONSTRAINT stock_movements_value_delta_check
    CHECK (value_delta IS NULL OR value_delta <> 0 OR movement_type = 'opening');

COMMIT;

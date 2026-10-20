# Sales orders

## Invoicing behavior

- An order must be fully fulfilled before it can be invoiced. Partial invoices are not supported.
- Each sales order can have one linked invoice. The database link and the transaction both reject a second invoice.
- The invoice uses the existing `invoices` and `invoice_items` columns and is returned in the same row-plus-`items` shape as invoice creation. Product names and SKUs are copied into the line description; the order discount percentage and value are included there, while `amount` stores the discounted line subtotal.
- Order subtotal is net of line discounts. Tax is calculated on that net subtotal. The invoice receives those server-calculated values; client-submitted totals are ignored.
- Invoice creation leaves `due_date` null because a sales order's expected delivery date is not an invoice payment due date. Set a due date through a later explicit workflow if needed.
- Invoice creation does not change stock. Fulfillment is the only sales-order operation that deducts stock. The existing free-text invoice endpoint, PDF generation and payment flows remain available and unchanged.
- A failure inserting the invoice or any invoice item rolls the whole invoice transaction back. The fulfilled order and its stock movements remain intact, so invoice creation can be retried.

## Fulfillment behavior

- Fulfillment accepts quantities up to each line's outstanding quantity and the locked product's available stock. Over-fulfillment and insufficient stock return conflict responses without committing changes.
- A required `Idempotency-Key` is scoped to the tenant and order. Replaying a key returns its original fulfillment and does not deduct stock again. The client keeps the same key when retrying an open submission.
- Each fulfilled line creates one stock movement of type `adjustment` with a negative delta, matching the existing inventory ledger's allowed movement types. The movement links to the fulfillment line and records the JWT user's `userId`.
- Order and line quantities use two decimal places to match `invoice_items.quantity`; inventory balances and stock movements use the inventory schema's three decimal places.

## Migration sequence

`20261018_003_sales_orders.sql` is forward-only and is not idempotent. It requires `20261018_001_products_and_stock_movements.sql` to have been applied, plus the existing tenant, client, invoice and invoice-item schema. It checks the required core columns and `invoices.id` UUID default, verifies the inventory ledger constraints, and aborts if client rows cannot support the composite tenant key. It does not require the suppliers/purchasing migration, although a chronological migration run should apply `20261018_002_suppliers_and_purchasing.sql` between `001` and `003` when that migration is pending.

The migration does not change invoice numbers and does not require the separate invoice-number uniqueness migration. The known duplicate `INV-0002` remains untouched. Do not apply the invoice-number uniqueness migration while that duplicate pair exists; it requires a separately approved reconciliation before it can succeed.

Before applying migrations, inspect the migration ledger and the schema on a disposable database snapshot, then review the generated DDL and confirm the snapshot connection. No migration should be run against production as part of this change.

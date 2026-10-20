# Expenses

## Expense behavior

- New expenses are drafts. The server assigns an `EXP-####` number while locking the authenticated tenant row; request-body tenant IDs, expense numbers, status and audit user IDs are ignored.
- The tenant creates and deactivates its own categories. Categories are deactivated rather than deleted so existing expense history remains available.
- An optional supplier must be active and belong to the authenticated tenant. A free-text payee may be recorded instead. Both can be omitted.
- Amounts are positive `numeric(12,2)` values. Currency defaults to `KES`; the API accepts a three-letter currency code, and all summary totals group by currency rather than combining unlike currencies.
- Creation requires an `Idempotency-Key`. Replaying the same key and payload returns the existing record; reusing the key with different expense data returns `409`. The key is scoped to a tenant.
- Only drafts can be edited. Allowed transitions are draft to approved or cancelled, and approved to paid or cancelled. Paid and cancelled records are terminal. Repeating the same transition is idempotent; conflicting transitions return `409`.
- Approval and payment transitions are recorded with the verified JWT user ID and database timestamp. A paid expense requires a valid payment method and the status change and audit fields are written in one transaction. This records the user's payment assertion; it does not initiate a transfer or M-Pesa transaction.
- Period summaries include approved and paid expenses and keep currencies separate. Draft, cancelled, approved and paid amounts are separately available in the status summary. The dashboard displays approved plus paid expenses separately from the existing invoice-derived revenue and never nets the two values.
- File uploads and attachment references are not included because the project has no storage, upload validation or access-control flow. No accounting entries are created.

## Migration and authorization

`20261019_001_expenses.sql` is forward-only. It depends on `20261018_002_suppliers_and_purchasing.sql`, which in turn depends on the inventory migration `20261018_001_products_and_stock_movements.sql`. Apply pending migrations in date order on a reviewed disposable database snapshot. This migration checks the tenant key, supplier composite key and fields, and UUID generator before creating expense tables. It makes no changes to existing invoices, payments, inventory or purchasing records.

The application currently uses JWT authentication and tenant-scoped queries, but has no role-based authorization middleware or expense-specific approval policy. Any authenticated user in a tenant can currently create, approve, pay or cancel that tenant's expenses. Define and implement a role or separation-of-duties policy before relying on expense approval as an independent financial control.

Do not add expense rows to a general ledger until an accounting design defines accounts, periods, tax treatment, reversals and reconciliation.

# Expenses

## Expense behavior

- Expenses are entered manually through the Expenses page and `/api/expenses`; the API persists records in PostgreSQL `expenses` and categories in `expense_categories`. There is no bank-statement, bank-transaction or M-Pesa expense import. Expenses are not automatically created or linked from invoices or purchase orders; an optional supplier is only a payee reference.
- New expenses are drafts. The server assigns an `EXP-####` number while locking the authenticated tenant row; request-body tenant IDs, expense numbers, status and audit user IDs are ignored.
- The tenant creates and deactivates its own categories. Categories are deactivated rather than deleted so existing expense history remains available.
- An optional supplier must be active and belong to the authenticated tenant. A free-text payee may be recorded instead. Both can be omitted.
- Amounts are positive `numeric(12,2)` values. Currency defaults to `KES`; the API accepts a three-letter currency code, and all summary totals group by currency rather than combining unlike currencies.
- Creation requires an `Idempotency-Key`. Replaying the same key and payload returns the existing record; reusing the key with different expense data returns `409`. The key is scoped to a tenant.
- Only drafts can be edited. Allowed transitions are draft to approved or cancelled, and approved to paid or cancelled. Paid and cancelled records are terminal. Repeating the same transition is idempotent; conflicting transitions return `409`.
- Approval recognizes the expense in the tenant ledger: the mapped expense account is debited and the configured accounts-payable account is credited. Payment debits that same accounts-payable account and credits the tenant-owned cash or bank account selected by the user; it never creates a second expense. Both transitions are recorded with the verified JWT user ID and database timestamp in one transaction. This records the user's payment assertion; it does not initiate a transfer or M-Pesa transaction.
- Each category must map to an active tenant expense account before approval. New categories use the tenant's only unambiguous active expense account as a setup default; administrators can change mappings through the accounting category-mapping control. The accounts-payable and optional input-VAT asset accounts are configured per tenant.
- Input VAT is optional. A positive amount requires a tax document reference; recoverable VAT additionally requires explicit recoverability and the configured tenant input-VAT asset account. No tax rate or recoverability is inferred.
- Posted expense journals are immutable. Unposted expenses may be cancelled with a reason; approved or paid expenses require the audited reversal action, which posts reversal journals and retains the original accounting history.
- Period summaries include approved and paid expenses and keep currencies separate. Draft, cancelled, approved and paid amounts are separately available in the status summary. The dashboard displays approved plus paid expenses separately from the existing invoice-derived revenue and never nets the two values.
- File uploads and attachment references are not included because the project has no storage, upload validation or access-control flow.

## Migration and authorization

`20261019_001_expenses.sql` is forward-only. It depends on `20261018_002_suppliers_and_purchasing.sql`, which in turn depends on the inventory migration `20261018_001_products_and_stock_movements.sql`. Apply pending migrations in date order on a reviewed disposable database snapshot. This migration checks the tenant key, supplier composite key and fields, and UUID generator before creating expense tables. It makes no changes to existing invoices, payments, inventory or purchasing records.

The application uses JWT authentication, tenant-scoped queries, and the accounting permission middleware for approval, payment, cancellation, category mapping, and reversal actions. The workflow does not itself enforce a separate approver/payee separation-of-duties policy; configure roles and operational review accordingly.

`20261102_001_expense_accounting.sql` is additive and must be applied after the accounting foundation. It adds tenant-owned expense/payables/VAT mappings, expense VAT and posting/reversal references, payment account/date fields, and tenant-scoped foreign keys and uniqueness indexes. It does not backfill legacy approved or paid expenses; review those records before relying on period-close readiness.

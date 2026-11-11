# Supplier bills and payables

## Scope

Supplier bills are separate from purchase orders, goods receipts, and operating expenses. A PO is an authorization/reference, a goods receipt is a quantity/stock record, and an expense is the existing category-based spend workflow. None of those records proves a supplier has been paid. This workflow creates a bill liability only after an administrator approves the supplier invoice.

The API is mounted at `/api/supplier-bills`. Reads require the existing `accounting:read` permission. Mutations require `accounting:manage-payables`, currently granted only to the existing `admin` role. Tenant and actor identifiers are taken from the authenticated JWT; request-body tenant identifiers are ignored.

## Bill lifecycle

- Create a draft with an internal `BILL-######` number, supplier invoice number, bill/due dates, currency, notes, lines, line tax rate, and explicit debit account per line.
- Supplier invoice numbers are unique case-insensitively after trimming within a tenant and supplier.
- A bill can reference an ordered, partially received, or received PO. Individual lines can link to that PO and a specific receipt line. The links are tenant-scoped and checked against the supplier and PO line; they do not create inventory accounting entries.
- Draft edits replace bill lines transactionally. A draft or submitted bill can be cancelled with a reason. Submitted bills require a different administrator from the creator to approve them.
- Approval debits the chosen line expense/asset accounts and credits an active liability/credit account selected as AP. It uses the existing `postJournal` transaction and the bill's date unless the approver supplies an accounting date. Journal event keys are stable for retries.
- Paid, partially paid, and overdue are calculated from verified payment allocations and the bill due date. They are not independently editable workflow states.
- A posted bill cannot be edited or deleted. An unpaid approved bill can be reversed with a reason, open period, and reversal date. Verified payments must be reversed first.

## Supplier payments

`POST /payments` records a pending supplier payment and immutable allocations to one or more approved bills. The allocations must equal the full payment amount; this release does not support supplier prepayments or unallocated cash. A pending payment does not reduce a bill balance.

An administrator other than the payment creator verifies the payment only after checking external evidence. Verification locks the relevant bill rows, rechecks supplier, currency, and outstanding balances, and posts debits to each bill's AP account and a credit to the selected cash/bank asset account. The transaction, allocation, and journal posting are atomic. A pending payment can instead be marked failed with a reason. A verified payment can be reversed through `reverseJournal`; original payment and allocation history remains available.

## Accounting and validation boundaries

- Bill line amounts use decimal-string input, quantity precision 3, unit-price precision 2, and line subtotal rounding to cents. Tax is calculated per line using the submitted percentage and rounded to cents. Header totals must match line sums, with a deferred database check.
- The existing tax profiles are for issued customer documents and point to tax-payable liability accounts. They do not configure supplier input/recoverable tax. Tax-bearing bills can be saved and submitted, but approval is blocked until an approved input-tax account mapping and policy exist. No customer output-tax account is reused for supplier input tax.
- Foreign-currency drafts can be recorded, but posting is limited to the tenant's configured base currency. Exchange-rate sourcing and realized/unrealized FX policy are not configured here.
- Debit account selection is explicit per bill line. The current chart has no supplier-specific AP mapping or required inventory/expense system keys; the approver selects an active credit-liability AP account. Classification, inventory valuation, and goods-received-not-invoiced policy still need accounting approval.
- PO and receipt links are reference/matching metadata. There is no approved variance tolerance, inventory valuation method, receipt accrual, or GRNI workflow. A PO or receipt does not auto-create a bill or prove settlement.
- Payment verification is a privileged manual confirmation of bank/cash/provider evidence; no bank feed or provider settlement reconciliation is connected. Failed payments are retained and should be replaced by a new payment record.
- The overdue list status uses the database `CURRENT_DATE`; tenant-specific timezone policy is not implemented.

## Migration and verification

`migrations/20261024_001_supplier_payables.sql` is a prepared, additive migration. It creates the supplier bill, line, event, payment, allocation, and payment-event tables; case-insensitive duplicate-invoice uniqueness; tenant-scoped supplier/accounting/PO/receipt foreign keys; immutable posted-history triggers; bill-total and payment-allocation consistency checks; and a supporting unique key for exact receipt-line references. It is not executed by this change.

The migration preflights for repository-defined purchasing and accounting objects and key names. That is not evidence that any deployed database has those definitions or that this migration is production compatible. Compare against authoritative target DDL and approved migration history before applying it.

Focused unit/route tests cover monetary normalization, computed tax and totals, payment allocation totals, duplicate/overpayment policy helpers, currency and approval boundaries, balanced journal-line construction, JWT-derived tenant identity, admin gating, and duplicate invoice conflict reporting. They do not replace a guarded PostgreSQL integration test. The migration has not been applied or validated against PostgreSQL in this task.

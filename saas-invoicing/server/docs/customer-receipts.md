# Customer receipts and invoice allocations

This workflow is additive to the legacy M-Pesa `payments` request flow. An STK request or callback alone does not create a receipt or mark money verified. A matching server-to-server Daraja status query can create a pending M-Pesa receipt; that receipt still requires the normal evidence review and accounting verification described below. See [M-Pesa STK Push verification](mpesa-payment-verification.md).

## Receipt states

- `pending`: receipt details were recorded. No journal is posted and no invoice allocation is allowed.
- `verified`: an authorized administrator confirmed the payment, selected a cash/bank asset account and open accounting period, and a balanced journal was posted in the same transaction.
- `failed`: an authorized administrator recorded why the pending receipt was not received. It cannot be verified later.
- `reversed`: a verified receipt was reversed through a linked journal. The receipt, journal, events and allocation rows remain for audit; its allocations no longer reduce invoice outstanding.

Receipt verification debits the selected asset account and credits the tenant's configured receivables account for the full receipt. Allocation is a separate customer-subledger operation: it assigns some or all of that credit to one or more posted invoices. Unallocated value remains visible on the customer receipt balance. A fully allocated invoice is marked `paid`; reversing a receipt reopens invoices whose active allocations no longer cover their totals, using the invoice due date to choose `sent` or `overdue`. Allocation does not edit an issued invoice's financial amounts or create another journal.

## API

- `POST /api/payments/receipts` records a pending receipt; requires an `Idempotency-Key`.
- `POST /api/payments/receipts/:id/verify` confirms and posts a pending receipt; requires an `Idempotency-Key`, cash/bank asset account and open period.
- `POST /api/payments/receipts/:id/fail` records a failure reason for a pending receipt.
- `POST /api/payments/receipts/:id/allocate` allocates a verified receipt to one or more outstanding invoices; requires an `Idempotency-Key`.
- `POST /api/payments/receipts/:id/reverse` posts an audited reversal for a verified receipt; requires an `Idempotency-Key`, open period and reason.
- `GET /api/payments/receipts`, `GET /api/payments/receipts/:id`, and `GET /api/payments/customers/:customerId/payment-history` return tenant-scoped receipt, allocation and event history.
- `GET /api/payments/receipts/outstanding-invoices?customer_id=...` returns issued invoices that have an accounting issue snapshot and a posted journal in the configured currency.

Tenant and actor identities come from the authenticated JWT. Mutations require the existing accounting administrator authorization pattern. Idempotency keys are tenant-scoped, and allocation checks are repeated in database triggers while receipt and invoice rows are locked.

## Currency, invoice and account boundaries

Receipt posting is KES-only and requires the receipt currency to match the tenant accounting currency. Allocations accept only `sent` or `overdue` invoices whose immutable issue snapshot matches the invoice total and whose linked journal is posted in the same currency. Old issued invoices without those accounting records need a reviewed cutover before this workflow can allocate to them.

The accounting chart currently classifies accounts only by broad `account_type`; it has no cash/bank subtype. The service verifies the selected account is active, tenant-owned and an asset distinct from receivables. The operator must choose the intended cash, bank or clearing asset. A dedicated account-purpose mapping is not part of this change.

The pre-existing `payments` table has no repository DDL or verified status contract. The existing route creates pending M-Pesa requests and its public callback validates and acknowledges payloads without mutating payment state. An authorized Daraja query writes a separate reconciliation audit event and may create a pending receipt, but the legacy payment row remains pending. Only receipt verification followed by invoice allocation reduces the outstanding invoice balance.

## Database change

`migrations/20261023_001_customer_receipts.sql` adds receipt, append-only event, allocation-batch and allocation tables, tenant-scoped keys, immutable-history triggers and allocation-limit checks. It also adds unique tenant/id indexes to `clients` and `invoices` as the targets for scoped foreign keys. Its preflight fails if the core invoice/customer column types or required accounting keys do not match the expected contract. This migration has not been executed and requires authoritative schema review before any deployment. No production compatibility is claimed.

The focused service tests can be run with:

```sh
node --test test/customerReceipts.test.js test/customerReceiptRoutes.test.js test/payments.test.js test/accounting.test.js test/invoiceAccounting.test.js test/invoices.test.js
```

Those unit tests use mocks and are not a substitute for the guarded disposable PostgreSQL integration suite.

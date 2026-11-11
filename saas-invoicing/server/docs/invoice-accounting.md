# Invoice accounting

## Tax configuration

Each tenant must configure invoice receivables and sales revenue accounts with `PUT /api/accounting/invoice-mappings`:

```json
{
  "receivables_account_id": "<tenant asset account UUID>",
  "sales_revenue_account_id": "<tenant revenue account UUID>"
}
```

The mapping API accepts only active accounts owned by the tenant, requires distinct accounts, and checks the receivables and revenue account types. If a selected tax profile requires a liability, its tax payable account must also be an active tenant liability account.

Create tax profile versions with `POST /api/accounting/tax-profiles`. Each request must provide `profile_key`, `name`, `tax_rate`, `calculation_method` (`exclusive` or `inclusive`), `rounding_method` (`invoice_total` or `line_item`), `effective_from`, optional `effective_to`, `requires_tax_payable`, and a tenant-owned `tax_payable_account_id` when required. Versions are retained and immutable; create a new version with a later effective date when policy changes. Deactivation does not delete the version.

The software does not prescribe Kenyan legal tax categories or treatments. The tenant and its accountant must confirm the applicable Kenyan tax treatment, rate, calculation method, effective dates and liability mapping before creating profiles. Tax configuration is tenant-owned and applies to both direct invoices and Sales Order invoices.

## Creating and issuing invoices

Both `POST /api/invoices` and `POST /api/sales-orders` require a tenant tax profile ID. The server calculates exact-decimal line amounts and tax, ignores client totals and saves the selected profile version and calculated totals with the draft. Sales Order discounts are applied to each line before tax; invoice generation preserves the discounted line amount and does not apply the discount again.

The first release is KES-only. Non-KES currency input is rejected, and no conversion is performed. Finalization requires tenant accounting base currency `KES`, a valid tax snapshot, active account mappings and exactly one open accounting period covering the issue date.

Drafts create no journal. An authorized administrator issues a draft with:

```http
POST /api/invoices/:id/finalize
Content-Type: application/json
```

The body may be empty or contain only an optional validated `issue_date` in `YYYY-MM-DD` format. Financial totals, tax values, currency, status and accounts are derived from server records. A successful first issuance returns HTTP 201 with `{ "invoice", "journal", "lines", "replayed": false }`; an identical retry returns HTTP 200 with the linked journal and `replayed: true`. The source event and idempotency key are stable for the invoice UUID and issue event. A retry that supplies a different issue date conflicts.

Issuance locks and validates the tenant-owned invoice and client, its lines, Sales Order link where applicable, exact-decimal totals and immutable tax snapshot. It then posts Accounts Receivable as a debit, Sales Revenue as a credit, and tax payable as a credit when the selected snapshot requires it. Invoice status/audit and the journal/event commit in one transaction on the same PostgreSQL client. A constraint failure at commit rolls back the invoice issuance and journal together.

Existing `sent`, `overdue` or `paid` invoices without a matching issued tax snapshot are not automatically posted. Finalization returns a conflict for those records; they need a separately approved cutover process. The existing duplicate invoice number `INV-0002` remains untouched; the invoice-number uniqueness migration is outside this work.

The generic invoice status endpoint cannot set `sent` or `paid`; issuance uses the finalize endpoint. M-Pesa STK prompts are asynchronous: the initial acknowledgement is not proof of payment. The public callback is structurally validated and acknowledged but remains non-mutating because the repository and reviewed provider contract do not establish callback authentication. An authorized administrator can query the saved checkout ID with Daraja; a matching final provider success creates an idempotent pending customer receipt, which still requires the normal receipt evidence review, accounting posting, and invoice allocation. See [M-Pesa STK Push verification](mpesa-payment-verification.md) for provider requirements and the legacy `payments` schema limitation.

## Reversals and deferred work

Cancellation, credit notes, refunds and historical cutover are not implemented. The generic journal reversal endpoint explicitly rejects invoice-source journals, so it cannot leave an issued invoice collectible after reversing only its ledger entry. No source-specific invoice reversal is enabled: invoice status, tax treatment, customer balances, receipt allocations and refunds cannot yet be changed together under an approved business policy. A controller/tax adviser must approve the credit-note or cancellation model, allocation/refund effects, and date/period policy before a dedicated transactional workflow is added. Historical invoices require an approved cutover plan and must not be silently posted or assigned opening balances.

The unit tests in `server/test/invoiceAccounting.test.js` use mocked PostgreSQL clients; they do not exercise PostgreSQL itself. Separately, `server/integration/run-invoice-accounting-postgres.cmd` runs an opt-in PostgreSQL suite that sends requests through the real Express invoice, Sales Order and accounting routes. It currently defines 19 integration tests covering direct and Sales Order-generated invoices, balanced posting, saved tax snapshots and discounted totals, idempotent and concurrent retries, tenant isolation, authorization, configuration/period failures, rollback and legacy-invoice behavior.

The integration suite creates its core tables from `server/integration/invoice-fixture-schema.sql`, which is explicitly test-only, then applies selected repository migrations to its guarded disposable database. The fixture is not authoritative DDL for the original `tenants`, `users`, `clients`, `invoices` or `invoice_items` tables, and it does not define `payments`. Passing tests against this fixture demonstrate behavior with that fixture and those migration files; they do not establish production-schema compatibility. The original core schema remains unrecovered. The repository has no applied-migration ledger, so the presence of migration files is not evidence that they are deployed.

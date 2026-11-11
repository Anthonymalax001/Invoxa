# Accounting period close

Accounting periods can be reviewed by any authenticated user with `accounting:read`. Closing is restricted to tenant administrators with `accounting:close-periods`. The close request requires an explicit confirmation, a reason, and an `Idempotency-Key`.

`GET /api/accounting/periods/:id/readiness` returns the period, checks, blockers, warnings, and close audit history. A missing table or column is reported as an unavailable blocker; it is not treated as a successful check. Checks cover draft journals/opening balances, pending receipts/payments, failed receipt/payment warnings, draft or submitted supplier bills, approved/paid expenses without journals, inventory quantity movements without valuation journals, unresolved new M-Pesa initiation/reconciliation requests, posted-journal balance integrity, open bank reconciliations overlapping the period, and close-audit schema availability.

The journal schema only permits `draft` and `posted` journal states. It has no approved-but-unposted journal state. Supplier bills use `draft`, `submitted`, and `approved`; submitted bills are included as blockers, while approval and its posted journal are committed together by the existing service.

Pending receipts and supplier payments are assessed by their transaction dates. Supplier bills are assessed by bill date because approval posts at the bill date unless an administrator supplies another permitted date. Draft or submitted bills created or edited on a date in a closed period are rejected. Pending receipts and supplier payments with dates in closed periods are likewise rejected. These records acquire a shared period-row lock; close takes an exclusive lock before rechecking readiness, so the code paths serialize with closure.

All financial posting and reversal paths continue to use the accounting posting service. It locks the selected accounting period and rejects closed periods or dates outside the selected period. The database foundation migration also prevents a closed period from being reopened and prevents mutation of posted journals. The close workflow does not add a reopening endpoint.

## Required additive migration

Apply `20261030_002_accounting_period_close_audit.sql` only after reviewing it against the deployed schema. It creates append-only `accounting_period_events` rows for blocked close attempts and completed closes, including tenant, period, actor, time, reason, outcome, readiness details, and an idempotency fingerprint. Until it is applied, readiness reports the audit check as unavailable and the close API refuses to close a period. This migration has not been executed as part of this change.

The bank-reconciliation check depends on the tables from `20261030_001_bank_reconciliation.sql`. If those tables are absent, readiness reports an unavailable blocker. Reconciliation completeness is evaluated for open statement batches whose date range overlaps the accounting period.

The M-Pesa readiness check depends on `mpesa_stk_initiation_requests` from `20261031_002_mpesa_stk_initiation_idempotency.sql` and `mpesa_payment_reconciliation_audit` from `20261030_003_mpesa_reconciliation_audit.sql`. Unresolved reservation/provider states and payment rows without a conclusive latest reconciliation are blockers. The service does not query legacy `payments` dates or statuses because their deployed schema and status domain are not defined in the repository. It therefore adds a separate `legacy_mpesa_coverage` unavailable blocker for every period. Until authoritative legacy schema and an approved review/attestation process exist, period close will remain blocked for all tenants; no override endpoint is provided.

Any stock movement in the period blocks closure because movement rows contain quantities without an accounting valuation or linked journal. Approved/paid expenses likewise block because no expense journal mapping or posting workflow exists. Expense create/edit/approval/payment operations also take a shared accounting-period row lock and reject a date in a closed period. These checks intentionally prevent a period from reporting ready while supported source activity lacks ledger evidence.

## Known policy limits

- `accounting_periods` only models `open` and `closed`; no reopening workflow is provided. Any future reopening needs its own permission, reason, audit event and downstream reconciliation policy.
- Supplier bills have no separate accounting-period identifier before posting. Readiness uses `bill_date`, and the final posting service validates the chosen journal date and period. If an administrator approves a bill using a different open period, the bill is accounted in that selected period.
- Readiness is not a substitute for a controller's review of source documents or bank statements. Warnings are returned separately; the current supported checks are blockers when unresolved or unavailable.
- Automated tests use in-memory database fakes. They do not verify PostgreSQL row-lock interaction, trigger execution or migration compatibility. A PostgreSQL integration test against an approved non-production schema is still required before relying on database-level concurrency behavior.

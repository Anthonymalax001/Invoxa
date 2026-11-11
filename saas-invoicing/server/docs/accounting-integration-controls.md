# Accounting integration controls and unresolved policy

This note records the safe boundary for the current M-Pesa, invoice, expense, inventory, and period-close workflows. No provider request or database connection was made while preparing it.

## M-Pesa STK initiation idempotency

`POST /api/payments/request` requires a tenant-scoped `Idempotency-Key` bound to invoice ID/number, exact KES total, currency, and normalized phone number. Same-key/same-payload requests replay or resume local persistence; changed payload reuse returns HTTP 409. Different keys cannot start a second prompt while an invoice reservation remains active.

The server holds a PostgreSQL tenant/invoice advisory lock through the provider call, commits `reserved` before calling Daraja, and rechecks invoice status, posted total, verified allocations, customer receipts, and active requests under customer/invoice row locks. A unique partial index enforces one active request per invoice. `reserved`, `outcome_unknown`, `provider_accepted`, `reference_recovered`, `payment_recorded`, and `provider_succeeded` all retain the invoice reservation. A confirmed provider success creates a receipt through the standard receipt workflow and retains the reservation. Only a definite structured rejection or audited administrator resolution after external review closes a request without collection.

`GET /api/payments/stk-request-status` accepts the original key and returns tenant-scoped status plus immutable request events without the phone number or payload hash. `POST /api/payments/stk-request/recover` repairs local state only for a normal persisted provider acceptance, or after an administrator locates the real checkout identifier in an external Daraja record and supplies that ID, the original phone, an evidence reference and a reason. Ambiguous recovery appends a `reference_recovered` event and creates only a `pending` payment row for later exact-ID server-side reconciliation. It never invents a provider response, marks payment successful, creates a receipt, or posts a journal. `POST /api/payments/stk-request/resolve` requires `accounting:manage-receipts`, explicit confirmations of no collection and no outstanding prompt, an evidence reference, and a reason; it records an administrator assertion and releases only unresolved requests. It cannot release provider-confirmed success. A timeout or malformed response never starts another prompt automatically.

The phone number is retained only while safe local persistence recovery needs it; it is cleared after payment recording, definite rejection or administrative resolution. A process crash while the row is `reserved` can leave the phone stored. There is no expiry job. An administrator must wait for the advisory lock to clear and compare provider records before resolving a crashed/ambiguous request. Do not retry with a new key while the reservation is active.

STK acceptance never changes payment status to success. It creates only a `pending` legacy payment row. The callback remains untrusted and non-mutating. A final server-side Daraja query plus the separate receipt verification and allocation workflow is required before accounting entries are posted.

STK prompts reject an invoice if verified receipt allocations reduce its balance, or if the customer has a pending or verified-unallocated receipt. Since receipts are customer-scoped and need not yet name an invoice, this unallocated-receipt gate is deliberately conservative. Manual receipt creation/verification is held while a customer has an active STK request; allocations and reversals lock the selected invoices and fail while another channel's STK reservation is active. STK requests for partial balances are not enabled.

### Migration prerequisite

`migrations/20261031_002_mpesa_stk_initiation_idempotency.sql` and `migrations/20261031_003_mpesa_stk_invoice_reservations.sql` are additive and were not executed. Migration 002 checks the legacy `payments` columns and tenant/UUID prerequisites; migration 003 requires 002, aborts on duplicate active invoice requests/payment links, extends statuses and creates the unique reservation indexes. Review both against authoritative deployed DDL and migration-runner behavior. The reconciliation audit migration `20261030_003_mpesa_reconciliation_audit.sql` must also be reviewed/applied before provider reconciliation and period readiness use the new request state. Historical `payments` rows without linked durable requests are not assumed safe to reconcile; review their deployed status/date contract first.

## Invoice journal reversal

The generic journal reversal service permits only manual-adjustment sources by default. Invoice journals are rejected with HTTP 409 and cannot be reversed through the generic journal route. No invoice-specific reversal endpoint is implemented. This intentionally leaves the invoice, tax snapshot, receipt allocation, customer balance, and payment records untouched.

Before a source-specific invoice reversal or cancellation can be implemented, approve whether an issued invoice is corrected with a credit note or cancellation, the related tax document/tax-liability treatment, how posted receipt allocations and refunds are released, how collectible balances are recalculated, and which date/period and approval controls apply. Any future operation must lock and recheck the invoice and all allocations/receipts, create a linked immutable reversal/credit document, update business state in the same transaction, preserve the source journal, and use a stable idempotency key. The current safe outcome is to block the operation.

## Expenses

The expense schema has amount/currency/category/supplier/payment-method/reference and status/actor timestamps. It has no category-to-ledger-account mapping, payment date, tax fields, posted-journal link, or reversal link. Current transitions are draft to approved, approved to paid, and draft/approved to cancelled. These transitions do not post journals. Expense creation, edits, approval, and payment now take a shared accounting-period row lock and reject dates in closed periods. Paid expenses cannot be cancelled through the current route. Approved and paid expenses block period close and remain ambiguous in cutover preview; the system does not assume that an approval or a payment method proves an accounted transaction.

Do not add automatic expense journals until the controller approves expense-category account mapping, whether approval recognizes expense versus payment, verified cash/bank or payable account mapping, payment date/evidence, tax treatment, cancellation/reversal rules, and maker/checker permissions. A supported model could separate expense recognition from verified payment settlement, but the repository does not establish that policy. There is no expense journal to duplicate today; any later posting needs a tenant-scoped source link, unique event key and transactionally enforced open-period check.

## Inventory, purchasing, and fulfillment

Repository migrations define product `cost_price`, purchase-order item `unit_cost`, receipt-item `unit_cost`/`line_total`, quantity-only `stock_movements`, and quantity changes on purchase receipt and sales-order fulfillment. Purchase receiving and fulfillment are transactional and have source idempotency keys, but no accounting journal or valued stock layer is linked to those movements. Product `cost_price` is not a reliable historical cost layer. The current close-readiness check therefore blocks on any stock movement in the period and reports an unavailable blocker when the stock-movement schema is absent.

Do not post inventory or cost-of-goods-sold from current `cost_price` or retroactively assign costs to quantity movements. A safe accounting design needs approved policies for FIFO versus weighted average, landed freight/duty treatment, purchase accrual/GRNI timing, tax capitalization, stock-count adjustments, returns/credits, negative stock, and cutover valuation. The design also needs immutable valuation layers or an equivalent cost ledger, stable links from receipt/fulfillment events, per-product locking, a unique source-event constraint, and linked reverse/return movements. Those policies and source evidence are not established here, so accounting postings remain unsupported.

## Period-close readiness

Readiness now includes blockers for approved/paid expenses without journals, stock movements without valuation/journals, unresolved new M-Pesa initiation/reconciliation rows, and unavailable required schemas. The new M-Pesa check uses only the repository-created request/audit tables. It does not query the undocumented legacy payment schema.

Historical M-Pesa coverage is therefore always returned as an `unavailable` blocker: the repository does not define a safe date/status contract for existing `payments` rows. Period close records a blocked audit event and leaves the period open until an approved legacy schema and review process can account for that history. No override or attestation route is provided. This means period close is deliberately unavailable for all tenants until that prerequisite is resolved.

The journal posting service and period close use shared/exclusive period-row locks in their transactions. Current automated concurrency tests use mocked database clients; they do not prove PostgreSQL lock behavior, constraints, trigger execution, or compatibility with a populated deployment schema. A guarded PostgreSQL integration test against an approved disposable schema remains required.

## Deployment blockers

- Recover and review authoritative legacy `payments` DDL and migration history, then define a tenant-scoped historical reconciliation/attestation workflow before closing periods.
- Review/apply additive M-Pesa migrations in dependency order only after schema and migration-runner preflight. Neither was executed here.
- Approve invoice credit/cancellation and tax policy, expense recognition/settlement policy, and inventory valuation/costing policy before enabling those accounting workflows.
- Verify PostgreSQL transaction/locking behavior and migrations on an approved disposable database. Unit tests are mocked and are not compatibility evidence.

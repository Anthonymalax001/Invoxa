# Phase 4 Finance Policy Decision Log — Draft for Review

**Status:** proposals only; no accounting, tax, or legal policy in this document is approved. Decisions require review by the business owner and a qualified Kenyan accounting/tax adviser where appropriate.

**Repository scope:** this draft is based on local source, migrations, documentation, and disposable test fixtures. No database was queried and production compatibility was not verified.

## Decision register

Each proposal below is a suggested default for discussion, not an approved policy or a statement of Kenyan law.

### 1. Chart of accounts and required mappings

**Question:** Which account template and mandatory account mappings should every tenant receive, and who may change them?

**Options:** (a) one standard template with tenant-editable codes/names; (b) several business-type templates; (c) tenant-defined chart with a guided minimum set; (d) no seeded chart, with administrator setup before posting.

**Risk:** Posting to the wrong account or allowing missing/inactive mappings can misstate receivables, sales, tax, inventory, payables, expenses, or cash. Existing accounting schema supports account types, invoice AR/revenue mappings, and tax payable accounts, but does not seed a chart.

**Proposed default — requires approval:** use a small, versioned baseline template with required system keys for receivables, sales revenue, tax payable when applicable, cash/bank/M-Pesa clearing, inventory, accounts payable, and expense categories. Permit tenant labels/codes while preventing deletion/deactivation of accounts with posted history. Map expense categories and payment channels explicitly before their posting features are enabled.

**Dependencies:** approved chart template; migration/bootstrap strategy; account mapping UI/API; tenant role policy; source schema contract.

**Acceptance tests:** every required mapping belongs to the same tenant, has the required account type and active status; missing/wrong-type/inactive mapping blocks posting without leaking foreign-account existence; account with posted journal history cannot be deleted or made unusable; mapping edits are audited and do not rewrite prior journals.

### 2. Accounting date, periods, close and reopen

**Question:** Which date drives posting, how are backdated events handled, and can a closed period be reopened?

**Options:** event date; document date; server receipt date; or an explicit posting date within an open period. Close can be hard/irreversible, or controlled reopen with approval and audit.

**Risk:** A timezone/date mismatch or silent backdating changes reported periods. Reopening without controls undermines already-reviewed statements. Current schema prevents overlapping periods and posting into closed periods; the API exposes closing but no reopen operation.

**Proposed default — requires approval:** store business dates as dates; require an explicit effective accounting date for every posting; default it from the source document's date; reject dates outside exactly one open tenant period. Make close irreversible through ordinary UI; a separately authorized, reasoned, audited reopen workflow would require explicit approval.

**Dependencies:** period setup and tenant timezone policy; posting event shape; receipts, bills, expenses, reversals and reports.

**Acceptance tests:** boundary-date and timezone cases; gaps/overlaps; closing a period blocks new postings; close actor/time/reason audit; no silent edits to posted dates; reopen path (if approved) requires privileged authorization and records before/after state.

### 3. Invoice recognition and legacy invoice cutover

**Question:** When does an invoice create revenue/receivable, and how should existing draft/sent/overdue/paid invoices be brought into accounting?

**Options:** post on issue/finalization; post when sent; post on payment (cash basis); or support an approved accounting-basis configuration. Historical cutover can use opening balances, individually reconstructed journals, or prospective-only posting.

**Risk:** Double-posting invoices already represented in opening balances; treating `paid` as cash evidence; retroactive posting into closed periods; missing tax profile snapshots on legacy records. Current code posts on invoice finalization, and the invoice suite verifies new invoice posting. Documentation says legacy invoices are not automatically posted.

**Proposed default — requires approval:** keep invoice issue/finalization as the posting event for new invoices; retain cash receipt as a separate posting. Cut over historical balances through an explicit, reconciled opening-balance/import process, never automatic backfill from status alone. Preserve legacy invoices without journal linkage until each is reviewed or included in an approved opening balance.

**Dependencies:** verified production invoice DDL and duplicate-number handling; chart mappings; tax policy; period policy; opening-balance/reconciliation process.

**Acceptance tests:** draft invoice has no journal; successful finalization creates one balanced receivable/revenue/tax journal and issuance audit; retries/concurrency do not duplicate; legacy `sent`/`overdue`/`paid` rows do not auto-post; cutover totals reconcile to source AR and GL control accounts.

### 4. Customer receipts, allocations, overpayments, refunds and M-Pesa

**Question:** What is a receipt, when is it considered confirmed, how are receipts allocated, and how are excess funds/refunds represented?

**Options:** require allocation to one or more invoices; allow unapplied customer credit; reject overpayments; refund excess; or record customer deposits/liabilities. M-Pesa callback could be informational only, verified synchronously, or verified through signed callback plus independent provider reconciliation.

**Risk:** A request-initiation response is not proof of cash. Duplicate/unverified callbacks, wrong-tenant invoice IDs, amount mismatches, and retries can create fictitious cash or duplicate credits. Current `payments` route initiates STK and callback acknowledges without applying verified state; there is no migration-defined receipt schema or PostgreSQL receipt test.

**Proposed default — requires approval:** model receipt separately from invoice and payment request; post only after independently verified provider result or a privileged manual bank/cash confirmation with evidence/reference. Allow one receipt to allocate across invoices; retain any excess as unapplied customer credit liability, with explicit later allocation/refund; refunds require a separate authorized reversing cash event. Treat M-Pesa collection as a clearing-account flow, reconciled to settlement, not direct bank cash.

**Dependencies:** authoritative invoice/payment/client DDL; chart including M-Pesa clearing and customer-credit liability; period rules; callback authenticity/idempotency/reconciliation design; approved allocation/refund policy.

**Acceptance tests:** no journal on STK initiation; valid verified receipt posts balanced debit to clearing/cash and credit to AR/customer credit; duplicate callback is idempotent; amount/tenant/invoice mismatch is rejected; partial and multi-invoice allocations sum to receipt; overpayment and refund retain an audit trail; settlement reconciliation clears M-Pesa balance.

### 5. Supplier bills, purchase receipts, inventory valuation and supplier payments

**Question:** Is liability recognized when a supplier bill is received, when goods are received, or at both stages through a goods-received-not-invoiced account? How are PO receipt discrepancies handled?

**Options:** bill-only accounting; receipt accrual followed by bill matching; or simple bill entry without inventory integration. Inventory cost can use moving weighted average, FIFO, specific identification, or another approved method.

**Risk:** Existing purchase orders and receipts track quantities and cost snapshots but no supplier bill/AP or valuation layer exists. Treating PO total as a bill creates liabilities before a valid invoice; posting inventory at both receipt and bill duplicates asset cost; no selected valuation method makes COGS unreliable.

**Proposed default — requires approval:** introduce supplier bills as distinct records; match bills to PO and receipts; if business requires inventory accrual at receipt, use a GRNI clearing account and reverse it on bill match. Do not infer a payable from PO status. Choose and document one inventory cost method before posting inventory/COGS.

**Dependencies:** authoritative supplier/product/PO schema and operational workflow; chart (inventory, GRNI, AP, input tax where approved); tax and period policy; bill/payment evidence and matching tolerances.

**Acceptance tests:** PO alone creates no AP; receipt/bill matching is tenant-scoped and idempotent; partial receipt/bill and price/quantity variances are explicit; inventory/GRNI/AP entries balance; supplier payment reduces AP once and cannot exceed allocated payable unless prepayment policy permits; valuation and COGS reconcile.

### 6. Expense approval, payment evidence, posting, cancellation and reversal

**Question:** Does approval authorize spend, or does it also post an expense? What evidence proves payment, and how are cancellations handled after posting?

**Options:** post on approval/accrual; post only when paid; or separate recognition from settlement. Cancellation can hard-delete, mark cancelled before posting, or reverse a posted journal.

**Risk:** Current expense status `paid` is only a workflow field; no expense-to-ledger integration or payment evidence model exists. Assuming paid means cash left the business would overstate cash movements. Deleting posted costs breaks auditability.

**Proposed default — requires approval:** separate expense recognition from payment settlement. Require approval before posting an eligible expense, attach payee/date/category/evidence, then post payment separately only when verified. Permit cancellation before posting with reason; after posting, preserve source and create a linked reversal with reason and actor.

**Dependencies:** chart/category mappings; approval roles; payment evidence/cash account; period and reversal policy; expense source schema as migrated.

**Acceptance tests:** draft/unapproved expense has no journal; approved posting is balanced/idempotent; unverified payment does not reduce cash; cancellation before posting leaves no journal; posted cancellation cannot erase history and produces balanced reversal; tenant and actor checks apply.

### 7. Kenyan tax configuration and tax reporting

**Question:** Which taxes, rates, tax-inclusive/exclusive calculations, rounding rules, exemptions, invoice fields, and report formats apply to each tenant and transaction date?

**Options:** tenant-managed effective-dated profiles; centrally maintained profiles with tenant selection; or manual tax entry. Reports can be operational summaries or approved statutory returns.

**Risk:** Tax law/rates and treatment can change. A technically valid profile is not a tax/legal determination. Incorrect tax payable accounts or retroactive profile edits corrupt issued invoices and returns. Existing code stores effective-dated versioned profiles and immutable invoice tax snapshots; no statutory report endpoint exists.

**Proposed default — requires approval:** use effective-dated, versioned profiles approved by a tax adviser; snapshot all applied profile fields and exact invoice amounts at issue; never recompute issued invoices from current configuration. Label any initial reports as internal reconciliation until an adviser approves statutory scope and mapping.

**Dependencies:** tax adviser-approved rules; chart and tax-payable mappings; invoice/cancellation/credit-note policy; reporting period/date rules.

**Acceptance tests:** profile version selected by effective date; inclusive/exclusive and rounding examples approved by adviser; snapshot remains immutable after profile edits; missing/inactive/wrong-type payable account blocks applicable posting; tax summaries reconcile to posted tax liability and issued-document register.

### 8. Opening balances and reconciliation

**Question:** What date and source records establish opening balances, and who signs off reconciliation?

**Options:** import trial balance only; import AR/AP subledgers and bank balances; or reconstruct source transactions from an agreed cutover date. Reconciliation can be one-time signoff or ongoing workflow.

**Risk:** Opening a ledger without matched subledgers causes statements to disagree. Combining historical invoice journals with a trial balance double-counts receivables/revenue. Existing accounting migration creates no opening balances and documentation describes no historical backfill.

**Proposed default — requires approval:** select a cutover date; import a balanced, reviewed opening trial balance plus customer/supplier subledger details and bank/cash reconciliations; freeze source totals and retain import manifests, exceptions, and sign-off. Do not auto-post old invoices based on current status.

**Dependencies:** source-schema evidence; chart mapping; cutover recognition policy; customer/supplier records; FX and tax treatment; reconciliation owner.

**Acceptance tests:** opening journal balances; AR/AP subledger totals equal control accounts; bank/cash statement reconciles; imported identifiers are idempotent; exceptions are visible; post-cutover reports reconcile without duplicate historical postings.

### 9. Reporting currency and foreign-currency transactions

**Question:** Is each tenant KES-only or multi-currency? Which rates and dates are used for conversion and revaluation?

**Options:** KES-only; document currency with tenant functional currency; or multi-currency ledger with transaction, functional, and presentation currencies.

**Risk:** Journal schema has FX metadata fields, while invoice route/docs currently constrain accounting to KES. Accepting foreign currency without a rate source, date, rounding, realized/unrealized FX policy, and revaluation workflow produces unbalanced or misleading reports.

**Proposed default — requires approval:** ship KES-only posting initially and reject non-KES accounting configuration until multi-currency requirements are approved. If multi-currency is required, retain original currency/amount and approved rate source/time, post functional currency, and define period-end revaluation separately.

**Dependencies:** tenant market requirements; exchange-rate source; chart FX gain/loss accounts; tax/invoice requirements; report currency design.

**Acceptance tests:** non-KES blocked while KES-only; amount precision and rate provenance retained when FX is enabled; journal balances in functional currency; translation/revaluation entries and reports reconcile for approved examples.

### 10. Audit, roles and corrections (cross-cutting)

**Question:** Which actions require maker/checker separation and immutable audit events? Who can correct a posted transaction?

**Options:** admin-only; configurable roles; or approval thresholds with dual control.

**Risk:** Existing accounting mutators are admin-gated in routes, while expense documentation allows any authenticated tenant user to change workflow state. Actor columns are not consistently FKs to users. A status change alone is not a durable financial audit trail.

**Proposed default — requires approval:** preserve tenant-scoped authorization on every read/write; require privileged approval for posting, close/reopen, refunds, and reversals; store actor, timestamp, reason, and before/after reference; correct posted activity only with linked reversal/new entry.

**Dependencies:** verified user/role schema; role design; audit retention; each source workflow.

**Acceptance tests:** cross-tenant access is indistinguishable from missing record; non-authorized user cannot post/close/refund/reverse; every financial correction retains original and linked event; actor references resolve under approved user lifecycle rules.

## Disposable PostgreSQL test safety review (inspection only)

No launcher was executed and no database was contacted.

### Accounting launcher

- `server/integration/run-accounting-postgres.cmd` delegates to `run-accounting-postgres.ps1`; the PowerShell script takes the disposable role password with a hidden `Read-Host` prompt and builds a fixed local connection to database `invoxa_accounting_test_local`, role `invoxa_accounting_test_role`, host `127.0.0.1`, port `5432`.
- The harness requires the accounting-test URL and explicit confirmation; it does not fall back to `DATABASE_URL`. It checks a safe database-name prefix, exact database comment `INVOXA_DISPOSABLE_ACCOUNTING_TEST`, expected database/role identity, non-superuser status, recovery/read-only flags, UUID support, schema privileges, and zero user relations before creating synthetic schema and applying accounting migrations.
- **Residual risk:** this launcher does not clear all ambient `DATABASE_URL`/`PG*` variables as the invoice launcher does. Harness connection selection is explicit and no fallback was found, but environment hygiene could be improved. A local port-forward/tunnel could still make `127.0.0.1` reach another host; the operator must confirm the listener is the intended local PostgreSQL instance.

### Invoice-accounting launcher

- `server/integration/run-invoice-accounting-postgres.cmd` delegates to `run-invoice-accounting-postgres.ps1`; the script uses a hidden password prompt and fixed database/role/host/port: `invoxa_accounting_test_invoice_local`, `invoxa_accounting_test_role`, `127.0.0.1:5432`.
- It clears `DATABASE_URL` and `PG*` environment variables, validates the explicit local connection and confirmation, then checks exact database identity/comment, non-superuser, recovery/read-only state, UUID support, required privileges, and an empty user-relation catalog before applying the test-only core fixture and selected migrations.
- It does not apply or reference the protected invoice-number migration. It uses `invoice-fixture-schema.sql`, which is explicitly a minimal test fixture, not production DDL.
- The harness attempts cleanup of fixture objects. If cleanup fails, discard/recreate the disposable database rather than reusing a partially contaminated database.
- **Residual risk:** exact comment and database identity prove what the server reports, not that the local listener has no forwarding tunnel. Verify local PostgreSQL listener provenance and never use a production connection string.

These are code-inspection findings only. The current user-reported passing results (90 unit, 16 accounting PostgreSQL, 19 invoice-accounting PostgreSQL) were not re-run or independently verified in this task.

## Recommended next implementation slice

**Proposed next slice:** after decisions 1–4 and authoritative schema review, implement the smallest customer-receipt vertical slice: a manually confirmed KES receipt allocated to one issued invoice, posted transactionally to the approved receipt/clearing account and AR, with an immutable receipt event. Keep M-Pesa callback confirmation, multi-invoice allocation, overpayment/refund, and supplier/expense posting out of this first slice until their policies are approved.

**Prerequisites:**

1. Obtain authoritative, sanitized DDL/migration history for tenants, users, clients, invoices, invoice items, and payments; resolve types, tenant FKs, uniqueness, and delete rules.
2. Approve chart and receipt mappings, accounting date/period behavior, and receipt evidence semantics.
3. Decide whether the existing payment table is retained or a distinct receipt/event/allocation schema is required; document idempotency and tenant-scoped FK rules.
4. Create a fixture based on approved schema evidence, clearly labeled as a fixture, and run only against the guarded local disposable database after operator-provided password.

**Likely files after approval:** a new forward-only migration under `server/migrations/`; a receipt service and route under `server/src/services/` and `server/src/routes/`; route mount in `server/src/index.js`; focused unit tests; a separate guarded PostgreSQL fixture/harness or an extension consistent with existing guards; documentation. The protected invoice-number migration is outside this slice.

**Expected behavior:** privileged user records a confirmed receipt against an issued same-tenant invoice; the service locks/rechecks the invoice and accounting configuration, validates positive exact-decimal amount and open period, creates an idempotent receipt/posting event and balanced journal in one transaction, and records allocation without changing invoice tax snapshot or rewriting the invoice journal. A failed journal/constraint commit rolls back receipt, allocation, and posting together.

**Acceptance tests:** unit tests for validation, tenant authorization, and exact decimal calculation; PostgreSQL tests for same-tenant FK enforcement, balanced debit/credit, transaction rollback/deferred-constraint rollback, idempotent retry, concurrent duplicate receipt prevention, period/account validation, and inability to allocate more than the outstanding invoice balance under the approved policy. No production database is involved.

## Remaining blockers

1. Authoritative original DDL for `tenants`, `users`, `clients`, `invoices`, `invoice_items`, and `payments` is absent from the inspected repository. The local invoice fixture is not a substitute for production schema evidence.
2. Chart template, required accounts, posting dates/period policy, receipt evidence/allocation/refund policy, supplier recognition/valuation, expense policy, tax policy, cutover/reconciliation, and currency scope require explicit business/accounting approval.
3. Production compatibility cannot be verified from migrations and source alone. No production connection or query was attempted, consistent with the guardrails.
4. Test launchers were inspected but not run; database identity and listener provenance were not independently checked in this task.

## Existing repository documents checked

`server/docs/accounting-foundation.md`, `server/docs/invoice-accounting.md`, `server/docs/expenses.md`, `server/integration/README.md`, and `server/integration/INVOICE-ACCOUNTING-README.md` were read before creating this separate draft. Existing documents were not overwritten.

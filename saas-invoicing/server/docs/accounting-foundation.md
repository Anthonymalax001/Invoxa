# Accounting foundation

## Scope and accounting model

`20261021_001_accounting_foundation.sql` adds tenant settings, non-overlapping accounting periods, a chart of accounts, posting events, journal headers, and journal lines. It does not seed accounts, choose a base currency, post an opening balance, or backfill invoices, payments, expenses, purchases, receipts, stock movements, or sales orders.

Each tenant must explicitly configure a three-letter base currency before creating periods or posting. Journal line debit and credit values are exact decimal strings with up to six fractional places. PostgreSQL stores them as `numeric(20,6)`. Every line must have exactly one positive side, and total debits must equal total credits. A foreign-currency line also stores its transaction currency and amount, explicit exchange rate, rate source, and rate timestamp. The converted amount must equal the functional-currency debit or credit after six-place rounding. No exchange rate is inferred.

Posting uses a single PostgreSQL client. By default, `postJournal(pool, input)` owns the transaction: it checks out a client, begins, posts the event and journal, commits, rolls back on failure, and releases the client. A caller that already owns a transaction can call `postJournal(pool, input, { client })`; that supplied client must already be in the caller's transaction. In this mode the service only issues posting queries. It never begins, commits, rolls back, or releases the caller's client. The caller must roll back its entire transaction if posting throws, so business changes and journal changes are undone together. A successful return is still uncommitted until the caller commits; the deferred database constraint trigger checks balance, period, active accounts, currency conversion, and event linkage at that outer commit. Use the same client for all business writes that must be atomic with the journal. Do not use pool-level queries for those writes.

The service creates an idempotency event, validates tenant settings, an open period, and active tenant accounts, inserts a draft header and lines, marks the journal posted, then completes the event. It preserves exact decimal normalization and tenant-scoped validation in either ownership mode. Errors propagate to the caller; known unique-key and integrity conflicts retain the existing mapped status codes.

Posted headers and lines cannot be edited or deleted. Corrections use a linked reversal journal with swapped debit/credit sides, its own open-period date, actor, reason, and idempotency key. The original journal remains intact. Source type, source ID, event type, and source reference are audit references. Invoice finalization invokes the posting service inside the invoice transaction; there is no general manual-journal creation endpoint.

## API

All endpoints below require a bearer JWT with valid user and tenant UUID claims. Tenant identity comes only from the verified JWT claim; request-body tenant IDs are ignored. Authenticated users may read accounting settings, accounts, periods, and posted journals. Accounting mutations require the signed JWT `role` claim to be exactly `admin`.

- `GET /api/accounting/settings` reads settings; it returns `null` before configuration.
- `PUT /api/accounting/settings` sets the explicit base currency. It can be changed only while no journal exists.
- `GET /api/accounting/accounts?active=true|false|all` lists this tenant's accounts.
- `POST /api/accounting/accounts` creates a non-system account with `account_code`, `name`, `account_type`, and `normal_balance`.
- `PATCH /api/accounting/accounts/:id` changes an account name or active flag. Used accounts cannot be renamed; account type/code/normal balance are immutable through this API. System accounts cannot be deactivated.
- `GET /api/accounting/periods` lists this tenant's periods.
- `POST /api/accounting/periods` creates a period with `name`, `starts_on`, and `ends_on`. Periods cannot overlap.
- `PATCH /api/accounting/periods/:id/close` closes an open period. Closed periods cannot be reopened through this API.
- `GET /api/accounting/journals` lists posted journals, optionally filtered by `from`, `to`, and `search`.
- `GET /api/accounting/journals/:id` reads one posted journal and its tenant-owned accounts/lines.
- `POST /api/accounting/journals/:id/reverse` creates a reversal. Send `Idempotency-Key` and body `{ "period_id": "...", "reversal_date": "YYYY-MM-DD", "reason": "..." }`.

The posting service is an internal module, not a general journal-creation API. Invoice finalization uses it inside the invoice transaction. Future business integrations must call it inside their approved source transaction and use stable idempotency keys. Reusing a key with a different canonical payload returns HTTP 409. A matching retry returns the already posted journal. Unique source-event collisions also return HTTP 409.

The accounting routes enforce this permission policy:

- `accounting:read`: any authenticated user with valid user and tenant claims may read their tenant's settings, accounts, periods, and posted journals.
- `accounting:manage-settings`, `accounting:manage-accounts`, `accounting:manage-periods`, `accounting:close-periods`, `accounting:reverse-journals`, `accounting:manage-invoice-tax`, and `accounting:issue-invoices`: `admin` role only.

The existing application signs the database `users.role` into the JWT at login; new tenant registration creates the initial user with role `admin`. There is no shared authorization middleware or other verified production role vocabulary in the repository. On every accounting request, the permission middleware checks that the verified JWT's `userId`, `tenantId`, and `role` still match a `users` row queried by both user and tenant IDs. Missing or malformed claims, a deleted or cross-tenant user, stale role claims, and any mutation role other than the exact `admin` value are denied. A database role change therefore takes effect on the next accounting request, even while an older JWT remains cryptographically valid. The read permission does not grant a role privilege; it permits a current authenticated user to read only data scoped to the JWT tenant.

The mocked authorization tests use a synthetic `test-reader` role row to exercise the rule that a non-admin authenticated user may read but cannot mutate. This fixture is not evidence that `test-reader` (or any non-admin role name) exists in production. The repository does not include complete users-table DDL or a role constraint, so the set of role values present in a deployed database remains unverified. Confirm the production role vocabulary and user-provisioning process before relying on non-admin access patterns. Review role administration and separation of duties before granting accounting-admin access to production users.

## Migration procedure

This is an additive, forward-only migration and has no automatic historical data posting. The repository does not provide a migration runner or migration ledger. First confirm applied migration state against a disposable PostgreSQL snapshot and record checksums in the deployment process. Do not infer that production matches repository files from filenames alone.

The accounting migration requires `public.tenants.id` to be UUID and uniquely constrained, plus `uuid_generate_v4()`. It must be tested after the existing operational schema migrations on the snapshot. The intended repository dependency order is inventory, purchasing, sales orders, expenses, then accounting foundation. If the disposable snapshot already contains those four ERP migrations, do not reapply them; verify their catalog objects and apply only the reviewed accounting migration to the disposable copy.

After confirming the connection targets the disposable database, apply exactly one migration with `psql -X -v ON_ERROR_STOP=1 -f server/migrations/20261021_001_accounting_foundation.sql`. The file wraps its DDL in `BEGIN`/`COMMIT`, so a statement error aborts the transaction. Inspect the exit status and verify every accounting table, index, trigger and constraint on the snapshot before any later environment is considered. No production connection or migration is part of this implementation task.

There is no automatic downgrade. Recovery from an unsuccessful attempt should use the transaction rollback on error, then inspect the disposable schema before retrying. Do not manually drop accounting objects in a shared environment.

## Tests and limits

The backend unit tests run with `cd server; npm test` and use fake PostgreSQL pools for accounting and invoice-service cases. They verify application behavior such as tenant scoping, retry semantics and rollback paths; they do not execute PostgreSQL DDL. The accounting PostgreSQL integration suite uses a real `pg` connection and a synthetic tenant baseline to test the accounting migrations and database constraints. A separate invoice-accounting PostgreSQL suite exercises the real Express invoice, Sales Order and accounting routes against PostgreSQL using the test-only core schema in `integration/invoice-fixture-schema.sql`. It covers direct and Sales Order-generated invoice finalization, posting, retries, tenant and role checks, configuration failures, and rollback behavior. See [`integration/README.md`](../integration/README.md) and [`integration/INVOICE-ACCOUNTING-README.md`](../integration/INVOICE-ACCOUNTING-README.md) for suite boundaries and safeguards.

The invoice fixture's core-table definitions and constraints are assumptions, not authoritative production DDL. A passing run against that fixture verifies behavior only against the fixture and migrations applied in that disposable test database; it does not establish production-schema compatibility. The repository has no migration runner or applied-version ledger, so local migration files do not prove that any migration has been applied to production.

Invoice issuance is connected to the ledger through the explicit finalize operation documented in [`invoice-accounting.md`](invoice-accounting.md). Customer payment/M-Pesa receipts and supplier bills/payments use their dedicated accounting workflows; inventory movements, sales fulfillment, and legacy expenses are not connected to journal posting. In particular, an expense row marked `paid` remains a recorded operational assertion and does not prove a transfer. Opening-balance scope, assumptions and the read-only legacy cutover preview are documented in [`accounting-opening-balances.md`](accounting-opening-balances.md). Kenyan tax treatment, inventory costing, payment allocations, M-Pesa settlement fees, historical cutover policy and period-close ownership still require finance approval before additional source integrations or historical posting.

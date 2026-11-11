# Phase 4 Core Schema Evidence Recovery

**Result:** no authoritative creation DDL or complete migration history for `tenants`, `users`, `clients`, `invoices`, `invoice_items`, or `payments` was recovered from the inspected repository or its reachable Git history.

**Safety:** no database or Neon project was contacted; no SQL, migration, integration launcher, or test was executed. An initial broad text search used an incorrect path-relative exclusion and emitted two matching lines from the protected invoice-number migration. That output was not used as evidence; the file was not manually opened, executed, or modified. All later content searches excluded it. Do not treat this note as production-compatibility verification.

## Search performed

- Searched tracked repository files for table-creation DDL and schema-export/setup references. No tracked `CREATE TABLE` definition was found for any of the six tables.
- Searched current repository files, excluding the protected migration, for `CREATE TABLE` and `ALTER TABLE` statements for the six names. For those six target tables, the only current `CREATE TABLE` statements are in the explicitly test-only invoice fixture; the accounting integration harness creates a synthetic `tenants` table for its isolated test setup.
- Searched all 16 reachable Git commits, from `f08494b` through current `HEAD` `7892360`, for core-table creation statements. No matches were found. Commit `55e00ec` (“Expand Invoxa into ERP modules”, 2026-10-20) added the listed product, purchasing, sales-order, expense, and preflight SQL files; its migration history does not include original creation DDL for the six core tables.
- Inspected repository setup/deployment references: the root README, `server/src/config/db.js`, `server/nixpacks.toml`, `client/vercel.json`, and the server package scripts. They describe the app start/database connection and deployment routing; none defines the core tables or a migration runner/history.
- Read both Phase 4 drafts, the integration READMEs, `invoice-fixture-schema.sql`, and `20261012_000_preflight_tenant_integrity_report.sql`.

The current Git status shows the protected migration as untracked, so it was not part of the tracked-history search. Its contents are not evidence for this audit.

## What the evidence establishes

| Table | Creation DDL recovered? | Evidence and boundary |
|---|---|---|
| `tenants` | No | Source queries/registration and later migrations require a tenant key. `accounting-postgres.js` creates a synthetic test table. Neither is the original DDL. |
| `users` | No | Source uses user and tenant fields; invoice fixture defines a minimal test table. No authoritative creation migration found. |
| `clients` | No | Source uses client fields; Sales Orders migration adds a composite unique index on `(tenant_id, id)` to the existing table. The original PK, columns, and constraints remain unknown. |
| `invoices` | No | Source and preflight SQL name expected fields; invoice fixture defines a test table. `20261018_003_sales_orders.sql` adds nullable `sales_order_id`, a tenant/order/client composite FK, and a partial unique index for non-null Sales Order links. This is an alteration, not original table DDL. |
| `invoice_items` | No | Source and preflight SQL name fields; invoice fixture defines a test table. The Sales Orders migration checks compatibility assumptions but does not create the table. |
| `payments` | No | The payment route and preflight SQL use payment fields, but no repository migration or fixture defines the table. |

### Important source distinctions

- `server/integration/invoice-fixture-schema.sql` begins with `TEST FIXTURE ONLY` and creates minimal `tenants`, `users`, `clients`, `invoices`, and `invoice_items`. Its types, keys, tenant FKs, delete rules, and constraints are fixture choices, not production facts. It does not define `payments`.
- `server/integration/accounting-postgres.js` creates only a synthetic `tenants` baseline for accounting tests. It is also fixture code.
- `server/migrations/20261012_000_preflight_tenant_integrity_report.sql` is explicitly a read-only preflight report. Its expected columns are based on current backend query usage; its catalog queries can report observed types/nullability when run against a database, but the SQL file is not table-creation DDL. The static `tenant-integrity-report.txt` is not full DDL, a migration ledger, or proof of current deployed state.
- Application SQL in routes/services establishes what code expects, not whether production has those columns or constraints.
- `server/migrations/20261018_003_sales_orders.sql` supplies only the identified additive relationship on existing invoices and client index. Its presence in Git does not prove it has been applied to a deployed schema.

## Unresolved schema questions

Obtain authoritative evidence for each core table's exact columns, PostgreSQL types, nullability, defaults, primary key, indexes, unique constraints, foreign keys, checks/enums/domains, triggers, and `ON DELETE`/`ON UPDATE` behavior. Also establish:

- Tenant ownership and whether every child relationship is enforced by a tenant-scoped composite key, including invoice/client, invoice item/invoice, payment/invoice, and user/tenant.
- Invoice number uniqueness scope and existing duplicate handling; invoice status values and transition rules; timestamp/date and monetary precision rules.
- Payment currency and status domain, M-Pesa request/receipt uniqueness and idempotency, callback evidence fields, and whether payment rows are tenant-scoped to the referenced invoice.
- Migration versions actually deployed, any out-of-repository/manual schema changes, and whether deployed types/defaults align with the repository's newer migration prerequisites.
- Any database-level tenant security policies, triggers, extensions, sequences, and functions that are required at runtime.

The README statement that every table has a `tenant_id`, the static preflight report, and application query fields must not be promoted to DDL or constraint claims.

## Safest approved way to obtain a schema-only artifact

1. **Ask the schema owner or release engineer for the canonical migration source and applied-version ledger first.** Include the exact application release/Git SHA and database migration versions. This is preferable to reconstructing history from a live system.
2. **If a database-derived snapshot is still needed, use an owner-approved non-production clone** at the relevant release version. Verify and record its environment identity before exporting. This task did not and must not connect to Neon or any production database.
3. Have the authorized operator export schema only, with no table data or ownership/ACL statements. For a PostgreSQL non-production clone, a command template is:

   ```text
   pg_dump --schema-only --no-owner --no-privileges --schema=public --file=core-schema.sql --dbname=service=APPROVED_NONPROD_SCHEMA_SOURCE
   ```

   Configure `APPROVED_NONPROD_SCHEMA_SOURCE` as an approved non-production libpq service alias and use an interactive password prompt or approved secret manager. Do not put a password or connection string in this document, chat, shell history, process arguments, or committed files. Include any additional application schemas explicitly if the owner confirms they are required.
4. Before sharing/importing, have the owner review the export for data-bearing objects, sensitive comments, secrets embedded in function bodies, foreign-server/user-mapping details, production-specific grants, and environment-specific settings. `--schema-only` excludes table rows but does not guarantee the DDL contains no sensitive text. Record source environment, source release/migration version, export time, PostgreSQL tool/server versions, reviewer, and sanitization changes.
5. Keep the approved sanitized file as a controlled artifact. Restore it only into a separate, empty local disposable database with a dedicated non-superuser role, explicit local connection, database identity checks, and a conspicuous disposable-database comment. Never import it into a production or shared database.
6. Do not point the existing invoice fixture launcher at a preloaded snapshot: its empty-database guard and fixture assumptions are intentional. Do not relax those checks. If snapshot-based integration coverage is approved, create a separate guarded local import workflow and compare the snapshot's provenance and schema before tests.

If no approved non-production clone or canonical migration archive exists, the next step is a schema-owner request for that evidence. Do not infer production schema from the fixture or query production as a substitute in this task.

## Review of the two Phase 4 drafts

- The core-schema draft's conclusion that original core DDL was not present remains supported. Qualify it as **not found in the inspected working tree and 16 reachable Git commits**; this does not establish that no external DBA archive, deployment artifact, or older unreachable Git history exists.
- Keep the invoice Sales Orders migration fact narrowly scoped to its added column, FK, and index. It does not verify the invoice table's original definition or prove deployed migration state.
- Keep all invoice fixture constraints labeled `TEST FIXTURE ASSUMPTION`. The new search found no evidence that makes them production facts.
- Treat the preflight migration/report as expected-query columns plus read-only catalog observations, not authoritative creation DDL. The policy draft's requirement for owner-approved schema evidence remains appropriate.
- No changes were made to either existing draft; this review is recorded separately to preserve the prior audit and its uncommitted work.

## Files reviewed

- `server/migrations/20261012_000_preflight_tenant_integrity_report.sql`
- `server/migrations/20261018_003_sales_orders.sql`
- `server/integration/invoice-fixture-schema.sql`
- `server/integration/accounting-postgres.js`
- `server/integration/README.md`
- `server/integration/INVOICE-ACCOUNTING-README.md`
- `server/src/config/db.js`
- `server/nixpacks.toml`
- `client/vercel.json`
- `README.md`
- `server/docs/phase4-core-schema-contract-draft.md`
- `server/docs/phase4-finance-policy-decision-log-draft.md`

No tests, database connections, SQL commands, migrations, or integration launchers were run.

# Accounting PostgreSQL integration tests

This opt-in suite applies `migrations/20261021_001_accounting_foundation.sql` and `migrations/20261022_001_invoice_accounting_configuration.sql` to a fresh disposable database and tests the database constraints together with the real `pg` driver and accounting service. The normal `npm test` suite does not discover or connect through this file. The harness never loads `.env`, imports `config/db.js`, or falls back to `DATABASE_URL`.

## Database prerequisites

Use a newly created, empty PostgreSQL database dedicated to this suite. A Neon branch copied from a populated database is not suitable: the harness rejects any user tables, views, sequences, materialized views or foreign tables. Create an empty database in a dedicated disposable Neon project/branch, or locally. Do not point this at production or any database with business data.

The URL must explicitly contain a PostgreSQL hostname, username and password. The database name must be `invoxa_accounting_test_` followed by lowercase letters, digits or underscores, for example `invoxa_accounting_test_local`. The database must:

- Have the comment `INVOXA_DISPOSABLE_ACCOUNTING_TEST`.
- Have `uuid-ossp` and `uuid_generate_v4()` available on the connection search path.
- Be writable by a non-superuser test role with `USAGE` and `CREATE` on `public`, so it can create and drop its own test objects.
- Contain no user relations before the test starts.

For a local disposable database, an administrator can create it with:

```powershell
createdb --owner=INVOXA_TEST_ROLE invoxa_accounting_test_local
```

`INVOXA_TEST_ROLE` is a placeholder for an already configured non-superuser local role; use the same role in the test database URL. The role must own the database or have equivalent DDL privileges.

Connect to that database using the local PostgreSQL administration tool and run these setup statements. The second statement uses the actual database name:

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
COMMENT ON DATABASE invoxa_accounting_test_local IS 'INVOXA_DISPOSABLE_ACCOUNTING_TEST';
GRANT USAGE, CREATE ON SCHEMA public TO invoxa_accounting_test_role;
```

Run the grant only in the disposable test database, as its owner or an administrator, if the role does not already have those schema privileges. The extension and database comment are prerequisites, not part of the accounting migration. Give the non-superuser test role ownership or equivalent create/drop privileges on the disposable database and its `public` schema. For Neon, provision an empty test database and extension/comment through the isolated project's controls; do not use a populated production clone.

The harness itself checks the connected database name, database comment, recovery/read-only state, role superuser flag, UUID function and empty user-relation catalog before creating anything. It then creates only a minimal synthetic `tenants` baseline and synthetic tenant/account/period fixtures, applies the two accounting migrations, runs the tests and removes its own accounting and baseline objects. It does not create invoice, invoice-item or payment tables because their complete source DDL is not present in this repository. The database comment and UUID extension remain. An advisory lock serializes multiple invocations of this harness; keep the test database exclusive while it runs. If cleanup reports failure, discard the test database and create a fresh one.

## Run the local test from Windows CMD

From an interactive CMD window, run:

```cmd
cd /d C:\Users\ADMIN\Desktop\Invoxa\saas-invoicing\server
integration\run-accounting-postgres.cmd
```

The launcher prompts for the password with hidden input, URL-encodes it, and creates the dedicated connection URL only in the PowerShell child process environment. It targets only `invoxa_accounting_test_role` at `127.0.0.1:5432/invoxa_accounting_test_local`, sets the required disposable-database confirmation, runs the npm integration command, and removes both environment variables afterward. The password and URL are not command arguments, echoed, or written to shell history. Do not use `set`, `set /p`, or a literal URL on the command line. The script assumes local PostgreSQL listens on port 5432; update the fixed port in `run-accounting-postgres.ps1` if the local instance uses another port.

The same `.cmd` launcher can be invoked from PowerShell with `& .\integration\run-accounting-postgres.cmd` after changing to the server directory.

## Run against the fresh local accounting test database

Use this launcher only after provisioning a separate, empty `invoxa_accounting_test_fresh` database owned by the non-superuser `invoxa_accounting_test_runner` role. Set the database comment to `INVOXA_DISPOSABLE_ACCOUNTING_TEST`, install `uuid-ossp`, and grant the role `USAGE` and `CREATE` on `public`. The harness verifies these prerequisites and refuses databases containing user relations.

From an interactive CMD window, run:

```cmd
cd /d C:\Users\ADMIN\Desktop\Invoxa\saas-invoicing\server
integration\run-accounting-postgres-fresh.cmd
```

The launcher prompts for the role password with hidden input, targets only `127.0.0.1:5432/invoxa_accounting_test_fresh`, sets the test URL and required confirmation for the npm test process, then clears them. It reports the test process exit code and never uses `DATABASE_URL`. This separate launcher leaves the existing `invoxa_accounting_test_local` launcher target unchanged.

The integration command fails before connecting if the dedicated URL, its password, or confirmation is missing, or if its database name does not have the required prefix. Connection and setup failures report a sanitized error name, PostgreSQL error code when available, and message; connection URLs and password-like values are redacted. The target database is not modified unless the full preflight, including the exact comment, non-superuser role, writable state, UUID function, schema privileges and empty-relation check, succeeds. Run the mocked suite separately with `npm.cmd test`.

## Coverage and remaining validation

The suite covers both accounting migration applications, tenant-scoped invoice mappings and tax-profile/snapshot constraints, balanced posting, database rejection/rollback of an unbalanced posted journal, cross-tenant account foreign keys, closed-period rejection, posted-journal immutability, reversal linkage and uniqueness, same-key concurrent requests, same-key/different-payload conflict, and atomic rollback after an injected line-insert failure. Caller-owned transaction coverage verifies that a journal/event and a temporary business fixture commit together, a posting failure lets the caller roll both back, the service does not issue transaction-control statements or release the client, and a deferred temporary foreign-key violation surfaces at the caller's commit and can be rolled back. Temporary business tables are session-local and dropped by each test. This accounting-foundation suite does not test invoice finalization. The separate [`INVOICE-ACCOUNTING-README.md`](INVOICE-ACCOUNTING-README.md) documents the PostgreSQL suite that exercises real Express invoice, Sales Order and accounting routes against the explicitly test-only `invoice-fixture-schema.sql`; that suite currently defines 19 integration tests. Its fixture core DDL is not authoritative production schema, and passing against it does not establish production-schema compatibility. These opt-in suites apply repository migrations only to their guarded disposable databases. No repository migration file or passing disposable-database test proves which migrations have been applied to production; the repository does not include an authoritative applied-version ledger.

# Phase 4 — Authoritative Core Schema Handoff

**Audience:** database owner or release engineer
**Purpose:** recover and approve the actual core-table schema before further accounting work depends on it.
**Status:** request and procedure only. The six-table schema has not been recovered; production compatibility remains unverified.

This handoff supplements, and does not overwrite, the existing [core-schema evidence draft](phase4-core-schema-contract-draft.md), [finance-policy decision log](phase4-finance-policy-decision-log-draft.md), and [schema evidence recovery note](phase4-core-schema-evidence-recovery.md).

## 1. Evidence requested from the owner

Please provide one of the following, in preference order:

1. The canonical version-controlled creation migrations/schema source **and** the applied migration/version ledger for the environment/release represented by the approved non-production clone; or
2. A reviewed, sanitized, schema-only PostgreSQL export from an approved non-production clone at a recorded application release and schema version.

Include provenance: source environment name (must be non-production), application Git SHA/release, database migration ledger or schema version, PostgreSQL server and `pg_dump` versions, export timestamp and timezone, exported schemas, reviewer, sanitization changes, and SHA-256 checksum of the delivered artifact. Do not send credentials, connection strings, table data, customer identifiers, or production data with the artifact.

The repository’s query fields and test fixture may be attached as comparison aids, but neither is authoritative creation evidence.

## 2. Required evidence for each table

For **each** table below, capture the complete metadata checklist in section 3. The listed fields are only fields observed in route/preflight SQL; they are prompts to reconcile against the actual catalog, not a claim that the columns exist in the authoritative schema.

### `tenants`

Confirm the complete definition, especially `id`, `name`, `email`, and `phone` as observed by registration/query code. Establish the exact type/default/generation of `id`, PK and alternate/unique keys, tenant name/email uniqueness scope, nullability, and every FK that references it. Confirm any tenant deletion behavior, triggers, RLS, and whether required UUID-generation extensions/functions exist.

### `users`

Confirm the complete definition, especially observed `id`, `tenant_id`, `name`, `email`, `password_hash`, and `role`. Establish the key type and tenant FK, uniqueness scope for email/username, role type/domain/check, defaults, user deactivation/deletion behavior, and any FK/trigger/policy behavior. Identify whether actor IDs stored by ERP migrations are expected to reference users, and if so how tenant ownership and user deletion are enforced.

### `clients`

Confirm the complete definition, especially observed `id`, `tenant_id`, `name`, `email`, `phone`, `address`, and `created_at`. Establish PK, base tenant FK, unique/index rules, nullable contact fields, timestamps, and deletion/update behavior when invoices and sales orders reference the client. Specifically confirm whether unique `(tenant_id, id)` exists and whether it is a constraint or unique index, since the Sales Orders migration depends on it.

### `invoices`

Confirm the complete base definition, especially observed `id`, `tenant_id`, `client_id`, `invoice_number`, `due_date`, `subtotal`, `tax_rate`, `tax_amount`, `total`, `notes`, `status`, and `created_at`; also report whether `sales_order_id` is present. Establish monetary and quantity precision, date/timestamp types and time-zone semantics, status domain/check and allowed transitions, numbering uniqueness scope, all defaults, indexes, tenant/client FKs, triggers, and deletion/update restrictions.

Reconcile two specific ERP dependencies:

- `20261018_003_sales_orders.sql` adds nullable `sales_order_id uuid`, a composite FK `(tenant_id, sales_order_id, client_id)` to Sales Orders `(tenant_id, id, client_id)`, and a partial unique index on `(tenant_id, sales_order_id)` for non-null values. Confirm whether these objects are present and structurally equivalent; their presence in the repository does not prove deployment.
- Do not assume or create invoice-number uniqueness from application code, a report, or a fixture. Record the actual unique constraints/indexes and their predicates. Do not replay or reconstruct the protected invoice-number migration as part of this handoff.

### `invoice_items`

Confirm the full definition, including observed `invoice_id`, `description`, `quantity`, `unit_price`, and `amount`, and whether a primary identifier or other columns exist. Establish numeric precision/scale, nullability, checks, parent invoice FK and its tenant scope, delete/update action, indexes, and triggers. Record how line amounts and quantities are stored; do not infer the fixture’s `numeric` precision or `ON DELETE CASCADE` as production behavior.

The Sales Orders migration performs compatibility checks against the existing table, including the expected `invoice_id` UUID type, numeric quantity/price/amount fields, and description presence. Those are migration preconditions, not a full `invoice_items` definition.

### `payments`

Confirm the full definition, especially observed `id`, `tenant_id`, `invoice_id`, `amount`, `phone_number`, `mpesa_checkout_id`, `mpesa_receipt`, `status`, and `created_at`. Establish the currency and amount precision, status domain/transitions, request and receipt uniqueness/idempotency, callback-related fields, nullable rules, and all tenant/invoice FKs and deletion actions. Determine whether a payment can reference an invoice from a different tenant and whether database constraints prevent that. No repository migration or integration fixture currently defines this table, so source SQL alone cannot resolve its schema.

## 3. Metadata checklist — required for all six tables

For every table and dependent object, provide:

- Exact schema/table name and object kind; partitioning or inheritance if present.
- Every column in ordinal order: exact PostgreSQL type including precision/scale/length, collation/domain/enum, nullability, default expression, identity/generated expression, and sequence ownership where applicable.
- Primary key and every unique constraint, including column order, expressions, predicates, null semantics, collations/operator classes, and whether enforcement is a constraint or standalone index.
- Every index: name, definition, columns/order, expression, predicate, included columns, uniqueness, validity/readiness, and backing constraint if any.
- Every foreign key: local and referenced columns in order, referenced schema/table, `ON DELETE`, `ON UPDATE`, match type, deferrability/initial mode, validation state, and supporting indexes.
- Every CHECK constraint and enum/domain definition, including exact expression and validation state.
- Every trigger: name, timing, event, enabled state, function name/body, and relevant function dependencies.
- RLS enabled/forced state and all policies; relevant rules, views, procedures/functions, and security-definer behavior.
- Extensions and required versions, sequences, custom types, and schema-level dependencies needed to create and use the tables.
- A specific statement for all referenced-row deletion/update behavior, including behavior implemented by triggers rather than FKs.

Names alone are insufficient: compare object definitions and behavior. Include disabled, invalid, unvalidated, or duplicate objects in the evidence rather than silently omitting them.

## 4. ERP migration and tenant-dependency checks

Compare the recovered schema against the repository migrations without running any migration:

| Migration/source | Dependency to verify against recovered schema |
|---|---|
| `20261018_001_products_and_stock_movements.sql` | Existing `tenants.id` must be UUID-compatible and uniquely referenceable; tenant FKs, UUID generation, and tenant-scoped product relationships must fit. |
| `20261018_002_suppliers_and_purchasing.sql` | Same tenant key dependency; supplier and purchasing objects are migration-defined. Confirm no source schema conflicts on existing supplier/product relationships if comparing the complete ERP schema. |
| `20261018_003_sales_orders.sql` | Existing `clients` must support unique `(tenant_id, id)`; invoice table must accept nullable UUID `sales_order_id` and the composite tenant/order/client FK/index; existing invoice-item data/type preconditions must match. Check tenant scoping through clients, Sales Orders, invoice items, fulfillment, and stock movements. |
| `20261019_001_expenses.sql` | Existing tenant and supplier key types/unique targets must support the declared tenant-scoped FKs. Expense actor UUIDs are not all user FKs in that migration; do not infer them. |
| `20261021_001_accounting_foundation.sql` | `tenants.id` must be UUID and uniquely referenceable; `uuid_generate_v4()` and its required extension must be available. Verify tenant-scoped accounting period, account, event, journal, and journal-line FKs and required referenced unique keys. |
| `20261022_001_invoice_accounting_configuration.sql` | Verify tenant-scoped account, tax-profile, journal, mapping, and snapshot dependencies. Tax snapshot `source_id` is polymorphic for invoice/Sales Order and is not a direct FK to either source table in the migration. |
| Application payment routes and preflight report | Compare observed payment columns and joins with the recovered table. Treat them as application expectations only; no versioned migration currently defines `payments`. |

For tenant isolation, explicitly verify `users.tenant_id`, `clients.tenant_id`, `invoices.tenant_id`, and `payments.tenant_id` references to the tenant key and the intended composite relationships: invoice/client; invoice item/invoice; payment/invoice; and any actor/user relationship approved by policy. Check that same-tenant composite FKs have the necessary referenced unique keys. The preflight report’s relationship list is a review prompt, not proof those constraints exist.

## 5. Safe export, review, and delivery procedure

1. **Select source.** The database owner/release engineer selects an approved non-production clone matching the target release/schema version. Confirm its identity and source migration ledger through the organization’s approved controls. Do not use Neon production, a production URL, or a populated production copy for this task.
2. **Prepare credentials.** Configure a named libpq service alias that points only to that approved non-production clone. Use an interactive prompt or approved secret manager. Do not put a password/URL in chat, shell history, command arguments, or the exported file.
3. **Export schema only.** From the operator’s approved environment, export the required application schemas, excluding ownership and ACLs. Example for `public` only:

   ```text
   pg_dump --format=plain --schema-only --no-owner --no-privileges --schema=public --file=core-schema.sql --dbname=service=INVOXA_SCHEMA_SOURCE_NONPROD
   ```

   Configure `INVOXA_SCHEMA_SOURCE_NONPROD` to the approved non-production source only. Add schemas only when the owner confirms they are part of the application contract. Do not export table rows, large objects, or unrelated schemas.
4. **Review and sanitize.** Review the SQL for literals in defaults/comments/functions, embedded credentials or tokens, production hostnames, foreign-server/user-mapping details, role names, grants, and environment-specific settings. `--schema-only` omits table rows but is not a guarantee that schema text contains no secrets. Preserve structural DDL; if a sensitive literal must be removed or replaced, document the exact change and have the owner confirm it does not alter relevant schema behavior. Do not sanitize by dropping constraints, indexes, triggers, or policies needed for comparison.
5. **Record and deliver.** Produce a manifest with source environment, release/Git SHA, migration ledger, versions, export timestamp/timezone, schema list, reviewer, sanitization log, and SHA-256. Deliver the schema and manifest using the approved restricted internal channel. Do not include credentials or data. Owner signs off that the artifact is complete and safe to share.

## 6. Import into a new local disposable database

This is an operator procedure for a future local review. It was not performed in this task.

1. Create a **new** local database with a unique recovery name, for example `invoxa_schema_recovery_local_20261024`, and a dedicated non-superuser local role, for example `invoxa_schema_recovery_role`. Do not reuse `invoxa_accounting_test_local`, `invoxa_accounting_test_invoice_local`, or any shared/deployed database.
2. Before importing, set a distinct database comment such as `INVOXA_SCHEMA_RECOVERY_DISPOSABLE`. Confirm the local service alias points to `127.0.0.1` and the exact new database/role; confirm the database contains no user relations. Keep production variables/connection strings out of the process and do not rely on `DATABASE_URL` fallback.
3. Inspect the reviewed SQL and any extension requirements first. Have a local administrator install only the required extensions in this new database if needed; keep the import role non-superuser and grant it only the ownership/schema privileges required for this disposable database.
4. Restore the reviewed schema-only file into this new database with stop-on-error behavior. Use a local-only service alias and verify the connected database identity immediately before import. For example:

   ```text
   psql --set=ON_ERROR_STOP=1 --single-transaction --dbname=service=INVOXA_SCHEMA_RECOVERY_LOCAL --file=core-schema.sql
   ```

   `INVOXA_SCHEMA_RECOVERY_LOCAL` must be configured only for the new local recovery database. If restore fails, discard and recreate that database; do not reuse a partial import. If a command in the export cannot run transactionally, stop and have the owner review the dump and an adjusted disposable-only import procedure.
5. Verify the restored database identity, schema object counts, and absence of row data. Save the import log and artifact checksum alongside the manifest. Do not run the current accounting or invoice fixture launchers against this preloaded database: their empty-database guards and synthetic fixture assumptions must remain intact. Snapshot-based tests require a separate reviewed and guarded local workflow in a later task.

## 7. Migration comparison and discrepancy report

Use the sanitized export and the versioned migration files as read-only comparison inputs. Do not execute/replay migrations during comparison.

1. Build an object inventory from the export and a second inventory from the repository migrations. For each object, compare columns/types/defaults/nullability; key and index columns/order/predicate; FK target/actions/deferrability; checks; trigger/function bodies and enablement; domains/enums/extensions; and RLS policies.
2. Record migration ledger versions for the non-production source. For each migration-defined object, classify it as present and equivalent, absent, present but different, present but invalid/unvalidated/disabled, or present with a different name but equivalent behavior. Record source/target release and all manual/out-of-band changes.
3. Detect duplicate enforcement semantically, not by name only. Compare unique constraints with equivalent unique indexes, duplicate indexes on the same key/predicate/expression, repeated FKs/checks/triggers, and overlapping partial predicates. Report both definitions and storage/enforcement implications; do not drop or rename anything during this handoff.
4. Specifically reconcile Sales Orders additions to `clients` and `invoices`, invoice-item preconditions, tenant-key requirements, accounting foundation FKs, and invoice accounting configuration FKs listed above. Report migration-defined objects not present in the snapshot and snapshot objects not represented by repository migrations.
5. For every difference, label it **missing migration/object**, **conflicting definition**, **duplicate equivalent enforcement**, **manual/out-of-band object**, **fixture-only assumption**, or **unresolved**. Include exact DDL/object names, source migration/version, likely impact, and owner decision. Do not infer that a missing object should be created until data compatibility and migration approval are separately established.
6. Review invoice-number uniqueness independently. Report the actual schema definitions present in the approved snapshot and any migration ledger evidence. Preserve existing production data and do not run the protected migration as part of schema reconstruction or comparison.

## 8. Acceptance gates before accounting implementation proceeds

The database owner/release engineer and application owner should sign off that:

- [ ] The artifact is authoritative for a named release/schema version, from an approved non-production source, with provenance and checksum.
- [ ] The complete definitions and all required metadata in section 3 are present for all six tables; unresolved columns, key types, tenant relationships, deletion behavior, triggers, policies, and payment semantics are explicitly listed and assigned.
- [ ] Migration ledger and schema comparison cover Sales Orders, accounting foundation, invoice accounting configuration, and tenant dependencies; all missing, conflicting, duplicate, manual, and unvalidated objects have documented disposition.
- [ ] Tenant-scoped references and composite keys required to prevent cross-tenant links are verified or implementation is blocked until an approved corrective plan exists.
- [ ] Invoice and payment status/amount/date precision and uniqueness behavior are understood. No uniqueness or payment-posting policy is inferred from code or fixture assumptions.
- [ ] The snapshot contains no business rows or unreviewed secrets and has been imported only into a newly named, locally identified disposable database. Current test databases and launchers remain untouched.
- [ ] Any fixture changes needed for later PostgreSQL integration work are proposed separately, labeled as fixture assumptions, and do not weaken the existing safety guards.
- [ ] Finance-policy decisions that shape receipt, AP, expense, tax, cutover, and currency behavior are approved separately; schema evidence alone is not accounting-policy approval.
- [ ] The protected invoice-number migration has not been opened, executed, or modified as part of this handoff; no migration, deployment, or production change is authorized by this document.

If any gate is unmet, keep implementation that depends on the unresolved schema blocked and return the discrepancy list to the owner for resolution. No tests or production-compatibility claims follow from this handoff.

## Next action for the operator

The database owner/release engineer should select the approved non-production clone (or provide the canonical migration archive and applied-version ledger), produce the sanitized schema-only artifact and provenance manifest, and deliver them through the approved internal channel. The application owner can then review the comparison matrix against this checklist before any schema-dependent accounting work resumes.

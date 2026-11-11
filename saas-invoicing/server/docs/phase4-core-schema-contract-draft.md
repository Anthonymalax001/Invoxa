# Phase 4 Core Schema Contract — Evidence Draft

**Status:** preparation draft; not an approved production schema contract.
**Scope:** repository evidence only. No database was queried, no migration was run, and production compatibility has not been verified.

## Evidence labels

- **VERIFIED IN VERSIONED MIGRATION** — the listed detail is explicitly declared or altered by a migration in this repository. This does not prove that the migration has been applied to any deployed database.
- **VERIFIED IN EXISTING SOURCE CODE ONLY** — code reads or writes the field/table, but this repository does not provide its authoritative DDL.
- **TEST FIXTURE ASSUMPTION** — a disposable PostgreSQL test fixture defines this detail; it is not evidence of production schema.
- **UNKNOWN — REQUIRES AUTHORITATIVE SCHEMA EVIDENCE** — this repository does not establish the detail. Obtain an approved schema dump or migration history before relying on it.

When a migration adds a relationship to a pre-existing table, only the added relationship is migration-verified; the original table definition remains unknown.

## Core application tables

### `tenants`

- **VERIFIED IN EXISTING SOURCE CODE ONLY:** Authentication/registration code inserts `name`, `email`, and `phone`; other code uses `id` and sometimes `name`.
- **VERIFIED IN VERSIONED MIGRATION:** Accounting and product/purchasing/sales migrations reference `public.tenants(id)` as a UUID and require a unique key usable by foreign keys. They call `uuid_generate_v4()` for UUID defaults. These are migration prerequisites/references, not a migration defining `tenants`.
- **UNKNOWN — REQUIRES AUTHORITATIVE SCHEMA EVIDENCE:** The table's creation DDL; primary key declaration; all column types/nullability/defaults; tenant name/email uniqueness; deletion behavior; and whether deployed `id` is UUID with the required unique constraint.

### `users`

- **VERIFIED IN EXISTING SOURCE CODE ONLY:** Auth code writes `tenant_id`, `name`, `email`, `password_hash`, and `role`. Accounting authorization looks up a user's `role` constrained by both user `id` and `tenant_id`.
- **UNKNOWN — REQUIRES AUTHORITATIVE SCHEMA EVIDENCE:** Table DDL, key types, tenant FK, email uniqueness scope, role domain, password representation, user/tenant deletion rules, and actor FKs used by newer migrations. The migrations' `created_by`/`approved_by`-style UUID columns generally do not declare user FKs.

### `clients`

- **VERIFIED IN EXISTING SOURCE CODE ONLY:** Client routes write/read `tenant_id`, `name`, `email`, `phone`, and `address`; invoice and Sales Order code uses client `id` and name.
- **VERIFIED IN VERSIONED MIGRATION:** `20261018_003_sales_orders.sql` creates a unique index on `(tenant_id, id)` so tenant-scoped composite foreign keys can reference clients.
- **UNKNOWN — REQUIRES AUTHORITATIVE SCHEMA EVIDENCE:** Original table DDL, PK/type/nullability, base tenant FK, client-number or email uniqueness, and delete/update rules. The added composite unique index does not establish those base facts.

### `invoices`

- **VERIFIED IN EXISTING SOURCE CODE ONLY:** Invoice routes and accounting services use `id`, `tenant_id`, `client_id`, `invoice_number`, `due_date`, `subtotal`, `tax_rate`, `tax_amount`, `total`, `notes`, `status`, and `created_at`. Direct invoice creation/finalization and Sales Order invoice generation are implemented in `src/routes/invoices.js` and `src/routes/salesOrders.js` and call invoice accounting/tax services.
- **VERIFIED IN VERSIONED MIGRATION:** `20261018_003_sales_orders.sql` adds nullable `sales_order_id uuid`, a composite FK `(tenant_id, sales_order_id, client_id)` to the Sales Order tenant/id/client key, and a partial unique index on `(tenant_id, sales_order_id)` when non-null.
- **TEST FIXTURE ASSUMPTION:** `integration/invoice-fixture-schema.sql` supplies a minimal invoice table for local disposable integration testing. Its PK, base columns, defaults, FKs, checks, and status behavior are not proof of production DDL.
- **UNKNOWN — REQUIRES AUTHORITATIVE SCHEMA EVIDENCE:** Original invoice DDL, base PK and FK definitions, exact types/nullability/defaults, invoice-number uniqueness, status CHECK/domain, timestamp semantics, and deletion behavior. A repository artifact `tenant-integrity-report.txt` is a static column report, not complete DDL or proof of current production state. It notes duplicate invoice number `INV-0002`; do not infer or impose uniqueness from that artifact.

### `invoice_items`

- **VERIFIED IN EXISTING SOURCE CODE ONLY:** Invoice code uses `invoice_id`, `description`, `quantity`, `unit_price`, and `amount`.
- **TEST FIXTURE ASSUMPTION:** The invoice fixture defines `id uuid` primary key, `invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE`, `description text`, `quantity numeric(10,2)`, `unit_price numeric(12,2)`, and `amount numeric(12,2)`.
- **VERIFIED IN VERSIONED MIGRATION:** `20261018_003_sales_orders.sql` checks preconditions on the pre-existing invoice-item data/schema, including UUID `invoice_id`, numeric quantity/price/amount, and description presence. Those checks do not create or fully define `invoice_items`.
- **UNKNOWN — REQUIRES AUTHORITATIVE SCHEMA EVIDENCE:** Production PK/FK, numeric precision/scale, nullability, item deletion semantics, and all constraints.

### `payments`

- **VERIFIED IN EXISTING SOURCE CODE ONLY:** `src/routes/payments.js` uses tenant and invoice identifiers, amount, phone number, M-Pesa checkout identifier, and status; invoice joins expose invoice number. The public callback validates its envelope and identifiers, acknowledges it, and never changes payment or invoice state. An authorized tenant user can run the Daraja STK status-query flow, which records a separate append-only audit result and creates only a pending customer receipt on a matching provider success. `src/config/mpesa.js` selects the sandbox endpoint.
- **UNKNOWN — REQUIRES AUTHORITATIVE SCHEMA EVIDENCE:** No repository migration creates `payments`. Its DDL, PK/FKs, column types, currency, status domain, idempotency/receipt uniqueness, callback payload storage, and deletion rules are unknown. The route's SQL is not schema proof.
- **UNKNOWN — REQUIRES AUTHORITATIVE SCHEMA EVIDENCE:** Legacy payment id/status/amount types and constraints; whether deployed data includes duplicate checkout IDs; and whether all tenants use the configured Daraja business shortcode. There is no PostgreSQL payment integration fixture in the inspected harness. The provider-side callback URL, live Daraja credentials, and account setup cannot be verified from repository files.

## Products, inventory, suppliers, purchasing, and sales

The following tables are defined by the named versioned migrations, subject to those migrations actually being applied in a target database.

### Products and stock movements — `20261018_001_products_and_stock_movements.sql`

- **VERIFIED IN VERSIONED MIGRATION — `products`:** `id uuid` PK/default `uuid_generate_v4()`; `tenant_id uuid` FK to tenants; `name varchar(255)`; `sku varchar(100)`; nullable `description text`; `unit_of_measure varchar(50)` default `each`; `cost_price`, `selling_price numeric(12,2)` default zero; `current_stock`, `low_stock_threshold numeric(12,3)` default zero; `is_active boolean` default true; created/updated timestamps without time zone. Unique `(tenant_id,id)` and tenant-scoped case/trim-insensitive SKU uniqueness. Name/SKU nonblank and monetary/stock values nonnegative checks.
- **VERIFIED IN VERSIONED MIGRATION — `stock_movements`:** UUID PK; tenant/product UUIDs; `movement_type varchar(20)`; `quantity_delta`, `quantity_before`, `quantity_after numeric(12,3)`; nullable `reference varchar(100)`, `notes text`, and `created_by uuid`; created timestamp without time zone. Composite tenant/product FK. Checks limit movement type to `receipt` or `adjustment`, require nonzero delta/nonnegative stock, require receipt positive, and enforce after = before + delta. The actor UUID is not declared as a users FK.
- **VERIFIED IN VERSIONED MIGRATION:** Sales and purchasing migrations later add nullable source-item UUID links to `stock_movements`, with composite FKs and partial unique indexes for source linkage.
- **UNKNOWN — REQUIRES AUTHORITATIVE SCHEMA EVIDENCE:** Whether production has applied these migration versions and the actual state of any existing product/stock data.

### Suppliers and purchasing — `20261018_002_suppliers_and_purchasing.sql`

- **VERIFIED IN VERSIONED MIGRATION — `suppliers`:** UUID PK; tenant UUID FK; `business_name varchar(255)`; nullable `contact_person varchar(255)`, `email varchar(255)`, `phone varchar(50)`, `address text`, `notes text`; `is_active boolean` default true; created/updated timestamps without time zone. Unique `(tenant_id,id)`, nonblank name check, tenant/name and active indexes.
- **VERIFIED IN VERSIONED MIGRATION — `purchase_orders`:** UUID PK; tenant and supplier UUIDs; `purchase_order_number varchar(50)`; `order_date date`; nullable `expected_delivery_date date`; `status varchar(24)` default `draft`; `subtotal`, `tax_amount`, `total numeric(12,2)`; `tax_rate numeric(5,2)`; nullable notes and `created_by uuid`; timestamps without time zone. Status check: `draft`, `ordered`, `partially_received`, `received`, `cancelled`. Tenant-scoped PO number and `(tenant_id,id)` uniqueness; composite tenant/supplier FK; nonnegative totals and expected-date checks.
- **VERIFIED IN VERSIONED MIGRATION — `purchase_order_items`:** UUID PK; tenant/order/product UUIDs; product name/SKU snapshots (`varchar(255)`/`varchar(100)`); ordered/received quantities `numeric(12,3)`; unit cost/line subtotal `numeric(12,2)`; timestamps without time zone. Composite unique keys/FKs scope item to order and product.
- **VERIFIED IN VERSIONED MIGRATION — `purchase_order_receipts`:** UUID PK; tenant/order UUIDs; idempotency key `varchar(100)`; received timestamp without time zone; nullable received-by UUID and notes; tenant/order/id and tenant/order/idempotency unique keys; composite order FK.
- **VERIFIED IN VERSIONED MIGRATION — `purchase_order_receipt_items`:** UUID PK; tenant/order/receipt/order-item/product UUIDs; received quantity `numeric(12,3)`; unit cost and line total `numeric(12,2)`; composite unique keys and FKs tying receipt, PO item, and product together.
- **UNKNOWN — REQUIRES AUTHORITATIVE SCHEMA EVIDENCE:** These are purchasing/receipt records, not supplier bills or accounts-payable records. No supplier bill, payable balance, supplier-payment, or payment-allocation table is created by this migration.

### Sales orders — `20261018_003_sales_orders.sql`

- **VERIFIED IN VERSIONED MIGRATION — `sales_orders`:** UUID PK; tenant/client UUIDs; `order_number varchar(50)`; `order_date date`; nullable expected delivery date; `status varchar(24)` default `draft`; `subtotal`, `discount_total`, `tax_amount`, `total numeric(12,2)`; `tax_rate numeric(5,2)`; nullable notes and created-by UUID; created/updated timestamps without time zone. Status check: `draft`, `confirmed`, `partially_fulfilled`, `fulfilled`, `cancelled`. Tenant/order-number and tenant/id keys plus tenant-scoped client FK.
- **VERIFIED IN VERSIONED MIGRATION — `sales_order_items`:** UUID PK; tenant/order/product UUIDs; product name/SKU snapshots; ordered/fulfilled quantities `numeric(10,2)`; unit price `numeric(12,2)`; discount rate `numeric(5,2)`; discount amount and line subtotal `numeric(12,2)`; created/updated timestamps without time zone; composite keys/FKs scope rows to order/product.
- **VERIFIED IN VERSIONED MIGRATION — `sales_order_fulfillments` and `sales_order_fulfillment_items`:** UUID identifiers; tenant/order/fulfillment/order-item/product keys; idempotency key `varchar(100)`; fulfillment timestamp and nullable actor/notes; fulfilled quantity `numeric(10,2)`; unique idempotency/source keys and composite FKs to related order/item/product.
- **VERIFIED IN VERSIONED MIGRATION:** Invoice Sales Order link described above; stock movement link to fulfillment item.
- **UNKNOWN — REQUIRES AUTHORITATIVE SCHEMA EVIDENCE:** Runtime migration state and any production-specific changes beyond repository migrations.

## Expenses

### `20261019_001_expenses.sql`

- **VERIFIED IN VERSIONED MIGRATION — `expense_categories`:** UUID PK; tenant UUID FK; `name varchar(100)`; nullable `description varchar(1000)`; `is_active boolean` default true; created/updated timestamps without time zone; tenant/id unique key and case-insensitive tenant/name uniqueness; nonblank name.
- **VERIFIED IN VERSIONED MIGRATION — `expenses`:** UUID PK; tenant UUID FK; `expense_number varchar(50)`; `expense_date date`; category UUID; nullable supplier UUID/payee name; description `varchar(2000)`; `amount numeric(12,2)`; `currency char(3)` default `KES`; nullable `payment_method varchar(20)`, `payment_reference varchar(255)`, notes; `status varchar(16)` default `draft`; nullable idempotency key; created-by and nullable approved/paid/cancelled actor UUIDs; nullable approval/payment/cancellation timestamps; created/updated timestamps without time zone. Tenant/number and tenant/id uniqueness; partial tenant/idempotency uniqueness; composite tenant/category and tenant/supplier FKs. Statuses: `draft`, `approved`, `paid`, `cancelled`; positive amount, currency/method shape, and status/audit-field consistency checks.
- **VERIFIED IN VERSIONED MIGRATION:** Actor UUIDs are stored, but this migration does not define them as FKs to `users`. The migration does not create expense journal entries or a payment evidence table.
- **UNKNOWN — REQUIRES AUTHORITATIVE SCHEMA EVIDENCE:** Whether deployed schema/data matches this migration and whether expense status changes have been given accounting meaning outside this repository.

## Accounting and tax

### `20261021_001_accounting_foundation.sql`

- **VERIFIED IN VERSIONED MIGRATION — `accounting_settings`:** Tenant UUID PK/FK; base currency `varchar(3)`; created-by UUID; created/updated timestamps with time zone; currency-format check. One row per tenant. Migration requires the pre-existing tenant UUID key and `uuid_generate_v4()`.
- **VERIFIED IN VERSIONED MIGRATION — `accounting_periods`:** UUID PK; tenant UUID FK; name `varchar(100)`; start/end dates; status `varchar(10)` default `open`; created-by UUID; nullable closed-by UUID and close timestamp; created timestamp with time zone. Tenant/id and tenant/name unique keys; date order/status/close-audit checks. Trigger rejects overlapping periods and requires tenant settings. The API exposes close, not reopen.
- **VERIFIED IN VERSIONED MIGRATION — `accounts`:** UUID PK; tenant UUID FK; account code `varchar(30)`, name `varchar(150)`, account type `varchar(12)`, normal balance `varchar(6)`, active/system booleans, nullable system key `varchar(50)`, created-by UUID, created/updated timestamps with time zone. Tenant/id and tenant/account-code uniqueness; partial tenant/system-key uniqueness; type values `asset`, `liability`, `equity`, `revenue`, `expense`; normal balance `debit`/`credit`; system-field checks.
- **VERIFIED IN VERSIONED MIGRATION — `posting_events`:** UUID PK; tenant FK; idempotency key `varchar(100)`; payload hash `char(64)`; source type `varchar(50)`; nullable source UUID/reference `varchar(255)`; event type `varchar(50)`; status `varchar(12)` default `processing`; nullable journal UUID, created-by UUID, created/completed timestamps with time zone. Tenant/id and tenant/idempotency uniqueness; partial unique tenant/source/source-id/event key; completeness/status checks; journal FK; posted event immutability.
- **VERIFIED IN VERSIONED MIGRATION — `journal_entries`:** UUID PK; tenant UUID FK; accounting period UUID; entry date; description text; status `varchar(10)` default `draft`; functional currency `char(3)`; source type/reference/event fields; nullable source UUID; posting-event UUID; nullable reversal-of UUID/reason; created-by and nullable posted-by UUIDs; created/posted timestamps with time zone. Tenant/id and tenant/posting-event unique keys; composite FKs to period, event, and reversal; posted/draft checks; audit and reversal checks; one reversal per original; posted rows are immutable.
- **VERIFIED IN VERSIONED MIGRATION — `journal_lines`:** UUID PK; tenant/journal/account UUIDs; line number integer; nullable description `varchar(255)`; debit/credit `numeric(20,6)` default zero; nullable transaction currency `char(3)`, transaction amount `numeric(20,6)`, exchange rate `numeric(20,10)`, rate source `varchar(100)`, and rate timestamp with time zone; created timestamp with time zone. Tenant/id and tenant/journal/line uniqueness; composite journal/account FKs; exactly one positive debit or credit per line; FX metadata consistency check.
- **VERIFIED IN VERSIONED MIGRATION:** Deferred validation ensures posted event/journal consistency, balanced journal lines, open period, active accounts, and valid conversion metadata. Accounting code includes `postJournal` and `reverseJournal`; current migration does not seed a chart, account mappings, settings, opening balances, or historical postings.
- **UNKNOWN — REQUIRES AUTHORITATIVE SCHEMA EVIDENCE:** The deployed migration state, selected chart-of-accounts design, which periods/settings exist, and any operational close/reopen policy beyond code.

### `20261022_001_invoice_accounting_configuration.sql`

- **VERIFIED IN VERSIONED MIGRATION — `accounting_invoice_mappings`:** Tenant UUID PK/FK; receivables and sales-revenue account UUIDs; updated-by UUID; created/updated timestamps with time zone. Composite tenant/account FKs and distinct-account check. One mapping row per tenant; no actor FK declared.
- **VERIFIED IN VERSIONED MIGRATION — `accounting_tax_profiles`:** UUID PK; tenant FK; profile key `varchar(50)`, name `varchar(150)`, version integer, rate `numeric(5,2)`, calculation method `varchar(12)`, rounding method `varchar(20)`, effective dates, requires-tax-payable boolean, nullable payable-account UUID, active boolean, created-by UUID, created/updated timestamps with time zone. Tenant/id and tenant/profile-key/version uniqueness; partial uniqueness for one active profile per key; validity checks; composite tenant/tax-account FK. Version changes are controlled; profile versions are not silently overwritten.
- **VERIFIED IN VERSIONED MIGRATION — `accounting_invoice_tax_snapshots`:** UUID PK; tenant FK; source type `varchar(20)`, source UUID, profile UUID and profile version; profile key/name, rate, calculation and rounding method, requires-payable flag and nullable payable account; subtotal/tax/total `numeric(12,2)`; created-by UUID and timestamp; nullable issuance date/actor/time and journal UUID. Unique `(tenant_id,source_type,source_id)`; source type limited to invoice or sales order; total equals subtotal plus tax; composite tenant-scoped FKs to profile/account/journal; issuance-state and issued-snapshot immutability checks. `source_id` is polymorphic and has no FK directly to invoices or sales orders.
- **VERIFIED IN EXISTING SOURCE CODE ONLY:** `src/services/invoiceTax.js`, `src/services/invoiceAccounting.js`, and invoice/Sales Order routes save and use tax snapshots and issue invoice journals. Invoice-accounting PostgreSQL integration harness exercises invoice finalization and posting against its fixture.
- **UNKNOWN — REQUIRES AUTHORITATIVE SCHEMA EVIDENCE:** Deployed migration state and whether its tax settings reflect approved tax/legal policy. Repository behavior is not legal or tax authority.

## Test-fixture boundaries

- **TEST FIXTURE ASSUMPTION:** `integration/invoice-fixture-schema.sql` supplies deliberately minimal `tenants`, `users`, `clients`, `invoices`, and `invoice_items` tables because their original DDL is absent. It is used only after the guarded disposable-database checks; it does not claim production compatibility.
- **TEST FIXTURE ASSUMPTION:** Accounting and invoice integration suites apply selected repository migrations to synthetic local schemas and test transactions/constraints there. The test harness does not turn fixture assumptions into production schema evidence.
- **UNKNOWN — REQUIRES AUTHORITATIVE SCHEMA EVIDENCE:** No authoritative source DDL or approved schema dump for the original core tables was found in inspected repository files/artifacts. A production schema contract cannot be finalized until the owner supplies an approved migration history or sanitized authoritative schema export.

## Repository references inspected

- Migrations: `server/migrations/20261018_001_products_and_stock_movements.sql`, `20261018_002_suppliers_and_purchasing.sql`, `20261018_003_sales_orders.sql`, `20261019_001_expenses.sql`, `20261021_001_accounting_foundation.sql`, `20261022_001_invoice_accounting_configuration.sql`.
- Core source: `server/src/routes/auth.js`, `clients.js`, `invoices.js`, `payments.js`, `products.js`, `suppliers.js`, `purchaseOrders.js`, `salesOrders.js`, `expenses.js`, `accounting.js`; `server/src/services/accounting.js`, `invoiceAccounting.js`, `invoiceTax.js`; `server/src/middleware/accountingAuthorization.js`.
- Fixtures/docs: `server/integration/invoice-fixture-schema.sql`, `server/integration/accounting-postgres.js`, `server/integration/invoice-accounting-postgres.js`, `server/integration/README.md`, `server/integration/INVOICE-ACCOUNTING-README.md`, `server/docs/accounting-foundation.md`, `server/docs/invoice-accounting.md`, `server/docs/expenses.md`.
- Static artifact `server/tenant-integrity-report.txt` was treated only as a report, not as complete schema DDL or current production proof. The protected invoice-number migration was not opened or executed.

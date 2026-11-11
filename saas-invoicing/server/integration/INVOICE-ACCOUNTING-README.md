# Guarded invoice-to-ledger PostgreSQL integration

This is a separate, local-only suite for real PostgreSQL invoice finalization.
It uses invoxa_accounting_test_invoice_local, while the accounting foundation
suite keeps its existing invoxa_accounting_test_local target and assumptions.
The invoice suite refuses to run unless its explicit URL points to
127.0.0.1:5432/invoxa_accounting_test_invoice_local, the connected role is
invoxa_accounting_test_role, the exact database comment is
INVOXA_DISPOSABLE_ACCOUNTING_TEST, the role is not a superuser, the database
is writable and empty, and uuid_generate_v4() and public-schema privileges
are available. It has no DATABASE_URL fallback and removes ambient database
environment variables before starting Node.

## One-time local database setup

Use a local PostgreSQL administrator session to create a dedicated database
and role. Do not use a production connection or a production clone. If the
existing local test role is already dedicated, non-superuser, and has the
needed privileges, create only the new database and grant access:

    CREATE DATABASE invoxa_accounting_test_invoice_local;
    COMMENT ON DATABASE invoxa_accounting_test_invoice_local
      IS 'INVOXA_DISPOSABLE_ACCOUNTING_TEST';
    GRANT CONNECT, CREATE, TEMPORARY ON DATABASE invoxa_accounting_test_invoice_local
      TO invoxa_accounting_test_role;

Connect as the administrator to the new database and make sure the extension
and public-schema permissions are available:

    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    GRANT USAGE, CREATE ON SCHEMA public TO invoxa_accounting_test_role;

The integration role must not be a superuser. The suite requires ownership or
equivalent privileges to create and drop its own public-schema fixture objects.
Do not add any relations to the database before running the suite. If setup or
cleanup fails after the suite has passed the guards, discard this dedicated
test database and provision a fresh one.

## Run from Windows CMD

Open an interactive CMD window and run:

    cd /d C:\Users\ADMIN\Desktop\Invoxa\saas-invoicing\server
    integration\run-invoice-accounting-postgres.cmd

At the hidden password prompt, type the password for the local
invoxa_accounting_test_role and press Enter. No characters are echoed. The
password is read as a secure string, URL-encoded only in the launcher process,
and passed to the Node child only through the dedicated test URL environment
variable. Do not put it in chat, a command, shell history, or a file.

The existing accounting suite is run separately with
integration\run-accounting-postgres.cmd; its guarded target and checks are not
changed by this suite.

## Fixture source and limits

The repository contains no original DDL for tenants, users, clients, invoices,
or invoice_items, and no local schema dump was found. The fixture in
invoice-fixture-schema.sql is therefore deliberately minimal and test-only.
Its selected columns and data types follow the read-only tenant integrity
preflight report and actual route/service SQL. The constraints added to make
the fixture internally safe are fixture assumptions, not verified production
facts.

The suite applies the repository's product/stock migration, Sales Order
migration, accounting foundation migration, and invoice accounting
configuration migration only after the empty-database guard passes. It never
reads or runs 20261017_001_unique_invoice_number_per_tenant.sql. No
invoice-number uniqueness rule is added, and the known duplicate INV-0002
remains outside this disposable fixture.

The tests call the real Express invoice, Sales Order, and accounting routes
against the disposable pool. Sales Order generation is exercised through its
route with a fulfilled fixture order; product stock movements and payment
receipt workflows are outside this milestone. The legacy paid-status case
does not imply receipt or post a payment journal.

## Test coverage and evidence limits

The suite currently defines 19 PostgreSQL integration tests. They include
draft invoices with no journal before issuance; direct and Sales Order invoice
finalization; balanced journals and issuance audit; saved tax and discount
totals; identical and concurrent retries; cross-tenant invoice/account checks;
non-admin rejection; invalid currency, mappings, tax configuration and
periods; rollback after invoice update and at deferred constraint failure;
and protection against automatically posting legacy sent, overdue or paid
invoices. These tests use real PostgreSQL transactions and constraints and
send requests through the actual Express routes.

This is distinct from `server/test/invoiceAccounting.test.js`, whose unit
tests use a mocked PostgreSQL client. Both kinds of tests are distinct from
production-schema verification: the PostgreSQL suite builds the core tables
from the test-only fixture described above. Passing against that fixture
proves neither that production has the same schema nor that any repository
migration has been applied there. The authoritative core schema and applied
migration history remain unverified; no deployment status is implied by this
test documentation.

# Bank reconciliation

## CSV format

The first version accepts UTF-8 CSV up to 1 MiB and 5,000 data rows. The header row is case-insensitive and must contain:

```csv
transaction_date,bank_reference,description,debit,credit,running_balance
2026-05-01,BANK-1001,"Customer payment",0.000000,1500.000000,11500.000000
2026-05-02,BANK-1002,"Monthly fee",25.000000,0.000000,11475.000000
```

The order of columns may vary. `bank_reference` and `running_balance` are optional. Dates must be real calendar dates in `YYYY-MM-DD`. Amounts must be unsigned decimal text with at most six fractional places and no grouping separators. Enter a positive value in exactly one of `debit` or `credit`; use zero in the other. Quotes, escaped quotes, commas, and line breaks inside quoted fields are supported.

If `running_balance` is present, every row must provide it, rows must be chronological, each row balance must equal the prior balance plus credit less debit, and the opening balance is derived from the first row. The last running balance is the statement closing balance. If running balances are absent, the preview form requires the statement opening and closing balances and checks that opening plus credits less debits equals closing. Negative account balances are supported.

The statement currency is the tenant's configured accounting base currency because the current accounting schema has no currency classification on bank accounts. A statement in another currency cannot be imported against this account. Select the account explicitly in the chart setup; account names are never used to infer bank status.

## Import and reconciliation rules

- Imports are previewed and validated before confirmation. A preview token binds confirmation to the validated CSV contents.
- Imported transaction rows and their file hash are retained as immutable records. Reimporting the same file or an existing transaction fingerprint is rejected. When no bank reference is present, duplicate detection uses date, description, direction, and amount; identical legitimate transactions without bank references may need bank-specific references to distinguish them.
- Suggestions require exact amount and direction, the same designated account and currency, a posted journal line, and a journal date within seven days. Reference similarity affects suggestion order. Original posted journals and posted reversals can both be candidates; the journal source and reversal link are shown.
- Manual matches still require exact amount, direction, account, currency, a posted journal, and explicit confirmation. Matching is one statement transaction to one complete journal line. Partial and split matching are not supported by the existing journal allocation model.
- Outstanding ledger lines dated in the statement period are listed. The adjusted statement closing balance equals statement closing balance plus unmatched ledger debits less unmatched ledger credits. Difference is adjusted statement closing less posted ledger closing at the statement end date. Every statement row must be matched and the difference must be zero before completion.
- An administrator can release a match only with a reason. Reopening a completed reconciliation also requires a reason and creates an audit event. Posting journals dated on or before a reconciled cutoff is blocked by the migration's journal-posting guard until affected reconciliations are reopened.
- Bank fees, interest, and other unmatched bank entries do not create journals automatically. An administrator must select an offset account and open accounting period, review the description and direction, and explicitly authorize a journal through the existing accounting posting service. The journal and match are committed in one transaction with a stable idempotency key.

## API

The private frontend uses `/api/accounting/bank-reconciliation`. Reads require authentication and accounting read permission; account setup, import confirmation, matching, adjustment, completion, and reopening require the accounting administrator role. Tenant identity is always taken from the authenticated JWT.

The batch detail and import history endpoints accept `page` and `page_size`; maximum page size is 100. The UI shows 25 transactions per detail page. No CSV export is implemented.

## Migration and verification

`migrations/20261030_001_bank_reconciliation.sql` is additive. It adds explicit bank-account designation, immutable import batches and statement rows, one-to-one active match constraints, append-only audit events, and the reconciled-cutoff guard. It does not classify or backfill existing accounts. Do not deploy the feature until this migration has been reviewed and applied to an approved non-production database first, then rolled out through the project's normal migration process.

The automated tests in `test/bankReconciliation.test.js` use an in-memory query stub. They cover parser rules, idempotent import behavior, tenant scoping, exact matching, simulated concurrent matching, audit events, and balance difference arithmetic. They do not establish PostgreSQL syntax, locking, trigger behavior, or database compatibility. The migration was not executed for this implementation.

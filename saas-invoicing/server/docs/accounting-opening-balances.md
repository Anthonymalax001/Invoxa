# Accounting opening balances and cutover

## Scope and accounting assumptions

The opening-balance workflow creates one tenant-scoped cutover batch and, after a second administrator approves it, posts one immutable journal through the existing accounting posting service. The entry is visible in the Trial Balance, General Ledger and Balance Sheet like other posted journals.

Only active asset, liability and equity accounts are accepted. Revenue and expense balances are rejected so an opening entry cannot inflate current-period profit or loss. Amounts use the ledger's exact six-decimal precision and must balance exactly in the tenant's configured functional currency. Foreign-currency opening balances and remeasurement are not supported by this workflow.

The user supplies the full balanced trial balance. If assets, liabilities and equity do not balance, the workflow rejects the draft. It never chooses a retained-earnings account or calculates an equity plug. Finance must approve the cutoff trial balance and explicitly select the appropriate retained-earnings/equity account and amount, if applicable.

The effective date must fall inside the selected open accounting period. Posting into a closed period is rejected. Reversals use a new date in an open period, create a linked journal using the existing reversal service and leave the original journal untouched. Only one cutover may be live or posted for a tenant. After a cutover is reversed, a replacement draft may be created only at the original effective date; it still must pass the open-period rule. Cancelling an unposted draft permits a corrected draft.

Draft creation and approval/posting require separate administrators. Cancellation and reversal require an administrator, explicit confirmation, a reason and an idempotency key. Events record the actor, reason, event type, payload hash, related journal and timestamp. Drafts block period closure until posted or cancelled.

## Historical-record preview

The preview is read-only and never creates journals or changes source records. It classifies invoices, customer receipts, supplier bills, supplier payments and expenses only when the repository's expected column names and types are present. A source is marked already accounted for only when a linked posted journal proves that relationship. Unverifiable source records are ambiguous; draft, failed, unissued or cancelled records are excluded only where the existing source contract supports that status.

Preview amounts are source-record amounts, not a calculation of the amount to enter as an opening balance. Counts and totals are informational and can include gross invoice/bill/receipt amounts; they must not be summed to build the cutover journal. The cutover amount must come from the finance-approved trial balance as of the cutoff date.

Automatic historical posting is deliberately unsupported. In particular, the repository does not define an authoritative legacy `payments` schema/status contract, and legacy expenses do not have a ledger account/journal link. Those rows are not treated as settled or already accounted for without proof. An accepted M-Pesa request or an unverified payment result is not evidence of receipt. Ambiguous records require manual review against source documents and posted journals before the trial balance is approved.

## Operator steps

1. Confirm the approved cutover date, functional currency, chart of accounts, accounting period and a finance-approved trial balance.
2. Review the read-only historical-record preview. Resolve ambiguous records outside this workflow and ensure represented balances are not counted twice.
3. Enter debit and credit balances using active asset, liability and equity accounts. Add any approved equity/retained-earnings amount explicitly. Confirm the exact debit/credit equality and date/period.
4. Create the draft with an idempotency key. A different accounting administrator must independently compare the draft with the approved trial balance before posting it with a reason.
5. Verify the posted journal and resulting Trial Balance, General Ledger and Balance Sheet. If correction is necessary, use the audited reversal workflow, then stage a replacement at the same effective date while its accounting period remains open. If that period is closed, do not backdate or bypass the close; obtain an approved finance policy for the correction path.

## Installation and verification limits

`20261031_001_accounting_opening_balance_cutover.sql` is an additive migration and has not been executed. It adds tenant-scoped draft lines, state guards, append-only audit events and uniqueness constraints. Review its preconditions against authoritative deployment schema evidence and the migration sequence before applying it. The application requires these objects and fails when they are unavailable.

Automated service tests use mocked database clients. They do not verify PostgreSQL row-lock, deferred-trigger, unique-index or migration behavior. No production schema, database connection or migration execution is part of this implementation.

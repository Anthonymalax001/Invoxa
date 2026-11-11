# Financial reporting

The accounting reports read accounting_journal_entries and
accounting_journal_lines. Every financial balance is limited to the
authenticated tenant and to journals whose status is posted. Draft journal
entries and source-document totals are not used.

## Available reports

- **Trial balance** shows opening debit/credit balances, posted debit and credit
  movements in the selected range, and closing debit/credit balances. The
  server sums PostgreSQL numeric values and uses integer six-place arithmetic
  for derived balances and totals.
- **General ledger** requires one tenant-owned account and shows a date-ordered
  history with a running balance, reference filter, pagination, and journal
  detail drill-down. The schema has no human journal sequence; the report
  identifies a journal by its UUID. It accepts a start/end date or accounting
  period; an `as_of` filter is rejected because the ledger needs a defined
  opening date to calculate its opening and running balances. The balance sheet
  continues to support an as-of cutoff.
- **Profit and loss** reports posted revenue and expense account balances for a
  range and derives net profit or loss. It does not split expenses into cost of
  sales, operating expenses, or other expenses because account metadata has no
  such classification.
- **Balance sheet** reports asset, liability, and equity account balances as
  of a date and adds unclosed posted revenue less expenses to equity. It checks
  assets against liabilities, equity, and unclosed earnings. Current and
  non-current subtotals are omitted because the chart has no such metadata.
- **Cash flow** reads posted journal lines for the tenant's explicitly
  designated bank-reconciliation accounts. It reports opening cash, exact
  period inflows/outflows, net change, closing cash, and account detail.
  Equity-only counterparts are financing, asset-only counterparts are
  investing, revenue/expense/liability counterparts are operating, and mixed
  or unsupported counterparts remain unclassified rather than being silently
  assigned.

Trial balance and general ledger balances use each account's configured normal
balance. Profit and loss and balance sheet amounts are signed relative to the
account type's conventional side (debit for assets and expenses; credit for
liabilities, equity, and revenue), so an account configured with the opposite
normal balance is presented as a contra balance.

The optional
`20261025_001_financial_reporting_cash_flow_metadata.sql` migration remains
available for tenants that require audited, effective-dated cash-equivalent and
line-activity classifications. The current report does not apply or infer
those records; unsupported activity remains unclassified.

## Reversal and history rules

Posted journals are immutable and corrections are separate posted reversal
journals. Reports include both the original and its posted reversal, so their
amounts net in balances while the general ledger retains the audit history.
Filtering by reversal_of_entry_id would produce incorrect balances.

Opening and balance-sheet totals assume the tenant ledger contains its complete
posted history, including any opening balances. The accounting foundation has
no verified cutover-balance or ledger-completeness marker, so the reports do not
claim that this assumption is true for a particular tenant. Comparative
periods are omitted for the same reason: the system does not certify complete
historical coverage.

Period filters are resolved by tenant and use that period's dates. If explicit
dates are also supplied, they must match the selected period. The reports use
the tenant's immutable-after-posting functional currency. They do not revalue
transaction-currency amounts.

CSV export is available for the numeric reports. General ledger CSV contains
the currently displayed page; the other report exports contain the complete
report. Print layout can be saved as PDF using the browser's print dialog;
there is no server-generated PDF report.

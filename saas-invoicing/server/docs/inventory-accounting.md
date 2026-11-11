# Inventory accounting

Inventory uses perpetual weighted-average costing. Quantities are stored to
three decimal places and costs and values to six decimal places using exact
decimal arithmetic.

## Account setup

Each tenant must configure these accounts through
`PUT /accounting/inventory-settings`:

- **Inventory asset**: an active debit-normal asset account.
- **Inventory COGS**: an active debit-normal expense account.
- **Inventory adjustment**: a debit-normal expense account for negative
  adjustments and a credit-normal revenue account for positive adjustments.
- **Inventory clearing**: an active credit-normal liability account.
- **Inventory opening-balance counterpart**: an active credit-normal equity
  account used only for the controlled opening-stock valuation workflow.

Account IDs are tenant-owned and are checked again when a transaction posts.
The migration does not guess mappings for an existing tenant.

## Posting behavior

An approved goods receipt increases quantity and inventory value and posts:

```
Dr Inventory asset
Cr Inventory clearing
```

The linked supplier bill must use the configured inventory-clearing account
for received-inventory lines. It transfers the clearing balance to Accounts
Payable and must not debit inventory a second time. Freight, duty,
capitalized tax, and other landed-cost policies remain explicit policy
decisions and are not inferred by this workflow.

Sales fulfilment uses the product's current weighted-average cost and posts:

```
Dr COGS
Cr Inventory asset
```

Returns reverse that cost flow. Positive inventory adjustments require an
explicit unit cost; negative adjustments use the current weighted-average
cost and post to the adjustment account.

All quantity, product-value, and journal changes occur in the existing
transaction. Source idempotency keys prevent duplicate postings, and posted
journals remain immutable. Transactions dated in a closed period are rejected.

## Opening-stock valuation

An accounting administrator can call `POST /accounting/inventory-opening-stock`
with an `Idempotency-Key`, product ID, the quantity currently recorded on the
product, an explicit opening unit cost, an open-period date, and an audit
reference. The quantity must match the locked product quantity; the workflow
never overwrites stock to manufacture an opening balance. For positive stock it
posts:

```
Dr Inventory asset
Cr Inventory opening-balance counterpart
```

The product value, weighted-average cost, opening snapshot movement, and journal
are written in one transaction. Replays are idempotent and a reused key with
different journal data conflicts. A product that is already valued cannot be
valued again. The opening counterpart must be explicitly mapped as an equity
account; no account is inferred from account codes or names.

Zero opening stock is recorded as a zero-value opening snapshot without a
zero-amount journal (zero journals are not valid accounting entries). It does
not value a product that currently has positive stock.

## Existing stock without a valuation

Products with stock when the migration is applied are marked `unvalued`.
Receipts, fulfilments, returns, and adjustments against that stock fail until
the opening-stock workflow above establishes a valuation. This is intentional:
the system does not invent a historical cost.

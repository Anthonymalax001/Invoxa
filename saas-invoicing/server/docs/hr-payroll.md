# HR payroll

Payroll is tenant-configured and uses effective-dated compensation and component
snapshots. Earnings, employee deductions, and employer contributions are separate
component kinds. Components can be fixed amounts or percentages of basic salary or
gross pay. Payroll calculation stores compensation, component, attendance, and leave
snapshots on each item, so later configuration changes do not rewrite history.

Runs move from `draft` to `calculated`, `approved`, and `paid`. Approval and payment
lock the run and call the existing accounting journal service with idempotency keys.
Draft runs never post journals. Approval posts salary expense, employer contribution
expense, employee deductions payable, employer contributions payable, and net salaries
payable. Payment settles net salary payable against the configured payroll cash account.

PAYE, NSSF, SHIF, and Affordable Housing Levy are represented by effective-dated
component configuration. The verified rule defaults are copied into a statutory
component's stored JSON configuration when it is created, and the complete rule and
calculation breakdown is copied into every payroll item snapshot. A tenant can
replace a rule only by explicitly changing its configuration and source metadata.

Administrators can create and edit earning, employee-deduction, and employer-contribution
components in the Payroll page. Statutory components require an authority and statutory
code, and their effective dates and configuration are preserved in each calculated
payroll item snapshot.

## Statutory source review

The implementation was reviewed against these official starting points on 3 November
2026:

- [KRA PAYE guidance](https://www.kra.go.ke/individual/filing-paying/types-of-taxes/paye):
  employment income and employer PAYE obligations. Current bands, reliefs, benefits,
  and exemptions must be verified before configuring PAYE.
- [NSSF Year 4 (2026) employer notice](https://www.nssf.or.ke/notice-to-employers-year-4-2026-nssf-contribution-rates/):
  the applicable 2026 NSSF notice. The notice must be checked in full by payroll
  administrators before entering the effective-dated NSSF rule.
- [Affordable Housing Act, current Kenya Law text](https://kenyalaw.org/akn/ke/act/2024/2/eng@2026-07-01/publication):
  the published Act states a 1.5% levy on gross salary and an equivalent employer
  amount, subject to current law and effective dates.
- [Kenya Law recent legislation](https://new.kenyalaw.org/legislation/recent):
  authoritative source for later amendments and commencement dates.

## Statutory calculation rules

For a monthly run, the engine applies:

- PAYE: 10% on the first KSh 24,000, 25% on the next KSh 8,333, 30% on the
  next KSh 467,667, 32.5% on the next KSh 300,000, and 35% above KSh 800,000.
  The KSh 2,400 resident personal relief is applied only when the employee's
  compensation `statutory_profile` explicitly sets `tax_resident` or
  `personal_relief_eligible` to true. Configured allowable deduction component
  codes are deducted from taxable income before the bands are applied.
- NSSF Year 4: from February 2026, 6% on Tier I up to KSh 9,000 and 6% on
  Tier II from KSh 9,000 to KSh 108,000, capped at KSh 6,480 for each employee
  and employer contribution.
- SHIF: 2.75% of gross salary for the employee, subject to a KSh 300 minimum.
- Affordable Housing Levy: 1.5% of applicable gross salary for the employee and
  1.5% employer contribution.

Statutory amounts are rounded half-up to the nearest cent after the rule formula.
All intermediate values use integer micro-units; JavaScript floating-point arithmetic
is not used. Statutory components are calculated after regular earnings and in the
order NSSF, SHIF, housing levy, then PAYE so explicitly configured PAYE deductions
can reference earlier statutory component codes.

The verified rule defaults are monthly. Weekly and biweekly runs are rejected when
they contain these monthly statutory rules; a separately verified and explicitly
configured frequency-specific rule is required rather than silently prorating a
monthly statutory schedule.

The PAYE allowable-deduction list, employee relief eligibility, taxable-benefit
treatment, non-monthly proration, and any later amendments must be configured and
reviewed by a Kenyan tax professional. The system rejects incomplete or unknown
statutory rule types instead of silently treating them as verified.

## Statutory remittances

When an approved payroll contains statutory components, the approval transaction
creates one tenant-scoped obligation per authority and statutory code. Employee
deductions and employer contributions remain separate balances. Authorized
administrators can view outstanding obligations at
`GET /api/payroll/remittances/obligations` and record a payment with
`POST /api/payroll/remittances`.

Remittance requests require an idempotency key, payment date, exact amount, payment
reference, and a tenant-owned asset account. The service locks the obligation,
rejects overpayment, selects an open accounting period for the payment date, and
posts a balanced payable-to-cash journal through the existing accounting service.
Each settlement records its journal, reference, allocation, and audit event.
Approved payroll snapshots are never recalculated or changed by remittance.

Migration `20261103_005_payroll_statutory_remittances.sql` adds statutory metadata,
tenant-scoped accounting-account foreign keys, obligations, remittance payments,
indexes, and remittance audit support. It depends on migrations `001` through `004`
and has not been run against production.

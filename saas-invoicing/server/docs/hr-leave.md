# HR leave management

Leave types are tenant-configured. The migration seeds Annual, Sick, Maternity,
Paternity, and Unpaid leave types for each existing tenant, but leaves their annual
entitlements unset because statutory and contractual entitlement varies by employer.
Administrators configure employee balances by leave type and leave year. Negative
balances are rejected unless the balance explicitly allows them.

Applications count Monday through Friday only; public holidays and employer-specific
work schedules are intentionally not assumed. Pending and approved applications may
not overlap for an employee. Approval locks the application and its yearly balance,
checks the remaining entitlement, increments used days, and writes an immutable audit
event atomically. Cancellation reverses an approved deduction in the same transaction.

Approved leave is exposed by the leave APIs for HR review. It does not automatically
create or overwrite attendance records, so manually recorded attendance remains
auditable. Leave approval, rejection, and cancellation are administrative workflows;
payroll and statutory leave rules are outside this step.

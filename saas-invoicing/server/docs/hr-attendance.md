# HR attendance

Attendance is tenant-scoped and references the existing `hr_employees` records through
a composite tenant foreign key. Each employee may have one record per attendance date.
The supported statuses are `present`, `absent`, `late`, `half-day`, and `on leave`.

Clock times use local `HH:MM`/`HH:MM:SS` values. When both times are supplied, the
database calculates working minutes and overtime minutes (anything above eight hours
in a day). Clock-out before clock-in is rejected. Absent and on-leave records cannot
contain clock times.

Attendance changes are written with a corresponding immutable audit snapshot in
`hr_attendance_audit` in the same transaction. The API supports daily filtering,
employee history, department/status filters, and monthly summaries. Attendance does
not implement leave approval, payroll, or accounting integration.

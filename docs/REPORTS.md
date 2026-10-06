# Reports (Part 7)

Reports are worked out from the real transactional records every time one is opened (invoices, payments, jobs, bookings, stock movements, time entries…). Nothing is stored as a summary, so a report can never go stale or disagree with the records. There is no AI: every figure is a count, a sum or a date calculation, and every sentence is a fixed label.

```
request -> report.view + the report's own permissions + plan feature
        -> filters validated (only the ones the report declares)
        -> date range resolved on the BUSINESS calendar (time zone, not UTC)
        -> one tenant transaction: queries -> columns/metrics the caller may not see are removed
        -> page of rows (server-side pagination) + summary + chart data + notes
```

## Where things are

| Piece | File |
| --- | --- |
| Definitions (one per report) | `src/server/reports/defs/*.ts`, listed in `registry.ts` |
| Framework (permissions, scope, limits) | `src/server/reports/run.ts`, `params.ts`, `range.ts`, `types.ts` |
| CSV / Excel / PDF | `src/server/reports/export.ts` (uses `lib/tabular.ts` and `pdf-lib`) |
| Custom reports | `src/server/reports/custom/schema.ts` (approved schema), `engine.ts` (compiler) |
| Saved reports, sharing | `src/server/reports/saved.ts` |
| Schedules and delivery | `src/server/reports/schedules.ts`, `recipient.ts` |
| Pages | `/reports`, `/reports/[key]`, `/reports/saved`, `/reports/builder`, `/reports/schedules` |
| API | `/api/v1/reports/*` |

## The reports

Financial: **Revenue** (invoiced, credit notes, cash received, refunds and what is still owed, by day / week / month), **Invoices** (status, ageing), **Payments** (by method, refunds, customer credit), **Outstanding receivables** (ageing buckets with drill-down), **Quotes** (outcomes, approval and decline rates).
Operations: **Jobs** (by status, technician, service, location, period, or each job), **Bookings** (status, conversion to jobs, popular services, peak days and hours, capacity used).
People: **Customers**, **Customer retention**, **Vehicles**, **Technician workload**, **Labour** (hours worked and billed, revenue, cost, margin).
Stock: **Stock on hand** (on hand, reserved, available, value), **Stock movements**, **Parts usage**, **Slow-moving stock**.
Purchasing: **Suppliers**, **Purchase orders** (by status, outstanding deliveries).
Profit and tax: **Profitability** (by service, job or period), **VAT (operational)**, **Accounting export**.

Definitions (also printed on every report):

* **Revenue** is what was *invoiced*, VAT excluded, by invoice date, less credit notes issued. **Cash received** is shown separately and is never called revenue. **Outstanding** is what customers still owe on issued invoices.
* **Gross profit = revenue − parts cost − labour cost**, using the cost copied onto each invoice line when the line was created. Lines with no recorded cost count as zero cost and are counted and shown. It is not net profit and not accounts.
* **VAT** and the accounting export are operational data for an accountant. They are not a VAT return and not an accounting integration.
* **Utilisation / capacity** is only shown where hours and bays (or technician hours) exist; otherwise it is blank, never guessed.
* **Slow-moving** uses the business's own threshold (Settings, Reporting). With less stock history than the threshold nothing is called slow.
* **Retention** uses deterministic date arithmetic on jobs (visit = a job opened). There is no prediction.

## Permissions and plans

Every report declares the permissions it needs; the caller also needs `report.view`. Columns and summary tiles can declare a permission of their own (`needs`); the framework **removes** them before anything leaves the server, so a technician or advisor never receives cost, margin or valuation figures, even from a report they may open. Location scope applies to every location-bearing table (a restricted member sees only their locations; several locations at once is a `multi_location` feature). Plans: `advanced_reports` (Team and up) for quotes, retention, technicians, labour, suppliers, slow-moving, VAT and accounting; `financial_reports` for profitability; `inventory_reports` for movements, usage and slow-moving; `custom_reports` and `scheduled_reports` (Business and up).

Exports need `report.export`, plus `finance.export` for financial reports and `inventory.export` for stock and purchasing reports. Every export is audited (report, format, rows, columns, filters) and rate limited. CSV text that starts with `=`, `+`, `-` or `@` is defused so it cannot run as a spreadsheet formula.

## Custom reports

A custom report is a **configuration** (source, fields, filters, grouping, totals, sort, date range, locations), never SQL. The approved schema lists, for each source, the fields it exposes; nothing else can be reached (no passwords, tokens, sessions, security data, customer contact details or private employee data; a test enforces this). The compiler writes one parameterised `SELECT` from that schema: field and operator names are looked up, operators are checked against the field's type, and every value is a bound parameter. Field-level permissions apply at run time: a person cannot build, or filter on, or run a report containing a field they may not see.

## Saved and shared reports

Saved reports have an owner and a visibility (private, shared with chosen roles / people, business-wide with `report.manage`). **Sharing shares the recipe, not the data**: whoever runs a shared report runs it with their own permissions, locations and plan, and a custom report with a field they may not see refuses to run for them.

## Scheduled reports

`saved report -> scheduler -> per recipient: generate with THAT person's permissions -> export file -> email via the shared message service (REPORT_DELIVERY, so it is in the communication history) -> run recorded`.
A missed stretch produces one catch-up run. A recipient who lost access is skipped and the skip is recorded; a run that reaches nobody is `FAILED`. Failures are retried (4 attempts), audited, and raised in the app to the person who set the schedule up. Run history and delivered report files are cleared after the business's retention period.

## Not built / limits

* No cached aggregates: reports query live data (correctness over speed). Pagination, indexes and a 25-second statement timeout keep them bounded; export is capped at 50,000 rows.
* Charts are drawn server-side as accessible SVG (every bar has a text value; every chart has a data table); there is no interactive charting library.
* Technician "utilisation" counts hours worked against availability; it is a workload measure, not an assessment.
* No customer-level "marketing" lists: customers' contact details are not offered to the custom builder.

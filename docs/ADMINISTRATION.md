# Administration, imports and exports (Part 7)

Business administration lives under **Admin** (`/admin`). It is the business's own administration: nothing here reaches another business or the platform, and platform administration (separate, API/CLI only) is untouched. Every action is a normal permissioned action; there is no "admin bypass". The `admin.view` permission only opens the landing page and the views listed below; each view and each action checks its own permission and plan feature again.

| Screen | Permission | Notes |
| --- | --- | --- |
| Overview | `admin.view` | plan and usage, alerts, setup progress, connections (connected / not, never how), recent audit |
| Setup check | `settings.view` | fixed checklist, deterministic, Complete / Could be better / Action required, each with a "fix this" link |
| Alerts | per item | low / out of stock, late deliveries, overdue invoices, failed payments and messages, failed documents / reports / imports, storage, trial and subscription; worked out live, so they disappear when fixed; also summarised on the dashboard |
| Audit log | `audit.view` | filters: text, action, person, record type, dates; CSV export needs `business.export` and is itself audited; append-only (the database refuses UPDATE and DELETE) |
| Security events | `security.view_events` + `advanced_admin` | member / role / ownership / security-setting events and data leaving the business, without addresses or devices; plus each member's two-factor status, last activity and signed-in devices |
| Archive | `admin.view` + `advanced_admin` + the kind's permission | customers, vehicles, parts, suppliers, documents; restore uses the module's own restore |
| Search | `admin.view` + `advanced_admin` | ordinary database matching across records, team members, documents and audit events; wildcards are literal; no semantic or vector search |
| Import | `data.import` | see below |
| Export | `business.export` | links to the full data export (Part 1), report exports, accounting files, audit export |

Ownership transfer and business closure are the Part 2 flows (Settings, Security): re-authentication, audit entries, confirmation and the closure rules are unchanged; closing never deletes data.

**Privacy boundary:** an individual's sign-in, failed sign-in, password and device events are private to that person's account (Part 2 row-level security). A business sees whether its people are protected (two-factor, last activity), not their personal sign-in history.

## Import centre

`upload -> choose type -> map columns -> validate -> preview -> confirm -> process -> results`

* Kinds: customers, vehicles, suppliers (Business plan: `advanced_import`); parts have the Part 5 importer (prices, categories, opening stock).
* The file (CSV or Excel, up to 5,000 rows, 8 MB) is **staged** in `import_batches` / `import_rows`; nothing touches real records until the person confirms.
* Validation uses the same rules as creating the record by hand (and the business's vehicle rules). Rows are VALID, INVALID (with reasons) or DUPLICATE.
* **Duplicates are deterministic and never merged**: customers by customer number, email or phone (compared by last nine digits); vehicles by normalised registration or VIN; suppliers by reference or name; against existing records *and* earlier rows in the same file. A duplicate is listed with what it matches and skipped.
* Vehicles must name their owner (customer number, email or mobile); an unknown or ambiguous owner is an invalid reference.
* Confirming with problems needs an explicit "skip them"; every skipped, duplicate or failed row stays in the batch with its reason, and "download rows to fix" gives a CSV to correct and upload again.
* Rows are saved 100 at a time, **each group one transaction** (a failure rolls the group back and marks its rows failed; nothing is half-saved), and every row is re-checked inside the transaction. A crash leaves the import resumable (only still-valid rows are processed).
* Audited (uploaded, validated, completed / failed / cancelled), with counts. Staged files are cleared after the business's retention period; the records created stay.

## Exports

Report exports (CSV, Excel, PDF) follow filters, columns, location access and permissions and are audited. The full business export (Part 1) is unchanged and asynchronous. Accounting exports are clean rows (invoices, credit notes, payments, refunds, VAT), explicitly not an accounting integration.

## Limits

* Imports are synchronous in the request (up to 5,000 rows); a background-job import for very large files is not built.
* Closing, ownership transfer and role editing keep their Part 2 screens; the Admin area links to them.
* The reports, administration and settings pages were checked in a browser at phone width (375 px) in Part 8: no horizontal overflow and no render errors on any of them (see [PRODUCTION-READINESS.md](PRODUCTION-READINESS.md)). There are no automated browser tests, and real devices were not used.

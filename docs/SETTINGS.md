# Business settings and workshop configuration (Part 7)

A setting is only worth having if it changes behaviour. Every setting below says where the code reads it. All changes are validated on the server, need their own permission (and plan feature where noted), and write an audit entry with the old and new values (never a secret). Nothing here ever rewrites history: numbers already issued, labour already recorded, vehicles and jobs already saved keep what they have.

Settings are spread over pages under **Settings** (`/settings/all` lists them) and stored in the existing settings tables plus one new row per business, `business_config` (`src/server/settings/config.ts`).

| Setting | Page | Where it takes effect |
| --- | --- | --- |
| Business profile, VAT, time zone, currency, locale | Business | `businesses`; every document and report |
| Numbering (customer, booking, job, quote, invoice, payment, receipt, credit note, refund, PO, GRN, transfer, supplier return) | Numbering | `numbering/sequence.ts`, `finance/common.ts`, `inventory/common.ts`: new numbers only; each kind keeps counting; prefixes must differ across kinds |
| Labour rounding step and minimum billable time | Labour | `team/time.ts` when time becomes a labour line (the time entry keeps the actual minutes; the line shows worked and billed) |
| Job status and priority names, optional steps switched off, required fields | Jobs | names: `job-labels.tsx` everywhere; switched-off steps: `jobcards/service.ts` (not offered, refused; a job already in the step can still resume); required fields: `openJobTx` |
| Service catalogue (price, VAT, checklist, default parts, labour rate) | Services | quote / invoice forms add a priced line (a copy); labour rates resolve as before |
| Job templates | Services | `createJobFromTemplate`: copies labour, parts and a checklist note onto the new job; the job keeps no link to the template |
| Booking rules (gap between appointments, minimum notice, daily limit, walk-ins, waiting list, cancellation window) | Bookings | `bookings/availability.ts` (pure rules), `bookings/service.ts`, `bookings/extras.ts` |
| Vehicle required fields, option lists, default service interval | Vehicles | `vehicles/service.ts` (a retired option stays valid on vehicles that have it), `vehicles/insights.ts` |
| Stock defaults (reorder quantity, markup) | Stock | `inventory/parts.ts` new parts only |
| Payment methods, terms, bank details, online payments (secrets write-only) | Quotes, invoices and payments | `finance/*` (Part 4) |
| Communication (sender, reminders, who is told) and templates | Communication | `notifications/*` (Part 6) |
| Documents, categories, retention | Documents | `files/*` (Part 6) |
| Reporting defaults (period, slow-moving days, "not seen" days, dashboard blocks hidden) | Reporting | `reports/run.ts`, the dashboard |
| Session length, invitation expiry | Security | `tenancy/context.ts` (a sign-in older than the limit must sign in again, in that business only), `memberships/service.ts` |
| Retention (trash days, financial documents — lengthen only, report history, import files) | Data | `files/lifecycle.ts`, `reports/schedules.ts` cleanup |
| Locations (contact details, document code) | Locations | `finance/common.ts businessSnapshot`: a document with a location uses that location's phone, email and address, else the business's |

## Precedence

Global business default -> location override where one exists. Today that is the location's contact details on its own documents and its document code in numbers; opening hours, bays and technicians are business-wide (see limits).

## Dependencies handled

Disabling a payment method keeps old payments; retiring a job status keeps historical jobs and lets those in it leave; an archived service or template stays on the records that used it; changing VAT or a labour rate never rewrites an issued invoice (documents carry frozen snapshots); changing a prefix never touches issued numbers.

## Limits (honest list)

* **Vehicles have no number** (they are identified by registration and VIN); there is nothing to configure for "vehicle numbering".
* **Job statuses** are a fixed workflow: names can be changed and the two optional steps (awaiting parts, on hold) switched off, but statuses cannot be added or reordered, because the workflow rules (quality check gate, approvals, stock and invoicing hooks) depend on them.
* **Job templates** copy a checklist as an internal note; they do not enforce inspection fields.
* **Opening hours** and technician availability are business-wide; per-location hours are not modelled.
* **Password rules** are platform-level (they apply before a person belongs to any business), so they are not a business setting; MFA is.
* **Audit log and communication history retention** are not configurable: both are append-only and kept permanently.
* Per-location **numbering** is the existing document code (`INV-CPT-000001`), set under Locations.

# Workshop operations (Part 3)

Customer → Vehicle → Booking → Check-in → Job card → Inspection → Diagnosis → Recommended work → Approval.
Everything here is deterministic: stored rows, explicit rules, user-chosen values. There is no AI anywhere
(`tests/security/no-ai.test.ts` fails the build if an AI package, endpoint or model name appears).

## Data model

```
Business ─┬─ Customer ─┬─ Vehicle ─┬─ VehicleMileage (append-only)   ServiceInterval   VehicleContact
          │            │           └─ Booking ── BookingEvent (append-only)
          │            └─ Booking ── JobCard ─┬─ JobCheckIn         JobTechnician (additional technicians)
          │                                   ├─ Inspection ── InspectionItem
          │                                   ├─ Diagnosis          RecommendedWork (own approval state)
          │                                   ├─ JobNote / JobPhoto (INTERNAL | CUSTOMER)
          │                                   ├─ JobPart / JobLabour (foundation for Part 5)
          │                                   └─ JobQualityCheck (append-only)
          ├─ ServiceType, Bay, WorkshopHours, WorkshopSettings, TechnicianSchedule, TechnicianTimeOff
          ├─ WaitingListEntry, RecurringBookingRule (each occurrence is a real Booking)
          └─ ActivityEvent (append-only; the one feed behind the customer, vehicle and job timelines)
```

Integrity lives in the database, not only in the services:

* Every link is a **composite foreign key** `(id, business_id)`, so a row can never point at another business's record.
  A job's inspection/diagnosis uses `(job, business, vehicle, customer)`, so they cannot disagree with their job.
* RLS is enabled **and forced** on every table (the guard test in `tests/db/rls.test.ts` fails if one is missed).
* Registration and VIN are unique **per business among non-archived vehicles** (partial unique indexes). Two businesses may hold the same plate.
* One bay cannot hold two live bookings: a `gist` **exclusion constraint** on `(bay_id, time range)`.
* A booking has at most one job (`job_cards (booking_id, business_id)` unique) and a trigger checks the job matches the booking's customer/vehicle.
* Mileage history, booking history, quality checks and activity events are **append-only** (trigger).

## Numbers

`CUS-000001` (customers), `BKG-000001` (bookings), `JOB-0000001` (jobs). One atomic upsert per kind
(`numbering/sequence.ts`), taken inside the creating transaction, so concurrent creates never collide and a rolled-back
create does not burn a number. The prefix/width is passed by the caller, so a settings screen can later make it configurable.

## Bookings and availability

`bookings/availability.ts` is a **pure function** (`evaluateSlot`) over preloaded data, so the same rules answer
"can I book this?", "which times are free?" and "can this be dragged here?".

| Rule | Soft? | Meaning |
|---|---|---|
| `IN_PAST` | no | the start has passed |
| `OUTSIDE_HOURS` | yes | must start inside opening hours and finish the same day (a gap in the hours is a break) |
| `TECHNICIAN_OFF` | yes | the technician's own hours (else the workshop's) and their leave |
| `TECHNICIAN_BUSY` | no | no overlapping appointments for one technician (unless the business allows it) |
| `BAY_BUSY` | no | one appointment per bay (also a DB constraint) |
| `CAPACITY_FULL` | no | peak concurrent bookings ≤ configured maximum, else ≤ number of bays (if any) |

"Soft" conflicts can be knowingly waived by someone with `booking.manage`. Every booking write takes a **per-business
advisory lock** inside its transaction, so two receptionists booking the same technician at the same instant are checked
one after the other (tested: 5 parallel creates → exactly 1 succeeds).

Reschedule keeps a `booking_events` row (old time, new time, who, why) and emails the customer if the business has that on.
`Completed` is never set by hand: it happens when the linked job completes. `No-show` is only allowed after the start time.
**Check-in is idempotent**: the booking row is locked, an existing job is returned instead of creating a second one, and the
database refuses a second job for the booking anyway.

Recurring series create one real booking per date (max 104); dates that cannot be booked are skipped and reported, never squeezed in.
The waiting list never books anyone by itself: staff choose the slot and it goes through the normal rules.

## Job workflow

```
Booked → Checked In → Inspection → Diagnosis → Awaiting Approval → Approved → (Awaiting Parts ↔) In Progress
       → Quality Check → Ready for Collection → Completed          (+ On Hold, Cancelled)
```

`jobcards/transitions.ts` holds the rules as data (`decideTransition`, `nextStatuses`) and is unit-tested for every
status pair. Notable rules: asking for approval needs recommended work; approving needs every item decided and ≥1
approved; Quality Check can only be left by recording the quality check (pass → Ready, fail → In Progress with a reason);
a held job resumes only where it stopped; cancelling/holding need a reason. `job.override_status` permits any move but needs a
reason and is audited as `job.status_overridden`. A status change carries the status the user was looking at
(`expectedStatus`); if someone else moved the job meanwhile, the change is refused with that explanation.

Who may act: moving/ editing a job needs the permission **and** either `job.assign` (advisors, managers) or being assigned to
the job (technicians) — so a technician cannot touch jobs that are not theirs.

The vehicle's workshop status follows the job by explicit rules (`applyWorkflowVehicleStatus`) and records the job and reason
every time; `INACTIVE` is never changed by a job.

## Inspection, diagnosis, recommended work — three separate things

* **Inspection**: standard checklist (exterior, tyres/wheels, mechanical) copied per job; each item Good/Attention/Critical, with measurement, internal note, customer note and a "show to customer" flag. Photos optional.
* **Diagnosis**: *observations* (symptoms, fault codes, tests, findings) are separate from the technician's *stated diagnosis*, which only counts once someone presses **Confirm**. Editing the conclusion withdraws the confirmation.
* **Recommended work**: a proposal (priority, estimate, parts) with its own approval state (`PENDING/APPROVED/DECLINED`, method, who, when). Editing what the work is, its priority or price **withdraws** a previous decision. Nothing creates or approves work automatically. Part 4's quote workflow will drive this same state.

## Internal vs customer-visible

Notes and photos carry `visibility`. The **customer report** (`jobcards/reports.ts`) is built by whitelisting fields:
customer-visible items with their *customer* notes, customer-visible photos, recommended work flagged for the customer, the
technician's customer summaries and customer-visible job notes. Internal notes, internal photos, fault codes and raw findings
never appear (tested with planted markers). Changing visibility is audited. There is no customer portal yet; the report is a
printable page for staff to hand over, and files are only ever served to signed-in staff with permission.

Prices (part costs/prices, labour rates, estimates) need `job.view_pricing`; without it they are neither accepted nor returned.

## Vehicle health indicator

Deterministic and explained (`vehicles/insights.ts › computeHealth`), never a diagnosis:

* **Immediate attention** — unresolved CRITICAL finding in the latest completed inspection, or outstanding URGENT work.
* **Attention recommended** — unresolved ATTENTION finding, outstanding IMPORTANT/RECOMMENDED work, or an overdue maintenance interval.
* **Good** — none recorded.

"Resolved" = recommended work created from the finding has been completed. The result lists the recorded facts behind it and
shows recommendations separately from facts.

## Service history, mileage, intervals

Service history **is** the vehicle's completed job cards (no separate table to drift). Mileage is an append-only log; a lower
reading is refused unless someone with `vehicle.correct_mileage` records a correction with a reason. Maintenance intervals are
by distance, time or both (whichever first); completing a job of the linked service type resets them.

## Search

Server-side, tenant-scoped, trigram-indexed, every word must match: customers (name, number, mobile digits, email, company),
vehicles (registration in any spacing, VIN, make, model, owner), bookings and jobs (number, customer, registration, VIN, technician).
Registered in `search/registry.ts`, so the global search box and each list use the same code.

## Permissions added

`vehicle.correct_mileage`, `job.change_status`, `job.override_status`, `job.inspect`, `job.quality_check`, `job.approve_work`,
`job.view_pricing`. Workshop configuration uses the existing `booking.manage`. Defaults: technicians inspect, diagnose,
recommend, move assigned jobs along and complete them; advisors create/assign/approve and see pricing; managers have all job
permissions; accounts see job pricing.

## Not in this part (by design)

Quotes, invoices, payments and customer balances (Part 4 — the customer/vehicle "Spend" and "Balance" show as unavailable, not zero, and
the *has outstanding balance* filter is not offered yet); inventory, suppliers, employee time tracking (Part 5 — job parts/labour are
the foundation rows); customer notifications beyond the reschedule/cancel emails and a "reminder sent" marker (Part 6); report/settings
screens beyond workshop configuration (Part 7).

# Inventory, suppliers, purchasing and team (Part 5)

TFME Auto's stock system is **transactional**: a quantity is never an editable number. Every change is a movement in an immutable ledger, and the database itself applies each movement to the stock row under a lock. Purchasing (suppliers, purchase orders, receiving, supplier returns) and the team (employees, technicians, assignment, time, labour rates) are built on the same Account + Business Membership architecture from Parts 1–3. There is no AI anywhere.

## The three numbers

| Number | Meaning |
|---|---|
| **On hand** | what is physically there |
| **Reserved** | promised to a job but not yet used (still on the shelf) |
| **Available** | on hand − reserved: what can still be promised |

Screens always show all three together; a page can never imply that reserved stock is free. The server works out every figure from the database (`server/inventory/stock.ts`); totals sent by a browser are never used.

## How stock changes (migration `0008`)

- `stock_movements` is append-only (a trigger refuses UPDATE/DELETE). Types: Received, Sold, Used, Reserved, Unreserved, Returned, Adjusted, Damaged, Lost, Transfer in/out, Supplier return. A CHECK constraint gives each type its exact shape (e.g. *Used* takes from on hand and, optionally, releases the same quantity from reserved, in **one** row, so stock is never taken twice).
- `stock_levels` quantities can be changed **only** by a movement: a `BEFORE INSERT` trigger on movements locks the level row, checks `available ≥ 0` (unless the business has allowed negative stock), fills in before/after, and updates the level. A direct `UPDATE stock_levels SET on_hand = …` is refused (`pg_trigger_depth()` guard), as is inserting a level with stock in it.
- Two requests for the last unit are decided one after the other by the row lock; the loser gets "not enough stock". The service pre-checks under the same lock to give a friendly message; the trigger is the backstop.
- Idempotency: movements, goods receipts, supplier returns and timers carry optional keys with partial unique indexes, so a retry or double tap is one change.
- A correction is another movement (an adjustment), never an edit. A test proves `sum(movements) = stock level` for every row.
- Negative stock is **off by default**. Enabling it needs `inventory.negative_stock`; every movement that ends below zero is flagged (`went_negative`) and audited, and a *manual* adjustment below zero needs that permission too.

## Parts catalogue

Parts have SKU, part number, barcode, brand, manufacturer, category (configurable tree, one sub-level), unit, cost, selling price, VAT treatment, minimum stock, reorder level/quantity, main supplier, status (Active / Inactive / Archived), notes, photos and documents (shared document store). Parts are archived, never deleted; a part with stock or reservations cannot be archived. SKU, part-number and barcode uniqueness is configurable per business (SKU and barcode on by default) and enforced under a business-wide advisory lock; identifier checks are case-insensitive. Cost and price changes keep an append-only history (who, when, why, source: manual, receipt, import, bulk).

Search is database-side and paged: name, SKU, part number, barcode, brand, manufacturer, supplier part number, category and compatible make/model; filters for status, category, supplier, location, stock level (in / low / out / reserved), available range, and "fits this vehicle". LIKE wildcards are matched literally.

**Compatibility** is plain structured data (make, model, years, variant, engine, size, fuel, transmission). A rule matches a vehicle when every attribute it names agrees; blank attributes do not restrict; an attribute the rule names but the vehicle lacks is not a match. It is a search aid, not a fitment guarantee.

**Barcodes**: a keyboard-wedge scanner works in any search box; the camera scanner uses the browser's `BarcodeDetector` where it exists (Team plan and above) and says plainly when it does not. No image leaves the device.

## Locations

Stock is held per (part, location). Everyone has the business's main location; further locations need the `multi_location` plan feature. A member's location access applies **everywhere**: stock counts, search, movements, dashboards, reports, purchase orders and transfers only ever include the locations they may use, so aggregates cannot leak another location's numbers.

**Transfers** (Draft → Requested → Approved → In transit → Received, plus Cancelled) use paired movements: shipping takes the stock off the source (needs access to the source and available stock); receiving puts it on the destination (needs access to the destination). In transit it is on neither shelf. Approval can be required by a setting.

## Job parts

A catalogue part on a job moves through Part 3's states with real stock behind them:

| State | Stock |
|---|---|
| Requested / Ordered | nothing held |
| Reserved | reserved ↑ (on hand unchanged) |
| Fitted | on hand ↓, reservation released (one movement) |
| Returned | unused reservation released, or a fitted part put back on the shelf |

Selling price is copied from the catalogue when the part is added; the **cost is copied when the part is used** (what it cost then). Neither changes when the catalogue changes. A fitted part can only be returned; if it is on a draft invoice the invoice must be fixed first; if it is on an issued invoice a credit note must exist and the person must acknowledge it, and the invoice is never rewritten. Invoices from jobs bill only fitted parts at the job's recorded prices. A job cannot be completed, and a quality check cannot pass, while parts are still reserved; cancelling a job releases its reservations. Quote and invoice lines may name a catalogue part (cost filled in from the catalogue even for people who cannot see costs); quotes and invoices do not themselves move stock.

## Purchasing

Purchase orders are a different domain from customer invoices (they share only part records). Statuses: Draft, Pending approval, Approved, Ordered, Partially received, Received, Cancelled (Pending approval and Approved are additions to the specification's list, needed for configurable approval). A database trigger enforces the allowed moves, freezes lines once an order is placed, and refuses `Received` while any quantity is outstanding and `Ordered` for an order that needs approval but has none. Numbers (`PO-000123`, with the location code when one is set) are issued inside the transaction and never reused.

**Receiving** is one immutable receipt: good units become stock (one RECEIVED movement at the price actually paid), damaged units are recorded and **never** become usable stock, wrong items are recorded and refused, and anything not delivered stays outstanding. Partial deliveries accumulate; stock is never duplicated. The part's cost follows the business's cost method (latest price or weighted average); each receipt line keeps the price paid for ever. A mistake is corrected with a **supplier return** (its own record, capped to what was received and not yet returned, taking stock out through a SUPPLIER_RETURN movement) or an adjustment. An order can be closed short once something has arrived.

PO PDFs are drawn from the stored order with the business's branding and the supplier's details (no customer information) and can be emailed to the supplier (PDF attached) — only when someone chooses to.

## Reports, valuation, exports, import

Dashboard, low stock (with suggested order quantities), usage, movement summary, valuation, margins (by part, job, customer, vehicle or invoice, from finalised invoices) and purchasing, all from real data and location-scoped. **Valuation is operational** (units on hand × the part's current cost); parts with no cost are counted and left out, and the screens say it is not an accounting stock valuation. Margin reports count lines with no recorded cost as zero cost and say how many. Exports (CSV or Excel; stock list, movements, low stock, purchase orders, supplier history, part usage, valuation, profitability) need `inventory.export`, omit cost columns for people who cannot see costs, defuse spreadsheet formulas, are capped at 20,000 rows and are audited.

**Import** (CSV or .xlsx, Business plan): choose file → match columns → validate → preview → confirm → process → report. The preview changes nothing; bad rows are listed and never imported silently (the person must choose to skip them); price changes to existing parts need their own confirmation; processing is in atomic batches of 100 rows and reports exactly what happened. **Bulk changes** (category, minimum stock, status, bin, price, cost) show a preview first and need a second confirmation for prices.

## Team

- **Employees are accounts with a business membership.** The directory (`/team`) shows role, status, locations, joined and last-active dates; the profile shows only what the business is entitled to see (no MFA, sign-in addresses or devices) plus a summary of what the role allows. Invitations, resend, cancel, role change (previous role, new role, who, when and an optional reason are audited), suspend, reactivate and remove already existed (Part 2) and are reused; expired invitations are marked and the sender told by the scheduler. Seat limits are enforced by the server; an over-limit business (after a downgrade) keeps everyone and is told, and cannot add or reactivate until within the limit.
- **Technicians** are designated on a profile (skills, services, billable and cost rates, active/inactive). Without a profile the Part 3 rule applies (a role with `job.edit`). Deactivation stops *new* assignments and bookings; nothing already assigned is moved, and the people who run the schedule are told what is affected.
- **Availability** reuses Part 3's schedule and leave tables (the booking calendar reads the same rows); this module reads them for capacity and performance and links to the existing editor.
- **Assignment** changes are recorded in an append-only history (who, what, by whom, when) and announced to the people concerned.
- **Labour rates**: technician rate > service-type rate > business default; the rate in force is **copied onto the labour line** when recorded, so changing a rate never rewrites earlier work or invoices. Internal cost rates are separate and never customer-visible.
- **Time**: a timer is a server row (start, no end), so refreshes, backgrounding and lost connections lose nothing; start/stop are idempotent; one running timer per person is enforced by an index; manual entries are refused if backwards, in the future, over 24 h, before the job existed, or overlapping other time. Entries are voided (never deleted), edits need `time.edit` and a reason and keep before/after, time posted to labour is locked, and time on an issued invoice needs a credit note. A person without `time.view_all` sees only their own.
- **Metrics** (jobs completed/open, bookings, booked/worked/billable hours, capacity and utilisation, average time to complete, parts fitted, labour recorded) describe workload from real records; revenue only for people who may see labour rates. They are not an assessment of a person.

## Permissions (new)

`inventory.manage_suppliers`, `inventory.view_costs`, `inventory.approve_purchase`, `inventory.transfer`, `inventory.import`, `inventory.export`, `inventory.manage_settings`, `inventory.negative_stock`; `employee.manage_technicians`, `employee.view_reports`; `labour.view_rates`, `labour.view_costs`, `labour.manage_rates`; `time.record`, `time.edit`, `time.view_all`, `time.approve`. Technicians get stock lookup and `time.record` and nothing financial; part costs, supplier costs, margins and labour costs need their own permission everywhere they could appear (lists, detail, exports, PDFs, job cards).

## Plans (central entitlements)

Solo: catalogue, suppliers, stock tracking, job parts, basic reports. Team adds `purchase_orders`, `barcode_workflows`, `technician_management` (and the existing multi-location). Business adds `bulk_inventory` and `inventory_reports` (valuation, margins, purchasing reports). Enforcement is on the endpoints and services (`requireFeature`), never only in the UI; the data model exists on every plan.

## Known limits (honest list)

- Quantities are whole units (a litre of oil is a "can"); fractional stock is not supported.
- Job parts move as whole lines (no partial fitting of one line: split it into two lines).
- A transfer is received in full; a discrepancy is corrected afterwards with an adjustment.
- Damaged/returned goods do not re-open the quantity on the purchase order beyond what "close short" already allows, and a supplier return does not create a supplier credit note (there is no payables ledger).
- The weighted-average cost is across all locations (a business-wide cost per part).
- Employee import (bulk invitations) is not built; people are invited one at a time through the existing secure invitation flow.
- A "technician schedule digest" notification is not built; assignment and low-stock/late-order notifications are.
- Part photos are stored and shown but not resized/thumbnailed.
- No automated browser tests: layouts were checked manually at 375 px and on desktop.

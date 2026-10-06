# Documents, photos and file management (Part 6)

TFME Auto has **one** document system. Customer, vehicle, job, quote, invoice, receipt, credit note, statement, supplier, purchase order, part, employee and business files all go through the same code, the same private store, the same checks and the same audit trail. Generated PDFs (invoices, quotes, receipts, credit notes, purchase orders, inspection reports, job summaries, statements) are files in that same store. There is no AI anywhere: every generated document is drawn from stored records and fixed labels.

## What a file is

A row in `files` (metadata) plus a private object in storage (the bytes). The row carries: business, storage key (server-made), original name and an optional display name, detected MIME type and extension, size, SHA-256, uploader, the record it is attached to (`resource_type` / `resource_id`), the customer and location that record belongs to (looked up server-side, never taken from the browser), description, category, visibility, version, status, source (upload or generated), scan status, a thumbnail key, and retention fields.

Large files never go into ordinary tables. Storage is the private driver from Part 1 (local for development, S3-compatible for production). Nothing has a public URL.

## Records a file can be attached to (`files/registry.ts`)

One table of rules decides, per kind of record: how to prove the record exists **in this business**, which customer and location it belongs to, which permission is needed to see its files, which permission is needed to attach to it, whether it may ever be shown to a customer, and its default category and visibility. Kinds: business, customer, vehicle, job, inspection, diagnosis, booking, quote, invoice, payment, receipt, credit note, statement, part, supplier, purchase order, goods receipt, supplier return, stock transfer, employee. A new module adds one entry.

The browser sends a record type and id; neither is believed until the registry has looked the record up inside the tenant. Another business's record is "not found".

## Upload pipeline (`files/service.ts` → `store.ts`)

1. Permission (`document.upload`, plus the record's own permission and `document.share` / `document.view_restricted` when asked for), writable subscription.
2. Size: platform cap (`MAX_UPLOAD_MB`), lowered further by the business's own setting. An oversize `Content-Length` is refused before the body is read.
3. Type from the **bytes**, not the filename or declared MIME (`files/sniff.ts`): JPG, PNG, WebP, GIF, HEIC, PDF, DOCX, XLSX, CSV, TXT. SVG, HTML, executables and archives are refused. A PDF named `.png` is stored as the PDF it is.
4. Images must actually decode (a picture that is only the right first bytes is refused).
5. Location access to the record is checked.
6. **Scanning** (`files/scan.ts`): always-on structural checks (antivirus test signature, PDFs that launch programs or run scripts, Office files with macros or hidden programs, unreadable Office archives, zip bombs). If `CLAMAV_HOST` is set, every upload is also streamed to ClamAV and the upload **fails closed** if the scanner is down. A file that passed only the structural checks is recorded as `NOT_SCANNED`, never as `CLEAN`.
7. Storage limit (`assertWithinLimit('storage')`): the plan's allowance, from the central entitlement data. Over the limit uploads are refused with the plan-limit error; nothing is ever deleted to make room.
8. The object is written **inside the database transaction**, so a storage failure rolls the row back and a failed commit removes the object. A row never exists without its object.
9. A thumbnail (360 px WebP, metadata and GPS stripped) is made for JPEG/PNG/WebP/GIF after the commit. HEIC is stored but has no thumbnail. A missing thumbnail is never an error.
10. Audit entry: who, what, which record, category, visibility, scan engine.

## Access: one set of rules for lists and single files (`files/access.ts`)

A person may open a file only if they hold `document.view` (+ `document.download` for the bytes), the permission for the record it is on (so no `customer.view` means no customer files), `document.view_restricted` if it is restricted, and they can use the location it belongs to. Employee documents need `document.manage_employee`; business documents need `document.manage` to upload. Lists, search and detail all apply the same filter, so the three can never disagree. A file the person may not see is "not found", the same answer as for a made-up id or another business's file.

## Visibility

`INTERNAL` (staff), `CUSTOMER` (may be shown to the customer through their private link), `RESTRICTED` (needs `document.view_restricted`). Visibility is explicit: nothing is shared by default and it is never inferred from the kind of record. Making something customer-visible needs `document.share`. Records that are internal by nature (supplier, part, purchase order, employee, diagnostic, payment, business) can **never** be customer-visible; this is enforced in the service and again by a database CHECK constraint, so even direct SQL cannot do it. Job photos carry their own visibility flag and the two are kept in step in both directions.

## Downloads

* Signed-in: `GET /api/v1/files/:id` (`?thumb=1`, `?download=1`). Audited (previews and downloads; thumbnails are not).
* Short-lived signed link: `POST /api/v1/files/:id/link` returns `/api/public/files/<token>` valid 5 minutes (15 at most). The token is an HMAC (`FILE_SIGNING_KEY`) over file id, business id, issuer and expiry. Each use re-checks that the file is still active and that the issuer is still an active member with `document.download`, so trashing the file or removing the person kills the link at once. Never a storage path.
* Customer: `/api/public/jobs/:token/files/:fileId` through a `JOB` link (below).
* Every response sets `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store` (thumbnails: private, 5 minutes) and a strict `Content-Security-Policy` (`sandbox` for everything except PDFs, which need their built-in viewer). Only safe types are shown inline; everything else downloads with a safe `Content-Disposition`.

## Customer-facing job page (`documents/customer.ts`, `/j/:token`)

A staff member with `document.share` creates a private link (120 days, only its hash is stored, same mechanism as quote and invoice links). The page shows the job's status, **customer-visible** notes, **customer-visible** photos, and customer-visible documents attached to the job or to its quotes and invoices. Everything is selected by explicit whitelist: internal notes and photos, restricted, archived, trashed, supplier, employee, diagnostic and cost information are never selected. Every file fetch re-checks visibility, status and that the file belongs to this link's job. Taking a file back from the customer (visibility to internal) removes it at once. An expired, revoked, malformed or unknown link gives the same "not available" answer.

## Lifecycle: Active → Archived → Trash → Permanently deleted (`files/lifecycle.ts`)

* **Archive** hides from everyday lists; still readable; restorable. (`document.delete`)
* **Trash** is the "delete" button; restorable; counts toward storage until deleted.
* **Permanent delete** needs `document.purge`, the file must already be in the trash, the object is removed and the row stays as a record that it existed. A scheduled cleanup (hourly) removes files that have been in the trash longer than the business's retention period (default 30 days), audited, never touching active or archived files.
* **Financial documents** (generated quotes, invoices, receipts, credit notes, statements) are flagged `is_financial` with `retain_until` (default 5 years, configurable, can be lengthened but never shortened). A database trigger refuses to move them to the trash, to delete them before `retain_until`, to delete the row, or to change the stored bytes. They can be archived.
* Stored objects are immutable: a trigger refuses to change `storage_key`, `sha256`, `size_bytes`, `mime_type`, `version` or `source`.
* An orphan sweep (daily) removes stored objects with **no record at all** (left if a server died mid-upload): only under the business's own prefix, only older than 3 days, never anything referenced by a file, thumbnail or data export, at most 200 per business per run, audited. `reconcileStorage` checks the other direction (records whose object is missing).

## Versions

Uploading a replacement (`POST /files/:id/versions`) keeps the old file as an earlier version in a version group; exactly one is current (unique partial index). Generated documents are versioned the same way: see below. A generated financial document cannot be replaced by an upload.

## Generated documents (`documents/generator.ts`, `report-pdf.ts`, `renderers.ts`)

`DocumentGenerator` with one renderer per kind: quote, invoice, receipt, credit note, purchase order, inspection report, job summary (statements are stored by `storeStatementPdf`). Each is a pure function of stored records.

* **Stored once, served from the store.** Asking for a document returns the stored copy; nothing is silently regenerated, so an old quote or receipt never picks up today's business details. Quotes are stored per quote version; receipts and credit notes once; purchase orders when the order is placed.
* **Events create versions**: an invoice is stored when issued; a payment and a credit note each add a new version of the invoice (earlier versions kept untouched) and make the receipt / credit-note document. Invoices are also rendered live from their frozen issue-time snapshots by the existing `/pdf` endpoint, so what a customer downloads always shows the current payment state.
* **People** can ask for a *new* version only with `document.manage` (financial) or `document.upload` (job documents) and a written reason, which goes into the audit trail.
* **Customer safe by construction.** The inspection report and job summary are built from whitelisted fields: customer notes and summaries, customer-visible photos, recorded work and fitted parts **without** prices, costs or rates. Internal notes, fault-code analysis and internal photos are never read into them. By default they are filed `INTERNAL`; sharing is a separate, deliberate step.
* **Failure is safe.** The file row exists only once the object is really stored. A failed generation never creates a corrupt reference; the failure is audited; the job queue retries (4 attempts) and records each attempt in `document_generations`; a requester is notified when it is ready; someone with `document.manage` can retry a failed one from Settings → Documents. A failed PDF never undoes the invoice or payment that caused it: the work is queued and the PDF can always be rendered again.

## Search (`files/search.ts`)

Database queries, no semantic search. Matches filename, display name, description, category; customer name, email, number and phone digits; vehicle registration and VIN (also on that vehicle's jobs); job, quote, invoice, receipt, payment, credit note and purchase order numbers; supplier, part and employee names; uploader. Filters: state, file type, category, visibility, record, uploader, location, dates, size, source. Paginated (max 100), sortable. `LIKE` wildcards in the search box match literally. Trigram index on file names, composite indexes on business + resource / category / customer / uploader / status.

## Storage usage (`files/usage.ts`)

Computed from the file records on request (never from a counter): used, limit, percent, file count, trash, by category, by record type, largest files. States in words (ok / near / full / over). Trash counts until deleted. A downgrade that leaves a business over its new limit keeps every file and only blocks new uploads.

## Settings and plan entitlements

Settings → Documents: usage, trash retention, financial retention, upload limit, custom categories (Team plan and above, `advanced_documents`), failed generations. Limits come from the central plan data; none are hard-coded in the UI.

## Permissions added

`document.download`, `document.share`, `document.view_restricted`, `document.manage`, `document.manage_employee`, `document.purge` (plus the existing view / upload / edit / delete / export). Existing roles that could view documents keep being able to open them (migration 0011). Managers get everything except purge and employee documents; admins and owners get everything.

## Known limits (honest list)

* Thumbnails are not made for HEIC (stored fine; shown as a file icon).
* Malware scanning beyond the structural checks needs a ClamAV daemon; none is bundled. Without one, files are recorded `NOT_SCANNED`.
* Thumbnails are derived objects and are not counted in storage usage.
* A PDF is not previewed inside the page (the app's security headers forbid framing); it opens in the browser's own viewer in a new tab.
* The customer job page is read-only: customers cannot upload to it.
* Generated PDFs use the standard Latin-1 fonts (as in Part 4); characters outside Latin-1 print as `?`.

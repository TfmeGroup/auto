# Architecture

## Layers

```
src/app/            Presentation: pages (server components), API route handlers (thin)
src/components/     UI building blocks, layout shell, forms
src/server/         Application logic — the only place business rules live
  http/             route() wrapper: auth, permission, CSRF, rate limit, errors, response shape
  auth/ tenancy/    sessions, passwords, "who is this and which business are they in"
  permissions/      catalog + role definitions + can()/requirePermission()
  <module>/         service.ts per domain (customers, memberships, files, billing, ...)
  db/               Prisma client, tenant-scoped transactions
  jobs/ notifications/ storage/ billing/   infrastructure behind small interfaces
src/lib/            Pure helpers: money, validation, env, errors, formatting
prisma/             schema + SQL migrations (incl. RLS, triggers, grants)
tests/              Vitest against a real PostgreSQL
```

Route handlers contain no business logic: parse → call a service → return. Services take a
`BusinessContext` (who, which business, which permissions), check a permission, validate input with
Zod, run a tenant transaction, write an audit event, return data. The frontend never decides anything
that matters; it is a client of the same API anyone else could call.

## Accounts, businesses, membership

A **User** is a person. A **Business** is a workspace. **Membership** links them with a **Role** and a
status (`INVITED → ACTIVE ⇄ SUSPENDED → ARCHIVED`). A person can belong to several businesses. The
current business lives in the *server-side session* and is re-validated against an ACTIVE membership
on every request; the client never names a business. Leaving a business only ends access — records the
person created keep pointing at them.

## Roles and permissions

`permissions/catalog.ts` lists every permission. Roles are named sets of permissions stored in the
database (`roles`, `role_permissions`); code only ever asks `can(ctx, 'customer.create')`, never
"is this a manager". Custom roles are therefore a data feature, not a refactor. Guards:
nobody can grant or manage permissions they don't hold; a business always keeps ≥1 Owner (row-locked
check, tested under concurrency). System roles are written only by the migration role.

## Tenant isolation — two independent layers

1. **Application**: every query filters `businessId`, taken from the authenticated context.
2. **Database**: Postgres row-level security on every tenant table. The app connects as `tfme_app`
   (not a superuser, no `BYPASSRLS`) and each request runs in `withTenant(businessId, tx => …)`, which
   sets `app.business_id` for that transaction only. Forget the `WHERE` or the wrapper and you get
   *zero rows*, not someone else's data. `tests/db/rls.test.ts` includes a guard that fails if a new
   table with a `business_id` column ships without RLS.

Control-plane tables (users, sessions, memberships, businesses, subscriptions, jobs, roles) are not
under RLS because they are read before a tenant is known; they are guarded by service code, composite
constraints and DB triggers (e.g. a membership cannot use another business's role or location).

Cross-tenant access returns **404, not 403**, so IDs from other businesses are indistinguishable from
non-existent ones. Missing *permission* in your own business returns 403.

## Accounts, MFA and sessions (Part 2)

A personal **account** needs no business: profile, photo, notification preferences, password, verified email
change, MFA, device/session management and deactivation all work with none (route group `(account)`). Two-factor
auth is TOTP on Node's crypto; with MFA on, a correct password yields only a short-lived single-use *challenge*, and
a session exists only after the second factor passes. Sensitive actions (ownership transfer, closing a business,
deactivating an account) re-ask for the password and a fresh code.

## Entitlements, usage and the subscription state machine (Part 2)

Plans, limits and feature entitlements are database rows. `route({ feature })` and `requireFeature()` enforce them
per request from the live subscription; `usage/service.ts` is the one place that measures consumption. The
subscription's current status is *derived from dates* by a pure function (`billing/state-machine.ts`), so access
never depends on a cron job; a scheduler (run by the worker) keeps stored state, audit and emails in step. See
docs/BILLING.md.

## Platform administration is separate

`platform_admins` (owner-managed, MFA-required) gate `/api/platform/*`. No business role or permission reaches them,
and being a platform admin grants no access to any business's data.

## Audit

`recordAudit(tx, meta, event)` runs inside the same transaction as the change (all-or-nothing).
`audit_logs` is append-only for real: the app role has only SELECT/INSERT, a trigger rejects
UPDATE/DELETE/TRUNCATE even for the owner, and there is no write API. Secrets are stripped from
before/after snapshots.

## Money

Integer cents, quantities in thousandths, rates in basis points, `BigInt` intermediates, one
documented rounding rule (half away from zero). `lib/money.ts` is the only arithmetic allowed on
amounts. VAT rate is a per-business setting.

## Search

Server-side only. Each module registers a `SearchProvider` (with the permission it requires) in
`search/registry.ts`; the service runs them inside the caller's tenant transaction, so results are
permission-filtered and tenant-isolated by construction. Postgres trigram (GIN) indexes serve
`ILIKE '%q%'`; phone numbers match on digits only.

## Workshop operations (Part 3)

Customers, vehicles, bookings, job cards, inspection, diagnosis and recommended work live in `src/server/{customers,vehicles,bookings,jobcards,workshop,activity}`
and follow the module pattern. Money (quotes, invoices, payments, credit) is documented in [FINANCE.md](FINANCE.md): pure calculation core (`server/finance/calc.ts`), one settlement path for every payment, database-enforced integrity, and a separate customer-payment provider boundary. See [WORKSHOP.md](WORKSHOP.md) for the data model, availability rules, the job workflow, the internal/customer
visibility model and the vehicle health indicator. Business-local time (opening hours, "today", calendar days) is converted in one place, `lib/tz.ts`.

## Inventory and team (Part 5)

`src/server/inventory` (parts, categories, suppliers, the stock ledger, job parts, purchasing, receiving, transfers, reports, import/export, alerts) and `src/server/team` (directory, technicians, labour rates, time, performance, assignment history) follow the module pattern. The stock model is transactional: `stock_movements` is an immutable ledger and a database trigger applies each movement to `stock_levels` under a row lock, so quantities cannot be edited directly or drift from their history. Purchase-order and transfer status changes are enforced by triggers too. Location access is applied by every reader. See [INVENTORY.md](INVENTORY.md).

## Files, documents and notifications (Part 6)

One document system (`src/server/files`, `src/server/documents`): a `StorageDriver` (local for development and tests, S3-compatible for production) holds the private bytes; the `files` table holds the metadata, visibility, version and retention. Keys are server-generated (`<businessId>/<year>/<uuid>`), never user input. Uploads are validated by **content** (magic bytes, decodable images, a pluggable scanner that fails closed), not filename or declared type; every kind of record that can have files is described once in `files/registry.ts`; one access rule serves lists, search and single files; downloads are authorised endpoints or short-lived HMAC-signed links with `nosniff`, a sandbox CSP and `no-store`. Files go Active → Archived → Trash → Permanently deleted, with financial documents retention-locked by database triggers. Generated PDFs (a renderer per kind, pure functions of stored records) are stored through the same pipeline, versioned, and made by events or on request, with failures queued, retried and audited. See [DOCUMENTS.md](DOCUMENTS.md).

One notification service (`src/server/notifications`): an event registry, safe templates, provider interfaces for email, SMS and WhatsApp, a communication history, a delivery job on the existing queue with retries, idempotency and forward-only delivery states, customer preferences and consent, deterministic reminders, and the in-app centre. See [NOTIFICATIONS.md](NOTIFICATIONS.md).

## Background jobs

A PostgreSQL-backed queue (`jobs`): `FOR UPDATE SKIP LOCKED` claiming, exponential backoff, dead-letter
state, stale-lock recovery, dedupe keys. Jobs are enqueued inside the business transaction (outbox
pattern) so a rolled-back change never sends an email. Run `npm run worker` as its own process in
production.

## Billing

`PaymentProvider` interface; PayFast implemented (signed checkout form, ITN verification). A
subscription becomes ACTIVE **only** via a verified provider webhook matched to a payment record the
server created, with the amount checked against what was requested. Webhooks are stored under a
unique `(provider, externalId)`, processed under a row lock, and idempotent. Plan limits (seats,
locations, storage) and read-only mode for expired subscriptions are enforced server-side from dates,
with no cron dependency.

## Errors and responses

`{ data, meta? }` on success; `{ error: { code, message, details?, requestId } }` on failure. Unknown
errors are logged with full detail server-side and returned as a generic 500 with the request id.

## Reports, settings and administration (Part 7)

* **Reports** (`src/server/reports`): one `ReportDef` per report, run by `run.ts` inside a tenant transaction; columns and metrics the caller may not see are stripped *after* the query, so a report cannot leak cost data. Dates resolve in the business time zone. Custom reports are a configuration compiled against an approved schema (`custom/`), never SQL. Saved reports share the recipe, not the data. Schedules are claimed idempotently by the scheduler and delivered per recipient with that person's permissions through the shared message service. See [REPORTS.md](REPORTS.md).
* **Settings** (`src/server/settings`): one `business_config` row per business plus the existing settings tables. Each setting is read by the workflow it changes (numbering, labour, jobs, vehicles, bookings, stock, sessions, retention); every change is audited with before/after. See [SETTINGS.md](SETTINGS.md).
* **Administration** (`src/server/admin`, `src/server/imports`): alerts, setup check, audit and security-event views, archive, search, and staged, validated imports. See [ADMINISTRATION.md](ADMINISTRATION.md).

## Entitlements, integrity and verification (Part 8)

* **Entitlements** are read in one place (`billing/entitlements.ts`): plan, status, limits, live usage, anything over its limits and ready answers such as `can.inviteMember`. Services still enforce; nothing outside `billing/` compares a plan name. A downgrade never deletes data: it restricts new use and shows the business as over its plan.
* **Referential integrity is tenant-scoped in the database.** Every reference between two tenant tables is a composite `(id, business_id)` foreign key, with three reviewed exceptions (a membership's role, which may be a shared system role; and the billing records, which webhooks write with no tenant context). A test audits this structurally and audits the data of every business after the rest of the suite.
* **Client and server code are kept apart.** A server component may only render what a `"use client"` module exports, never call it; shared helpers live in modules without the directive. A static test enforces it, because the failure only appears when a page renders.
* **Readiness** (`/api/health/ready`) checks the database and object storage independently and reports queue health; liveness (`/api/health`) checks nothing external.
* **The API reference** (`docs/API.md`) is generated from the `route({...})` declarations, so it states the protection the code applies.

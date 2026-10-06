# Adding a module (vehicles, jobs, invoices, …)

`src/server/customers/` is the reference. Follow it step by step; the guard tests will catch most
omissions.

1. **Schema** — add the model to `prisma/schema.prisma` with `businessId`, `@@unique([id, businessId])`,
   timestamps, `RecordStatus` for archive-not-delete, and `@@map` snake_case names. Money as integer
   cents. References to other tenant records should use a **composite foreign key**
   `(other_id, business_id)` so cross-tenant links are impossible at the database level.
2. **Migration** — `npx prisma migrate dev --create-only`, then in the SQL: enable **and force RLS**
   with the standard `tenant_isolation` policy, add trigram indexes for searchable text, add CHECK
   constraints. `tests/db/rls.test.ts › every table with a business_id column has RLS…` fails the build
   if you forget RLS. The default privileges already grant `tfme_app` DML on new tables.
3. **Permissions** — add keys to `permissions/catalog.ts` (many already exist) and decide which system
   roles get them. `npm run db:migrate` syncs them.
4. **Service** — `src/server/<module>/service.ts`:
   `requirePermission` → `parseOrThrow(zodSchema, input)` → `withTenant(ctx.business.id, tx => …)` →
   queries filter `businessId` → `recordAudit(tx, …)` in the same transaction. Use `nextNumber()` for
   human numbers (JOB-0001), `lib/money.ts` for every calculation, `assertWithinLimit()` if the plan
   caps it, `assertCanWrite()` (or `write: true` on the route) so expired subscriptions are read-only.
5. **API** — thin `src/app/api/v1/<module>/route.ts` using `route({ access: 'business', permission,
   write? }, …)`. Lists take `paginationSchema` and a **whitelisted** sort.
6. **Search** — implement a `SearchProvider` and add it to `search/registry.ts`.
7. **Plan gating and limits** — if the module is a plan feature, add a key to `billing/features.ts`, include it in
   the right plans, and put `feature: '<key>'` on the route (and `requireFeature` in the service). If it is metered
   (users, locations, storage, …) add it to `usage/service.ts` so billing screens and limits stay in agreement.
   Register an **export dataset** in `exports/registry.ts` so it is included in business data exports with its own
   permission.
8. **Files** — to allow attachments, add an entry to `RESOURCES` in `files/registry.ts` (how to prove the record is in this business, its customer and location, the permission to see its files, whether a customer may ever see them). Customer/supplier messages go through `sendCustomerMessage()` with an event from `notifications/events.ts`; in-app notices through `notifyInternal()`; stored PDFs through the generator in `documents/generator.ts`.
9. **UI** — pages under `src/app/(app)/<module>/`; add the nav entry in `components/layout/nav-config.ts`
   (and Quick Create). Phones get cards, tablets+ get tables; touch targets ≥ 44 px.
10. **Tests** — copy the pattern: permission matrix, **cross-tenant attempt returns 404 and leaves the
   record untouched**, validation, audit trail, pagination, concurrency where numbering/stock is involved.

## Pitfalls learned the hard way

* **Zod 4 keeps `.default()` values under `.partial()`.** An update schema built as `createSchema.partial()` silently resets every
  defaulted field (a status change reset a part's quantity; a profile edit would have switched VAT registration off). Declare the
  shape once WITHOUT defaults, add defaults only for the create schema, and build the update schema from the plain shape.
* **Never run overlapping queries on one transaction.** Inside `withTenant()` every query shares one connection; use `seq([...])`
  from `db/client.ts` instead of `Promise.all` (the pg driver deprecates overlapping queries). Prisma queries are lazy, so passing
  them to `seq` does not start them early; do not pass already-started async functions.
* **No `BEGIN`/`COMMIT` inside a migration file.** Prisma runs the file as one batch; an explicit COMMIT mid-file commits what came
  before and leaves the migration half-applied if a later statement fails. Use `ALTER TYPE … RENAME VALUE` rather than the
  generated enum-swap block, and test a migration against a database that already holds rows (backfills, NOT NULL columns).
* History that must not change (mileage, booking history, quality checks, the activity feed) is **append-only at the database**
  (`forbid_change()` trigger); corrections are new rows.
* Timeline events are written by the service that made the change, in the same transaction (`activity/service.ts`), never derived later.

Never: read a business id from the request, compute money with floats, hard-delete business records,
add a route outside `route()`, or skip the audit event.

## Adding a report or setting (Part 7)

* **Report:** add a `ReportDef` under `src/server/reports/defs/`, register it in `registry.ts`, declare permissions, plan feature and a `needs` on every cost or valuation column, and add a known-scenario test plus a permission test.
* **Custom-report field:** add it to `custom/schema.ts` with its `needs`; never expose contact details, credentials or private employee data.
* **Setting:** it must change behaviour. Add the column or `business_config` field, validate it on the server, read it in the workflow, audit the change, and test the effect (see `tests/settings/workflows.test.ts`).
* New routes under reports, settings, admin or imports are checked by `tests/security/part7-security.test.ts`.

## Rules added by the full-system verification (Part 8)

* **Server pages never call client-module exports.** A helper a server page needs (formatting, options, row mapping) lives in a module *without* `"use client"`; the client form imports it from there. `tests/unit/rsc-boundary.test.ts` fails if a server file uses a client module's export as a value. The failure otherwise appears only when the page renders.
* **Tenant references are composite.** A foreign key from one tenant table to another includes `business_id`; the integrity audit (`tests/e2e/zz-data-integrity.test.ts`) fails on one that does not.
* **Declare the route's protection in `route({...})`** (access, permission, plan feature, `write: true` for changes). Run `npm run docs:api`; `tests/unit/api-docs.test.ts` fails if the reference is stale, or if a new "any member" or ungated-write endpoint appears without being reviewed into that test.
* **Index what you look up.** A new foreign key needs a covering index (a ratchet test counts the exceptions).
* **No unused code.** `noUnusedLocals` and lint (zero warnings) are CI gates.
* **Order-independent tests.** The suite shares one database: scope every query to your own business. Files run in a fixed order and `zz-*` files run last.

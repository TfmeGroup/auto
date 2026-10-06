# Production readiness (Part 8)

**Assessment: READY WITH DEPLOYMENT VERIFICATION REQUIRED.**

The application builds, passes its full automated suite, type-checks and lints clean, and was exercised in a real browser at phone width. Everything that depends on the real world (a live payment provider, SMS/WhatsApp, a virus scanner, S3, real e-mail delivery, backups on real infrastructure, TLS and a reverse proxy, real devices) has **not** been run and is listed in [Not tested](#not-tested--requires-the-deployment-environment). Do not read this document as a statement that those work.

Everything below is a statement about what was run in the build environment, not a guarantee.

## How to verify it yourself

```bash
npm ci
npm run lint        # ESLint, zero warnings allowed
npm run typecheck   # strict TypeScript for the app AND the tests, no unused locals
npm test            # the whole suite against a real PostgreSQL started by the test harness
npm run build       # production build
npm run audit       # dependency audit gate (high/critical, documented exceptions)
npm run docs:api    # regenerate docs/API.md (a test fails if it is out of date)
```

`.github/workflows/ci.yml` runs lint, typecheck, tests, the build and the audit on every push and pull request. It does not deploy anything.

## What was run, and the result

| Check | Result |
| --- | --- |
| Automated tests | **74 files, 1,191 tests, all passing** (about 5.5 minutes), in a fixed order so the whole-database audit always runs last |
| Lint | clean, zero warnings |
| Type check | clean (app and tests; `noUnusedLocals` is now enforced) |
| Production build | succeeds |
| Production server boot | booted the built server with a valid production configuration; liveness 200; readiness 503 (with no internal detail) when the database was unreachable; login page 200; unauthenticated pages redirect; unauthenticated API answers 401; full security-header set present; no framework banner; no secrets in the log |
| Dependency audit | passes; four accepted *high* advisories, all in the Prisma CLI toolchain (see [Dependencies](#dependencies)) |
| Fresh database | all 15 migrations applied from nothing, both by the test harness and by a separate throwaway development database |
| Upgrade path | the newest migration was re-applied over a database already holding data (test) |
| Browser, phone width (375 x 812) | 119 authenticated routes returned 200 with no server-side render errors; ~70 screens measured: **no page-level horizontal overflow, no error pages** |

### What the automated suite covers

Parts 1-7 each have their own suites (tenant isolation, row-level security, permissions, billing state machine and webhooks, workshop workflow, finance maths, inventory ledger, documents, notifications, reports, settings, imports). Part 8 added:

* **Subscription tiers** (`tests/billing/tier-matrix.test.ts`): for Solo, Team, Business and Custom, the exact feature set and limits; a restricted call is a 402 and an entitled one is not; the user limit is enforced by the server; behaviour in every subscription state (active, past due, grace, cancelled, suspended, expired) including that reads always work and nothing is deleted; an expired trial is read-only and upgrading restores it; Business to Solo keeps all data, reports "over plan" and refuses new records; custom plans use contract limits.
* **Subscription security** (`tests/security/part8-subscription-security.test.ts`): forged plan/status/trial/limit/provider fields on business, location, member and checkout requests change nothing; checkout trusts only the plan key and grants nothing; a webhook for another business, a wrong amount or an unknown reference changes nothing and a genuine one applies once even when delivered twice; only billing, closure and platform code may write a subscription (static check); workshop-customer money and TFME subscription money are separate (no shared records, no cross foreign keys).
* **Two complete end-to-end scenarios on real records** (`tests/e2e/`): registration to payment and receipt (account, verification, business, trial, configuration, customer, vehicle, booking, check-in, inspection, diagnosis, recommended work, quote, customer approval over the public link, parts, labour, QC, completion, invoice, payment, receipt, reports, audit trail, notifications, documents), and the failure path (declined quote, revised quote, obsolete-version approval refused, part not in stock, awaiting parts, partial delivery, work resumes, invoice, part payment, overdue, final payment).
* **Cross-tenant sweep** (`tests/security/part8-tenant-sweep.test.ts`): every API route that takes an ID is called with another business's real IDs (customer, vehicle, booking, job, quote, invoice, payment, receipt, part, supplier, purchase order, location, member, file, saved report, role): refusals only, no data or ID echoed, no 500, and a fingerprint of the first business's tables is unchanged. Empty-bodied writes mostly stop at validation, so the per-module suites (which send real bodies) remain the evidence for write isolation.
* **Whole-database integrity audit** (`tests/e2e/zz-data-integrity.test.ts`): after every other test, reads every tenant's rows as the database owner and checks: composite foreign keys between tenant tables, row-level security enabled and forced, one owner per business, invoice balances and totals, paid amount against payments less refunds, payments split and receipted, no duplicate invoices/payments/quote conversions, no negative customer credit, stock level equals the sum of its ledger, nothing negative without the permitted route, no phantom reservations, workflow and ownership relationships, files belong to the business of their record.
* **Production configuration** (`tests/security/part8-production-config.test.ts`): security headers, cookie flags, log redaction, liveness/readiness (including storage down), no debug/test routes, no hard-coded credentials, production refuses memory/console drivers and sandbox payments, every environment variable documented.
* **Database** (`tests/db/migrations.test.ts`): sequential migrations, all applied, no destructive statements, all constraints and indexes valid, every foreign key indexed (ratchet), the newest migration over live data.
* **Large data** (`tests/perf/large-data.test.ts`): see [Performance](#performance).
* **Scheduled work** (`tests/jobs/scheduler-idempotency.test.ts`): a second tick, and two simultaneous ticks, send and record nothing the first did.
* **Static guards**: server components may not use anything exported by a client module (`tests/unit/rsc-boundary.test.ts`), the API reference matches the code and the "any member" and "not write-gated" endpoint lists are exactly the reviewed ones (`tests/unit/api-docs.test.ts`).

## Defects found and fixed in this part

Real defects, found by running things rather than by reading:

1. **Four pages crashed when rendered**: the Parts list, New purchase order, Edit purchase order, and Edit quote / Edit invoice. Each server page called a helper exported from a `"use client"` module, which Next refuses at render time. The build and the unit tests could not see it. Fixed by moving the helpers to server-safe modules; a static test now fails if it recurs. (Found by loading the pages in a browser, then by the new guard.)
2. **Declined, revised, approved quote left the work declined.** Declining a quote marked its recommended work declined; approving the revised quote only re-approved work still pending, so the job could never be approved. An explicit approval now supersedes the earlier decline of that same work, recorded in the decision note and the audit entry. (Found by the failure-path scenario.)
3. **Team plan included multi-location**; the specification puts it in Business. Aligned (Team is single-location).
4. **Two references between tenant tables did not carry the business**, so only application code stopped them pointing into another business (reminder log to service interval, technician service types to technician profile). Now composite foreign keys (migration 0015).
5. **Missing indexes** on `location_id` for the location-scoped lists and on payment/receipt/refund links (migration 0015).
6. **Readiness did not check storage**, and a database failure hid the storage state. Both are now checked independently.
7. **`npm run typecheck` (what CI runs) failed on the test project**, from Part 7 tests that had only been checked against the app project. Fixed; CI now also lints.
8. **Dead code**: 35 unused locals and imports, an unused `import.process` job type, a `db:seed` script pointing at a file that does not exist. Removed; `noUnusedLocals` is enforced.
9. **No skip-to-content link** for keyboard and screen-reader users. Added.
10. An older payments test queried the receipts table globally and broke as other tests added rows; scoped to its own business.

## Subscription tiers and entitlements

| Tier | Users | Locations | Notes |
| --- | --- | --- | --- |
| Solo | 1 | 1 | the whole core workshop |
| Team | up to 10 | 1 | adds technicians and time, advanced stock, purchase orders, online payments, financial and advanced reports, communication history, templates, service reminders, SMS |
| Business | up to 35 | up to 10 | adds multi-location and transfers, custom roles, custom and scheduled reports, bulk and inventory reports, WhatsApp, advanced administration and imports |
| Custom | 36+ | by contract | everything in Business, limits by contract; **an entitlement and limits foundation only**: no bespoke integration or workflow exists and none is claimed |

All of it is data (`plans`, `plan_features`), read by one place (`billing/entitlements.ts`, `GET /api/v1/billing/entitlements`) and enforced by the services (`requireFeature`, `assertWithinLimit`, `assertCanWrite`). No plan name is compared outside `billing/`. Prices are intentionally unset (the specification leaves them open), so no plan can be bought online until a price is set. The 14-day trial belongs to the business, is decided from stored dates on the server, and its reminders and expiry are guarded so they happen once.

**Decision (confirmed):** Team has granular permissions through the predefined roles; creating and editing custom roles is Business-only (`tests/billing/team-permissions.test.ts`).

## Security

**Performed (automated, in this environment):** authentication, MFA and session behaviour (Part 2 suites); permission matrix per role and direct-API attempts; tenant isolation by service, API, database row-level security and the new ID sweep; location isolation; customer/internal data boundary through the public pages and endpoints; financial and cost permissions; file upload validation, signed-link expiry, private storage; webhook signature, amount, replay and concurrency handling; CSRF; rate limits on authentication, public links, payments, uploads, exports, imports and messaging; SQL-injection and permission-bypass attempts on the custom report builder; secrets never in responses, audit entries or logs; production configuration refusal; static scans for hard-coded secrets, debug routes and development bypasses; dependency audit.

**Not performed:** a professional external penetration test, dynamic scanning (DAST) of a running deployment, a threat-model review by a third party, load or denial-of-service testing, and any testing of the real TLS and proxy path. None of that is claimed.

Known limits are listed in [SECURITY.md](SECURITY.md). Notable: the content security policy still allows inline scripts (a per-request nonce is a documented hardening step); there is no automated malware scanning without a ClamAV service; passkeys and session geolocation are not built.

## Performance

Measured through the real services on a real PostgreSQL, on one tenant holding **10,000 customers and vehicles, 5,000 jobs, 5,000 invoices (each with lines, payment and receipt), 5,000 parts**, plus thousands of documents, messages and notifications. The data is bulk-cloned from real, valid records so every constraint applies. Warm timings, milliseconds, on a development machine:

| Operation | ms | Operation | ms |
| --- | --- | --- | --- |
| Customers page 1 | 6 | Invoices page 1 | 11 |
| Customers search (name) | 12 | Invoices search (number) | 33 |
| Customers search (phone digits) | 12 | Payments / receipts page 1 | 8 / 5 |
| Customers deep page | 8 | Parts page 1 / search | 8 / 34 |
| Vehicles page 1 / search | 10 / 13 | Documents / messages / notifications page 1 | 5 / 15 / 2 |
| Jobs page 1 / search | 6 / 27 | Global search | 91 |
| Dashboard | 46 | Reports: revenue, invoices, receivables, payments | 11, 12, 6, 10 |
| Reports: jobs, customers, stock | 47, 114, 13 | | |

Every list is paginated and capped (an absurd page size is capped, never "everything"), and **no list issues more SQL statements for a bigger page** (5 to 9 statements whether it returns 5 or 50 rows), so there is no N+1. Every searched column has a valid trigram index. Reports are computed live with a 25 s statement timeout and a 50,000-row export cap; nothing is cached, by design. These numbers are from one machine and one data shape; they show the design is sound, not what production latency will be.

## Mobile and responsive

Checked in the built-in browser at 375 x 812 (a phone), signed in as a business owner and as a technician, and on the customer pages. Covered: authentication, dashboard, customers, vehicles, bookings, job cards (every tab), quotes, invoices, payments, credit notes, finance, stock, parts, suppliers, purchase orders, movements, scanning, transfers, stock reports, employees, time, workload, documents, notifications, messages, reports (including builder, saved, schedules), administration (all screens), audit, and every settings page.

* No page-level horizontal overflow and no error page on any of them; data tables become cards.
* **Technician flow:** sign in, My jobs (one tap each to open, inspect, parts, photos), job card tabs for inspection, diagnosis, work, parts and labour, photos, documents, notes and timeline, start inspection. No prices or costs are shown to the technician.
* **Customer flow:** the quote page (clean, full-width actions) was approved through the page itself; the invoice page shows no internal data and, correctly, no Pay button because no online payment provider is configured here.
* The service-advisor and customer-booking flows were covered by the end-to-end tests and by page checks, **not** walked screen by screen on a phone.

**Not done:** real iPhone/Android devices, other browsers, tablet and desktop breakpoints with the same measurements, and automated browser (Playwright) tests in CI.

## Accessibility

Automated checks on 24 key screens (including the customer pages): document language set, exactly one `h1` and one `main`, every form control labelled, every button and link named, no image without alternative text. Focus is visible everywhere (`:focus-visible`), status badges carry text (not colour alone), and a skip-to-content link was added. **Not done:** a screen-reader pass, a full keyboard-only walkthrough of every flow, colour-contrast measurement, zoom/reflow testing, or any WCAG conformance claim.

## Production configuration

Configuration is entirely environment-based; [`.env.example`](../.env.example) lists every variable (a test fails if one is missing) and production refuses to start on an unsafe configuration (non-HTTPS URL, missing keys, console/memory drivers, sandbox payments).

Deploying, in order:

1. **Database:** a managed PostgreSQL with TLS, automated backups and point-in-time recovery. Two roles: the owner (`MIGRATE_DATABASE_URL`, used only by the migrate step) and the restricted `tfme_app` (`DATABASE_URL`, used by the web and worker processes; row-level security is forced on every tenant table). Tenant context is set per transaction (`set_config(..., true)`) and discarded at commit, so it never depends on session state that a pool could carry between requests. Behaviour behind an external pooler such as PgBouncer was **not** tested; verify it in staging (the application uses the `pg` driver through Prisma's pg adapter).
2. **Migrate:** `npm run db:migrate` with the owner URL (applies migrations and syncs plans and permissions).
3. **Web:** `next start` (or the standalone build) behind a TLS-terminating proxy; set `TRUST_PROXY=true` only behind a proxy you control.
4. **Worker:** `npm run worker`, at least one (jobs, e-mail, the scheduler); any number are safe.
5. **Storage:** `STORAGE_DRIVER=s3` with a private bucket (versioning and lifecycle rules on the bucket are infrastructure, not code).
6. **E-mail:** SMTP with a verified sender domain (SPF/DKIM/DMARC) and `EMAIL_FROM`.
7. **Payments:** PayFast production credentials, `PAYFAST_SANDBOX=false`, notify URL `https://<host>/api/webhooks/payfast`; per-business customer payment providers are configured in the app and their webhooks are `/api/webhooks/payments/<provider>/<businessId>`.
8. **Monitoring:** probe `/api/health` (liveness) and `/api/health/ready` (database, storage, queue depth, dead jobs; provider flags carry no credentials). Alert on 5xx rate, readiness failing, dead jobs, failed webhooks.
9. **Headers and cookies:** already set by the application (HSTS, CSP, framing, referrer, permissions; session cookie `HttpOnly`, `SameSite=Lax`, `Secure` in production). Re-check them through your proxy and CDN.

## Observability and logging

Structured JSON logs (pino) with a request id on every response and in the logs; secrets and credentials are redacted by path (tested); the audit log is separate, append-only and tenant-isolated. **There is no error-monitoring service wired in** (for example Sentry): errors are in the logs only. **Log retention is an infrastructure decision**: the application does not rotate or expire application logs.

## Backups and recovery

`scripts/backup.sh` and `scripts/restore-drill.sh` exist and are documented in [OPERATIONS.md](OPERATIONS.md). **They have never been executed**: this environment has no `pg_dump`, `pg_restore`, `psql` or Docker. A backup that has not been restored is not a backup: run the drill against staging before launch, then on a schedule. Object-storage durability, environment-secret backup and migration rollback (forward-fix; no down migrations) are procedures to be confirmed on the real infrastructure.

## Third-party integrations

| Integration | Status |
| --- | --- |
| PayFast (subscriptions) | signature, amount, merchant and idempotency logic tested against a fake provider; **not tested against the live or sandbox PayFast service** |
| Customer online payments | abstraction and a fake provider tested end to end; **no real provider has been connected** |
| SMTP e-mail | driver and retry logic tested with an in-memory transport; **not tested against a real mail server** |
| SMS / WhatsApp (Twilio) | abstraction, consent, retry and failure handling tested with a memory driver; **not tested against a live Twilio account**; WhatsApp template approval is not modelled |
| ClamAV | scanner client fails closed; **not run against a real ClamAV** |
| S3 storage | driver exists; **not run against a real bucket** (local driver tested) |

## Dependencies

`npm outdated`: patch update applied (nodemailer). Not upgraded, deliberately, because each is a major version needing its own migration and test cycle: Next 16, TypeScript 7, Vitest 5, Prisma 8 (release candidate), @types/node 26. The audit gate reports four *high* advisories (`prisma`, `@prisma/config`, `deepmerge-ts`, `mysql2`), all in the Prisma CLI toolchain, not loaded by the running application (PostgreSQL only); the only automatic fix is a breaking Prisma downgrade. Impact is limited to the build and migration environment; the mitigation is not to run the Prisma CLI against untrusted configuration.

## Known issues and limits

* Part 7 limits stand (vehicles have no number; job statuses are a fixed workflow with configurable names and two optional steps; opening hours are business-wide; imports are synchronous up to 5,000 rows; reports are live, not cached; scheduled reports need Business).
* Custom tier is a foundation, not a set of enterprise features.
* The CSP allows inline scripts; no external penetration test; no error-monitoring service; no browser tests in CI; PDFs are Latin-1 only; refunds are recorded, not executed through a provider; SMS/WhatsApp inbound replies are not handled.
* Performance figures are from one machine; production sizing is not validated.

## Not tested / requires the deployment environment

Live PayFast, customer payment providers, SMTP delivery, Twilio SMS and WhatsApp, ClamAV, S3; backup and restore on real infrastructure; TLS, proxy and CDN behaviour; real mobile devices and other browsers; screen readers and contrast; load and soak testing; the scheduler and worker running continuously for days; an external penetration test; the production domain, DNS and e-mail sender authentication.

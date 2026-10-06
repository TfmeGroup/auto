# Operations

## Environments

| | Development | Test | Production |
|---|---|---|---|
| Database | `npm run db:local` (embedded Postgres) | throwaway embedded Postgres per `npm test` | managed PostgreSQL ≥ 15 (needs `pg_trgm`) |
| Email | `console` driver | `memory` driver | `smtp` (enforced) |
| Files | local disk | temp dir | private S3-compatible bucket (recommended) |
| Billing | `none` or PayFast sandbox | fake provider | PayFast live (`PAYFAST_SANDBOX=false`, enforced) |

Config is validated at startup (`src/lib/env.ts`); an unsafe production configuration refuses to boot
and names the offending variable. Never commit `.env`. Keep `MIGRATE_DATABASE_URL` (schema owner) out
of the web and worker processes: only the migrate job gets it.

## Deploying

Three processes, one codebase (`Dockerfile` has a target for each):

1. **migrate** — one-shot: `npm run db:migrate` (applies `prisma/migrations`, sets the `tfme_app`
   password from `DATABASE_URL`, syncs system roles + plans). Run before each release.
2. **web** — `next start` / the standalone server. `JOBS_INLINE_WORKER=false`.
3. **worker** — `npm run worker`. Run ≥1; any number are safe (SKIP LOCKED).

Set `TRUST_PROXY=true` behind your load balancer/CDN. Terminate HTTPS there (HSTS is sent).
`docker compose up --build` gives a full local stack (untested here — no Docker on the build machine).

PayFast: set the ITN/notify URL to `https://<host>/api/webhooks/payfast` (the app sends it per
checkout). Complete a sandbox purchase end-to-end before going live.

## Background work and the scheduler

The **worker** (`npm run worker`, or `JOBS_INLINE_WORKER=true` in dev) does two things: it processes queued jobs
(emails, provider calls, data exports) and runs the **scheduler once a minute** — trial reminders, trial expiry,
past-due → grace → suspended transitions, scheduled downgrades, and housekeeping (expired sessions, tokens, MFA
challenges, rate-limit rows). Run one or more workers; overlapping runs are safe because every step is a guarded
update or a deduplicated enqueue. **If no worker runs, nothing is lost or wrongly restricted** — access is derived
from dates (see BILLING.md) — but reminders, emails and exports stop. Alert on the readiness endpoint's
`jobs.oldestDueSeconds`.

## Platform administration (TFME staff only)

Separate from any customer's business administration; reachable only through the schema-owner tooling and the
`/api/platform` endpoints (platform admins with MFA).

```bash
npm run platform -- grant-admin someone@tfme.co.za   # they must then enable MFA in their account
npm run platform -- list-admins
npm run platform -- set grace_days 10                # tune billing windows, reminder days, retention…
npm run platform -- settings                         # show effective settings
```

Custom (36+ user) contracts: `POST /api/platform/businesses/<id>/custom-plan` as a platform admin.

## Secrets and keys

| Secret | Notes |
|---|---|
| `MFA_ENCRYPTION_KEY` | 32 bytes, base64. Required in production. Encrypts every user's TOTP secret. |
| `DATABASE_URL` / `MIGRATE_DATABASE_URL` | App role vs schema owner — never give the web app the owner. |
| SMTP / S3 / PayFast credentials | Secret manager only. |

Production email sender: set `EMAIL_FROM` (e.g. `TFME Auto <no-reply@tfme.co.za>`) and SMTP credentials;
the domain needs SPF/DKIM/DMARC records for deliverability. Nothing in the code is tied to a particular sender.

## Documents and communication (Part 6)

* **New secrets / settings.** `FILE_SIGNING_KEY` (at least 32 bytes, base64) signs short-lived download links and customer opt-out links: required in production, keep it in the secret manager (rotating it only invalidates links that are already out). `CLAMAV_HOST` / `CLAMAV_PORT` connect a clamd daemon: when set, every upload is scanned and **uploads fail closed** if the daemon is down, so monitor it. `SMS_DRIVER` / `WHATSAPP_DRIVER` (`none` by default) with `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_FROM`, `TWILIO_WHATSAPP_FROM`. Point the provider's status callback at `https://<host>/api/public/webhooks/twilio`; callbacks are accepted only with a valid signature. Run a real provider test (and a real clamd scan) before relying on either; neither has been exercised against a live service here.
* **Worker jobs added.** `comm.deliver` (one per message; retries with backoff, up to 5 attempts) and `document.generate` (up to 4). The scheduler (every 10 minutes) now also: sends booking reminders and service reminders (quote-expiry warnings are part of the finance tasks), purges files that have been in the trash past each business's retention period (hourly), and sweeps stored objects that have no record at all (daily; only objects older than 3 days, only under a business's own prefix, audited). Everything is idempotent and safe with several workers.
* **What to watch.** Failed customer messages (Messages → status Failed; each raises a grouped in-app alert for the people who can act), failed document generations (Settings → Documents), and the dead-letter count of `comm.deliver` / `document.generate` jobs. A business that reaches its hourly message cap sees messages wait, not disappear.
* **Storage.** Thumbnails and generated PDFs live in the same private bucket under the business prefix. The bucket must stay private; nothing in the app builds a public URL. `Settings → Documents → Check that every file is still in storage` reports records whose object is missing.
* **Restore note.** A restore drill should include the object store and the database together: file rows without their objects are reported by the check above, and objects without rows are removed by the daily sweep after three days.

## Health and monitoring

- `GET /api/health` — liveness (no dependencies).
- `GET /api/health/ready` — readiness: database up, plus job-queue depth: `jobs.due`, `jobs.dead`,
  `jobs.oldestDueSeconds`. **Alert on** `dead > 0` and on `oldestDueSeconds` growing (worker stopped).
- Logs are structured JSON (pino) with a `requestId` that matches the `x-request-id` response header
  and the id shown in API errors — users can quote it to support. Credentials and cookies are redacted.
- Suggested alerts: 5xx rate, readiness failing, dead jobs, failed webhooks
  (`SELECT * FROM webhook_events WHERE status = 'FAILED'`), login-lock spikes (`auth.login_locked`).

## Backups and recovery

Layers, in order of importance:

1. **Provider point-in-time recovery** on the managed database (enable it; ≥7 days). This is the
   primary safety net.
2. **Logical backups** with `scripts/backup.sh` (`pg_dump` custom format + file-storage archive +
   checksums), at least daily, shipped **off-host to encrypted storage**, retention e.g. 30 daily /
   12 monthly.
3. **Object storage**: enable bucket versioning and cross-region replication. Files are archived,
   never deleted by the app, so versioning protects against operator error.

**Restore procedure (database):** create an empty database as the owner, `pg_restore --no-owner
--dbname <new> db.dump`, run `npm run db:migrate` against it (sets the app role password, re-syncs
reference data, applies any newer migrations), point `DATABASE_URL`/`MIGRATE_DATABASE_URL` at it,
start web + workers. Files: restore the bucket version/archive; keys are stable
(`<businessId>/<year>/<uuid>`), so database rows and objects line up with no rewriting.

**`scripts/restore-drill.sh` automates a non-destructive restore test** (restores into a scratch
database, checks checksums, row counts, that RLS is still forced on tenant tables, that the audit
triggers survived). Run it monthly and after any backup-process change, and log the result.

> **Honest status:** `backup.sh` and `restore-drill.sh` were written but could **not be executed** in the
> build environment (no `pg_dump`/`pg_restore`). The restore procedure above is therefore *designed,
> not proven*. Treat the first successful drill against a real backup as a release gate.

Recovery objectives to decide with the business: RPO (how much data loss is tolerable — PITR gives
minutes) and RTO (how long to be back up). Document them here once agreed.

## Routine tasks

- Rotate: SMTP/S3/PayFast credentials and the database passwords on a schedule; `tfme_app`'s password
  changes by editing `DATABASE_URL` and re-running `npm run db:migrate`.
- Housekeeping candidates for scheduled jobs (not yet scheduled): purge expired sessions/tokens
  (`sessions.expires_at`, `auth_tokens.expires_at`), `purgeStaleBuckets()` for rate limits, retention
  of `SUCCEEDED` jobs.
- Plan prices/limits live in `src/server/billing/plans.ts` (**placeholder prices — set real ones**) and
  are applied by `npm run db:migrate`.

## Known operational notes (Part 3)

* **Migration `0005_workshop_operations`** renames `customers.phone` → `mobile`, splits existing names into first/last, maps the old
  `COMPANY` customer type to `BUSINESS`, and gives every existing business the default service types, weekday opening hours and
  booking rules. It was applied to a database that already held Part 1–2 data and checked (names split, types mapped, defaults
  backfilled); it runs as ONE transaction (no explicit BEGIN/COMMIT), so a failure leaves nothing half-applied. Existing customer
  numbers (`CUST-0001`) are kept; new ones use `CUS-000001` and the counter continues.
* **A one-line `DeprecationWarning` about overlapping queries** ("Calling client.query() when the client is already executing a
  query…") can appear once per process in development and tests. It comes from Prisma 7's own relation loading when a query
  includes several relations inside a transaction — not from application code (the application serialises its own reads with
  `seq()`). It is harmless on pg 8 (queries queue); revisit when upgrading to pg 9 / a newer Prisma adapter.
* Business-local time (opening hours, "today", calendar days) uses the business's `timezone` (default `Africa/Johannesburg`).

## Reports, schedules and imports (Part 7)

* The scheduler (every 2 minutes) runs due report schedules; delivery is the `report.deliver` job (4 attempts, failure audited and shown in the app). Monitor the failed-jobs count as before.
* Report run history, delivered report files and staged import files are cleared after the business's retention settings (Settings, Data).
* Reports query live data with a 25 s statement timeout and a 50,000-row export cap. If a large tenant's report is slow, add an index for the filter in use rather than caching.
* Migration `0014_reports_settings_admin` adds tables and columns only; it is applied with the normal migrate step.

## Health, CI and pre-launch checks (Part 8)

* **Liveness:** `GET /api/health` (no dependencies). **Readiness:** `GET /api/health/ready` returns 503 with `database` and `storage` each `up`/`down`, and when ready also queue depth, dead jobs and whether each provider is configured (never any credential).
* **CI** runs lint (zero warnings), typecheck (app and tests), the full suite, the production build and the dependency audit. It does not deploy.
* **Before launch, in staging:** run the migrate step against an empty database; run `scripts/backup.sh` then `scripts/restore-drill.sh` (neither has ever been executed — see PRODUCTION-READINESS.md); send a real PayFast sandbox payment and a real e-mail; confirm the proxy forwards the client address (`TRUST_PROXY`) and that headers and cookies survive it; check behaviour behind your connection pooler; confirm logs are shipped and retained.
* **Database growth:** the migrations are additive. New indexes on large tables can lock writes while they build; schedule a migration that adds an index to a big table for a quiet period.

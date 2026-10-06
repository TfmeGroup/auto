# TFME Auto

Standalone workshop-management SaaS for automotive businesses. It shares nothing with any other TFME
product: its own database, accounts, billing, files and notifications. **There is no AI anywhere in
this application, by design.**

Status: **the complete build (Parts 1–8) — foundation, accounts, security, billing and tiers, workshop, finance, inventory, documents and notifications, reports, settings, administration, and the full-system verification** (customers, vehicles, bookings/scheduling, job cards, digital inspection, diagnosis, recommended work). The platform (auth with MFA, businesses,
membership and invitations, roles and permissions, audit, files, search, trials, subscriptions, entitlements, billing,
data export, jobs, UI shell) is built and tested, and the workshop workflow runs on top of it (see
[docs/WORKSHOP.md](docs/WORKSHOP.md)). Quotes, invoices, payments, credit and financial reporting (Part 4) are in [docs/FINANCE.md](docs/FINANCE.md). Inventory, suppliers, purchasing and the team (employees, technicians, time, labour rates) (Part 5) are in [docs/INVENTORY.md](docs/INVENTORY.md). Documents, photos, generated PDFs and the notification and communication system (Part 6) are in [docs/DOCUMENTS.md](docs/DOCUMENTS.md) and [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md). Reports, business settings, imports and administration (Part 7) are in [docs/REPORTS.md](docs/REPORTS.md), [docs/SETTINGS.md](docs/SETTINGS.md) and [docs/ADMINISTRATION.md](docs/ADMINISTRATION.md). What was verified, what was not, and what must be checked on the real deployment is in [docs/PRODUCTION-READINESS.md](docs/PRODUCTION-READINESS.md); every endpoint and the protection it carries is in [docs/API.md](docs/API.md).

## Quick start (no Docker needed)

```bash
npm install
cp .env.example .env         # defaults match the local database below
npm run db:local             # terminal 1: real PostgreSQL + migrations; leave running
npm run dev                  # terminal 2: http://localhost:3000
```

Emails (verification, password reset, invitations) are printed to the `npm run dev` terminal while
`EMAIL_DRIVER=console`. Register, open the verification link from the log, then create your business.

| Command | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | Next.js app |
| `npm test` | Full suite (about 1,200 tests, ≈5–6 min) against a throwaway real PostgreSQL |
| `npm run lint` | ESLint, zero warnings allowed |
| `npm run typecheck` | App + test type checking (strict, no unused locals) |
| `npm run docs:api` | Regenerate docs/API.md from the route table |
| `npm run db:migrate` | Apply migrations, sync system roles and plans (uses `MIGRATE_DATABASE_URL`) |
| `npm run worker` | Background worker: jobs + the minute-by-minute scheduler (or `JOBS_INLINE_WORKER=true` in dev) |
| `npm run platform -- …` | TFME-staff tooling: platform admins, platform settings (see docs/OPERATIONS.md) |
| `npm run audit` | Dependency audit gate used by CI |

## Stack

Next.js 15 (App Router) · TypeScript (strict) · Tailwind CSS 4 · PostgreSQL · Prisma 7 · Zod ·
Vitest. Passwords: Argon2id. Everything else (sessions, rate limiting, job queue) runs on PostgreSQL
itself, so a deployment needs exactly one stateful service plus object storage.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how it fits together
- [docs/WORKSHOP.md](docs/WORKSHOP.md) — customers, vehicles, bookings, job cards, inspection: rules, workflow, visibility
- [docs/FINANCE.md](docs/FINANCE.md) — quotes, invoices, payments, credit, refunds, credit notes, reminders, online payments, reports: rules, workflow, limits
- [docs/DOCUMENTS.md](docs/DOCUMENTS.md) — the shared document system: upload pipeline, access rules, visibility, lifecycle and retention, versions, generated PDFs, customer job page, storage usage
- [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md) — the shared notification service: events, providers, channel rules, queue and delivery states, templates, reminders, in-app centre, preferences and consent
- [docs/INVENTORY.md](docs/INVENTORY.md) — parts, stock ledger, suppliers, purchase orders, receiving, transfers, employees, technicians, time, labour rates: rules, workflow, limits
- [docs/REPORTS.md](docs/REPORTS.md) — standard, custom, saved and scheduled reports: definitions, permissions, exports
- [docs/SETTINGS.md](docs/SETTINGS.md) — every business setting and where it takes effect
- [docs/ADMINISTRATION.md](docs/ADMINISTRATION.md) — admin area, import centre, exports, audit and security events
- [docs/PRODUCTION-READINESS.md](docs/PRODUCTION-READINESS.md) — what was tested and how, defects found, performance, mobile and accessibility results, deployment checklist, and everything not yet verified
- [docs/API.md](docs/API.md) — every endpoint with its access rule, permission, plan feature and rate limit (generated from the code)
- [docs/BILLING.md](docs/BILLING.md) — plans, trial, the subscription state machine, payment flow, adding a provider
- [docs/SECURITY.md](docs/SECURITY.md) — threat model, controls, known limits
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — deploy, environments, backups & restore, monitoring
- [docs/ADDING-A-MODULE.md](docs/ADDING-A-MODULE.md) — the checklist every new module follows

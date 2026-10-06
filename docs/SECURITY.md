# Security

## Controls in place (each is covered by a test)

| Area | Control |
|---|---|
| Passwords | Argon2id (19 MiB, t=2); policy: ≥10 chars, not common, some variety |
| Sessions | 256-bit random token in an HttpOnly, SameSite=Lax (Secure in prod) cookie; only a SHA-256 hash is stored; revocable server-side; re-validated against membership every request; people can see and sign out their own devices (a session id of another person behaves as "not found") |
| Login | Per-IP and per-email rate limits; account lock after 5 failures (15 min); identical response and timing for unknown email vs wrong password; new-device sign-in alert |
| Two-factor (TOTP) | RFC 6238 (tested against the reference vectors); secret encrypted at rest (AES-256-GCM, `MFA_ENCRYPTION_KEY`); each code single-use (replay-proof); login yields only a short-lived single-use challenge (5 min, 5 guesses) — **no session until the second factor passes**; 10 single-use recovery codes stored hashed; disable / regenerate need password + a current code |
| Business-wide MFA | Owners/admins can require MFA of every member (plan entitlement). Enforced in `route()` and page loading: a member without MFA is blocked from business data (but can reach their account to fix it) |
| Registration / reset / email change | No account enumeration; tokens single-use, hashed, expiring (verify 24 h, reset 1 h, email change 24 h); a newer request cancels the older link; email change needs the password, goes to the NEW address, warns the OLD one, and signs everyone out once confirmed |
| Re-authentication | Ownership transfer, business closure and account deactivation re-ask for the password (+ a fresh MFA code) regardless of session age; failures are audited and rate-limited |
| Authorization | Permission checks on the server for every route and service; business never taken from the client; nobody can grant or manage permissions they lack; Owner is never granted, only transferred |
| Ownership | Exactly one ACTIVE Owner per business — enforced by a database unique index and trigger, not only by code |
| Isolation | App-level `businessId` filters **plus** Postgres RLS under a non-superuser role; cross-tenant IDs return 404 |
| Plan entitlements | Checked server-side from the live subscription on every request (`feature:` on `route()`); never UI-only |
| Platform vs business admin | TFME platform administration is a separate area (`platform_admins`, owner-managed, MFA required); no business role or permission reaches it |
| CSRF | Origin / `Sec-Fetch-Site` check on every mutating cookie-authenticated request, on top of SameSite |
| Input | Zod validation server-side; Prisma parameterised queries; the few raw-SQL statements use bound parameters and whitelisted `ORDER BY` |
| Output | React escaping; API returns JSON only; user uploads and QR codes rendered as images/downloads, never as markup |
| Files | Content sniffing, size caps, server-generated keys, private storage, authorised downloads; profile photos and logos are image-only |
| Headers | CSP, HSTS, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, COOP |
| Audit | Append-only (grants + trigger); secrets redacted from snapshots; people can read their own account-level events (enforced by RLS) |
| Webhooks | Signature + provider-side confirmation, amount check, idempotency, row-locked processing |
| Data export | Background job; each dataset needs its own permission; tenant-isolated; private storage; expires; audited on request, completion and each download |
| Secrets | Environment only; production config validation refuses unsafe settings; logs redact credentials; a test scans every API response for password hashes, token hashes, MFA secrets, session tokens, recovery codes and provider references |
| Workshop data (Part 3) | All 27 new tables have forced RLS; every cross-record link is a composite `(id, business_id)` foreign key, so another business's customer/vehicle/job/booking/bay/technician cannot be referenced even by a buggy query (tested by attempting it). Cross-business ids answer 404 exactly like a missing record |
| Internal vs customer-visible | Notes and photos carry a visibility flag; the customer report is built by whitelisting fields, never by removing internal ones (tested with planted markers). Changing visibility is audited. Prices need `job.view_pricing` and are neither accepted nor returned without it |
| Job-level authority | Hands-on changes need the permission AND (`job.assign` or being assigned to the job), so a technician cannot act on jobs that are not theirs; workflow overrides need their own permission, a reason, and are audited separately |
| Concurrency | Booking changes take a per-business advisory lock; job changes lock the job row; a stale status change is refused; bays are protected by an exclusion constraint; check-in is idempotent (unique booking→job). All covered by parallel tests |
| Supply chain | `npm run audit` gate in CI with an explicit, documented exception list |

## Known limits and recommended follow-ups

- **CSP allows `'unsafe-inline'` scripts** (Next's bootstrap). Move to per-request nonces for a strict CSP.
- **No passkeys / WebAuthn** yet; TOTP is the second factor. SMS is deliberately not offered (SIM-swap risk).
- **"Approximate location" of sessions** is not shown: it needs an IP-geolocation service/database. Device, browser,
  OS, IP and times are shown.
- **Rate limiting is Postgres-backed fixed windows.** Correct and shared across instances, but not a substitute for
  edge/WAF DDoS protection. `TRUST_PROXY=true` is required behind a proxy so limits see real client IPs.
- **Custom-role editing UI** is not built (the API, enforcement and audit are); detailed screens belong to Part 7.
- **Malware scanning of uploads** is not implemented (content-type validation only).
- **Encryption key rotation** for `MFA_ENCRYPTION_KEY` is not automated: rotating means re-encrypting `users.mfa_*_enc`.
- **PayFast integration is verified against its documented behaviour and tests, not PayFast's live sandbox**, and
  the S3 driver and Docker files have not been exercised here. See docs/BILLING.md and docs/OPERATIONS.md.
- A closed business is inaccessible to everyone (including its former Owner); reopening or exporting from a
  closed business is a platform-team support action, not self-service.

## Reporting

Treat any cross-tenant data exposure as a severity-1 incident: revoke affected sessions
(`UPDATE sessions SET revoked_at = now()`), snapshot the audit log, and review `audit_logs` for the
affected businesses.


## Financial data (Part 4)

- Every finance table has forced row-level security; links to customers/vehicles/jobs are composite `(id, business_id)` foreign keys.
- Totals are never accepted from a client. Issued invoices, sent quote versions, issued credit notes, payments (identity), events, refunds and the credit ledger are protected by database triggers; financial rows cannot be deleted.
- Customer pages use secret links: 256-bit tokens, only the SHA-256 hash stored, a narrow RLS policy that reveals exactly one row to a presented hash, generic "not valid" answer for malformed/unknown/expired/revoked links, per-IP rate limits, `noindex` and `no-referrer`. Customer views are built by whitelisting fields (no internal notes, costs or margins).
- Payment webhooks are verified with the business's own credentials (signature + provider confirmation), logged under (provider, business, event id), processed under a row lock and are idempotent. A browser redirect never completes a payment. Provider credentials are encrypted at rest (AES-256-GCM, shared key helper) and never returned.
- Exports require `finance.export` plus the permission for that data, respect locations and plan, neutralise spreadsheet formulas and are audited.

## Inventory, purchasing and team data (Part 5)

- Every new table has forced row-level security and composite `(id, business_id)` foreign keys; the application also filters by business explicitly. Cross-business ids (parts, suppliers, orders, movements, transfers, employees, time entries) answer "not found"; business, location and user ids sent in a body are validated against the caller's business and never trusted.
- Stock quantities change only through movements (trigger-enforced); movements, price history, supplier returns, delivery records and assignment history are append-only; parts, suppliers, orders, transfers and time entries cannot be deleted.
- Concurrency: a row lock per stock level, advisory locks for part identifiers and for one-timer-per-person, idempotency keys with unique indexes for movements, deliveries, returns and timers.
- Costs (part cost, supplier cost, margins, valuation, labour cost) need explicit permissions and are removed from lists, detail views, exports and PDFs for everyone else. Technicians hold no financial permission by default.
- Location access is enforced in every stock, order, transfer, movement, report and search path, so aggregates cannot leak another location's counts.
- Imports accept CSV/.xlsx only, are size- and row-limited, read plain values (formulas are never evaluated), report malformed or damaged files as a validation error, and require a preview and confirmation; exports neutralise spreadsheet formulas, omit costs for people who cannot see them and are audited.
- Employees keep a single authentication system: no passwords or security details are ever shown to a business; removing or suspending a member ends access but keeps history.

## Documents and communication (Part 6)

- Files: private storage only, no public URL; server-made keys; content-based type detection, a decodable-image check and a scanner that fails closed when ClamAV is configured; the business, record type and record id are never trusted from the browser (the registry proves ownership inside the tenant); forced row-level security on every new table; composite foreign keys to customers and locations.
- Access: one rule for lists, search and single files (document permissions + the record's own permission + restricted visibility + location access); another business's, a hidden or a deleted file answers "not found". Employee documents need their own permission. Customer visibility is explicit, needs `document.share`, can never apply to supplier / part / purchase order / employee / diagnostic / payment / business files (service check **and** a database CHECK), and customer pages select by whitelist and re-check on every fetch.
- Downloads: HMAC-signed links (`FILE_SIGNING_KEY`, 5 minutes by default, 15 at most) that re-check file availability and the issuer's permission on every use; `nosniff`, strict CSP, safe `Content-Disposition`; per-user rate limits; previews and downloads audited.
- Integrity: stored bytes never change (trigger); financial documents cannot be trashed, deleted early or rewritten (triggers); generated versions are new rows; purges and cleanups are audited and conservative.
- Messages: transactional only, no list sending; mandatory vs optional is fixed in code, not data; SMS and WhatsApp need recorded consent; templates cannot execute code or read data (own-property reads only, single pass, allow-listed placeholders, HTML escaped); private links are not stored in the history; provider credentials stay in the environment and out of every stored record; provider callbacks need a valid signature; a sent message cannot be sent again (state trigger + idempotent job); per-business and per-recipient caps and route rate limits bound abuse; opt-out links are signed, confirm before acting and affect only optional messages.
- Notifications: a person sees and changes only their own; high-priority (money, security) are never folded; links are always in-app paths.

## Reports, settings and administration (Part 7)

Covered by `tests/security/part7-security.test.ts` and the reports, settings and import suites:

* Every Part 7 route uses the shared wrapper with business access and a permission (a static test fails if one is added without); state changes are write-gated and CSRF checked.
* Cost, margin and valuation columns are removed server-side from callers without the matching permission; exports additionally need `report.export` plus the financial or inventory export permission, are rate limited and audited, and defuse spreadsheet formulas.
* Custom reports: approved schema only, bound parameters, operators checked by type, field-level permissions enforced on fields, filters and groups. No source offers contact details, credentials or private employee data.
* Scheduled reports are generated with each recipient's own permissions; a recipient who lost access is skipped and recorded.
* Settings and imports need their own permissions; payment credentials stay write-only and never reach responses or the audit log; the audit log is append-only at the database.
* Personal sign-in events remain private to the person; administrators see business-scoped security events and each member's MFA status and activity only.
* Limits: imports are synchronous (5,000 rows); no automated browser tests; Part 7 pages not yet checked in a real browser at phone width.

## Full-system verification (Part 8)

Added and tested in Part 8 (see [PRODUCTION-READINESS.md](PRODUCTION-READINESS.md) for the evidence and the limits):

* Plan, subscription state, trial dates, limits and provider ids cannot be changed from any request; checkout grants nothing; webhooks for the wrong business, amount or reference change nothing; only billing, closure and platform code may write a subscription.
* Every API route that takes an ID was driven with another business's real IDs: refusals only, nothing echoed, nothing changed.
* The database itself keeps tenant references inside one business (composite keys, including two that were previously application-only), and a whole-database audit checks it after the suite.
* Production configuration is refused if unsafe; log redaction is tested; security headers were observed on a real production boot; there are no debug or test routes and no hard-coded credentials (static scans).
* Server pages cannot call client-module functions (a render-time crash class), enforced statically.

**Not done:** an external penetration test, dynamic scanning of a deployed instance, load testing. The four accepted high advisories are in the Prisma CLI toolchain only (see PRODUCTION-READINESS.md).

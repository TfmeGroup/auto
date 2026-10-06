# Finance: quotes, invoices, payments and credit (Part 4)

This is TFME Auto's operational money system for a workshop: quote → customer approval → job → invoice → payments → receipt → balance, credit and overdue management. It is **not** accounting software (no ledger, no double entry, no statutory VAT filing); it produces clean exports for an accountant.

The money of a workshop's customers is a **separate domain** from TFME's own SaaS subscription billing (`server/billing`). They share no tables, no provider code, no webhooks and no statuses.

## Rules that never bend

- Money is integer cents, quantities integer thousandths, rates basis points. Totals are computed by `server/finance/calc.ts` only; the browser's preview uses the same pure function but the server recalculates and ignores any total it is sent.
- Every document stores the facts it was priced with (VAT registered / rate / prices-include-VAT, per-line rate, cost snapshots) and an issued invoice freezes the business and customer details, so history never changes when settings, prices or rates change.
- The database enforces the integrity itself (migration `0006`): row-level security on every table; composite foreign keys; `taxable = base - discount`, `total = taxable + vat` on every line and document; an invoice's `outstanding = total - paid - credit - credit notes - written off`; triggers that freeze issued invoices/lines/credit notes and sent quote versions, forbid deleting financial rows, make events, refunds and the credit ledger append-only, and stop a customer's credit going below zero.
- Anything that moves money runs in one transaction with locks taken in a fixed order (customer → invoice → payment), plus idempotency keys and unique indexes, so double clicks, retries and simultaneous requests cannot double-apply.

## Workflow

| Step | Where | Notes |
|---|---|---|
| Quote | `finance/quotes.ts` | Draft → Sent → Viewed → Approved/Declined/Expired → Converted; Cancelled. Numbers `QUO-000001`. |
| Versions | same | A sent version is frozen; editing makes v+1 (reason required), revokes the old link. Approval is for one version; an old link/version can never approve a newer one. |
| Customer review | `quote-public.ts`, `/q/[token]` | Secret link (SHA-256 hash stored). View, approve (typed name + accept terms), decline, request changes. Recorded with IP/device. Idempotent; one decision per version (unique index). |
| Expiry | `scheduled.ts` | Scheduler expires quotes past `valid until`; kept, link revoked. |
| Quote → job | `createJobFromQuote` | Once only (row lock + check). Reuses customer and vehicle; approved lines become approved work / requested parts. |
| Quote → invoice | `createInvoiceFromQuote` | Separate record linked to the approved version; totals must equal the approved total; once only (partial unique index). |
| Job → invoice | `createInvoiceFromJob` | Billable job status only (ready for collection / completed). Bills only FITTED parts and recorded labour (+ additional charges on the approved quote). Reserved/requested/ordered/returned parts are never billed. |
| Invoice | `invoices.ts` | Draft (no number) → Issued (number, dates, snapshots, locked) → Sent/Viewed → Partially paid/Paid/Overdue; Cancelled (only if nothing paid), Written off. `ISSUED` is an addition to the spec's list: it is the finalised-but-not-yet-sent state. |
| Payments | `payments.ts` | Manual (cash/card/EFT/other) or online. A payment is split into the part that settles the invoice and any excess that becomes customer credit; the whole amount is stored. |
| Deposits | same | A deposit is a payment with no invoice; it becomes credit in the customer's ledger, applied later with "use credit". No fake invoices. |
| Credit | `ledger.ts` | Append-only ledger; balance = sum. Applying credit locks the customer; the database refuses a negative balance. |
| Refunds | `payments.ts` | Computed from the payment's own history; credit comes back first, then the invoice is reopened; never more than refundable. Records that money was paid back; it does not move money. |
| Credit notes | `creditnotes.ts` | Draft → Issued (separate permission to authorise). Cumulative total can never exceed the invoice. Reduces the invoice, any excess becomes credit. |
| Receipts | `completePaymentTx` | One per completed payment, numbered `RCT-`, PDF filed in the shared document store. |
| Reminders | `scheduled.ts` | Per-business offsets from the due date; most recent threshold only; each sent once (dedupe key); transactional email; honours contact preference; needs the plan feature. |

## Online payments

`finance/providers/index.ts` defines `CustomerPaymentProvider`; PayFast is implemented (signed checkout, ITN verified by signature **and** PayFast's own validation call). Each business supplies its own merchant credentials (encrypted at rest with the same AES-GCM key helper as MFA secrets, never returned by any API). Flow: customer link → `POST /api/public/invoices/[token]/pay` creates a PENDING payment and a checkout form → provider → `POST /api/webhooks/payments/<provider>/<businessId>` → verify → one transaction completes the payment → receipt, balance, audit, email. The browser return page (`/pay/return`) only displays state. Adding Peach/Yoco = one class + one registry line.

**Status:** PayFast is built and covered by tests with stubbed HTTP; it has **not** been exercised against PayFast's live sandbox. Treat a sandbox payment as a release gate.

## Plans (central entitlements)

Core quotes, invoices, payment recording, history and the basic dashboard are on every plan. `online_payments`, `payment_reminders` and `financial_reports` (quote/payment analytics, profitability, VAT report) are plan features (Team and above in the catalogue; configurable data in `billing/plans.ts`). Enforcement is server-side (`requireFeature`).

## Permissions

New: `invoice.finalise`, `invoice.write_off`, `payment.apply_credit`, `payment.reconcile`, `credit_note.view|create|authorise`, `finance.view_reports`, `finance.view_costs`, `finance.export`, `finance.manage_settings` (alongside the existing quote/invoice/payment ones). Technicians get nothing financial by default.

## Known limits (honest list)

- PDFs use standard Latin-1 fonts: characters outside Latin-1 print as `?`.
- Refunds are recorded, not executed through a provider API; provider-side refunds are manual.
- Credit notes record how much reduced the invoice vs became customer credit, not a per-note "remaining credit"; remaining credit is the customer's ledger balance.
- A fully credited invoice shows as Paid (nothing owed) with a "settled by credit note" notice; there is no separate "Credited" status.
- Quote expiry is always on (no per-business switch); validity default is a setting.
- Statements show invoices, payments, credit notes, refunds and write-offs; no ageing on the statement itself.
- Gross profit counts lines with no recorded cost as zero cost and says how many there are; credit notes reduce revenue but not cost.
- Customer links are bearer secrets: anyone with the link can view and answer that one document (like any emailed link). Links expire (quotes 90 days, invoices 365) and are revoked on cancel/new version.
- Email is the only customer channel built; SMS/WhatsApp reminders are not.
- No automated browser tests; responsive layout was checked manually at 375px and desktop.

## Declined, then revised and approved (Part 8)

Declining a quote marks the recommended work on its lines as declined. If the workshop then revises the quote and the customer approves the new version, that explicit approval **supersedes** the earlier decline of the same work: it becomes approved (with the note "approved after an earlier decline") so the job can move on. The decline is not erased: it stays in the quote's history, the audit log (the `quote.approved` entry records how many declines it superseded) and the activity feed. Approving an obsolete version is still refused.

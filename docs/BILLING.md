# Billing, trials and subscriptions

A subscription belongs to a **business**, never to a personal account. Everything below is enforced on the
server; screens only display it.

## Plans (data, not code)

`src/server/billing/plans.ts` defines the catalogue; `npm run db:migrate` syncs it to the database, and the
application only ever reads the database.

| Plan | Users | Locations | Storage | What it adds |
|---|---|---|---|---|
| Solo | 1 | 1 | 2 GB | The whole core workshop: dashboard, customers, vehicles, bookings, job cards, inspections, quotes, invoices, payments, basic stock and suppliers, basic reports, documents and photos, e-mail notifications, business settings, administration. Business data export. |
| Team | 10 | 1 | 10 GB | Solo plus granular permissions through the predefined roles (assign, change and see them; creating or editing your own roles stays Business-only), technician management and time, advanced inventory, purchase orders and receiving, barcode workflows, online payments, payment reminders, financial and advanced reports, customer communication history, custom message templates, service reminders, SMS, advanced documents, advanced workshop configuration, MFA enforcement. |
| Business | 35 | 10 | 50 GB | Team plus multi-location (and stock transfers), custom roles, custom and scheduled reports, bulk inventory, inventory reports, WhatsApp, advanced administration (security events, archive, search), advanced imports. |
| Custom | 36+ | contract | contract | Everything in Business, with limits set by contract (`overrideMaxMembers`, `overrideMaxLocations`, `overrideMaxStorageMb`) by the platform team. Custom integrations and workflows are not built into the product: this is an entitlement and limits foundation, not a promise of bespoke features. |
| (Free trial) | 10 | 3 | 5 GB | Internal. Every new **business** (not account) gets it for **14 days** with every feature on. |

The tier matrix is also written out, independently of `plans.ts`, in `tests/billing/tier-matrix.test.ts`: moving a feature between tiers fails that test until the change is deliberate.

**Over-limit businesses.** A downgrade (or a contract change) never deletes anything. If a business holds more members, locations or storage than its plan allows it keeps all of it, is shown as *over its plan* (billing screen and `GET /api/v1/billing/entitlements`), and simply cannot add more until it upgrades or frees some up. Features it no longer has stop working at once (a 402 naming the feature), but the records they produced stay.

Each plan has: key, display name, price + billing interval, user/location/storage limits, status, effective
dates, and a set of **feature entitlements** (`plan_features`). Contract overrides for Custom plans live on the
subscription. **Prices are intentionally unset** (the specification leaves pricing to be configured): an unpriced
plan shows "Price to be announced" and cannot be bought until a price is set in the catalogue and synced.

Feature and limit allocations per plan are sensible defaults to **confirm with the business** (see `plans.ts`).

### Entitlements

`canUseFeature(sub, key)` / `requireFeature(sub, key)` (`billing/features.ts`), or `feature: 'key'` on `route()`.
The check runs on the server for every request against the *live* subscription, so a downgrade removes access at
once. Hiding a button is never the control. The full list of feature keys is `FEATURES` in `billing/features.ts`.
To gate something new: add the key, add it to the plans that include it, call `requireFeature`.

**One place answers "what may this business do?"** `getEntitlements(ctx)` (`billing/entitlements.ts`, also `GET /api/v1/billing/entitlements`) returns the plan, status, limits, live usage, what is left, anything over its limits, every feature, and ready answers for the questions screens ask (`can.inviteMember`, `createLocation`, `createCustomRole`, `createCustomReport`, `scheduleReports`, `useSms`, `useWhatsApp`, `usePurchaseOrders`, `transferStock`, `uploadFiles`, ...). It only reads; the services still enforce (`requireFeature`, `assertWithinLimit`, `assertCanWrite`), and no plan name is compared anywhere outside `billing/`.

### Limits and seats

`usage/service.ts` is the single source for "how much of the plan is used". **Seat policy:** ACTIVE members plus
pending invitations count (an invitation reserves a seat); SUSPENDED and ARCHIVED members do not. Reactivating a
suspended member needs a free seat. While a downgrade is scheduled, limits are the *lower* of the current and
pending plan so usage cannot grow past what the downgrade allows.

## The state machine

Stored status plus a few dates determine the status that applies **now** (`billing/state-machine.ts`,
`deriveStatus`) — correctness never depends on a cron job having run. The scheduler only keeps stored state tidy,
writes the audit trail, and sends each email once.

| Status | Meaning | Access |
|---|---|---|
| `TRIALING` | 14-day trial running | full |
| `ACTIVE` | paid and current | full |
| `PAST_DUE` | payment failed (or the paid period lapsed unpaid); first *retry window* (default 3 days) | full |
| `GRACE_PERIOD` | next *grace window* (default 7 days) | full + warnings |
| `SUSPENDED` | grace over, still unpaid | **read-only**, data preserved |
| `CANCELED` | cancelled by the customer or provider | full until the paid-through date |
| `EXPIRED` | trial ended unconverted, or cancelled period ended | **read-only**, data preserved |

Transitions (events → `applyEvent`):

```
TRIALING --payment succeeded--> ACTIVE (converted_at set once)
TRIALING --trial_ends_at passes--> EXPIRED
ACTIVE --renewal payment failed--> PAST_DUE (clock starts; repeated failures never reset it)
ACTIVE --period lapses with no renewal (+1 day tolerance)--> PAST_DUE (clock starts automatically)
PAST_DUE --retry window--> GRACE_PERIOD --grace window--> SUSPENDED
PAST_DUE | GRACE_PERIOD | SUSPENDED --payment succeeded--> ACTIVE (clock cleared)
ACTIVE | PAST_DUE | GRACE_PERIOD --cancel--> CANCELED --paid-through date passes--> EXPIRED
EXPIRED | CANCELED --payment succeeded--> ACTIVE
```

A failed **checkout** (first payment or an upgrade attempt) never degrades an existing paid subscription; only a
failed *renewal* starts the past-due clock. Nothing in this machine deletes data.

Windows and reminder days are **platform settings** (`platform_settings`; defaults in
`settings/platform.ts`; change with `npm run platform -- set grace_days 10`).

## Trial

Created inside the business-creation transaction (`startTrial`): start, end (= start + 14 days), status, trial
entitlement and an audit event, all server-side. Client-supplied trial fields are ignored. Phases for display:
*trialing*, *expiring* (≤ `trial_expiring_days`), *expired*, *converted*.

Reminders: the scheduler sends **one reminder per configured window** (default 7, 3 and 1 day) via the job queue
with dedupe keys, so repeated or concurrent scheduler runs never double-send. People can opt out of trial
reminders; billing-failure and security emails are never optional.

**Post-trial retention** (`post_trial_retention_days`, default 90) and closed-business retention
(`closed_business_retention_days`, default 365) are configurable policy values. **No automatic purge exists** —
data is never destroyed by this code; those values are for the platform team's retention process.

## Money flow

1. **Preview** — `GET /api/v1/billing/plan-change?plan=` returns prices (VAT-exclusive, VAT, total), limit and
   feature differences, and anything blocking the change. Changes nothing.
2. **Upgrade** — `POST /api/v1/billing/checkout` re-evaluates server-side, creates a `PENDING` payment record that
   *we* own, and returns the provider's signed checkout form. The subscription is **not** changed.
3. **Provider webhook** is the only thing that changes payment state: verified (signature + provider
   confirmation), stored under a unique `(provider, external_id)`, processed under a row lock, amount-checked
   (checkout amount for a first payment; the subscription's recurring amount for renewals), idempotent. A redirect
   back from the provider is not an event.
4. On success: plan/limits/features apply, a numbered tax invoice is issued (`TFMEA-000123`, VAT extracted from the
   VAT-inclusive charge), the billing contacts are emailed, everything is audited. An upgrade creates a *new*
   provider subscription, so the old one is cancelled by a retried background job (never billed twice).
5. **Downgrade** — validated against current usage (members incl. pending invites, locations, storage); the lower
   price is pushed to the provider, the plan switches at the end of the paid period. Needs a provider that can
   change the amount (`capabilities.updateAmount`). Can be cancelled before it takes effect.
6. **Cancel** — keeps access to the paid-through date, stops provider billing (job), preserves all data.

Billing contacts = active members whose role holds `settings.manage_billing` (always includes the Owner).

## Adding a payment provider (Peach Payments, Yoco, …)

1. Implement `PaymentProvider` (`billing/provider.ts`): `createCheckout`, `verifyWebhook` (throw
   `WebhookVerificationError` on a bad signature — and confirm with the provider where it supports that),
   optionally `cancelSubscription` / `updateAmount`, and declare `capabilities` honestly.
2. Register it in `PROVIDERS`, add its config to `src/lib/env.ts` (validated, with production safety checks), and
   set `BILLING_PROVIDER=<name>`.
3. Webhook URL is `/api/webhooks/<name>` automatically. Nothing else in the subscription system changes.

The `FakeProvider` in `tests/billing/lifecycle.test.ts` is the reference for the contract.

## What is NOT verified live

PayFast is implemented from its published documentation (signed checkout, ITN verification, subscription cancel and
amount-change API) and tested with a stubbed HTTP client. **Run a full sandbox purchase, renewal, failed payment,
cancellation and downgrade before enabling it in production**, and confirm the API signature and blank-field
rules against the live sandbox. Payment-method summary ("Visa ending 4242") is only shown if the provider reports
one; PayFast's ITN does not, so the screen says "Managed by payfast".

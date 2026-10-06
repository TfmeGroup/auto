# Notifications and communication (Part 6)

One shared service sends every operational message. Bookings, jobs, quotes, invoices, payments, reminders, purchase orders and the in-app centre all use it; none of them knows which provider carries a message. It is **transactional** only: there is no marketing event, campaign, list or bulk send, and a customer's marketing consent is never read for any of it. There is no AI: every message is a fixed template filled with stored values.

```
event -> channel choice (preferences, consent, plan, configuration)
      -> template -> communication record (QUEUED) -> job queue
      -> provider (email | SMS | WhatsApp) -> result recorded (SENT / FAILED / SKIPPED)
      -> delivery reports move it forward -> retry only if the failure was transient
```

A request that causes a message never waits for a provider. It writes the record and the job in its own transaction, so the message exists if and only if the business change committed.

## Event model (`notifications/events.ts`)

One registry of every customer/supplier message: key, label, category, whether it is **mandatory**, which text channels it may use, which variables its templates may use, and its default wording per channel.

* Bookings: confirmed, reminder, moved, cancelled, missed appointment.
* Job updates (each switched on by the business): checked in, diagnosis complete, work approved, work started, waiting for parts, ready for collection, completed. ("Quote ready" is the quote email itself.)
* Money: quote sent, quote decision, quote expiring, invoice sent, invoice reminder, invoice overdue, payment received, payment did not go through, credit note, refund.
* Service reminder; purchase order to a supplier; a message written by a person.

In-app notification types are one registry too (`NotificationTypes`: JOB_ASSIGNED, QUOTE_APPROVED, INVOICE_PAID, LOW_STOCK, PO_RECEIVED, SECURITY_ALERT, TRIAL_ENDING, SUBSCRIPTION_PAYMENT_FAILED, …). Existing free-text types were migrated (migration 0013).

## Providers (`notifications/providers/`)

`EmailProviderInterface` (the Part 2 email transports: console, SMTP, memory), `SmsProviderInterface` and `WhatsAppProviderInterface` (one `send()` each). Provider-specific code lives in one file per provider: `twilio.ts` (REST sending, status-callback signature check) and `text.ts` (driver selection, a `none` driver, a `memory` test driver). Choosing a provider is the `SMS_DRIVER` / `WHATSAPP_DRIVER` environment variable. **`none` is the default**: SMS and WhatsApp messages are then recorded as *skipped: not set up*, never as sent and never lost. Credentials are server-side environment variables only; they are never stored, returned to the browser, put in the job queue or written to logs or audit entries (a test searches for them).

## Channel rules (`notifications/comms.ts`)

* **Email** is the core channel. A business chooses the *name* its emails appear under, the reply-to address and a signature; the sending *address* is always the platform's. Security and account emails are not business settings and stay platform-controlled.
* **Mandatory** messages (a customer's own quote, invoice, receipt, payment, credit note, refund, a change to their booking, a purchase order to a supplier) go by email regardless of any switch, and also by the customer's preferred text channel when that is allowed.
* **Optional** messages (reminders, job updates, service reminders, missed appointment) honour the customer's switches and their stated preferred channel. A customer who prefers a phone call, or a channel the message cannot use, is **not** emailed instead: the history records why nothing was sent.
* **SMS / WhatsApp** need all of: the customer's recorded agreement, a usable mobile number (normalised to E.164 using the business's country), the business's own switch, the plan feature (`sms_notifications` from Team, `whatsapp_notifications` from Business), and a configured provider. Every refusal is recorded with its reason.
* **Consent** is an append-only history (type, status, source, who recorded it, wording version, time). Marketing consent is separate and unused here.
* **Opt-out link** in every optional email: a signed link to a confirmation page (a GET changes nothing; the button POSTs) that switches off that one category. It never touches mandatory messages and works across no other business.
* **Location**: a message carries the record's location; history respects the viewer's location access.

## Queue, retries, idempotency, delivery states

* Every message has a unique `(business, dedupe key, channel)`. The same event is sent once however many times a request, scheduler tick or worker retry repeats it.
* The delivery job is idempotent: a message already sent is never sent again, even if the job reruns after a crash.
* **Transient** failure (network, provider busy): the record goes back to `QUEUED`, the job retries with exponential backoff up to 5 attempts, then the message is `FAILED` with a safe reason. **Permanent** failure (bad number, refused): `FAILED` at once with a safe reason, not retried. Not configured: `SKIPPED`.
* States: Queued, Processing, Sent, Delivered, Viewed, Failed, Cancelled, Skipped. **Sent means the provider accepted it.** Delivered and Viewed come only from the provider's own delivery report. A database trigger makes a sent message move only forward (it can never go back to queued and be sent again) and makes skipped and cancelled final.
* **Delivery reports** (`POST /api/public/webhooks/twilio`) are accepted only if the provider's signature verifies against the auth token; the message is found by the provider's reference under a narrow row-level-security policy.
* **Safety limits**: a business-wide messages-per-hour cap (messages beyond it wait and are sent as the hour allows; if they cannot be, they end as failed and can be re-sent), a per-recipient cap of 20 an hour (extra messages are recorded as not sent), per-route rate limits on manual sending, and no way to send to a list.
* A failed message raises one grouped, high-priority in-app notification for people with `notification.view_history`, and can be re-sent or cancelled from its history page.

## Communication history

`communications` records every message: channel, event, category, recipient, subject, text (**with private links removed**, since only their hashes are otherwise stored), the record it is about, status and reason, provider and provider reference, attempts, and queued / sent / delivered / viewed / failed times. Never deleted or rewritten (triggers). Viewable from *Messages* and from a customer's *Messages* tab with search (customer, address, subject, registration, job / quote / invoice / payment numbers), filters (customer, record, channel, status, type, dates) and pagination. Needs `notification.view_history` and the Team plan (`communication_history`); recording happens on every plan. Part 4's earlier money-message log was migrated into this history (its delivery outcome had not been tracked, which the entries say).

## Templates (`notifications/render.ts`, `templates-admin.ts`)

Every event and channel has standard wording that cannot be switched off. A business may replace it (Team and above, `custom_templates`, `notification.manage_templates`), preview it, switch its own wording off to fall back, and every change is audited. A template is plain text with `{{placeholders}}` from the event's allowed list only: no expressions, loops, lookups or code. Rendering is one pass; a placeholder value that itself contains braces is not expanded; only the template's own properties are read (a test caught and fixed `{{constructor}}` reading inherited properties). Unknown placeholders are refused when saving; a template that has become invalid is ignored at send time in favour of the standard wording. Email HTML is built by escaping everything first. Previews use made-up sample values, never real customer data.

## Reminders (`notifications/reminders.ts`)

* **Service reminders**: from each vehicle's service intervals. Next due = last service date + interval months and/or last service km + interval km. A reminder goes out when the date is within the business's lead days or the vehicle's mileage within the lead km (whichever first; overdue still counts), once per due point (`service_reminder_log` unique key, so the next service creates a new due point). Respects the customer's switches, the vehicle's and customer's status, the plan feature and the business switch; a customer who opted out is remembered, not retried. Nothing is predicted.
* **Booking reminders**: confirmed or moved bookings starting within the business's window (default 24 h) are reminded once and marked `REMINDER_SENT`.
* **Invoice reminders and overdue notices** (Part 4 scheduler) and **quote expiring** (3 days before) use the same service.
* The scheduler runs these every 10 minutes (idempotent, safe with several workers).

## In-app notification centre

`/notifications`, a bell with the unread count in the header (phone and desktop). A person sees only their own; they can open (marks read), mark read or unread, and mark all read; paginated. Each notification has a type, title, message, related record, priority, times. Repetitive **low-priority** events of one kind fold into a single unread notification ("× 5"); **high-priority** (money, security, failures) are never folded. Links are always paths inside the app. Security alerts (also emailed; cannot be switched off) appear in every business the person works in; trial and payment warnings reach the people who handle billing.

Business settings (Settings → Communication) choose who is told inside the business about low stock, purchase orders, quotes, payments, bookings and job changes (people holding a chosen permission, in the app and/or by email). Security and billing alerts are not tunable. Needs `notification.manage_settings`; changing the audience needs the Team plan.

## Permissions added

`notification.view_history`, `notification.send`, `notification.manage_templates`, `notification.manage_settings`, `notification.manage_preferences`. The centre itself is for every member. Advisors and accounts can view history, send a message to one customer and (advisors) manage preferences; managers get all five; technicians get none.

## Known limits (honest list)

* **SMS and WhatsApp are provider-ready, not live.** A Twilio driver exists and is unit-tested (request shape, signature check, status mapping), but it has **not** been run against a real Twilio account, and no account is configured. Until `SMS_DRIVER` / `WHATSAPP_DRIVER` are set those channels record "not set up".
* WhatsApp business-initiated messages normally require pre-approved provider templates; this build sends the template text as a plain message and does not model the provider's template approval.
* Email delivery/open tracking is not available (SMTP only confirms submission), so email never reaches Delivered or Viewed.
* Security, account and billing emails to *staff* still use the platform email queue directly (by design: platform-controlled). They are mirrored in the in-app centre but not listed in the customer communication history.
* Locations have no contact details of their own in this model, so messages use the business identity (the location's name is available as `{{location_name}}`).
* No inbound handling (replies, STOP keywords) for SMS or WhatsApp.
* The `email.send` payload of platform emails and the `comm.deliver` payload both hold message content until the message is sent; the delivery payload is scrubbed on success.

# API reference

Generated from the route table by `npm run docs:api` (a test fails if this file is out of date). It lists every endpoint with the protection the code
applies; it is not a hand-written description of what an endpoint is supposed to do.

## Conventions

* **Base path:** `/api/v1` for the application, `/api/public` for the customer pages (quote, invoice, job link, receipt, opt-out) and `/api/webhooks` for provider callbacks.
* **Authentication:** an HTTP-only session cookie set by sign-in. There are no API keys. `public` endpoints need no session: the secret in the link (or the provider's signature) is the credential.
* **Request checks, in order:** request id -> cross-site check (state-changing requests must come from this site) -> session -> email verification -> business membership -> permission -> plan feature -> subscription (writes) -> rate limit. A handler cannot skip a step.
* **Business context:** the active business comes from the session, never from the request. A business id, role, price, balance or status sent in a body is ignored or refused.
* **Responses:** `{ "data": ..., "meta": ... }` on success; `{ "error": { "code", "message", "details" } }` on failure. Error codes include `UNAUTHENTICATED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404, also used for another business's records), `VALIDATION_ERROR` (422, with per-field `details`), `CONFLICT` (409), `FEATURE_NOT_IN_PLAN` and `PLAN_LIMIT_REACHED` (402), `SUBSCRIPTION_INACTIVE` (402, read-only mode) and `RATE_LIMITED` (429 with `Retry-After`). Errors never carry stack traces, SQL or file paths; the `x-request-id` response header identifies the request in the logs.
* **Pagination:** list endpoints take `page` and `pageSize` (capped) and return `meta: { page, pageSize, total, totalPages }`. Search is ordinary database matching with wildcards treated literally.
* **Idempotency:** endpoints that move money or stock (payments, refunds, goods receipts, stock adjustments, timers) accept an `idempotencyKey`; repeating a request with the same key returns the first result and changes nothing. Webhooks are de-duplicated by the provider's event id.
* **Audit:** every state change in a business writes an audit entry (who, what, before/after); the audit log is append-only.

## Columns

* **Access** - `public` (link or signature), `user` (any signed-in person), `business` (a member of the active business), `platform` (TFME staff only).
* **Permission** - what the member needs (any one of the listed); `any member` means every active member.
* **Plan feature** - the plan entitlement the endpoint requires (402 otherwise).
* **Write** - blocked while the subscription is read-only (expired or suspended).
* **Rate limit** - an additional limit on top of the general per-user and per-address limits.

421 endpoints.

## account

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/account/deactivate` | user | - | - | - | - |
| POST | `/api/v1/account/email` | user | - | - | - | - |
| POST | `/api/v1/account/mfa/disable` | user | - | - | - | - |
| POST | `/api/v1/account/mfa/enable` | user | - | - | - | - |
| POST | `/api/v1/account/mfa/recovery-codes` | user | - | - | - | - |
| GET | `/api/v1/account/mfa` | user | - | - | - | - |
| POST | `/api/v1/account/mfa/setup` | user | - | - | - | - |
| GET | `/api/v1/account/notifications` | user | - | - | - | - |
| PUT | `/api/v1/account/notifications` | user | - | - | - | - |
| GET | `/api/v1/account/photo` | user | - | - | - | - |
| POST | `/api/v1/account/photo` | user | - | - | - | 20/3600s |
| DELETE | `/api/v1/account/photo` | user | - | - | - | - |
| GET | `/api/v1/account` | user | - | - | - | - |
| PATCH | `/api/v1/account` | user | - | - | - | - |
| GET | `/api/v1/account/security-events` | user | - | - | - | - |
| DELETE | `/api/v1/account/sessions/{id}` | user | - | - | - | - |
| POST | `/api/v1/account/sessions/revoke-others` | user | - | - | - | - |
| GET | `/api/v1/account/sessions` | user | - | - | - | - |

## admin

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/admin/alerts` | business | any member | - | - | - |
| POST | `/api/v1/admin/archive/{kind}/{id}/restore` | business | admin.view | advanced_admin | yes | - |
| GET | `/api/v1/admin/archive/{kind}` | business | admin.view | advanced_admin | - | - |
| GET | `/api/v1/admin/audit/export` | business | audit.view | - | - | - |
| GET | `/api/v1/admin/audit` | business | audit.view | - | - | - |
| GET | `/api/v1/admin/overview` | business | admin.view | - | - | - |
| GET | `/api/v1/admin/search` | business | admin.view | advanced_admin | - | - |
| GET | `/api/v1/admin/security-events` | business | security.view_events | advanced_admin | - | - |
| GET | `/api/v1/admin/setup` | business | settings.view | - | - | - |
| GET | `/api/v1/admin/sign-in-status` | business | security.view_events | advanced_admin | - | - |

## audit

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/audit` | business | audit.view | - | - | - |

## auth

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/auth/change-password` | user | - | - | - | - |
| POST | `/api/v1/auth/confirm-email-change` | public | - | - | - | 20/3600s per ip |
| POST | `/api/v1/auth/forgot-password` | public | - | - | - | - |
| POST | `/api/v1/auth/login` | public | - | - | - | - |
| POST | `/api/v1/auth/logout` | user | - | - | - | - |
| POST | `/api/v1/auth/mfa/verify` | public | - | - | - | - |
| POST | `/api/v1/auth/register` | public | - | - | - | - |
| POST | `/api/v1/auth/resend-verification` | user | - | - | - | - |
| POST | `/api/v1/auth/reset-password` | public | - | - | - | - |
| POST | `/api/v1/auth/verify-email` | public | - | - | - | 20/3600s per ip |

## billing

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/billing/cancel` | business | settings.manage_billing | - | - | 5/3600s |
| POST | `/api/v1/billing/checkout` | business | settings.manage_billing | - | - | 10/3600s |
| POST | `/api/v1/billing/downgrade` | business | settings.manage_billing | - | - | 10/3600s |
| DELETE | `/api/v1/billing/downgrade` | business | settings.manage_billing | - | - | - |
| GET | `/api/v1/billing/entitlements` | business | any member | - | - | - |
| GET | `/api/v1/billing/invoices` | business | settings.manage_billing | - | - | - |
| GET | `/api/v1/billing/plan-change` | business | settings.manage_billing | - | - | - |
| GET | `/api/v1/billing` | business | settings.manage_billing | - | - | - |

## bookings

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/bookings/{id}/cancel` | business | booking.cancel | - | yes | - |
| POST | `/api/v1/bookings/{id}/check-in` | business | booking.edit | - | yes | - |
| POST | `/api/v1/bookings/{id}/reschedule` | business | booking.reschedule | - | yes | - |
| GET | `/api/v1/bookings/{id}` | business | booking.view | - | - | - |
| PATCH | `/api/v1/bookings/{id}` | business | booking.edit | - | yes | - |
| POST | `/api/v1/bookings/{id}/status` | business | booking.edit | - | yes | - |
| GET | `/api/v1/bookings/calendar` | business | booking.view | - | - | - |
| POST | `/api/v1/bookings/recurring/{id}/cancel` | business | booking.cancel | - | yes | - |
| GET | `/api/v1/bookings/recurring` | business | booking.view | - | - | - |
| POST | `/api/v1/bookings/recurring` | business | booking.create | - | yes | - |
| GET | `/api/v1/bookings` | business | booking.view | - | - | - |
| POST | `/api/v1/bookings` | business | booking.create | - | yes | - |
| GET | `/api/v1/bookings/slots` | business | booking.view | - | - | - |
| POST | `/api/v1/bookings/waiting-list/{id}/convert` | business | booking.create | - | yes | - |
| PATCH | `/api/v1/bookings/waiting-list/{id}` | business | booking.edit | - | yes | - |
| GET | `/api/v1/bookings/waiting-list` | business | booking.view | - | - | - |
| POST | `/api/v1/bookings/waiting-list` | business | booking.create | - | yes | - |

## business

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/business/close` | business | business.close | - | - | 5/3600s |
| GET | `/api/v1/business/logo` | business | any member | - | - | - |
| POST | `/api/v1/business/logo` | business | business.edit | - | yes | - |
| POST | `/api/v1/business/mfa-requirement` | business | settings.manage_security | mfa_enforcement | yes | - |
| GET | `/api/v1/business` | business | business.view or settings.view | - | - | - |
| PATCH | `/api/v1/business` | business | business.edit | - | yes | - |
| POST | `/api/v1/business/transfer-ownership` | business | business.transfer_ownership | - | yes | 5/3600s |

## businesses

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/businesses` | user | - | - | - | - |
| POST | `/api/v1/businesses/switch` | user | - | - | - | - |

## communication

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/communication/settings` | business | notification.manage_settings | - | - | - |
| PUT | `/api/v1/communication/settings` | business | notification.manage_settings | - | yes | - |
| POST | `/api/v1/communication/templates/active` | business | notification.manage_templates | - | yes | - |
| POST | `/api/v1/communication/templates/preview` | business | notification.manage_templates | - | - | 120/60s |
| GET | `/api/v1/communication/templates` | business | notification.manage_templates | - | - | - |
| PUT | `/api/v1/communication/templates` | business | notification.manage_templates | custom_templates | yes | - |

## communications

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/communications/{id}/cancel` | business | notification.send | - | yes | - |
| POST | `/api/v1/communications/{id}/retry` | business | notification.send | - | yes | 30/3600s |
| GET | `/api/v1/communications/{id}` | business | notification.view_history | communication_history | - | - |
| GET | `/api/v1/communications` | business | notification.view_history | communication_history | - | - |
| POST | `/api/v1/communications/send` | business | notification.send | - | yes | 30/3600s |
| GET | `/api/v1/communications/summary` | business | notification.view_history | communication_history | - | - |

## credit-notes

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/credit-notes/{id}/cancel` | business | credit_note.create | - | yes | - |
| POST | `/api/v1/credit-notes/{id}/issue` | business | credit_note.authorise | - | yes | - |
| GET | `/api/v1/credit-notes/{id}/pdf` | business | credit_note.view | - | - | - |
| GET | `/api/v1/credit-notes/{id}` | business | credit_note.view | - | - | - |
| GET | `/api/v1/credit-notes` | business | credit_note.view | - | - | - |
| POST | `/api/v1/credit-notes` | business | credit_note.create | - | yes | - |

## customers

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/customers/{id}/archive` | business | customer.archive | - | yes | - |
| GET | `/api/v1/customers/{id}/communication` | business | customer.view | - | - | - |
| PUT | `/api/v1/customers/{id}/communication` | business | notification.manage_preferences | - | yes | - |
| POST | `/api/v1/customers/{id}/consent` | business | notification.manage_preferences | - | yes | - |
| GET | `/api/v1/customers/{id}/credit` | business | payment.view or invoice.view | - | - | - |
| GET | `/api/v1/customers/{id}/financials` | business | invoice.view or quote.view or payment.view | - | - | - |
| GET | `/api/v1/customers/{id}/overview` | business | customer.view | - | - | - |
| GET | `/api/v1/customers/{id}` | business | customer.view | - | - | - |
| PATCH | `/api/v1/customers/{id}` | business | customer.edit | - | yes | - |
| GET | `/api/v1/customers/{id}/statement/pdf` | business | invoice.view | - | - | - |
| GET | `/api/v1/customers/{id}/statement` | business | invoice.view | - | - | - |
| POST | `/api/v1/customers/{id}/status` | business | customer.edit | - | yes | - |
| GET | `/api/v1/customers/{id}/timeline` | business | customer.view | - | - | - |
| GET | `/api/v1/customers` | business | customer.view | - | - | - |
| POST | `/api/v1/customers` | business | customer.create | - | yes | - |

## documents

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/documents/generate` | business | document.view | - | - | 60/60s |
| POST | `/api/v1/documents/generations/{id}/retry` | business | document.manage | - | yes | - |
| GET | `/api/v1/documents/generations` | business | document.manage | - | - | - |

## exports

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/exports/{id}/download` | business | business.export | - | - | - |
| GET | `/api/v1/exports` | business | business.export | - | - | - |
| POST | `/api/v1/exports` | business | business.export | data_export | - | - |

## files

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/files/{id}/archive` | business | document.delete | - | yes | - |
| GET | `/api/v1/files/{id}/details` | business | document.view | - | - | - |
| POST | `/api/v1/files/{id}/link` | business | document.download | - | - | 120/60s |
| POST | `/api/v1/files/{id}/purge` | business | document.purge | - | yes | - |
| POST | `/api/v1/files/{id}/restore` | business | document.delete | - | yes | - |
| GET | `/api/v1/files/{id}` | business | document.download | - | - | 600/60s |
| PATCH | `/api/v1/files/{id}` | business | document.edit | - | yes | - |
| POST | `/api/v1/files/{id}/trash` | business | document.delete | - | yes | - |
| GET | `/api/v1/files/{id}/versions` | business | document.view | - | - | - |
| POST | `/api/v1/files/{id}/versions` | business | document.upload | - | yes | 120/60s |
| POST | `/api/v1/files/{id}/visibility` | business | document.edit | - | yes | - |
| POST | `/api/v1/files/categories/{id}` | business | document.manage | advanced_documents | yes | - |
| GET | `/api/v1/files/categories` | business | document.view | - | - | - |
| POST | `/api/v1/files/categories` | business | document.manage | advanced_documents | yes | - |
| POST | `/api/v1/files/reconcile` | business | document.manage | - | - | 10/3600s |
| GET | `/api/v1/files` | business | document.view | - | - | - |
| POST | `/api/v1/files` | business | document.upload | - | yes | 120/60s |
| GET | `/api/v1/files/settings` | business | document.view | - | - | - |
| PUT | `/api/v1/files/settings` | business | document.manage | advanced_documents | yes | - |
| GET | `/api/v1/files/usage` | business | document.view | - | - | - |

## finance

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/finance/ageing` | business | finance.view_reports | - | - | - |
| GET | `/api/v1/finance/dashboard` | business | finance.view_reports | - | - | - |
| GET | `/api/v1/finance/export` | business | finance.export | - | - | - |
| PATCH | `/api/v1/finance/labour-rates/{id}` | business | finance.manage_settings | - | yes | - |
| GET | `/api/v1/finance/labour-rates` | business | finance.manage_settings | - | - | - |
| PATCH | `/api/v1/finance/locations/{id}` | business | finance.manage_settings | - | yes | - |
| GET | `/api/v1/finance/payment-analytics` | business | finance.view_reports | - | - | - |
| GET | `/api/v1/finance/profitability` | business | finance.view_reports | - | - | - |
| GET | `/api/v1/finance/quote-analytics` | business | finance.view_reports | - | - | - |
| GET | `/api/v1/finance/search` | business | invoice.view or quote.view or payment.view or credit_note.view | - | - | - |
| GET | `/api/v1/finance/settings` | business | settings.view | - | - | - |
| PATCH | `/api/v1/finance/settings` | business | finance.manage_settings | - | yes | - |
| GET | `/api/v1/finance/vat` | business | finance.view_reports | - | - | - |

## imports

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/imports/{id}/commit` | business | data.import | - | yes | - |
| GET | `/api/v1/imports/{id}/problems` | business | data.import | - | - | - |
| GET | `/api/v1/imports/{id}` | business | data.import | - | - | - |
| DELETE | `/api/v1/imports/{id}` | business | data.import | - | yes | - |
| POST | `/api/v1/imports/{id}/validate` | business | data.import | - | yes | - |
| GET | `/api/v1/imports` | business | data.import | - | - | - |
| POST | `/api/v1/imports` | business | data.import | - | yes | - |

## inventory

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/inventory/categories/{id}/archive` | business | inventory.edit | - | yes | - |
| PATCH | `/api/v1/inventory/categories/{id}` | business | inventory.edit | - | yes | - |
| GET | `/api/v1/inventory/categories` | business | inventory.view | - | - | - |
| POST | `/api/v1/inventory/categories` | business | inventory.edit | - | yes | - |
| GET | `/api/v1/inventory/dashboard` | business | inventory.view | - | - | - |
| GET | `/api/v1/inventory/export` | business | inventory.export | - | - | - |
| GET | `/api/v1/inventory/movements` | business | inventory.view | - | - | - |
| POST | `/api/v1/inventory/parts/{id}/bin` | business | inventory.edit | - | yes | - |
| DELETE | `/api/v1/inventory/parts/{id}/compatibility/{ruleId}` | business | inventory.edit | - | yes | - |
| POST | `/api/v1/inventory/parts/{id}/compatibility` | business | inventory.edit | - | yes | - |
| GET | `/api/v1/inventory/parts/{id}/jobs` | business | inventory.view | - | - | - |
| GET | `/api/v1/inventory/parts/{id}/movements` | business | inventory.view | - | - | - |
| GET | `/api/v1/inventory/parts/{id}/prices` | business | inventory.view_costs | - | - | - |
| GET | `/api/v1/inventory/parts/{id}/purchases` | business | inventory.view | - | - | - |
| GET | `/api/v1/inventory/parts/{id}` | business | inventory.view | - | - | - |
| PATCH | `/api/v1/inventory/parts/{id}` | business | inventory.edit | - | yes | - |
| POST | `/api/v1/inventory/parts/{id}/status` | business | inventory.edit | - | yes | - |
| GET | `/api/v1/inventory/parts/{id}/stock` | business | inventory.view | - | - | - |
| DELETE | `/api/v1/inventory/parts/{id}/suppliers/{supplierId}` | business | inventory.edit | - | yes | - |
| POST | `/api/v1/inventory/parts/{id}/suppliers` | business | inventory.edit | - | yes | - |
| POST | `/api/v1/inventory/parts/bulk` | business | inventory.edit | bulk_inventory | yes | - |
| POST | `/api/v1/inventory/parts/import` | business | inventory.import | bulk_inventory | yes | 30/3600s |
| GET | `/api/v1/inventory/parts/lookup` | business | inventory.view | barcode_workflows | - | - |
| GET | `/api/v1/inventory/parts` | business | inventory.view | - | - | - |
| POST | `/api/v1/inventory/parts` | business | inventory.create | - | yes | - |
| GET | `/api/v1/inventory/reports/low-stock` | business | inventory.view | - | - | - |
| GET | `/api/v1/inventory/reports/margins` | business | inventory.view_costs | inventory_reports | - | - |
| GET | `/api/v1/inventory/reports/movements` | business | inventory.view | - | - | - |
| GET | `/api/v1/inventory/reports/purchases` | business | inventory.view_costs | inventory_reports | - | - |
| GET | `/api/v1/inventory/reports/usage` | business | inventory.view | - | - | - |
| GET | `/api/v1/inventory/reports/valuation` | business | inventory.view_costs | inventory_reports | - | - |
| GET | `/api/v1/inventory/settings` | business | inventory.view | - | - | - |
| PATCH | `/api/v1/inventory/settings` | business | inventory.manage_settings | - | yes | - |
| POST | `/api/v1/inventory/stock/adjust` | business | inventory.adjust | - | yes | - |
| GET | `/api/v1/inventory/suppliers/{id}/history` | business | inventory.view | - | - | - |
| GET | `/api/v1/inventory/suppliers/{id}` | business | inventory.view | - | - | - |
| PATCH | `/api/v1/inventory/suppliers/{id}` | business | inventory.manage_suppliers | - | yes | - |
| POST | `/api/v1/inventory/suppliers/{id}/status` | business | inventory.manage_suppliers | - | yes | - |
| GET | `/api/v1/inventory/suppliers` | business | inventory.view | - | - | - |
| POST | `/api/v1/inventory/suppliers` | business | inventory.manage_suppliers | - | yes | - |

## invitations

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/invitations/accept` | user | - | - | - | 20/3600s |

## invoices

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/invoices/{id}/apply-credit` | business | payment.apply_credit | - | yes | - |
| POST | `/api/v1/invoices/{id}/cancel` | business | invoice.cancel | - | yes | - |
| POST | `/api/v1/invoices/{id}/finalise` | business | invoice.finalise | - | yes | - |
| GET | `/api/v1/invoices/{id}/pdf` | business | invoice.view | - | - | - |
| GET | `/api/v1/invoices/{id}` | business | invoice.view | - | - | - |
| PATCH | `/api/v1/invoices/{id}` | business | invoice.edit | - | yes | - |
| POST | `/api/v1/invoices/{id}/send` | business | invoice.send | - | yes | - |
| POST | `/api/v1/invoices/{id}/write-off` | business | invoice.write_off | - | yes | - |
| GET | `/api/v1/invoices` | business | invoice.view | - | - | - |
| POST | `/api/v1/invoices` | business | invoice.create | - | yes | - |

## jobs

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/jobs/{id}/assign` | business | job.assign | - | yes | - |
| GET | `/api/v1/jobs/{id}/assignments` | business | job.view | - | - | - |
| PATCH | `/api/v1/jobs/{id}/check-in` | business | job.edit | - | yes | - |
| POST | `/api/v1/jobs/{id}/customer-link` | business | document.share | - | yes | 60/3600s |
| POST | `/api/v1/jobs/{id}/diagnoses/{diagnosisId}/confirm` | business | job.inspect | - | yes | - |
| PATCH | `/api/v1/jobs/{id}/diagnoses/{diagnosisId}` | business | job.inspect | - | yes | - |
| POST | `/api/v1/jobs/{id}/diagnoses` | business | job.inspect | - | yes | - |
| GET | `/api/v1/jobs/{id}/finance` | business | job.view | - | - | - |
| POST | `/api/v1/jobs/{id}/inspection/complete` | business | job.inspect | - | yes | - |
| PATCH | `/api/v1/jobs/{id}/inspection/items/{itemId}` | business | job.inspect | - | yes | - |
| POST | `/api/v1/jobs/{id}/inspection/items` | business | job.inspect | - | yes | - |
| POST | `/api/v1/jobs/{id}/inspection` | business | job.inspect | - | yes | - |
| PATCH | `/api/v1/jobs/{id}/inspection` | business | job.inspect | - | yes | - |
| POST | `/api/v1/jobs/{id}/invoice` | business | invoice.create | - | yes | - |
| DELETE | `/api/v1/jobs/{id}/labour/{labourId}` | business | job.edit | - | yes | - |
| POST | `/api/v1/jobs/{id}/labour` | business | job.edit | - | yes | - |
| PATCH | `/api/v1/jobs/{id}/notes/{noteId}` | business | job.edit | - | yes | - |
| POST | `/api/v1/jobs/{id}/notes` | business | job.edit | - | yes | - |
| PATCH | `/api/v1/jobs/{id}/parts/{partId}` | business | job.edit | - | yes | - |
| DELETE | `/api/v1/jobs/{id}/parts/{partId}` | business | job.edit | - | yes | - |
| POST | `/api/v1/jobs/{id}/parts` | business | job.edit | - | yes | - |
| PATCH | `/api/v1/jobs/{id}/photos/{photoId}` | business | job.edit | - | yes | - |
| DELETE | `/api/v1/jobs/{id}/photos/{photoId}` | business | job.edit | - | yes | - |
| GET | `/api/v1/jobs/{id}/photos` | business | job.view | - | - | - |
| POST | `/api/v1/jobs/{id}/photos` | business | job.edit | - | yes | 60/60s |
| POST | `/api/v1/jobs/{id}/quality-check` | business | job.quality_check | - | yes | - |
| POST | `/api/v1/jobs/{id}/recommended-work/{workId}/decision` | business | job.approve_work | - | yes | - |
| PATCH | `/api/v1/jobs/{id}/recommended-work/{workId}` | business | job.inspect | - | yes | - |
| DELETE | `/api/v1/jobs/{id}/recommended-work/{workId}` | business | job.inspect | - | yes | - |
| GET | `/api/v1/jobs/{id}/recommended-work` | business | job.view | - | - | - |
| POST | `/api/v1/jobs/{id}/recommended-work` | business | job.inspect | - | yes | - |
| GET | `/api/v1/jobs/{id}/report` | business | job.view | - | - | - |
| GET | `/api/v1/jobs/{id}` | business | job.view | - | - | - |
| PATCH | `/api/v1/jobs/{id}` | business | job.edit | - | yes | - |
| POST | `/api/v1/jobs/{id}/status` | business | job.view | - | yes | - |
| GET | `/api/v1/jobs/{id}/timeline` | business | job.view | - | - | - |
| POST | `/api/v1/jobs/from-template` | business | job.create | advanced_settings | yes | - |
| GET | `/api/v1/jobs/mine` | business | job.view | - | - | - |
| GET | `/api/v1/jobs` | business | job.view | - | - | - |
| POST | `/api/v1/jobs` | business | job.create | - | yes | - |

## locations

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| PATCH | `/api/v1/locations/{id}` | business | settings.edit or location.manage | - | yes | - |
| DELETE | `/api/v1/locations/{id}` | business | settings.edit or location.manage | - | yes | - |
| GET | `/api/v1/locations` | business | settings.view | - | - | - |
| POST | `/api/v1/locations` | business | settings.edit or location.manage | - | yes | - |

## me

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/me` | user | - | - | - | - |

## members

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/members/{id}/resend` | business | employee.invite | - | yes | - |
| PATCH | `/api/v1/members/{id}` | business | employee.manage_roles | - | yes | - |
| DELETE | `/api/v1/members/{id}` | business | employee.invite | - | yes | - |
| POST | `/api/v1/members/{id}/status` | business | employee.suspend | - | yes | - |
| GET | `/api/v1/members` | business | employee.view | - | - | - |
| POST | `/api/v1/members` | business | employee.invite | - | yes | - |

## notifications

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/notifications/{id}/read` | business | any member | - | - | - |
| DELETE | `/api/v1/notifications/{id}/read` | business | any member | - | - | - |
| GET | `/api/v1/notifications/count` | business | any member | - | - | - |
| POST | `/api/v1/notifications/read-all` | business | any member | - | - | - |
| GET | `/api/v1/notifications` | business | any member | - | - | - |

## payments

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/payments/{id}/reconcile` | business | payment.reconcile | - | yes | - |
| POST | `/api/v1/payments/{id}/refund` | business | payment.refund | - | yes | - |
| GET | `/api/v1/payments/{id}` | business | payment.view | - | - | - |
| GET | `/api/v1/payments` | business | payment.view | - | - | - |
| POST | `/api/v1/payments` | business | payment.create | - | yes | - |

## platform

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/platform/businesses/{id}/custom-plan` | platform | - | - | - | - |
| GET | `/api/platform/businesses` | platform | - | - | - | - |

## public

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/public/files/{token}` | public | - | - | - | 60/60s per ip |
| GET | `/api/public/invoices/{token}/logo` | public | - | - | - | 60/60s per ip |
| POST | `/api/public/invoices/{token}/pay` | public | - | - | - | 10/60s per ip |
| GET | `/api/public/invoices/{token}/pdf` | public | - | - | - | 30/60s per ip |
| GET | `/api/public/invoices/{token}` | public | - | - | - | 60/60s per ip |
| GET | `/api/public/jobs/{token}/files/{fileId}` | public | - | - | - | 120/60s per ip |
| GET | `/api/public/jobs/{token}/logo` | public | - | - | - | 60/60s per ip |
| GET | `/api/public/jobs/{token}` | public | - | - | - | 60/60s per ip |
| POST | `/api/public/optout/{token}` | public | - | - | - | 20/60s per ip |
| GET | `/api/public/payments/status` | public | - | - | - | 60/60s per ip |
| POST | `/api/public/quotes/{token}/decision` | public | - | - | - | 20/60s per ip |
| GET | `/api/public/quotes/{token}/logo` | public | - | - | - | 60/60s per ip |
| GET | `/api/public/quotes/{token}/pdf` | public | - | - | - | 30/60s per ip |
| GET | `/api/public/quotes/{token}` | public | - | - | - | 60/60s per ip |
| POST | `/api/public/webhooks/twilio` | public | - | - | - | 600/60s per ip |

## purchase-orders

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/purchase-orders/{id}/approve` | business | inventory.approve_purchase | purchase_orders | yes | - |
| POST | `/api/v1/purchase-orders/{id}/cancel` | business | inventory.purchase | purchase_orders | yes | - |
| POST | `/api/v1/purchase-orders/{id}/close-short` | business | inventory.receive | purchase_orders | yes | - |
| POST | `/api/v1/purchase-orders/{id}/email` | business | inventory.purchase | purchase_orders | yes | 30/3600s |
| POST | `/api/v1/purchase-orders/{id}/order` | business | inventory.purchase | purchase_orders | yes | - |
| GET | `/api/v1/purchase-orders/{id}/pdf` | business | inventory.view_costs | purchase_orders | - | - |
| POST | `/api/v1/purchase-orders/{id}/receive` | business | inventory.receive | purchase_orders | yes | - |
| POST | `/api/v1/purchase-orders/{id}/reject` | business | inventory.approve_purchase | purchase_orders | yes | - |
| POST | `/api/v1/purchase-orders/{id}/reopen` | business | inventory.purchase | purchase_orders | yes | - |
| GET | `/api/v1/purchase-orders/{id}` | business | inventory.view | - | - | - |
| PATCH | `/api/v1/purchase-orders/{id}` | business | inventory.purchase | purchase_orders | yes | - |
| POST | `/api/v1/purchase-orders/{id}/submit` | business | inventory.purchase | purchase_orders | yes | - |
| GET | `/api/v1/purchase-orders` | business | inventory.view | - | - | - |
| POST | `/api/v1/purchase-orders` | business | inventory.purchase | purchase_orders | yes | - |

## quotes

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/quotes/{id}/approve` | business | quote.approve | - | yes | - |
| POST | `/api/v1/quotes/{id}/cancel` | business | quote.cancel | - | yes | - |
| POST | `/api/v1/quotes/{id}/create-job` | business | job.create | - | yes | - |
| POST | `/api/v1/quotes/{id}/invoice` | business | invoice.create | - | yes | - |
| GET | `/api/v1/quotes/{id}/pdf` | business | quote.view | - | - | - |
| GET | `/api/v1/quotes/{id}` | business | quote.view | - | - | - |
| PATCH | `/api/v1/quotes/{id}` | business | quote.edit | - | yes | - |
| POST | `/api/v1/quotes/{id}/send` | business | quote.send | - | yes | - |
| GET | `/api/v1/quotes` | business | quote.view | - | - | - |
| POST | `/api/v1/quotes` | business | quote.create | - | yes | - |

## receipts

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/receipts/{id}/pdf` | business | payment.view | - | - | - |
| GET | `/api/v1/receipts` | business | payment.view | - | - | - |

## receipts-in

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/receipts-in` | business | inventory.view | - | - | - |

## reports

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/reports/{key}/export` | business | report.export | - | - | - |
| GET | `/api/v1/reports/{key}` | business | report.view | - | - | - |
| POST | `/api/v1/reports/custom/run` | business | report.create_custom | custom_reports | - | - |
| GET | `/api/v1/reports/custom/schema` | business | report.create_custom | custom_reports | - | - |
| GET | `/api/v1/reports` | business | report.view | - | - | - |
| GET | `/api/v1/reports/saved/{id}/export` | business | report.export | - | - | - |
| GET | `/api/v1/reports/saved/{id}` | business | report.view | - | - | - |
| PATCH | `/api/v1/reports/saved/{id}` | business | report.view | - | yes | - |
| DELETE | `/api/v1/reports/saved/{id}` | business | report.view | - | yes | - |
| GET | `/api/v1/reports/saved/{id}/run` | business | report.view | - | - | - |
| GET | `/api/v1/reports/saved` | business | report.view | - | - | - |
| POST | `/api/v1/reports/saved` | business | report.view | - | yes | - |
| PATCH | `/api/v1/reports/schedules/{id}` | business | report.manage_scheduled | - | yes | - |
| DELETE | `/api/v1/reports/schedules/{id}` | business | report.manage_scheduled | - | yes | - |
| GET | `/api/v1/reports/schedules` | business | report.manage_scheduled | - | - | - |
| POST | `/api/v1/reports/schedules` | business | report.manage_scheduled | scheduled_reports | yes | - |

## role-definitions

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| PATCH | `/api/v1/role-definitions/{id}` | business | employee.manage_roles | custom_roles | yes | - |
| DELETE | `/api/v1/role-definitions/{id}` | business | employee.manage_roles | - | yes | - |
| GET | `/api/v1/role-definitions` | business | employee.view | - | - | - |
| POST | `/api/v1/role-definitions` | business | employee.manage_roles | custom_roles | yes | - |

## roles

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/roles` | business | employee.view | - | - | - |

## search

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/search` | business | 
      customer.view or vehicle.view or job.view or invoice.view or quote.view or inventory.view or inventory.view or employee.view or document.view or  | - | - | 120/60s |

## settings

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/settings/inventory-defaults` | business | settings.view | - | - | - |
| PATCH | `/api/v1/settings/inventory-defaults` | business | inventory.manage_settings | - | yes | - |
| PATCH | `/api/v1/settings/job-templates/{id}` | business | settings.manage_workshop | advanced_settings | yes | - |
| GET | `/api/v1/settings/job-templates` | business | job.view | - | - | - |
| POST | `/api/v1/settings/job-templates` | business | settings.manage_workshop | advanced_settings | yes | - |
| GET | `/api/v1/settings/jobs` | business | settings.view | - | - | - |
| PATCH | `/api/v1/settings/jobs` | business | settings.manage_workshop | advanced_settings | yes | - |
| GET | `/api/v1/settings/labour` | business | settings.view | - | - | - |
| PATCH | `/api/v1/settings/labour` | business | labour.manage_rates | advanced_settings | yes | - |
| GET | `/api/v1/settings/numbering` | business | settings.view | - | - | - |
| PATCH | `/api/v1/settings/numbering` | business | settings.view | - | yes | - |
| GET | `/api/v1/settings/reporting` | business | settings.view | - | - | - |
| PATCH | `/api/v1/settings/reporting` | business | settings.edit | - | yes | - |
| GET | `/api/v1/settings/retention` | business | settings.view | - | - | - |
| PATCH | `/api/v1/settings/retention` | business | settings.edit | - | yes | - |
| GET | `/api/v1/settings/security` | business | settings.view | - | - | - |
| PATCH | `/api/v1/settings/security` | business | settings.manage_security | - | yes | - |
| GET | `/api/v1/settings/services/{id}/line` | business | quote.create or invoice.create | - | - | - |
| PATCH | `/api/v1/settings/services/{id}` | business | settings.manage_workshop | advanced_settings | yes | - |
| GET | `/api/v1/settings/services` | business | settings.view | - | - | - |
| POST | `/api/v1/settings/services` | business | settings.manage_workshop | advanced_settings | yes | - |
| GET | `/api/v1/settings/vehicles` | business | settings.view | - | - | - |
| PATCH | `/api/v1/settings/vehicles` | business | settings.manage_workshop | advanced_settings | yes | - |

## supplier-returns

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/supplier-returns` | business | inventory.view | - | - | - |
| POST | `/api/v1/supplier-returns` | business | inventory.return | purchase_orders | yes | - |

## team

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| PATCH | `/api/v1/team/employees/{id}/locations` | business | employee.edit | multi_location | yes | - |
| GET | `/api/v1/team/employees/{id}` | business | employee.view | - | - | - |
| GET | `/api/v1/team/employees` | business | employee.view | - | - | - |
| GET | `/api/v1/team/export` | business | report.export | - | - | - |
| PUT | `/api/v1/team/rates/default` | business | labour.manage_rates | - | yes | - |
| GET | `/api/v1/team/rates` | business | labour.view_rates or labour.manage_rates | - | - | - |
| PUT | `/api/v1/team/rates/service/{id}` | business | labour.manage_rates | - | yes | - |
| GET | `/api/v1/team/seats` | business | employee.view | - | - | - |
| GET | `/api/v1/team/technicians/{id}/metrics` | business | any member | technician_management | - | - |
| GET | `/api/v1/team/technicians/{id}` | business | employee.view | - | - | - |
| PATCH | `/api/v1/team/technicians/{id}` | business | employee.manage_technicians | technician_management | yes | - |
| POST | `/api/v1/team/time/{id}/approve` | business | time.approve | technician_management | yes | - |
| POST | `/api/v1/team/time/{id}/post` | business | time.edit or time.record | technician_management | yes | - |
| PATCH | `/api/v1/team/time/{id}` | business | time.edit | technician_management | yes | - |
| POST | `/api/v1/team/time/{id}/void` | business | time.edit | technician_management | yes | - |
| GET | `/api/v1/team/time` | business | time.record or time.view_all | technician_management | - | - |
| POST | `/api/v1/team/time` | business | time.record | technician_management | yes | - |
| GET | `/api/v1/team/time/running` | business | time.record | technician_management | - | - |
| POST | `/api/v1/team/time/start` | business | time.record | technician_management | yes | - |
| POST | `/api/v1/team/time/stop` | business | time.record | technician_management | yes | - |
| GET | `/api/v1/team/workload` | business | employee.view_reports | technician_management | - | - |

## transfers

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/transfers/{id}/approve` | business | inventory.approve_purchase | multi_location | yes | - |
| POST | `/api/v1/transfers/{id}/cancel` | business | inventory.transfer | multi_location | yes | - |
| POST | `/api/v1/transfers/{id}/receive` | business | inventory.transfer | multi_location | yes | - |
| POST | `/api/v1/transfers/{id}/request` | business | inventory.transfer | multi_location | yes | - |
| GET | `/api/v1/transfers/{id}` | business | inventory.view | - | - | - |
| POST | `/api/v1/transfers/{id}/ship` | business | inventory.transfer | multi_location | yes | - |
| GET | `/api/v1/transfers` | business | inventory.view | - | - | - |
| POST | `/api/v1/transfers` | business | inventory.transfer | multi_location | yes | - |

## usage

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/usage` | business | settings.view or settings.manage_billing | - | - | - |

## vehicles

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/vehicles/{id}/archive` | business | vehicle.archive | - | yes | - |
| DELETE | `/api/v1/vehicles/{id}/contacts/{contactId}` | business | vehicle.edit | - | yes | - |
| POST | `/api/v1/vehicles/{id}/contacts` | business | vehicle.edit | - | yes | - |
| GET | `/api/v1/vehicles/{id}/diagnostics` | business | vehicle.view | - | - | - |
| GET | `/api/v1/vehicles/{id}/financials` | business | invoice.view or quote.view | - | - | - |
| DELETE | `/api/v1/vehicles/{id}/intervals/{intervalId}` | business | vehicle.edit | - | yes | - |
| POST | `/api/v1/vehicles/{id}/intervals/{intervalId}/serviced` | business | vehicle.edit | - | yes | - |
| GET | `/api/v1/vehicles/{id}/intervals` | business | vehicle.view | - | - | - |
| POST | `/api/v1/vehicles/{id}/intervals` | business | vehicle.edit | - | yes | - |
| POST | `/api/v1/vehicles/{id}/mileage/correct` | business | vehicle.correct_mileage | - | yes | - |
| GET | `/api/v1/vehicles/{id}/mileage` | business | vehicle.view | - | - | - |
| POST | `/api/v1/vehicles/{id}/mileage` | business | vehicle.edit | - | yes | - |
| GET | `/api/v1/vehicles/{id}/overview` | business | vehicle.view | - | - | - |
| GET | `/api/v1/vehicles/{id}` | business | vehicle.view | - | - | - |
| PATCH | `/api/v1/vehicles/{id}` | business | vehicle.edit | - | yes | - |
| GET | `/api/v1/vehicles/{id}/service-history` | business | vehicle.view | - | - | - |
| POST | `/api/v1/vehicles/{id}/status` | business | vehicle.edit | - | yes | - |
| GET | `/api/v1/vehicles/{id}/timeline` | business | vehicle.view | - | - | - |
| GET | `/api/v1/vehicles` | business | vehicle.view | - | - | - |
| POST | `/api/v1/vehicles` | business | vehicle.create | - | yes | - |

## workshop

| Method | Path | Access | Permission | Plan feature | Write | Rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| PATCH | `/api/v1/workshop/bays/{id}` | business | booking.manage | - | yes | - |
| GET | `/api/v1/workshop/bays` | business | booking.view or job.view or booking.manage | - | - | - |
| POST | `/api/v1/workshop/bays` | business | booking.manage | - | yes | - |
| GET | `/api/v1/workshop/hours` | business | booking.view or job.view or booking.manage | - | - | - |
| PUT | `/api/v1/workshop/hours` | business | booking.manage | - | yes | - |
| GET | `/api/v1/workshop/lookups` | business | booking.view or job.view or booking.manage | - | - | - |
| GET | `/api/v1/workshop/rules` | business | booking.view or job.view or booking.manage | - | - | - |
| PATCH | `/api/v1/workshop/rules` | business | booking.manage | - | yes | - |
| PATCH | `/api/v1/workshop/service-types/{id}` | business | booking.manage | - | yes | - |
| GET | `/api/v1/workshop/service-types` | business | booking.view or job.view or booking.manage | - | - | - |
| POST | `/api/v1/workshop/service-types` | business | booking.manage | - | yes | - |
| GET | `/api/v1/workshop/technicians/{membershipId}/schedule` | business | booking.view or job.view or booking.manage | - | - | - |
| PUT | `/api/v1/workshop/technicians/{membershipId}/schedule` | business | booking.manage | - | yes | - |
| DELETE | `/api/v1/workshop/time-off/{id}` | business | booking.manage | - | yes | - |
| GET | `/api/v1/workshop/time-off` | business | booking.view or job.view or booking.manage | - | - | - |
| POST | `/api/v1/workshop/time-off` | business | booking.manage | - | yes | - |

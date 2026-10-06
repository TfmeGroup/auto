import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { env } from '@/lib/env';
import { AppError, Errors } from '@/lib/errors';
import { appUrl } from '@/lib/url';
import { parseOrThrow, uuidSchema } from '@/lib/validation';
import { withTenant, type Tx } from '@/server/db/client';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { assertCanWrite } from '@/server/billing/subscriptions';
import { requirePermission } from '@/server/permissions/authorize';
import type { BusinessContext } from '@/server/context';

/**
 * Customer communication preferences and consent.
 *
 *  - Optional messages (reminders, job updates) follow the customer's switches. MANDATORY messages (their own quote, invoice,
 *    receipt, a change to their booking) do not: nobody can switch off their own invoice.
 *  - SMS and WhatsApp need the customer's agreement. Agreement is recorded as an append-only history: what, when, how it was given
 *    (the source), who recorded it and which wording version, so it can be shown later.
 *  - Marketing consent is a separate thing (Customer.marketingConsent). It is never consulted for any operational message and
 *    never turns anything on: there is no marketing sending in this product.
 */
export const CONSENT_VERSION = 1;

export interface PreferencesOut {
  preferredChannel: 'EMAIL' | 'SMS' | 'WHATSAPP' | null;
  bookingReminders: boolean;
  jobUpdates: boolean;
  paymentReminders: boolean;
  serviceReminders: boolean;
  smsOk: boolean;
  whatsappOk: boolean;
}

const DEFAULTS: PreferencesOut = { preferredChannel: null, bookingReminders: true, jobUpdates: true, paymentReminders: true, serviceReminders: true, smsOk: false, whatsappOk: false };

export async function loadPreferences(tx: Tx, businessId: string, customerId: string): Promise<PreferencesOut> {
  const p = await tx.customerCommPreference.findFirst({ where: { businessId, customerId } });
  return p ? { preferredChannel: p.preferredChannel, bookingReminders: p.bookingReminders, jobUpdates: p.jobUpdates, paymentReminders: p.paymentReminders, serviceReminders: p.serviceReminders, smsOk: p.smsOk, whatsappOk: p.whatsappOk } : DEFAULTS;
}

async function assertCustomer(tx: Tx, businessId: string, customerId: string) {
  const c = await tx.customer.findFirst({ where: { id: customerId, businessId }, select: { id: true, marketingConsent: true, marketingConsentAt: true } });
  if (!c) throw Errors.notFound('Customer');
  return c;
}

export async function getCustomerPreferences(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'customer.view');
  if (!ctx.permissions.has('notification.manage_preferences') && !ctx.permissions.has('notification.view_history')) throw Errors.forbidden();
  const customerId = parseOrThrow(uuidSchema, id);
  return withTenant(ctx.business.id, async (tx) => {
    const c = await assertCustomer(tx, ctx.business.id, customerId);
    const consents = await tx.consentRecord.findMany({ where: { businessId: ctx.business.id, customerId }, orderBy: { createdAt: 'desc' }, take: 20 });
    return { preferences: await loadPreferences(tx, ctx.business.id, customerId), consents, marketing: { consent: c.marketingConsent, at: c.marketingConsentAt, note: 'Marketing consent is recorded separately and is never used for operational messages.' } };
  });
}

const prefsSchema = z.object({
  preferredChannel: z.enum(['EMAIL', 'SMS', 'WHATSAPP']).nullable().optional(),
  bookingReminders: z.boolean().optional(),
  jobUpdates: z.boolean().optional(),
  paymentReminders: z.boolean().optional(),
  serviceReminders: z.boolean().optional(),
});

export async function setCustomerPreferences(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'notification.manage_preferences');
  assertCanWrite(ctx.subscription);
  const customerId = parseOrThrow(uuidSchema, id);
  const d = parseOrThrow(prefsSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    await assertCustomer(tx, ctx.business.id, customerId);
    const before = await loadPreferences(tx, ctx.business.id, customerId);
    // Choosing SMS/WhatsApp as the preferred channel does not by itself grant consent to use it.
    await tx.customerCommPreference.upsert({ where: { businessId_customerId: { businessId: ctx.business.id, customerId } }, create: { businessId: ctx.business.id, customerId, ...d }, update: d });
    const after = await loadPreferences(tx, ctx.business.id, customerId);
    await recordAudit(tx, ctx.meta, { action: AuditActions.commPreferenceChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'customer', resourceId: customerId, before, after });
    return after;
  });
}

const consentSchema = z.object({
  type: z.enum(['SMS', 'WHATSAPP']),
  status: z.enum(['GRANTED', 'WITHDRAWN']),
  source: z.enum(['in_person', 'phone', 'written_form', 'customer_request', 'portal']),
});

/** Record that a customer agreed to (or withdrew from) text messages. Append-only: history is never rewritten. */
export async function recordConsent(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'notification.manage_preferences');
  assertCanWrite(ctx.subscription);
  const customerId = parseOrThrow(uuidSchema, id);
  const d = parseOrThrow(consentSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    await assertCustomer(tx, ctx.business.id, customerId);
    const rec = await tx.consentRecord.create({ data: { businessId: ctx.business.id, customerId, consentType: d.type, status: d.status, source: d.source, version: CONSENT_VERSION, changedById: ctx.user.id } });
    const flag = d.type === 'SMS' ? { smsOk: d.status === 'GRANTED' } : { whatsappOk: d.status === 'GRANTED' };
    await tx.customerCommPreference.upsert({ where: { businessId_customerId: { businessId: ctx.business.id, customerId } }, create: { businessId: ctx.business.id, customerId, ...flag }, update: flag });
    await recordAudit(tx, ctx.meta, { action: AuditActions.commPreferenceChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'customer', resourceId: customerId, metadata: { consent: d.type, status: d.status, source: d.source } });
    return rec;
  });
}

// ───────── opt-out link in optional messages ─────────

export type OptOutCategory = 'bookingReminders' | 'jobUpdates' | 'paymentReminders' | 'serviceReminders';
const OPT_LABEL: Record<OptOutCategory, string> = { bookingReminders: 'booking reminders', jobUpdates: 'job updates', paymentReminders: 'payment reminders', serviceReminders: 'service reminders' };
const key = () => Buffer.from(env().FILE_SIGNING_KEY ?? 'dev-only-signing-key-do-not-use-in-production!!', env().FILE_SIGNING_KEY ? 'base64' : 'utf8');

/** A link a customer can use to stop one kind of OPTIONAL message. It carries who and what, signed; it opens nothing else. */
export function optOutLink(businessId: string, customerId: string, category: OptOutCategory): string {
  const body = Buffer.from(JSON.stringify({ b: businessId, c: customerId, k: category, e: Math.floor(Date.now() / 1000) + 400 * 86_400 })).toString('base64url');
  const sig = createHmac('sha256', key()).update(`optout.${body}`).digest('base64url');
  return appUrl(`/optout/${body}.${sig}`);
}

export function readOptOut(token: string): { businessId: string; customerId: string; category: OptOutCategory } {
  const bad = () => new AppError('NOT_FOUND', 404, 'This link is not valid or has expired.');
  const [body, sig] = token.split('.');
  if (!body || !sig || token.length > 600) throw bad();
  const expected = createHmac('sha256', key()).update(`optout.${body}`).digest();
  let given: Buffer;
  try { given = Buffer.from(sig, 'base64url'); } catch { throw bad(); }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw bad();
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { b: string; c: string; k: string; e: number };
    if (p.e * 1000 < Date.now() || !(p.k in OPT_LABEL)) throw bad();
    return { businessId: p.b, customerId: p.c, category: p.k as OptOutCategory };
  } catch {
    throw bad();
  }
}

export const optOutLabel = (c: OptOutCategory) => OPT_LABEL[c];

/** The customer used the link: switch that one optional category off. Never touches mandatory messages. */
export async function applyOptOut(token: string) {
  const o = readOptOut(token);
  await withTenant(o.businessId, async (tx) => {
    const exists = await tx.customer.findFirst({ where: { id: o.customerId, businessId: o.businessId }, select: { id: true } });
    if (!exists) throw Errors.notFound('Link');
    const flag = { [o.category]: false };
    await tx.customerCommPreference.upsert({ where: { businessId_customerId: { businessId: o.businessId, customerId: o.customerId } }, create: { businessId: o.businessId, customerId: o.customerId, ...flag }, update: flag });
    await recordAudit(tx, undefined, { action: AuditActions.commPreferenceChanged, businessId: o.businessId, resourceType: 'customer', resourceId: o.customerId, metadata: { via: 'opt_out_link', category: o.category } });
  });
  return { category: o.category, label: OPT_LABEL[o.category] };
}

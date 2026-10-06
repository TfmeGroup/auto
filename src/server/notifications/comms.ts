import { logger } from '@/lib/logger';
import { appUrl } from '@/lib/url';
import { prisma, seq, withTenant, type Tx } from '@/server/db/client';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { loadEffectiveSubscription } from '@/server/billing/subscriptions';
import { enqueue } from '@/server/jobs/queue';
import { JobTypes } from '@/server/jobs/types';
import { getStorage } from '@/server/storage';
import { vehicleLabel } from '@/server/vehicles/service';
import type { CommStatus } from '@/generated/prisma/client';
import { getEmailTransport, type EmailAttachment } from './email';
import { EVENTS, type CommChannelKey, type EventDef, type EventKey, VARIABLES } from './events';
import { getSmsProvider, getWhatsAppProvider, isChannelConfigured } from './providers/text';
import { ProviderError } from './providers/types';
import { emailHtml, redactLinks, renderText } from './render';
import { notifyInApp } from './service';
import { INTERNAL_EVENTS, NotificationTypes } from './events';
import { optOutLabel, optOutLink, type OptOutCategory } from './preferences';
import { loadCommSettings, type CommSettingsOut } from './settings';
import { resolveTemplate } from './templates-admin';

/**
 * The shared communication service. Every operational message to a customer or supplier goes through sendCustomerMessage():
 * bookings, jobs, quotes, invoices, payments, service reminders and purchase orders all use it, and none of them knows which
 * provider carries a message.
 *
 *   event -> channel choice (preferences, consent, plan, configuration) -> template -> communication record (QUEUED) -> job
 *   -> provider -> result recorded (SENT / FAILED / SKIPPED) -> retry only when the failure was transient
 *
 * The request that causes a message never waits for a provider: it only writes the record and the job, in its own transaction,
 * so the message exists if and only if the business change that caused it committed.
 */
export type SendOutcome = { channel: CommChannelKey; status: 'queued' | 'skipped' | 'duplicate' | 'disabled'; detail?: string; communicationId?: string };

export interface MessageTarget {
  /** A customer of this business (preferences, consent and contact details come from them). */
  customerId?: string;
  /** Or a supplier / other contact reached by email only. */
  contact?: { email: string; name: string };
}

export interface CustomerMessage extends MessageTarget {
  event: EventKey;
  entity?: { type: string; id: string };
  vars?: Record<string, string | undefined>;
  vehicleId?: string;
  /** The private link to the customer-facing view of the record (shown to the customer; only its hash is stored by the link system). */
  link?: { url: string };
  /** The same event, entity and dedupeKey is sent at most once per channel. */
  dedupeKey: string;
  attachmentFileIds?: string[];
  locationId?: string | null;
  manual?: { userId: string; subject?: string; body: string };
}

const COUNTRY_DIAL: Record<string, string> = { ZA: '27', NA: '264', BW: '267', ZW: '263', MZ: '258', LS: '266', SZ: '268', GB: '44', IE: '353', US: '1', CA: '1', AU: '61', NZ: '64', KE: '254', NG: '234', ZM: '260' };

/** A phone number as E.164, or null if it cannot be made one with certainty. */
export function toE164(raw: string | null | undefined, countryCode: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (trimmed.startsWith('00')) return digits.length >= 10 && digits.length <= 17 ? `+${digits.slice(2)}` : null;
  const dial = COUNTRY_DIAL[countryCode.toUpperCase()];
  if (!dial) return null;
  if (digits.startsWith('0') && digits.length >= 8) return `+${dial}${digits.slice(1)}`;
  if (digits.startsWith(dial) && digits.length >= 10) return `+${digits}`;
  return null;
}

const CTA_LABEL: Partial<Record<EventKey, string>> = { QUOTE_SENT: 'Review quote', QUOTE_EXPIRING: 'Review quote', INVOICE_SENT: 'View invoice', INVOICE_REMINDER: 'View invoice', INVOICE_OVERDUE: 'View invoice', PAYMENT_RECEIVED: 'View receipt', PAYMENT_FAILED: 'Open invoice' };

const PER_RECIPIENT_PER_HOUR = 20;

/** Which of the customer's switches governs an optional category (and so which one an opt-out link turns off). */
const OPT_CATEGORY: Partial<Record<EventDef['category'], OptOutCategory>> = { JOB_UPDATES: 'jobUpdates', BOOKING: 'bookingReminders', PAYMENT_REMINDERS: 'paymentReminders', SERVICE_REMINDERS: 'serviceReminders' };

/** Is this event something the business has switched on? Mandatory events are always on. */
function businessWants(def: EventDef, settings: CommSettingsOut, features: { has(f: string): boolean }): { ok: true } | { ok: false; reason: string } {
  const key = def.key as EventKey;
  if (def.category === 'JOB_UPDATES') {
    if (!features.has('advanced_communication')) return { ok: false, reason: 'Job updates are not included in this plan.' };
    if (!settings.jobUpdateEvents.includes(key)) return { ok: false, reason: 'This job update is switched off.' };
  }
  if (key === 'BOOKING_REMINDER' && !settings.bookingRemindersOn) return { ok: false, reason: 'Booking reminders are switched off.' };
  if (key === 'SERVICE_REMINDER' && (!settings.serviceRemindersOn || !features.has('service_reminders'))) return { ok: false, reason: 'Service reminders are switched off.' };
  return { ok: true };
}

export async function sendCustomerMessage(tx: Tx, businessId: string, m: CustomerMessage): Promise<SendOutcome[]> {
  const def = EVENTS[m.event] as EventDef;
  const [business, settings, sub] = await seq([
    tx.business.findUniqueOrThrow({ where: { id: businessId }, select: { name: true, tradingName: true, phone: true, email: true, countryCode: true } }),
    loadCommSettings(tx, businessId),
    loadEffectiveSubscription(tx, businessId),
  ]);
  const features: { has(f: string): boolean } = sub.features;
  const want = businessWants(def, settings, features);
  if (!want.ok) return [{ channel: 'EMAIL', status: 'disabled', detail: want.reason }];

  // Who it is for.
  const customer = m.customerId
    ? await tx.customer.findFirst({ where: { id: m.customerId, businessId }, select: { id: true, name: true, email: true, mobile: true, status: true, preferredContact: true } })
    : null;
  if (m.customerId && !customer) return [{ channel: 'EMAIL', status: 'skipped', detail: 'The customer was not found.' }];
  const prefs = customer ? await tx.customerCommPreference.findFirst({ where: { businessId, customerId: customer.id } }) : null;
  const name = customer?.name ?? m.contact?.name ?? 'there';
  const email = customer?.email ?? m.contact?.email ?? null;

  // Which channels. A mandatory message always goes by email, and also by the customer's preferred text channel when that is allowed.
  // An optional message honours the customer's stated preference and is NOT silently moved to email if it cannot go the preferred way.
  const prefRaw: string | null = customer ? (prefs?.preferredChannel ?? customer.preferredContact ?? null) : null;
  const textOk = (c: string): c is 'SMS' | 'WHATSAPP' => (c === 'SMS' || c === 'WHATSAPP') && def.channels.includes(c);
  let channels: CommChannelKey[];
  let declined: string | null = null;
  if (def.mandatory) channels = ['EMAIL', ...(prefRaw && textOk(prefRaw) ? [prefRaw] : [])];
  else if (!prefRaw || prefRaw === 'EMAIL') channels = ['EMAIL'];
  else if (textOk(prefRaw)) channels = [prefRaw];
  else {
    channels = ['EMAIL'];
    declined = prefRaw === 'PHONE' ? 'The customer prefers a phone call; automatic messages are not sent.' : `The customer prefers ${prefRaw.toLowerCase()}, which is not used for this message.`;
  }

  // Optional messages respect the customer's switches; mandatory ones (their own quote, invoice, receipt, booking change) never do.
  let optedOut: string | null = null;
  if (customer && !def.mandatory) {
    if (customer.status !== 'ACTIVE') optedOut = 'The customer is not active.';
    else if (def.category === 'JOB_UPDATES' && prefs && !prefs.jobUpdates) optedOut = 'The customer opted out of job updates.';
    else if (def.category === 'BOOKING' && prefs && !prefs.bookingReminders) optedOut = 'The customer opted out of booking reminders.';
    else if (def.category === 'PAYMENT_REMINDERS' && prefs && !prefs.paymentReminders) optedOut = 'The customer opted out of payment reminders.';
    else if (def.category === 'SERVICE_REMINDERS' && prefs && !prefs.serviceReminders) optedOut = 'The customer opted out of service reminders.';
    else optedOut = declined;
  }

  // Variables: only the registered ones, with values the system supplies.
  const vehicle = m.vehicleId ? await tx.vehicle.findFirst({ where: { id: m.vehicleId, businessId } }) : null;
  const locationName = m.locationId ? (await tx.location.findFirst({ where: { id: m.locationId, businessId }, select: { name: true } }))?.name : undefined;
  const bizName = business.tradingName ?? business.name;
  const vars: Record<string, string | undefined> = {
    customer_name: name, business_name: bizName, business_phone: business.phone ?? '', business_email: business.email ?? '', location_name: locationName,
    ...(vehicle ? { vehicle: vehicleLabel(vehicle), vehicle_registration: vehicle.registration ?? '', vehicle_make: vehicle.make ?? '', vehicle_model: vehicle.model ?? '' } : {}),
    ...m.vars, secure_link: m.link?.url ?? m.vars?.secure_link ?? '',
  };
  const known = new Set(Object.keys(VARIABLES));
  for (const k of Object.keys(vars)) if (!known.has(k)) delete vars[k]; // nothing outside the registry reaches a template

  const hourAgo = new Date(Date.now() - 3_600_000);
  const outcomes: SendOutcome[] = [];
  const skipRows: { channel: CommChannelKey; reason: string }[] = [];
  const sendable: CommChannelKey[] = [];
  for (const channel of channels) {
    if (optedOut) { skipRows.push({ channel, reason: optedOut }); break; }
    if (channel === 'EMAIL') {
      if (!email) { skipRows.push({ channel, reason: 'The customer has no email address.' }); continue; }
      sendable.push(channel);
      continue;
    }
    // SMS and WhatsApp: needs the number, the customer's consent, the business's switch, the plan feature and a configured provider.
    const phone = toE164(customer?.mobile, business.countryCode);
    const reason = !customer ? 'Text channels are only used for customers.'
      : !phone ? 'The customer has no usable mobile number.'
      : channel === 'SMS' && !prefs?.smsOk ? 'The customer has not agreed to receive SMS messages.'
      : channel === 'WHATSAPP' && !prefs?.whatsappOk ? 'The customer has not agreed to receive WhatsApp messages.'
      : channel === 'SMS' && !(settings.smsEnabled && features.has('sms_notifications')) ? 'SMS is not switched on for this business.'
      : channel === 'WHATSAPP' && !(settings.whatsappEnabled && features.has('whatsapp_notifications')) ? 'WhatsApp is not switched on for this business.'
      : !isChannelConfigured(channel === 'SMS' ? 'sms' : 'whatsapp') ? `${channel === 'SMS' ? 'SMS' : 'WhatsApp'} is not set up on this system.`
      : null;
    if (reason) { skipRows.push({ channel, reason: def.mandatory ? reason : `The customer prefers ${channel.toLowerCase()}; ${reason.charAt(0).toLowerCase()}${reason.slice(1)}` }); continue; }
    sendable.push(channel);
  }
  // Every sendable channel goes for a mandatory message; an optional one uses the single channel the customer prefers.
  // A channel that could not be used is recorded as skipped so staff can see why.
  const chosen = def.mandatory ? sendable : sendable.slice(0, 1);

  const make = async (channel: CommChannelKey, status: 'QUEUED' | 'SKIPPED', detail: string | null): Promise<SendOutcome> => {
    const tpl = await resolveTemplate(tx, businessId, m.event, channel);
    const manualBody = m.manual?.body;
    const bodyText = manualBody !== undefined ? renderText('{{note}}', { ...vars, note: manualBody }) : renderText(tpl.body, vars);
    const subject = channel === 'EMAIL' ? (m.manual?.subject ? m.manual.subject : renderText(tpl.subject ?? '', vars)).replace(/[\r\n]+/g, ' ').trim() : null;
    const recipient = channel === 'EMAIL' ? email : toE164(customer?.mobile, business.countryCode);
    const signature = channel === 'EMAIL' ? settings.signature : null;
    const optKey = !def.mandatory && customer && channel === 'EMAIL' ? OPT_CATEGORY[def.category] : undefined;
    const optOut = optKey && customer ? { label: optOutLabel(optKey), url: optOutLink(businessId, customer.id, optKey) } : null;
    const text = channel === 'EMAIL' ? `${/^\s*$/.test(name) ? '' : `Hi ${name},\n\n`}${bodyText}${signature ? `\n\n${signature}` : ''}${optOut ? `\n\nTo stop receiving ${optOut.label}: ${optOut.url}` : ''}\n\n— ${bizName}` : bodyText;
    const html = channel === 'EMAIL' ? emailHtml(`${name === 'there' ? 'Hi there,' : `Hi ${name},`}\n\n${bodyText}`, { businessName: bizName, signature, optOut, cta: m.link && def.withLink ? { label: CTA_LABEL[m.event] ?? 'Open', url: m.link.url } : null }) : null;
    const dedupe = `${m.dedupeKey}:${channel}`;
    let finalStatus = status;
    let finalDetail = detail;
    if (finalStatus === 'QUEUED' && recipient) {
      const recent = await tx.communication.count({ where: { businessId, recipient, channel, createdAt: { gte: hourAgo }, status: { not: 'SKIPPED' } } });
      if (recent >= PER_RECIPIENT_PER_HOUR) { finalStatus = 'SKIPPED'; finalDetail = 'Too many messages were sent to this recipient in the last hour.'; }
    }
    const made = await tx.communication.createManyAndReturn({
      data: [{
        businessId, customerId: customer?.id ?? null, channel, event: m.event, category: def.category, transactional: true, recipient: finalStatus === 'SKIPPED' && !recipient ? null : recipient,
        subject, body: redactLinks(text), entityType: m.entity?.type ?? null, entityId: m.entity?.id ?? null, locationId: m.locationId ?? null, status: finalStatus, statusDetail: finalDetail,
        templateKey: m.event, templateVersion: tpl.version, dedupeKey: dedupe, manual: !!m.manual, createdById: m.manual?.userId ?? null,
      }],
      skipDuplicates: true,
    });
    if (made.length === 0) return { channel, status: 'duplicate' };
    const row = made[0]!;
    if (finalStatus === 'SKIPPED') return { channel, status: 'skipped', detail: finalDetail ?? undefined, communicationId: row.id };
    await enqueue(tx, JobTypes.commDeliver, {
      businessId, communicationId: row.id, channel, to: recipient, name, subject, text, html, attachmentFileIds: m.attachmentFileIds ?? [], fromName: settings.senderName ?? bizName,
      replyTo: settings.replyTo ?? business.email ?? null,
    }, { dedupeKey: `comm:${row.id}`, businessId, maxAttempts: 5 });
    return { channel, status: 'queued', communicationId: row.id };
  };

  for (const channel of chosen) outcomes.push(await make(channel, 'QUEUED', null));
  for (const s of skipRows) if (!outcomes.some((o) => o.channel === s.channel)) outcomes.push(await make(s.channel, 'SKIPPED', s.reason));
  if (outcomes.length === 0) outcomes.push(await make('EMAIL', 'SKIPPED', 'There is nowhere to send this message.'));
  return outcomes;
}

// ───────── delivery ─────────

export interface DeliverPayload {
  businessId: string;
  communicationId: string;
  channel: CommChannelKey;
  to: string | null;
  name: string;
  subject: string | null;
  text: string;
  html: string | null;
  attachmentFileIds: string[];
  fromName: string;
  replyTo: string | null;
}

export const DELIVERY_MAX_ATTEMPTS = 5;

class Retry extends Error {}

const SAFE_FAILURE = 'The message could not be sent.';

async function loadAttachments(businessId: string, ids: string[]): Promise<EmailAttachment[]> {
  const out: EmailAttachment[] = [];
  for (const id of ids) {
    const f = await withTenant(businessId, (tx) => tx.file.findFirst({ where: { id, businessId, status: { in: ['ACTIVE', 'ARCHIVED'] } } }));
    if (!f) throw new ProviderError('permanent', 'An attached document is no longer available.');
    const { stream } = await getStorage().get(f.storageKey);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    out.push({ filename: f.displayName || f.originalName, contentType: f.mimeType, contentBase64: Buffer.concat(chunks).toString('base64') });
  }
  return out;
}

const setStatus = (businessId: string, id: string, data: { status: CommStatus } & Record<string, unknown>) =>
  withTenant(businessId, (tx) => tx.communication.update({ where: { id }, data }));

/**
 * The job handler. Idempotent: a message that already went out is never sent again, however many times the job runs. A transient
 * failure puts the record back in the queue and lets the job retry with backoff; a permanent failure (a bad number, a refused message)
 * is recorded with a safe reason and NOT retried. If the provider is not set up at all the message is recorded as skipped.
 */
export async function runDelivery(p: DeliverPayload, ctx: { jobId: string; attempt: number }): Promise<void> {
  const { businessId } = p;
  const row = await withTenant(businessId, (tx) => tx.communication.findFirst({ where: { id: p.communicationId, businessId } }));
  if (!row) return;
  if (['SENT', 'DELIVERED', 'VIEWED', 'CANCELLED', 'SKIPPED'].includes(row.status)) {
    await scrub(ctx.jobId, p);
    return;
  }
  const settings = await withTenant(businessId, (tx) => loadCommSettings(tx, businessId));
  const recentlySent = await withTenant(businessId, (tx) => tx.communication.count({ where: { businessId, status: { in: ['SENT', 'DELIVERED', 'VIEWED'] }, sentAt: { gte: new Date(Date.now() - 3_600_000) } } }));
  if (recentlySent >= settings.maxPerHour) {
    if (ctx.attempt >= DELIVERY_MAX_ATTEMPTS) {
      await failMessage(businessId, row.id, 'This business reached its hourly message limit and the message could not be sent in time. You can send it again.', p.channel);
      return;
    }
    await setStatus(businessId, row.id, { status: 'QUEUED', statusDetail: 'Waiting: this business reached its hourly message limit.' });
    throw new Retry('hourly limit');
  }
  await setStatus(businessId, row.id, { status: 'PROCESSING', attempts: { increment: 1 }, statusDetail: null });

  try {
    let providerRef: string | undefined;
    let provider = 'email';
    if (p.channel === 'EMAIL') {
      if (!p.to) throw new ProviderError('permanent', 'There is no email address for this message.');
      const attachments = p.attachmentFileIds.length ? await loadAttachments(businessId, p.attachmentFileIds) : undefined;
      const r = await getEmailTransport().send({ to: p.to, subject: p.subject ?? '', text: p.text, html: p.html ?? '', fromName: p.fromName, ...(p.replyTo ? { replyTo: p.replyTo } : {}), ...(attachments ? { attachments } : {}) });
      providerRef = r?.providerRef;
      provider = process.env.EMAIL_DRIVER === 'smtp' ? 'smtp' : 'email';
    } else {
      if (!p.to) throw new ProviderError('permanent', 'There is no phone number for this message.');
      const prov = p.channel === 'SMS' ? getSmsProvider() : getWhatsAppProvider();
      provider = prov.name;
      const r = await prov.send({ to: p.to, body: p.text, idempotencyKey: row.id, statusCallbackUrl: appUrl('/api/public/webhooks/twilio') });
      providerRef = r.providerRef;
    }
    // "Sent" means the provider accepted it. It is NOT claimed as delivered: that only ever comes from the provider's own report.
    await setStatus(businessId, row.id, { status: 'SENT', sentAt: new Date(), provider, providerRef: providerRef ?? null, statusDetail: null });
    await scrub(ctx.jobId, p);
  } catch (err) {
    const pe = err instanceof ProviderError ? err : null;
    const lastAttempt = ctx.attempt >= DELIVERY_MAX_ATTEMPTS;
    if (pe?.kind === 'not_configured') {
      await setStatus(businessId, row.id, { status: 'SKIPPED', statusDetail: pe.message });
      await scrub(ctx.jobId, p);
      return;
    }
    if (pe?.kind === 'permanent' || lastAttempt) {
      const reason = pe?.kind === 'permanent' ? pe.message : lastAttempt ? 'The provider stayed unavailable, so the message could not be sent.' : SAFE_FAILURE;
      await failMessage(businessId, row.id, reason, p.channel);
      return; // recorded as failed; the person can send it again from the history
    }
    logger.warn({ communicationId: row.id, attempt: ctx.attempt, err: String(err) }, 'message delivery failed; will retry');
    await setStatus(businessId, row.id, { status: 'QUEUED', statusDetail: 'Could not be sent yet; trying again shortly.' }).catch(() => {});
    throw err;
  }
}

async function failMessage(businessId: string, id: string, reason: string, channel: CommChannelKey) {
  await withTenant(businessId, async (tx) => {
    const row = await tx.communication.update({ where: { id }, data: { status: 'FAILED', failedAt: new Date(), statusDetail: reason } });
    await recordAudit(tx, undefined, { action: AuditActions.communicationFailed, businessId, resourceType: 'communication', resourceId: id, metadata: { channel, event: row.event, reason } });
    // Tell the people who can do something about it (one grouped notification, not one per message).
    const def = INTERNAL_EVENTS.MESSAGE_FAILED!;
    const people = await tx.membership.findMany({ where: { businessId, status: 'ACTIVE', user: { status: 'ACTIVE' }, role: { permissions: { some: { permission: def.permission } } } }, select: { userId: true } });
    for (const u of people) if (u.userId) await notifyInApp(tx, { businessId, userId: u.userId, type: NotificationTypes.MESSAGE_FAILED, title: 'A customer message could not be sent', body: reason, linkUrl: '/communications?status=FAILED', priority: def.priority, groupKey: 'message-failed' });
  });
}

/** After the message is out, the job no longer needs its content (which may hold a private link). */
async function scrub(jobId: string, p: DeliverPayload) {
  await prisma().job.update({ where: { id: jobId }, data: { payload: { businessId: p.businessId, communicationId: p.communicationId, scrubbed: true } } }).catch(() => {});
}


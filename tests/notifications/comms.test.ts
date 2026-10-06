import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { disconnectPrisma, prisma, withTenant } from '@/server/db/client';
import { resetEnvForTests } from '@/lib/env';
import { getEmailTransport } from '@/server/notifications/email';
import { MemoryTextProvider, resetTextProvidersForTests } from '@/server/notifications/providers/text';
import { ProviderError } from '@/server/notifications/providers/types';
import { sendCustomerMessage } from '@/server/notifications/comms';
import { listCommunications, getCommunication } from '@/server/notifications/history';
import { cancelCommunication, retryCommunication, sendManualMessage } from '@/server/notifications/manual';
import { getCustomerPreferences, recordConsent, setCustomerPreferences, applyOptOut, optOutLink } from '@/server/notifications/preferences';
import { listNotifications, markAllRead, setRead, getUnreadCount } from '@/server/notifications/inapp';
import { notifyInApp } from '@/server/notifications/service';
import { notifyInternal } from '@/server/notifications/internal';
import { getCommSettings, updateCommSettings } from '@/server/notifications/settings';
import { listTemplates, previewTemplate, saveTemplate, setTemplateActive } from '@/server/notifications/templates-admin';
import { applyDeliveryReport, handleTwilioCallback } from '@/server/notifications/webhooks';
import { runBookingReminders, runServiceReminders } from '@/server/notifications/reminders';
import { createBooking } from '@/server/bookings/service';
import { addInterval } from '@/server/vehicles/insights';
import { changeJobStatus, createJob } from '@/server/jobcards/service';
import { sendQuote } from '@/server/finance/quotes';
import { createMemberCtx, createWorkspace, drainJobs, ownerQuery, sentTo, upgradePlan, type TestWorkspace } from '../helpers/factory';
import { financeWorkspace, L, sentQuote } from '../helpers/finance';
import { memberWithPermissions, nextWeekday, seedCustomerVehicle } from '../helpers/workshop';
import { createHmac } from 'node:crypto';

afterAll(disconnectPrisma);

let ws: TestWorkspace;
beforeAll(async () => { ws = await financeWorkspace('Comms Workshop'); });
beforeEach(() => { MemoryTextProvider.reset(); });

const comm = async (customerId: string) => (await ownerQuery('SELECT * FROM communications WHERE customer_id = $1 ORDER BY created_at', [customerId])).rows;
const rejects = (p: Promise<unknown>, status?: number) => expect(p).rejects.toMatchObject(status ? { status } : {});
const send = (w: TestWorkspace, over: Record<string, unknown>) =>
  withTenant(w.businessId, (tx) => sendCustomerMessage(tx, w.businessId, { event: 'JOB_COMPLETED', dedupeKey: `t:${Math.random()}`, ...over } as never));
const makeDue = (w: TestWorkspace) => ownerQuery("UPDATE jobs SET run_at = now() WHERE type = 'comm.deliver' AND status = 'PENDING' AND business_id = $1", [w.businessId]);

describe('sending through the shared service', () => {
  it('a quote email is recorded, queued, delivered through the email provider, and its private link is not kept in the history', async () => {
    const { customer } = await seedCustomerVehicle(ws, 'Mail');
    const q = await sentQuote(ws, { customerId: customer.id });
    const [row] = await comm(customer.id);
    expect(row).toMatchObject({ channel: 'EMAIL', event: 'QUOTE_SENT', category: 'FINANCIAL', transactional: true, status: 'QUEUED', template_key: 'QUOTE_SENT', entity_type: 'quote', entity_id: q.id, recipient: customer.email });
    expect(row.body).toContain('/q/[private link]');
    expect(row.body).not.toMatch(/\/q\/[A-Za-z0-9_-]{20,}/);
    expect(row.queued_at).toBeTruthy();
    // the job carries the real link until the message is out, then is scrubbed
    const job = (await ownerQuery("SELECT payload FROM jobs WHERE dedupe_key = $1", [`comm:${row.id}`])).rows[0];
    expect(job.payload.text).toMatch(/\/q\/[A-Za-z0-9_-]{20,}/);
    await drainJobs();
    const after = (await comm(customer.id))[0];
    expect(after).toMatchObject({ status: 'SENT', attempts: 1 });
    expect(after.sent_at).toBeTruthy();
    expect(after.delivered_at).toBeNull(); // submission is never reported as delivery
    const mail = sentTo(customer.email!)[0]!;
    expect(mail).toMatchObject({ fromName: expect.stringContaining('Comms Workshop') });
    expect(mail.subject).toContain('Quote');
    expect((await ownerQuery("SELECT payload FROM jobs WHERE dedupe_key = $1", [`comm:${row.id}`])).rows[0].payload).toEqual({ businessId: ws.businessId, communicationId: row.id, scrubbed: true });
  });

  it('the same event is sent once: a repeated request, a retried job and a double delivery all produce one email', async () => {
    const { customer } = await seedCustomerVehicle(ws, 'Once');
    const dedupeKey = `once:${customer.id}`;
    const base = { event: 'QUOTE_SENT', customerId: customer.id, dedupeKey, vars: { quote_number: 'Q1', quote_total: 'R 1,00', valid_until: 'soon' } };
    expect((await send(ws, base)).map((o) => o.status)).toEqual(['queued']);
    expect((await send(ws, base)).map((o) => o.status)).toEqual(['duplicate']);
    const jobs = (await ownerQuery("SELECT id FROM jobs WHERE type = 'comm.deliver' AND payload->>'communicationId' = (SELECT id::text FROM communications WHERE customer_id = $1)", [customer.id])).rows;
    expect(jobs).toHaveLength(1);
    await drainJobs();
    expect(sentTo(customer.email!)).toHaveLength(1);
    // the job runs again (as after a crash between sending and recording): nothing more goes out
    await ownerQuery("UPDATE jobs SET status = 'PENDING', run_at = now() WHERE id = $1", [jobs[0].id]);
    await drainJobs();
    expect(sentTo(customer.email!)).toHaveLength(1);
    expect((await comm(customer.id))).toHaveLength(1);
  });

  it('a transient provider failure is retried later without losing the message; success then sends it exactly once', async () => {
    const { customer } = await seedCustomerVehicle(ws, 'Retry');
    await send(ws, { event: 'QUOTE_SENT', customerId: customer.id, dedupeKey: `r:${customer.id}`, vars: { quote_number: 'Q2', quote_total: 'R 2,00', valid_until: 'x' } });
    const transport = getEmailTransport();
    const real = transport.send.bind(transport);
    transport.send = async () => { throw new Error('smtp is down'); };
    try {
      await drainJobs();
      const mid = (await comm(customer.id))[0];
      expect(mid).toMatchObject({ status: 'QUEUED', attempts: 1 });
      expect(mid.status_detail).toMatch(/trying again/i);
      expect(sentTo(customer.email!)).toHaveLength(0);
    } finally { transport.send = real; }
    await makeDue(ws);
    await drainJobs();
    expect((await comm(customer.id))[0]).toMatchObject({ status: 'SENT', attempts: 2 });
    expect(sentTo(customer.email!)).toHaveLength(1);
  });

  it('a permanent failure is recorded with a safe reason, not retried forever, shown to staff, and can be sent again by a person', async () => {
    const { customer } = await seedCustomerVehicle(ws, 'Perm');
    await send(ws, { event: 'QUOTE_SENT', customerId: customer.id, dedupeKey: `p:${customer.id}`, vars: { quote_number: 'Q3', quote_total: 'R 3,00', valid_until: 'x' } });
    const transport = getEmailTransport();
    const real = transport.send.bind(transport);
    transport.send = async () => { throw new ProviderError('permanent', 'The mailbox does not exist.'); };
    try { await drainJobs(); } finally { transport.send = real; }
    const failed = (await comm(customer.id))[0];
    expect(failed).toMatchObject({ status: 'FAILED', status_detail: 'The mailbox does not exist.' });
    expect(failed.failed_at).toBeTruthy();
    expect((await ownerQuery("SELECT status FROM jobs WHERE dedupe_key = $1", [`comm:${failed.id}`])).rows[0].status).toBe('SUCCEEDED'); // the queue is not left retrying
    expect((await ownerQuery("SELECT 1 FROM audit_logs WHERE resource_id = $1 AND action = 'communication.failed'", [failed.id])).rowCount).toBe(1);
    expect((await ownerQuery("SELECT 1 FROM notifications WHERE business_id = $1 AND type = 'MESSAGE_FAILED'", [ws.businessId])).rowCount).toBeGreaterThan(0);
    // the person fixes the address and sends it again: the original message is reused
    const adv = await createMemberCtx(ws, 'technician');
    await rejects(retryCommunication(adv.ctx, failed.id), 403);
    await retryCommunication(ws.ctx, failed.id);
    await drainJobs();
    expect((await comm(customer.id))[0]).toMatchObject({ status: 'SENT' });
    await rejects(retryCommunication(ws.ctx, failed.id), 409);
  });

  it('a provider that stays unavailable ends as failed rather than retrying for ever', async () => {
    const { customer } = await seedCustomerVehicle(ws, 'Dead');
    await send(ws, { event: 'QUOTE_SENT', customerId: customer.id, dedupeKey: `d:${customer.id}`, vars: { quote_number: 'Q4', quote_total: 'R 4,00', valid_until: 'x' } });
    const transport = getEmailTransport();
    const real = transport.send.bind(transport);
    transport.send = async () => { throw new Error('connection refused'); };
    try {
      for (let i = 0; i < 6; i++) { await drainJobs(); await makeDue(ws); }
    } finally { transport.send = real; }
    const row = (await comm(customer.id))[0];
    expect(row).toMatchObject({ status: 'FAILED', attempts: 5 });
    expect(row.status_detail).toMatch(/stayed unavailable/);
  });

  it('a business-wide hourly limit makes messages wait instead of flooding, and never loses them', async () => {
    const w = await financeWorkspace('Rate Limited');
    await updateCommSettings(w.ctx, { maxPerHour: 1 });
    const a = await seedCustomerVehicle(w, 'RL1');
    const b = await seedCustomerVehicle(w, 'RL2');
    for (const c of [a, b]) await send(w, { event: 'QUOTE_SENT', customerId: c.customer.id, dedupeKey: `rl:${c.customer.id}`, vars: { quote_number: 'Q', quote_total: 'R 1', valid_until: 'x' } });
    await drainJobs();
    const rows = (await ownerQuery('SELECT status, status_detail FROM communications WHERE business_id = $1 ORDER BY created_at', [w.businessId])).rows;
    expect(rows.map((r) => r.status).sort()).toEqual(['QUEUED', 'SENT']); // whichever went first, the other waits
    expect(rows.find((r) => r.status === 'QUEUED')?.status_detail).toMatch(/hourly message limit/);
  });

  it('a queued message can be cancelled before it goes; a sent one cannot', async () => {
    const { customer } = await seedCustomerVehicle(ws, 'Cancel');
    await send(ws, { event: 'QUOTE_SENT', customerId: customer.id, dedupeKey: `c:${customer.id}`, vars: { quote_number: 'Q5', quote_total: 'R 5,00', valid_until: 'x' } });
    const id = (await comm(customer.id))[0].id;
    await cancelCommunication(ws.ctx, id);
    await drainJobs();
    expect((await comm(customer.id))[0].status).toBe('CANCELLED');
    expect(sentTo(customer.email!)).toHaveLength(0);
    await rejects(cancelCommunication(ws.ctx, id), 409);
    await expect(ownerQuery("UPDATE communications SET status = 'QUEUED' WHERE id = $1", [id])).rejects.toThrow(/final/);
  });
});

describe('customer preferences, consent and the transactional/marketing line', () => {
  it('mandatory messages ignore every switch and marketing consent; optional ones respect the customer\'s choices', async () => {
    const { customer } = await seedCustomerVehicle(ws, 'Prefs');
    await ownerQuery('UPDATE customers SET marketing_consent = false WHERE id = $1', [customer.id]);
    await setCustomerPreferences(ws.ctx, customer.id, { jobUpdates: false, bookingReminders: false, paymentReminders: false, serviceReminders: false });
    await updateCommSettings(ws.ctx, { jobUpdateEvents: ['JOB_COMPLETED'], serviceRemindersOn: true });
    const outcomes = async (event: string, vars: Record<string, string> = {}) => (await send(ws, { event, customerId: customer.id, vars })).map((o) => `${o.status}`).join(',');
    expect(await outcomes('QUOTE_SENT', { quote_number: 'Q', quote_total: 'R', valid_until: 'x' })).toBe('queued'); // their own quote: always
    expect(await outcomes('PAYMENT_RECEIVED', { payment_amount: 'R', receipt_number: 'R1' })).toBe('queued');
    expect(await outcomes('BOOKING_CANCELLED', { service_name: 's', appointment_date: 'd', appointment_time: 't' })).toBe('queued'); // a change to their booking
    expect(await outcomes('JOB_COMPLETED')).toBe('skipped'); // opted out of job updates
    expect(await outcomes('BOOKING_REMINDER', { service_name: 's', appointment_date: 'd', appointment_time: 't' })).toBe('skipped');
    expect(await outcomes('INVOICE_REMINDER', { invoice_number: 'I', amount_due: 'R', due_date: 'd', due_phrase: 'is due' })).toBe('skipped');
    expect(await outcomes('SERVICE_REMINDER', { service_name: 'Service', service_due: 'soon' })).toBe('skipped');
    const rows = await comm(customer.id);
    expect(rows.filter((r) => r.status === 'SKIPPED').every((r) => /opted out/.test(r.status_detail))).toBe(true);
    // turning one back on lets it through
    await setCustomerPreferences(ws.ctx, customer.id, { jobUpdates: true });
    expect(await outcomes('JOB_COMPLETED')).toBe('queued');
    // marketing consent being TRUE changes nothing about what is sent: there is no marketing sending
    await ownerQuery('UPDATE customers SET marketing_consent = true WHERE id = $1', [customer.id]);
    await setCustomerPreferences(ws.ctx, customer.id, { serviceReminders: false });
    expect(await outcomes('SERVICE_REMINDER', { service_name: 'Service', service_due: 'soon' })).toBe('skipped');
  });

  it('a customer who prefers a phone call is not sent automatic messages, and is told why in the history', async () => {
    const { customer } = await seedCustomerVehicle(ws, 'Phone');
    await ownerQuery("UPDATE customers SET preferred_contact = 'PHONE' WHERE id = $1", [customer.id]);
    await updateCommSettings(ws.ctx, { jobUpdateEvents: ['JOB_COMPLETED'] });
    expect((await send(ws, { event: 'JOB_COMPLETED', customerId: customer.id })).map((o) => o.status)).toEqual(['skipped']);
    expect((await comm(customer.id))[0].status_detail).toMatch(/phone call/);
    expect((await send(ws, { event: 'QUOTE_SENT', customerId: customer.id, vars: { quote_number: 'Q', quote_total: 'R', valid_until: 'x' } })).map((o) => o.status)).toEqual(['queued']);
  });

  it('records consent as an append-only history with source, time, who and version', async () => {
    const { customer } = await seedCustomerVehicle(ws, 'Consent');
    await recordConsent(ws.ctx, customer.id, { type: 'SMS', status: 'GRANTED', source: 'in_person' });
    await recordConsent(ws.ctx, customer.id, { type: 'SMS', status: 'WITHDRAWN', source: 'phone' });
    const p = await getCustomerPreferences(ws.ctx, customer.id);
    expect(p.preferences.smsOk).toBe(false);
    expect(p.consents.map((c) => [c.status, c.source, c.version, c.changedById])).toEqual([['WITHDRAWN', 'phone', 1, ws.ctx.user.id], ['GRANTED', 'in_person', 1, ws.ctx.user.id]]);
    await expect(ownerQuery("UPDATE consent_records SET status = 'GRANTED' WHERE customer_id = $1", [customer.id])).rejects.toThrow(/append-only/);
    await expect(ownerQuery('DELETE FROM consent_records WHERE customer_id = $1', [customer.id])).rejects.toThrow();
    const tech = await createMemberCtx(ws, 'technician');
    await rejects(recordConsent(tech.ctx, customer.id, { type: 'SMS', status: 'GRANTED', source: 'phone' }), 403);
    await rejects(setCustomerPreferences(tech.ctx, customer.id, { jobUpdates: false }), 403);
    expect((await ownerQuery("SELECT count(*)::int AS n FROM audit_logs WHERE resource_id = $1 AND action = 'communication.preference_changed'", [customer.id])).rows[0].n).toBe(2);
  });

  it('the opt-out link in an optional email switches off that one category, needs a valid link, and never touches mandatory messages', async () => {
    const { customer } = await seedCustomerVehicle(ws, 'Optout');
    await updateCommSettings(ws.ctx, { jobUpdateEvents: ['JOB_COMPLETED'] });
    await send(ws, { event: 'JOB_COMPLETED', customerId: customer.id });
    const job = (await ownerQuery("SELECT payload FROM jobs WHERE type = 'comm.deliver' AND payload->>'communicationId' = (SELECT id::text FROM communications WHERE customer_id = $1)", [customer.id])).rows[0];
    const url = /(https?:\/\/\S+\/optout\/\S+)/.exec(job.payload.text as string)![1]!;
    expect(url).toContain('/optout/');
    const token = url.split('/optout/')[1]!;
    await expect(applyOptOut(token.slice(0, -2) + 'xx')).rejects.toMatchObject({ status: 404 });
    await expect(applyOptOut('nonsense')).rejects.toMatchObject({ status: 404 });
    expect(await applyOptOut(token)).toMatchObject({ category: 'jobUpdates' });
    expect((await getCustomerPreferences(ws.ctx, customer.id)).preferences).toMatchObject({ jobUpdates: false, paymentReminders: true });
    expect((await send(ws, { event: 'JOB_COMPLETED', customerId: customer.id })).map((o) => o.status)).toEqual(['skipped']);
    expect((await send(ws, { event: 'QUOTE_SENT', customerId: customer.id, vars: { quote_number: 'Q', quote_total: 'R', valid_until: 'x' } })).map((o) => o.status)).toEqual(['queued']);
    // another business's customer cannot be switched off with a link for this one
    const other = await createWorkspace('Optout Other');
    const oc = await seedCustomerVehicle(other, 'OC');
    const foreign = optOutLink(other.businessId, oc.customer.id, 'jobUpdates').split('/optout/')[1]!;
    await applyOptOut(foreign);
    expect((await getCustomerPreferences(ws.ctx, customer.id)).preferences.paymentReminders).toBe(true);
  });
});

describe('SMS and WhatsApp through the provider abstraction', () => {
  it('sends only with agreement, the business switch, the plan feature and a configured provider; every refusal is recorded with its reason', async () => {
    const w = await financeWorkspace('Texts');
    const { customer } = await seedCustomerVehicle(w, 'Txt');
    await ownerQuery("UPDATE customers SET preferred_contact = 'SMS', mobile = '082 555 0199' WHERE id = $1", [customer.id]);
    const vars = { quote_number: 'Q', quote_total: 'R 9', valid_until: 'x' };
    const run = async () => (await send(w, { event: 'QUOTE_SENT', customerId: customer.id, vars })).map((o) => `${o.channel}:${o.status}${o.detail ? `(${o.detail})` : ''}`);
    // no consent, not switched on
    let r = await run();
    expect(r.join(' ')).toMatch(/EMAIL:queued/);
    expect(r.join(' ')).toMatch(/SMS:skipped\(The customer has not agreed to receive SMS messages\.\)/);
    await recordConsent(w.ctx, customer.id, { type: 'SMS', status: 'GRANTED', source: 'in_person' });
    r = await run();
    expect(r.join(' ')).toMatch(/SMS:skipped\(SMS is not switched on for this business\.\)/);
    await updateCommSettings(w.ctx, { smsEnabled: true });
    r = await run();
    expect(r.filter((x) => x.startsWith('SMS')).join()).toBe('SMS:queued');
    await drainJobs();
    expect(MemoryTextProvider.sent).toHaveLength(1);
    const sent = MemoryTextProvider.sent[0]!;
    expect(sent).toMatchObject({ channel: 'sms', message: { to: '+27825550199' } });
    expect(sent.message.body).toMatch(/Quote|quote/);
    expect(sent.message.body).toMatch(/\/q\/|secure|Review|Q/); // carries what the customer needs
    const row = (await ownerQuery("SELECT * FROM communications WHERE customer_id = $1 AND channel = 'SMS' AND status = 'SENT'", [customer.id])).rows[0];
    expect(row).toMatchObject({ provider: 'memory', provider_ref: sent.providerRef, recipient: '+27825550199' });
    expect(row.delivered_at).toBeNull();
    // a delivery report moves it forward, and only forward
    expect(await applyDeliveryReport({ providerRef: sent.providerRef, state: 'delivered' })).toBe('applied');
    expect((await ownerQuery('SELECT status, delivered_at FROM communications WHERE id = $1', [row.id])).rows[0]).toMatchObject({ status: 'DELIVERED' });
    expect(await applyDeliveryReport({ providerRef: sent.providerRef, state: 'sent' })).toBe('ignored');
    expect(await applyDeliveryReport({ providerRef: sent.providerRef, state: 'viewed' })).toBe('applied');
    expect(await applyDeliveryReport({ providerRef: 'unknown-ref', state: 'delivered' })).toBe('unknown');
    await expect(ownerQuery("UPDATE communications SET status = 'SENT' WHERE id = $1", [row.id])).rejects.toThrow(/cannot go back/);
    await expect(ownerQuery("UPDATE communications SET status = 'FAILED' WHERE id = $1", [row.id])).rejects.toThrow(/cannot go back/);
  });

  it('WhatsApp needs the Business plan; a team plan records it as not switched on', async () => {
    const w = await financeWorkspace('WhatsApp Team');
    await upgradePlan(w, 'team');
    const { customer } = await seedCustomerVehicle(w, 'Wa');
    await ownerQuery("UPDATE customers SET preferred_contact = 'WHATSAPP' WHERE id = $1", [customer.id]);
    await recordConsent(w.ctx, customer.id, { type: 'WHATSAPP', status: 'GRANTED', source: 'in_person' });
    await rejects(updateCommSettings(w.ctx, { whatsappEnabled: true }), 402);
    const out = await send(w, { event: 'QUOTE_SENT', customerId: customer.id, vars: { quote_number: 'Q', quote_total: 'R', valid_until: 'x' } });
    expect(out.find((o) => o.channel === 'WHATSAPP')).toMatchObject({ status: 'skipped', detail: expect.stringMatching(/not switched on/) });
    const solo = await financeWorkspace('Solo Texts');
    await upgradePlan(solo, 'solo');
    await rejects(updateCommSettings(solo.ctx, { smsEnabled: true }), 402);
  });

  it('a permanent provider refusal fails the text without retrying; a transient one retries; an unconfigured provider is recorded as not set up', async () => {
    const w = await financeWorkspace('Provider Faults');
    const { customer } = await seedCustomerVehicle(w, 'Pf');
    await ownerQuery("UPDATE customers SET preferred_contact = 'SMS' WHERE id = $1", [customer.id]);
    await recordConsent(w.ctx, customer.id, { type: 'SMS', status: 'GRANTED', source: 'phone' });
    await updateCommSettings(w.ctx, { smsEnabled: true });
    const text = (key: string) => send(w, { event: 'BOOKING_CANCELLED', customerId: customer.id, dedupeKey: key, vars: { service_name: 's', appointment_date: 'd', appointment_time: 't' } });
    MemoryTextProvider.failNext = new ProviderError('permanent', 'The phone number is not valid.');
    await text('pf1');
    await drainJobs();
    const failed = (await ownerQuery("SELECT status, status_detail, attempts FROM communications WHERE customer_id = $1 AND channel = 'SMS'", [customer.id])).rows[0];
    expect(failed).toMatchObject({ status: 'FAILED', status_detail: 'The phone number is not valid.', attempts: 1 });
    MemoryTextProvider.failNext = new ProviderError('transient', 'busy');
    await text('pf2');
    await drainJobs();
    const waiting = (await ownerQuery("SELECT status FROM communications WHERE customer_id = $1 AND dedupe_key = 'pf2:SMS'", [customer.id])).rows[0];
    expect(waiting.status).toBe('QUEUED');
    await makeDue(w);
    await drainJobs();
    expect((await ownerQuery("SELECT status FROM communications WHERE customer_id = $1 AND dedupe_key = 'pf2:SMS'", [customer.id])).rows[0].status).toBe('SENT');
    // no provider at all
    const e = process.env as Record<string, string | undefined>;
    e.SMS_DRIVER = 'none';
    resetEnvForTests(); resetTextProvidersForTests();
    try {
      const out = await text('pf3');
      expect(out.find((o) => o.channel === 'SMS')).toMatchObject({ status: 'skipped', detail: expect.stringMatching(/not set up/) });
    } finally { e.SMS_DRIVER = 'memory'; resetEnvForTests(); resetTextProvidersForTests(); }
  });

  it('accepts a provider status callback only with a valid signature', async () => {
    const e = process.env as Record<string, string | undefined>;
    e.TWILIO_AUTH_TOKEN = 'cb-secret';
    resetEnvForTests();
    try {
      const w = await financeWorkspace('Callbacks');
      const { customer } = await seedCustomerVehicle(w, 'Cb');
      await ownerQuery("UPDATE customers SET preferred_contact = 'SMS' WHERE id = $1", [customer.id]);
      await recordConsent(w.ctx, customer.id, { type: 'SMS', status: 'GRANTED', source: 'phone' });
      await updateCommSettings(w.ctx, { smsEnabled: true });
      await send(w, { event: 'BOOKING_CANCELLED', customerId: customer.id, vars: { service_name: 's', appointment_date: 'd', appointment_time: 't' } });
      await drainJobs();
      const ref = (await ownerQuery("SELECT provider_ref FROM communications WHERE customer_id = $1 AND channel = 'SMS'", [customer.id])).rows[0].provider_ref as string;
      const params = { MessageSid: ref, MessageStatus: 'delivered' };
      const url = 'http://localhost:3000/api/public/webhooks/twilio';
      const sig = createHmac('sha1', 'cb-secret').update(url + 'MessageSid' + ref + 'MessageStatus' + 'delivered').digest('base64');
      expect(await handleTwilioCallback(params, 'bad-signature')).toBe(false);
      expect(await handleTwilioCallback(params, null)).toBe(false);
      expect((await ownerQuery("SELECT status FROM communications WHERE customer_id = $1 AND channel = 'SMS'", [customer.id])).rows[0].status).toBe('SENT');
      expect(await handleTwilioCallback(params, sig)).toBe(true);
      expect((await ownerQuery("SELECT status FROM communications WHERE customer_id = $1 AND channel = 'SMS'", [customer.id])).rows[0].status).toBe('DELIVERED');
    } finally { delete e.TWILIO_AUTH_TOKEN; resetEnvForTests(); }
  });
});

describe('templates', () => {
  it('custom wording needs the plan feature and permission, is validated, used in real messages, and falls back safely', async () => {
    const w = await financeWorkspace('Templates');
    const { customer } = await seedCustomerVehicle(w, 'Tpl');
    const list = await listTemplates(w.ctx);
    expect(list.items.some((t) => t.event === 'QUOTE_SENT' && t.channel === 'EMAIL' && t.mandatory)).toBe(true);
    await expect(saveTemplate(w.ctx, { event: 'QUOTE_SENT', channel: 'EMAIL', subject: 'Your quote {{quote_number}}', body: 'Hi {{customer_name}}, your quote total is {{quote_total}}. {{secure_link}}' })).resolves.toMatchObject({ version: 1 });
    await send(w, { event: 'QUOTE_SENT', customerId: customer.id, link: { url: 'https://app.test/q/' + 'x'.repeat(43) }, vars: { quote_number: 'QTE-77', quote_total: 'R 770,00', valid_until: 'x' } });
    await drainJobs();
    const mail = sentTo(customer.email!)[0]!;
    expect(mail.subject).toBe('Your quote QTE-77');
    expect(mail.text).toContain('your quote total is R 770,00');
    // rejected: variables the message may not use, unfinished placeholders, unknown messages, text channels where there are none
    await rejects(saveTemplate(w.ctx, { event: 'QUOTE_SENT', channel: 'EMAIL', subject: 's', body: 'Balance {{amount_due}}' }), 422);
    await rejects(saveTemplate(w.ctx, { event: 'QUOTE_SENT', channel: 'EMAIL', subject: 's', body: 'Hi {{customer_name' }), 422);
    await rejects(saveTemplate(w.ctx, { event: 'NOT_AN_EVENT', channel: 'EMAIL', subject: 's', body: 'x' }), 422);
    await rejects(saveTemplate(w.ctx, { event: 'QUOTE_DECISION', channel: 'SMS', body: 'x' }), 422);
    // switching the wording off falls back to the standard text; the standard text cannot be disabled
    await setTemplateActive(w.ctx, 'QUOTE_SENT', 'EMAIL', false);
    const c2 = await seedCustomerVehicle(w, 'Tpl2');
    await send(w, { event: 'QUOTE_SENT', customerId: c2.customer.id, vars: { quote_number: 'QTE-78', quote_total: 'R 1,00', valid_until: 'x' } });
    await drainJobs();
    expect(sentTo(c2.customer.email!)[0]!.subject).toBe('Quote QTE-78 from Templates');
    // a template that became invalid under the registry (or was written around the API) is never sent
    await ownerQuery("UPDATE message_templates SET body = 'Secret {{database_password}}', active = true WHERE business_id = $1 AND event = 'QUOTE_SENT'", [w.businessId]);
    const c3 = await seedCustomerVehicle(w, 'Tpl3');
    await send(w, { event: 'QUOTE_SENT', customerId: c3.customer.id, vars: { quote_number: 'QTE-79', quote_total: 'R 1,00', valid_until: 'x' } });
    await drainJobs();
    expect(sentTo(c3.customer.email!)[0]!.text).not.toMatch(/database_password|Secret/);
    const audit = await ownerQuery("SELECT count(*)::int AS n FROM audit_logs WHERE business_id = $1 AND action = 'communication.template_changed'", [w.businessId]);
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it('is limited by plan and permission', async () => {
    const solo = await financeWorkspace('Solo Templates');
    await upgradePlan(solo, 'solo');
    await rejects(saveTemplate(solo.ctx, { event: 'QUOTE_SENT', channel: 'EMAIL', subject: 's', body: 'x' }), 402);
    expect((await listTemplates(solo.ctx)).canCustomise).toBe(false);
    await expect(previewTemplate(solo.ctx, { event: 'QUOTE_SENT', channel: 'EMAIL', subject: 'Quote {{quote_number}}', body: 'Hi {{customer_name}}' })).resolves.toMatchObject({ subject: 'Quote QUO-000045' });
    const tech = await createMemberCtx(ws, 'technician');
    await rejects(saveTemplate(tech.ctx, { event: 'QUOTE_SENT', channel: 'EMAIL', subject: 's', body: 'x' }), 403);
    await rejects(listTemplates(tech.ctx), 403);
  });

  it('previews with sample values only, escaped, and runs nothing', async () => {
    const p = await previewTemplate(ws.ctx, { event: 'INVOICE_SENT', channel: 'EMAIL', subject: 'Invoice {{invoice_number}}', body: 'Hi {{customer_name}} <script>1</script> {{business_name}}' });
    expect(p.subject).toBe('Invoice INV-000210');
    expect(p.text).toContain('Alex Sample');
    expect(p.html).not.toContain('<script>');
    expect(JSON.stringify(p)).not.toMatch(/example\.test/); // no real customer data
  });
});

describe('business communication settings', () => {
  it('sets the name emails appear under, the reply address and the signature, validated, gated and audited', async () => {
    const w = await financeWorkspace('Identity');
    const { customer } = await seedCustomerVehicle(w, 'Id');
    await updateCommSettings(w.ctx, { senderName: 'Sunrise Auto Care', replyTo: 'service@sunrise.test', signature: 'Kind regards\nThe Sunrise team' });
    await send(w, { event: 'QUOTE_SENT', customerId: customer.id, vars: { quote_number: 'Q', quote_total: 'R', valid_until: 'x' } });
    await drainJobs();
    const mail = sentTo(customer.email!)[0]!;
    expect(mail).toMatchObject({ fromName: 'Sunrise Auto Care', replyTo: 'service@sunrise.test' });
    expect(mail.text).toContain('The Sunrise team');
    await rejects(updateCommSettings(w.ctx, { replyTo: 'not-an-email' }), 422);
    await rejects(updateCommSettings(w.ctx, { senderName: 'Evil <attacker@x.test>' }), 422);
    await rejects(updateCommSettings(w.ctx, { jobUpdateEvents: ['NOT_A_JOB_EVENT'] }), 422);
    await rejects(updateCommSettings(w.ctx, { internalRules: { SECURITY_ALERT: { enabled: false, permission: 'settings.view', inApp: true, email: true } } }), 422); // security alerts are not tunable
    const tech = await createMemberCtx(w, 'technician');
    await rejects(updateCommSettings(tech.ctx, { senderName: 'Hijack' }), 403);
    await rejects(getCommSettings(tech.ctx), 403);
    expect((await ownerQuery("SELECT 1 FROM audit_logs WHERE business_id = $1 AND action = 'communication.settings_changed'", [w.businessId])).rowCount).toBeGreaterThan(0);
  });

  it('internal rules decide who hears about low stock; people without the permission are never told', async () => {
    const w = await createWorkspace('Rules');
    const buyer = await memberWithPermissions(w, ['inventory.view', 'inventory.purchase']);
    const watcher = await memberWithPermissions(w, ['inventory.view', 'job.view']);
    const tell = () => withTenant(w.businessId, (tx) => notifyInternal(tx, w.businessId, 'LOW_STOCK', { title: 'Brake pads are low', linkUrl: '/inventory' }));
    await tell();
    const notified = async (userId: string) => (await ownerQuery("SELECT count(*)::int AS n FROM notifications WHERE business_id = $1 AND user_id = $2 AND type = 'LOW_STOCK'", [w.businessId, userId])).rows[0].n as number;
    expect(await notified(buyer.user.id)).toBe(0); // default audience is people who edit stock
    await updateCommSettings(w.ctx, { internalRules: { LOW_STOCK: { enabled: true, permission: 'inventory.purchase', inApp: true, email: false } } });
    await tell();
    expect(await notified(buyer.user.id)).toBe(1);
    expect(await notified(watcher.user.id)).toBe(0);
    await updateCommSettings(w.ctx, { internalRules: { LOW_STOCK: { enabled: false, permission: 'inventory.purchase', inApp: true, email: false } } });
    await tell();
    expect(await notified(buyer.user.id)).toBe(1);
    // email goes to them too when asked, through the same queue
    await updateCommSettings(w.ctx, { internalRules: { LOW_STOCK: { enabled: true, permission: 'inventory.purchase', inApp: false, email: true } } });
    await tell();
    await drainJobs();
    expect(sentTo(buyer.user.email).length).toBe(1);
  });
});

describe('manual operational messages', () => {
  it('one message to one customer, recorded as written by staff, audited, and refused when there is nowhere to send it', async () => {
    const { customer, vehicle } = await seedCustomerVehicle(ws, 'Manual');
    const { job } = await createJob(ws.ctx, { customerId: customer.id, vehicleId: vehicle.id, complaint: 'x', mileageKm: 60_000 });
    const out = await sendManualMessage(ws.ctx, { customerId: customer.id, subject: 'About your car', body: 'Your car is ready for a test drive.', entityType: 'job', entityId: job.id });
    expect(out.map((o) => o.status)).toEqual(['queued']);
    await drainJobs();
    expect(sentTo(customer.email!)[0]).toMatchObject({ subject: 'About your car' });
    expect(sentTo(customer.email!)[0]!.text).toContain('Your car is ready for a test drive.');
    const row = (await comm(customer.id))[0];
    expect(row).toMatchObject({ manual: true, event: 'MANUAL_MESSAGE', created_by_id: ws.ctx.user.id, entity_type: 'job', entity_id: job.id });
    expect((await ownerQuery("SELECT 1 FROM audit_logs WHERE business_id = $1 AND action = 'communication.sent_manually' AND resource_id = $2", [ws.businessId, customer.id])).rowCount).toBe(1);
    // a record that belongs to someone else cannot be used to reach this customer
    const other = await seedCustomerVehicle(ws, 'ManualOther');
    await rejects(sendManualMessage(ws.ctx, { customerId: other.customer.id, body: 'hello there', entityType: 'job', entityId: job.id }), 422);
    await ownerQuery('UPDATE customers SET email = NULL WHERE id = $1', [other.customer.id]);
    await rejects(sendManualMessage(ws.ctx, { customerId: other.customer.id, body: 'hello there' }), 422);
    const tech = await createMemberCtx(ws, 'technician');
    await rejects(sendManualMessage(tech.ctx, { customerId: customer.id, body: 'hello there' }), 403);
    await rejects(sendManualMessage(ws.ctx, { customerId: customer.id, body: 'x'.repeat(1001) }), 422);
    await rejects(sendManualMessage(ws.ctx, { customerIds: [customer.id, other.customer.id], body: 'bulk message' }), 422); // there is no list sending
  });
});

describe('communication history', () => {
  it('lists, filters and searches messages, with pagination, isolation, permission and plan gating', async () => {
    const w = await financeWorkspace('History');
    const a = await seedCustomerVehicle(w, 'Hist');
    const q = await sentQuote(w, { customerId: a.customer.id });
    await send(w, { event: 'BOOKING_CANCELLED', customerId: a.customer.id, vars: { service_name: 's', appointment_date: 'd', appointment_time: 't' } });
    await ownerQuery("UPDATE customers SET email = NULL WHERE id = $1", [(await seedCustomerVehicle(w, 'NoMailHist')).customer.id]);
    await drainJobs();
    const all = await listCommunications(w.ctx, {});
    expect(all.meta.total).toBeGreaterThanOrEqual(2);
    const mine = await listCommunications(w.ctx, { customerId: a.customer.id });
    expect(mine.items.map((i) => i.event).sort()).toEqual(['BOOKING_CANCELLED', 'QUOTE_SENT']);
    expect((await listCommunications(w.ctx, { customerId: a.customer.id, event: 'QUOTE_SENT' })).items).toHaveLength(1);
    expect((await listCommunications(w.ctx, { q: q.number })).items.map((i) => i.event)).toEqual(['QUOTE_SENT']);
    expect((await listCommunications(w.ctx, { q: a.customer.name })).items).toHaveLength(2);
    expect((await listCommunications(w.ctx, { status: 'SENT', channel: 'EMAIL' })).items.every((i) => i.status === 'SENT')).toBe(true);
    expect((await listCommunications(w.ctx, { q: '%' })).items).toHaveLength(0);
    expect((await listCommunications(w.ctx, { pageSize: 1, page: 2 })).items).toHaveLength(1);
    const detail = await getCommunication(w.ctx, mine.items[0]!.id);
    expect(detail.body).not.toMatch(/\/q\/[A-Za-z0-9_-]{20,}/);
    // another business sees none of it
    const other = await createWorkspace('History Other');
    expect((await listCommunications(other.ctx, {})).items).toHaveLength(0);
    await rejects(getCommunication(other.ctx, mine.items[0]!.id), 404);
    const tech = await createMemberCtx(w, 'technician');
    await rejects(listCommunications(tech.ctx, {}), 403);
    const solo = await financeWorkspace('Solo History');
    await upgradePlan(solo, 'solo');
    await rejects(listCommunications(solo.ctx, {}), 402);
  });

  it('is never erased: messages cannot be deleted or rewritten, whatever happened to them', async () => {
    const { customer } = await seedCustomerVehicle(ws, 'Keep');
    await send(ws, { event: 'QUOTE_SENT', customerId: customer.id, vars: { quote_number: 'Q', quote_total: 'R', valid_until: 'x' } });
    const id = (await comm(customer.id))[0].id;
    await expect(ownerQuery('DELETE FROM communications WHERE id = $1', [id])).rejects.toThrow(/cannot be deleted/);
    await expect(ownerQuery("UPDATE communications SET body = 'rewritten' WHERE id = $1", [id])).rejects.toThrow(/cannot be rewritten/);
    await expect(ownerQuery("UPDATE communications SET recipient = 'x@y.z' WHERE id = $1", [id])).rejects.toThrow(/cannot be rewritten/);
  });
});

describe('the in-app notification centre', () => {
  it('lists a person\'s own notifications, marks read and unread, marks all read, counts, paginates and isolates', async () => {
    const w = await createWorkspace('Centre');
    const other = await createMemberCtx(w, 'manager');
    await withTenant(w.businessId, async (tx) => {
      for (let i = 0; i < 30; i++) await notifyInApp(tx, { businessId: w.businessId, userId: w.ctx.user.id, type: 'JOB_ASSIGNED', title: `Job ${i}`, linkUrl: `/jobs/${i}` });
      await notifyInApp(tx, { businessId: w.businessId, userId: other.ctx.user.id, type: 'JOB_ASSIGNED', title: 'For someone else' });
      await notifyInApp(tx, { businessId: w.businessId, userId: w.ctx.user.id, type: 'SECURITY_ALERT', title: 'Password changed', priority: 'HIGH', linkUrl: 'https://evil.test/phish' });
    });
    expect(await getUnreadCount(w.ctx)).toBe(31);
    const page1 = await listNotifications(w.ctx, { pageSize: 10 });
    expect(page1.items).toHaveLength(10);
    expect(page1.meta).toMatchObject({ total: 31, totalPages: 4 });
    expect(page1.items.find((n) => n.title === 'Password changed')).toMatchObject({ priority: 'HIGH', linkUrl: null }); // an off-site link is never offered
    expect(page1.items.every((n) => n.title !== 'For someone else')).toBe(true);
    const first = page1.items[0]!;
    await setRead(w.ctx, first.id, true);
    expect(await getUnreadCount(w.ctx)).toBe(30);
    expect((await listNotifications(w.ctx, { filter: 'unread', pageSize: 100 })).items).toHaveLength(30);
    await setRead(w.ctx, first.id, false);
    expect(await getUnreadCount(w.ctx)).toBe(31);
    // someone else's notification cannot be read or changed by id
    const theirs = (await listNotifications(other.ctx, {})).items[0]!;
    await rejects(setRead(w.ctx, theirs.id, true), 404);
    expect((await markAllRead(w.ctx)).marked).toBe(31);
    expect(await getUnreadCount(w.ctx)).toBe(0);
    expect(await getUnreadCount(other.ctx)).toBe(1);
    // another business's person cannot reach it either
    const alien = await createWorkspace('Centre Alien');
    await rejects(setRead(alien.ctx, theirs.id, true), 404);
  });

  it('folds repetitive low-priority events into one notification, but never hides an important one', async () => {
    const w = await createWorkspace('Folding');
    await withTenant(w.businessId, async (tx) => {
      for (let i = 0; i < 4; i++) await notifyInApp(tx, { businessId: w.businessId, userId: w.ctx.user.id, type: 'LOW_STOCK', title: `Low stock ${i}`, groupKey: 'low-stock' });
      for (let i = 0; i < 3; i++) await notifyInApp(tx, { businessId: w.businessId, userId: w.ctx.user.id, type: 'PAYMENT_FAILED', title: `Payment ${i} failed`, priority: 'HIGH', groupKey: 'payments' });
    });
    const r = await listNotifications(w.ctx, { pageSize: 50 });
    expect(r.items.filter((n) => n.type === 'LOW_STOCK')).toHaveLength(1);
    expect(r.items.find((n) => n.type === 'LOW_STOCK')).toMatchObject({ count: 4, title: 'Low stock 3' });
    expect(r.items.filter((n) => n.type === 'PAYMENT_FAILED')).toHaveLength(3); // financial events are each shown
    // once it has been read, the next one starts a fresh notification
    await markAllRead(w.ctx);
    await withTenant(w.businessId, (tx) => notifyInApp(tx, { businessId: w.businessId, userId: w.ctx.user.id, type: 'LOW_STOCK', title: 'Low again', groupKey: 'low-stock' }));
    expect((await listNotifications(w.ctx, { filter: 'unread' })).items).toHaveLength(1);
  });

  it('shows security alerts and trial warnings in the centre, and the user cannot switch them off', async () => {
    const { changePassword } = await import('@/server/auth/service');
    const { TEST_PASSWORD, testMeta, userContext } = await import('../helpers/factory');
    const w = await createWorkspace('Alerts');
    const uctx = await userContext(w.owner);
    await changePassword({ ...uctx }, { currentPassword: TEST_PASSWORD, newPassword: 'Another-Passw0rd!77' });
    const n = (await listNotifications(w.ctx, {})).items.find((i) => i.type === 'SECURITY_ALERT');
    expect(n).toMatchObject({ priority: 'HIGH', title: expect.stringMatching(/password/i) });
    const { runTrialReminder } = await import('@/server/billing/lifecycle');
    const sub = await prisma().subscription.findFirstOrThrow({ where: { businessId: w.businessId } });
    await runTrialReminder({ subscriptionId: sub.id, day: 7 });
    expect((await listNotifications(w.ctx, {})).items.some((i) => i.type === 'TRIAL_ENDING')).toBe(true);
    void testMeta;
  });
});

describe('deterministic reminders', () => {
  it('sends a service reminder once per due point, honouring opt-outs and vehicle status, and again after the next service', async () => {
    const w = await financeWorkspace('Service Reminders');
    await upgradePlan(w, 'business');
    await updateCommSettings(w.ctx, { serviceRemindersOn: true, serviceReminderDays: 14, serviceReminderKm: 1000 });
    const { customer, vehicle } = await seedCustomerVehicle(w, 'Svc');
    const interval = await addInterval(w.ctx, vehicle.id, { name: 'Oil service', everyKm: 10_000, lastServiceKm: 41_500 }); // due at 51 500; the vehicle is at 50 000
    expect((await runServiceReminders(w.businessId)).sent).toBe(0); // 1 500 km to go: outside the 1 000 km lead
    await ownerQuery('UPDATE vehicles SET mileage_km = 50_600 WHERE id = $1', [vehicle.id]);
    expect((await runServiceReminders(w.businessId)).sent).toBe(1);
    expect((await runServiceReminders(w.businessId)).sent).toBe(0); // not again for the same due point
    expect((await runServiceReminders(w.businessId)).sent).toBe(0);
    const msgs = (await comm(customer.id)).filter((m) => m.event === 'SERVICE_REMINDER');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toMatch(/Oil service/);
    expect(msgs[0].body).toMatch(/51.500 km/);
    expect((await ownerQuery('SELECT outcome FROM service_reminder_log WHERE interval_id = $1', [interval.id])).rows).toEqual([{ outcome: 'SENT' }]);
    await drainJobs();
    expect(sentTo(customer.email!).some((m) => /Service due/.test(m.subject))).toBe(true);
    // the service is done: the next due point is later, so no reminder yet; once near it, one more
    await ownerQuery('UPDATE service_intervals SET last_service_km = 51_000 WHERE id = $1', [interval.id]);
    expect((await runServiceReminders(w.businessId)).sent).toBe(0);
    await ownerQuery('UPDATE vehicles SET mileage_km = 60_500 WHERE id = $1', [vehicle.id]);
    expect((await runServiceReminders(w.businessId)).sent).toBe(1);
    // a customer who opted out is respected and not asked again; an inactive vehicle is left alone
    const b = await seedCustomerVehicle(w, 'SvcOptOut');
    await addInterval(w.ctx, b.vehicle.id, { name: 'Brake check', everyKm: 5_000, lastServiceKm: 40_000 });
    await ownerQuery('UPDATE vehicles SET mileage_km = 45_500 WHERE id = $1', [b.vehicle.id]);
    await setCustomerPreferences(w.ctx, b.customer.id, { serviceReminders: false });
    const c = await seedCustomerVehicle(w, 'SvcInactive');
    await addInterval(w.ctx, c.vehicle.id, { name: 'Tyre rotation', everyKm: 5_000, lastServiceKm: 40_000 });
    await ownerQuery("UPDATE vehicles SET mileage_km = 45_500, status = 'INACTIVE' WHERE id = $1", [c.vehicle.id]);
    const r = await runServiceReminders(w.businessId);
    expect(r.sent).toBe(0);
    expect((await comm(b.customer.id)).filter((m) => m.event === 'SERVICE_REMINDER')[0]).toMatchObject({ status: 'SKIPPED' });
    expect((await comm(c.customer.id)).filter((m) => m.event === 'SERVICE_REMINDER')).toHaveLength(0);
    expect((await runServiceReminders(w.businessId)).skipped).toBe(0); // the opt-out is remembered, not retried every run
  });

  it('service reminders need the plan feature and the business switch', async () => {
    const solo = await financeWorkspace('Solo Reminders');
    await upgradePlan(solo, 'solo');
    await rejects(updateCommSettings(solo.ctx, { serviceRemindersOn: true }), 402);
    const off = await financeWorkspace('Reminders Off');
    const s = await seedCustomerVehicle(off, 'Off');
    await addInterval(off.ctx, s.vehicle.id, { name: 'Service', everyKm: 5_000, lastServiceKm: 40_000 });
    await ownerQuery('UPDATE vehicles SET mileage_km = 45_500 WHERE id = $1', [s.vehicle.id]);
    expect((await runServiceReminders(off.businessId)).sent).toBe(0);
  });

  it('reminds about an appointment inside the window, once, and marks the booking', async () => {
    const w = await financeWorkspace('Booking Reminders');
    const { customer, vehicle } = await seedCustomerVehicle(w, 'Bk');
    const b = await createBooking(w.ctx, { customerId: customer.id, vehicleId: vehicle.id, serviceLabel: 'Full service', durationMin: 60, date: nextWeekday(2), time: '09:00' });
    await drainJobs();
    expect(sentTo(customer.email!).some((m) => /is confirmed/.test(m.subject))).toBe(true); // confirmation at booking
    expect(await runBookingReminders(w.businessId)).toBe(0); // two days out: too early
    await ownerQuery("UPDATE bookings SET starts_at = now() + interval '20 hours', ends_at = now() + interval '21 hours' WHERE id = $1", [b.id]);
    expect(await runBookingReminders(w.businessId)).toBe(1);
    expect(await runBookingReminders(w.businessId)).toBe(0);
    expect((await ownerQuery('SELECT status, reminder_sent_at FROM bookings WHERE id = $1', [b.id])).rows[0]).toMatchObject({ status: 'REMINDER_SENT' });
    await drainJobs();
    const reminder = sentTo(customer.email!).find((m) => /Reminder: your appointment/.test(m.subject))!;
    expect(reminder.text).toContain('Full service');
    expect(reminder.text).not.toMatch(/internal/i);
    // switched off by the business: nothing is sent
    const { customer: c2, vehicle: v2 } = await seedCustomerVehicle(w, 'Bk2');
    const b2 = await createBooking(w.ctx, { customerId: c2.id, vehicleId: v2.id, serviceLabel: 'Check', durationMin: 60, date: nextWeekday(3), time: '09:00' });
    await ownerQuery("UPDATE bookings SET starts_at = now() + interval '10 hours', ends_at = now() + interval '11 hours' WHERE id = $1", [b2.id]);
    await updateCommSettings(w.ctx, { bookingRemindersOn: false });
    expect(await runBookingReminders(w.businessId)).toBe(0);
  });
});

describe('job updates to customers', () => {
  it('are off until the business switches them on, then go out with a secure link to the customer page', async () => {
    const w = await financeWorkspace('Job Updates');
    const { customer, vehicle } = await seedCustomerVehicle(w, 'Ju');
    const { job } = await createJob(w.ctx, { customerId: customer.id, vehicleId: vehicle.id, complaint: 'x', mileageKm: 60_000 });
    await changeJobStatus(w.ctx, job.id, { status: 'INSPECTION' });
    expect((await comm(customer.id)).filter((c) => c.event.startsWith('JOB_'))).toHaveLength(0);
    expect((await ownerQuery("SELECT count(*)::int AS n FROM document_links WHERE business_id = $1 AND kind = 'JOB'", [w.businessId])).rows[0].n).toBe(0); // no link is made for a message nobody sends
    await updateCommSettings(w.ctx, { jobUpdateEvents: ['JOB_CHECKED_IN', 'JOB_WORK_STARTED'] });
    const second = await createJob(w.ctx, { customerId: customer.id, vehicleId: vehicle.id, complaint: 'y', mileageKm: 60_100 });
    const sent = (await comm(customer.id)).filter((c) => c.event === 'JOB_CHECKED_IN');
    expect(sent).toHaveLength(1);
    expect(sent[0].entity_id).toBe(second.job.id);
    const payload = (await ownerQuery("SELECT payload FROM jobs WHERE dedupe_key = $1", [`comm:${sent[0].id}`])).rows[0].payload;
    expect(payload.text).toMatch(/\/j\/[A-Za-z0-9_-]{20,}/);
    expect(sent[0].body).toContain('/j/[private link]');
    // a stage the business did not enable sends nothing
    await changeJobStatus(w.ctx, second.job.id, { status: 'INSPECTION' });
    expect((await comm(customer.id)).filter((c) => c.event === 'JOB_DIAGNOSIS_COMPLETE')).toHaveLength(0);
    // a team plan is needed for job updates at all
    const solo = await financeWorkspace('Solo Job Updates');
    await upgradePlan(solo, 'solo');
    await rejects(updateCommSettings(solo.ctx, { jobUpdateEvents: ['JOB_CHECKED_IN'] }), 402);
  });
});

describe('quotes and the money messages go through the same service', () => {
  it('records the quote and invoice messages with their record, and resends do not duplicate within the same minute window rules', async () => {
    const { customer } = await seedCustomerVehicle(ws, 'Money');
    const q = await sentQuote(ws, { customerId: customer.id, lines: [L('Wipers', 1, 25_000)] });
    const rows = (await comm(customer.id)).filter((r) => r.entity_id === q.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: 'QUOTE_SENT', channel: 'EMAIL' });
    const again = await sendQuote(ws.ctx, q.id);
    expect(again.emailed).toBe(true);
    expect((await comm(customer.id)).filter((r) => r.entity_id === q.id)).toHaveLength(2); // an explicit resend is a new message
  });
});

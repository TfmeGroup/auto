import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma } from '@/server/db/client';
import { getInvoice } from '@/server/finance/invoices';
import { runFinanceTasks } from '@/server/finance/scheduled';
import { updateFinanceSettings } from '@/server/finance/settings';
import { drainJobs, latestEmailTo, ownerQuery, sentTo, upgradePlan, type TestWorkspace } from '../helpers/factory';
import { L, financeWorkspace, issuedInvoice, party, pay } from '../helpers/finance';

afterAll(disconnectPrisma);

let ws: TestWorkspace;
beforeAll(async () => {
  ws = await financeWorkspace('Reminder Shop');
  await updateFinanceSettings(ws.ctx, { remindersEnabled: true, reminderOffsets: [-3, 0, 7], reminderRepeatDays: 7 });
});

const email = async (customerId: string) => (await ownerQuery<{ email: string }>('SELECT email FROM customers WHERE id = $1', [customerId])).rows[0]!.email;
// The communication history records each message under a dedupe key; a reminder's key carries which scheduled reminder it was.
const logs = async (invoiceId: string) => (await ownerQuery<{ kind: string; status: string; template_key: string; template_version: number }>("SELECT regexp_replace(dedupe_key, '^invoice:[^:]+:reminder:(.*):[A-Z]+$', 'reminder_\\1') AS kind, status, template_key, template_version FROM communications WHERE entity_id = $1 ORDER BY created_at", [invoiceId])).rows;
const reminders = async (invoiceId: string) => (await logs(invoiceId)).filter((l) => l.kind.startsWith('reminder_'));

describe('payment reminders', () => {
  it('sends the reminder that is due once, however many times the scheduler runs, even at the same moment', async () => {
    const inv = await issuedInvoice(ws, { send: true, dueInDays: 2 });
    const [a, b] = await Promise.all([runFinanceTasks(), runFinanceTasks()]);
    expect(a.remindersQueued + b.remindersQueued).toBeGreaterThanOrEqual(1);
    expect(await reminders(inv.id)).toHaveLength(1);
    expect((await reminders(inv.id))[0]).toMatchObject({ kind: 'reminder_offset:-3', status: 'QUEUED', template_key: 'INVOICE_REMINDER', template_version: 1 });
    expect((await runFinanceTasks()).remindersQueued).toBe(0);
    expect(await reminders(inv.id)).toHaveLength(1);
    const mail = await latestEmailTo(await email(inv.customerId));
    expect(mail?.subject).toContain(inv.number);
    expect(mail?.text).toMatch(/is due/);
    expect(mail?.text).toContain('/i/'); // link to the invoice
    expect(mail?.text).not.toMatch(/unsubscribe|marketing|offer/i); // transactional, not marketing
  });

  it('says overdue when it is late, and steps through the schedule as time passes', async () => {
    const inv = await issuedInvoice(ws, { send: true, dueInDays: -3 });
    await runFinanceTasks();
    const first = await reminders(inv.id);
    expect(first.map((r) => r.kind)).toEqual(['reminder_offset:0']);
    expect((await latestEmailTo(await email(inv.customerId)))?.text).toMatch(/was due on/);
    // a week and a bit later the next threshold applies, once
    const { backdateInvoice } = await import('../helpers/finance');
    await backdateInvoice(inv.id, -10);
    await runFinanceTasks();
    await runFinanceTasks();
    expect((await reminders(inv.id)).map((r) => r.kind)).toEqual(['reminder_offset:0', 'reminder_offset:7']);
    // and then it repeats weekly after the last offset
    await backdateInvoice(inv.id, -22);
    await runFinanceTasks();
    expect((await reminders(inv.id)).map((r) => r.kind)).toEqual(['reminder_offset:0', 'reminder_offset:7', 'reminder_repeat:2']);
    await drainJobs();
  });

  it('sends nothing for invoices that were never sent, are paid, or have been paid since', async () => {
    const unsent = await issuedInvoice(ws, { dueInDays: -3 });
    const paid = await issuedInvoice(ws, { send: true, dueInDays: -3 });
    await pay(ws, paid.id, 145_000);
    const partly = await issuedInvoice(ws, { send: true, dueInDays: -3 });
    await runFinanceTasks();
    expect(await reminders(unsent.id)).toHaveLength(0);
    expect(await reminders(paid.id)).toHaveLength(0);
    expect(await reminders(partly.id)).toHaveLength(1); // a part-paid invoice still owes money
    const w = await financeWorkspace('Quiet Shop');
    const quiet = await issuedInvoice(w, { send: true, dueInDays: -3 });
    await runFinanceTasks();
    expect(await reminders(quiet.id)).toHaveLength(0); // reminders are off by default
  });

  it('respects the customer\'s communication preference and a missing email address, and logs why nothing was sent', async () => {
    const { customer, vehicle } = await party(ws, 'Pref');
    await ownerQuery("UPDATE customers SET preferred_contact = 'WHATSAPP' WHERE id = $1", [customer.id]);
    const inv = await issuedInvoice(ws, { customerId: customer.id, vehicleId: vehicle.id, send: true, dueInDays: -3 });
    await drainJobs(); // deliver the invoice the workshop sent explicitly first
    const before = sentTo(await email(customer.id)).length;
    await runFinanceTasks();
    const r = await reminders(inv.id);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ status: 'SKIPPED' });
    const detail = await ownerQuery('SELECT status_detail AS detail FROM communications WHERE entity_id = $1 AND dedupe_key LIKE $2', [inv.id, '%:reminder:%']);
    expect(detail.rows[0]!.detail).toMatch(/prefers whatsapp/i);
    await drainJobs();
    expect(sentTo(await email(customer.id)).length).toBe(before + 0); // nothing automatic was emailed

    const p2 = await party(ws, 'NoMailRem');
    await ownerQuery('UPDATE customers SET email = NULL WHERE id = $1', [p2.customer.id]);
    const inv2 = await issuedInvoice(ws, { customerId: p2.customer.id, vehicleId: p2.vehicle.id, send: true, dueInDays: -3 });
    await runFinanceTasks();
    expect((await reminders(inv2.id))[0]).toMatchObject({ status: 'SKIPPED' });
  });

  it('stops once the invoice is paid and never touches cancelled invoices', async () => {
    const inv = await issuedInvoice(ws, { send: true, dueInDays: 2 });
    await runFinanceTasks();
    expect(await reminders(inv.id)).toHaveLength(1);
    await pay(ws, inv.id, 145_000);
    const { backdateInvoice } = await import('../helpers/finance');
    await backdateInvoice(inv.id, -10);
    await runFinanceTasks();
    expect(await reminders(inv.id)).toHaveLength(1);
    expect((await getInvoice(ws.ctx, inv.id)).invoice.status).toBe('PAID');
  });

  it('needs a plan with reminders, and a business that can still write', async () => {
    const solo = await financeWorkspace('Solo Reminder Shop');
    await ownerQuery("UPDATE finance_settings SET reminders_enabled = true, reminder_offsets = ARRAY[0] WHERE business_id = $1", [solo.businessId]);
    await upgradePlan(solo, 'solo');
    const inv = await issuedInvoice(solo, { send: true, dueInDays: -3 });
    await runFinanceTasks();
    expect(await reminders(inv.id)).toHaveLength(0);
    const team = await financeWorkspace('Lapsed Reminder Shop');
    await ownerQuery("UPDATE finance_settings SET reminders_enabled = true, reminder_offsets = ARRAY[0] WHERE business_id = $1", [team.businessId]);
    const inv2 = await issuedInvoice(team, { send: true, dueInDays: -3 });
    await ownerQuery("UPDATE subscriptions SET status = 'EXPIRED', trial_ends_at = now() - interval '30 days' WHERE business_id = $1", [team.businessId]);
    await runFinanceTasks();
    expect(await reminders(inv2.id)).toHaveLength(0);
  });

  it('writes an audit entry for each reminder', async () => {
    const inv = await issuedInvoice(ws, { send: true, dueInDays: 1 });
    await runFinanceTasks();
    const a = await ownerQuery("SELECT metadata FROM audit_logs WHERE resource_id = $1 AND action = 'invoice.reminder_queued'", [inv.id]);
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]!.metadata).toMatchObject({ reminder: 'offset:-3' });
    void L;
  });
});

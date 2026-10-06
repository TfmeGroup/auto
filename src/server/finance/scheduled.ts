import { prisma, withTenant } from '@/server/db/client';
import { logger } from '@/lib/logger';
import { formatMoney } from '@/lib/money';
import { formatDate } from '@/lib/format';
import { todayIso } from '@/lib/tz';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { recordActivity } from '@/server/activity/service';
import { canUseFeature } from '@/server/billing/features';
import { loadEffectiveSubscription } from '@/server/billing/subscriptions';
import { systemMeta } from '@/server/context';
import { daysBetween } from './calc';
import { dateOnly, isoOf, loadFinanceSettings, lockRow, recordFinanceEvent } from './common';
import { recomputeInvoice } from './ledger';
import { createDocumentLink, revokeDocumentLinks } from './links';
import { notifyStaff, sendFinanceMessage } from './notify';

/**
 * Time-based financial work, run by the worker's scheduler (never by someone happening to open a page):
 *  - quotes past their "valid until" date become Expired (kept, never deleted; the customer can no longer approve them);
 *  - issued invoices past their due date become Overdue;
 *  - payment reminders go out according to each business's settings, once each (a dedupe key makes repeat runs harmless).
 * Every step is safe to run twice, from any number of worker instances at the same time.
 */

export interface FinanceTickResult {
  quotesExpiring: number;
  quotesExpired: number;
  invoicesOverdue: number;
  remindersQueued: number;
}

const BIG = 7; // never send a reminder for a threshold that passed more than a week ago

export async function runFinanceTasks(now = new Date()): Promise<FinanceTickResult> {
  const out: FinanceTickResult = { quotesExpiring: 0, quotesExpired: 0, invoicesOverdue: 0, remindersQueued: 0 };
  const businesses = await prisma().business.findMany({ where: { status: 'ACTIVE' }, select: { id: true, name: true, tradingName: true, timezone: true, currency: true, locale: true } });
  for (const b of businesses) {
    try {
      out.quotesExpiring += await remindExpiringQuotes(b, now);
      out.quotesExpired += await expireQuotes(b, now);
      out.invoicesOverdue += await markOverdue(b, now);
      out.remindersQueued += await queueReminders(b, now);
    } catch (err) {
      logger.error({ businessId: b.id, err: String(err) }, 'finance scheduled tasks failed for a business');
    }
  }
  return out;
}

type Biz = { id: string; name: string; tradingName: string | null; timezone: string; currency: string; locale: string };

async function expireQuotes(b: Biz, now: Date): Promise<number> {
  const today = todayIso(b.timezone, now);
  const due = await withTenant(b.id, (tx) => tx.quote.findMany({ where: { businessId: b.id, status: { in: ['SENT', 'VIEWED'] }, validUntil: { lt: dateOnly(today) } }, select: { id: true }, take: 500 }));
  let n = 0;
  for (const { id } of due) {
    const done = await withTenant(b.id, async (tx) => {
      await lockRow(tx, 'quotes', b.id, id);
      const q = await tx.quote.findFirstOrThrow({ where: { id, businessId: b.id } });
      if (!['SENT', 'VIEWED'].includes(q.status) || !q.validUntil || isoOf(q.validUntil)! >= today) return false;
      await tx.quote.update({ where: { id }, data: { status: 'EXPIRED', expiredAt: now } });
      await revokeDocumentLinks(tx, b.id, 'QUOTE', id);
      await recordFinanceEvent(tx, b.id, { entityType: 'quote', entityId: id, version: q.currentVersion, type: 'quote.expired', actor: { kind: 'SYSTEM', name: 'Scheduler' }, detail: { validUntil: isoOf(q.validUntil) } });
      await recordAudit(tx, systemMeta('scheduler'), { action: AuditActions.quoteExpired, businessId: b.id, userId: null, resourceType: 'quote', resourceId: id, before: { status: q.status }, after: { status: 'EXPIRED' }, metadata: { number: q.number, validUntil: isoOf(q.validUntil) } });
      await recordActivity(tx, b.id, null, { type: 'quote.expired', summary: `Quote ${q.number} expired`, customerId: q.customerId, vehicleId: q.vehicleId, jobId: q.jobId, data: { quoteId: id } });
      if (q.createdById) await notifyStaff(tx, b.id, [q.createdById], { type: 'QUOTE_EXPIRED', title: `Quote ${q.number} has expired`, linkUrl: `/quotes/${id}` });
      return true;
    });
    if (done) n++;
  }
  return n;
}

/** A sent quote that is about to lapse: one reminder to the customer (per expiry date), when the business has reminders switched on. */
const EXPIRY_WARNING_DAYS = 3;
async function remindExpiringQuotes(b: Biz, now: Date): Promise<number> {
  const today = todayIso(b.timezone, now);
  const gate = await withTenant(b.id, async (tx) => {
    const s = await loadFinanceSettings(tx, b.id);
    if (!s.remindersEnabled) return false;
    const sub = await loadEffectiveSubscription(tx, b.id, now);
    return sub.canWrite && canUseFeature(sub, 'payment_reminders');
  });
  if (!gate) return 0;
  const soon = new Date(dateOnly(today).getTime() + EXPIRY_WARNING_DAYS * 86_400_000);
  const due = await withTenant(b.id, (tx) => tx.quote.findMany({ where: { businessId: b.id, status: { in: ['SENT', 'VIEWED'] }, validUntil: { gte: dateOnly(today), lte: soon } }, select: { id: true }, take: 500 }));
  let n = 0;
  for (const { id } of due) {
    const sent = await withTenant(b.id, async (tx) => {
      const q = await tx.quote.findFirstOrThrow({ where: { id, businessId: b.id } });
      if (!['SENT', 'VIEWED'].includes(q.status) || !q.validUntil) return false;
      const v = await tx.quoteVersion.findFirstOrThrow({ where: { quoteId: id, businessId: b.id, version: q.currentVersion } });
      const link = await createDocumentLink(tx, b.id, 'QUOTE', id, null);
      const res = await sendFinanceMessage(tx, b.id, {
        customerId: q.customerId, entityType: 'quote', entityId: id, event: 'QUOTE_EXPIRING', vehicleId: q.vehicleId, locationId: q.locationId, link: link.url,
        dedupeKey: `quote:${id}:expiring:${isoOf(q.validUntil)}`,
        vars: { quote_number: q.number, quote_total: formatMoney(v.totalCents, b.currency, b.locale), valid_until: formatDate(q.validUntil, 'UTC', b.locale) },
      });
      return res === 'queued';
    });
    if (sent) n++;
  }
  return n;
}

async function markOverdue(b: Biz, now: Date): Promise<number> {
  const today = todayIso(b.timezone, now);
  const due = await withTenant(b.id, (tx) =>
    tx.invoice.findMany({
      where: { businessId: b.id, finalisedAt: { not: null }, cancelledAt: null, writtenOffAt: null, outstandingCents: { gt: 0 }, status: { in: ['ISSUED', 'SENT', 'VIEWED', 'PARTIALLY_PAID'] }, dueDate: { lt: dateOnly(today) } },
      select: { id: true }, take: 1000,
    }),
  );
  let n = 0;
  for (const { id } of due) {
    const changed = await withTenant(b.id, async (tx) => {
      await lockRow(tx, 'invoices', b.id, id);
      const before = await tx.invoice.findFirstOrThrow({ where: { id, businessId: b.id } });
      const after = await recomputeInvoice(tx, b.id, id);
      if (before.status === after.status || after.status !== 'OVERDUE') return false;
      await recordFinanceEvent(tx, b.id, { entityType: 'invoice', entityId: id, type: 'invoice.overdue', actor: { kind: 'SYSTEM', name: 'Scheduler' }, detail: { dueDate: isoOf(after.dueDate), outstandingCents: after.outstandingCents } });
      await recordAudit(tx, systemMeta('scheduler'), { action: AuditActions.invoiceOverdue, businessId: b.id, userId: null, resourceType: 'invoice', resourceId: id, before: { status: before.status }, after: { status: 'OVERDUE' }, metadata: { number: after.number, outstandingCents: after.outstandingCents } });
      return true;
    });
    if (changed) n++;
  }
  return n;
}

/**
 * Which reminder, if any, an invoice is due for today. Offsets are days relative to the due date (negative = before). Only the most
 * recent threshold that has passed is used, so switching reminders on does not fire three emails at once, and an old threshold
 * is never sent late. After the last offset an overdue reminder repeats every `repeatDays` days (0 = never).
 */
export function dueReminder(daysFromDue: number, offsets: number[], repeatDays: number): { key: string; offset: number; when: 'before' | 'today' | 'overdue' } | null {
  const sorted = [...new Set(offsets)].sort((a, c) => a - c);
  const passed = sorted.filter((o) => daysFromDue >= o);
  const last = passed[passed.length - 1];
  if (last === undefined) return null;
  const isLastOffset = last === sorted[sorted.length - 1];
  if (isLastOffset && repeatDays > 0 && daysFromDue - last >= repeatDays) {
    const k = Math.floor((daysFromDue - last) / repeatDays);
    if (daysFromDue - (last + k * repeatDays) <= BIG) return { key: `repeat:${k}`, offset: last + k * repeatDays, when: 'overdue' };
  }
  if (daysFromDue - last > BIG) return null;
  // The wording follows how late the invoice actually is today, not which threshold triggered it.
  return { key: `offset:${last}`, offset: last, when: daysFromDue < 0 ? 'before' : daysFromDue === 0 ? 'today' : 'overdue' };
}

async function queueReminders(b: Biz, now: Date): Promise<number> {
  const today = todayIso(b.timezone, now);
  const gate = await withTenant(b.id, async (tx) => {
    const s = await loadFinanceSettings(tx, b.id);
    if (!s.remindersEnabled || s.reminderOffsets.length === 0) return null;
    const sub = await loadEffectiveSubscription(tx, b.id, now);
    if (!sub.canWrite || !canUseFeature(sub, 'payment_reminders')) return null;
    return s;
  });
  if (!gate) return 0;
  const open = await withTenant(b.id, (tx) =>
    tx.invoice.findMany({ where: { businessId: b.id, finalisedAt: { not: null }, sentAt: { not: null }, cancelledAt: null, writtenOffAt: null, outstandingCents: { gt: 0 } }, select: { id: true, dueDate: true }, take: 2000 }),
  );
  let n = 0;
  for (const { id, dueDate } of open) {
    if (!dueDate) continue;
    const r = dueReminder(daysBetween(isoOf(dueDate)!, today), gate.reminderOffsets, gate.reminderRepeatDays);
    if (!r) continue;
    const queued = await withTenant(b.id, async (tx) => {
      const dedupeKey = `invoice:${id}:reminder:${r.key}`;
      if (await tx.communication.findFirst({ where: { businessId: b.id, dedupeKey: { startsWith: `${dedupeKey}:` } }, select: { id: true } })) return false;
      const inv = await tx.invoice.findFirstOrThrow({ where: { id, businessId: b.id } });
      if (inv.outstandingCents <= 0 || inv.cancelledAt || inv.writtenOffAt) return false;
      const link = await createDocumentLink(tx, b.id, 'INVOICE', id, null);
      const res = await sendFinanceMessage(tx, b.id, {
        customerId: inv.customerId, entityType: 'invoice', entityId: id, event: r.when === 'overdue' ? 'INVOICE_OVERDUE' : 'INVOICE_REMINDER', vehicleId: inv.vehicleId, locationId: inv.locationId, dedupeKey, link: link.url,
        vars: { invoice_number: inv.number!, amount_due: formatMoney(inv.outstandingCents, b.currency, b.locale), due_date: formatDate(inv.dueDate!, 'UTC', b.locale), due_phrase: r.when === 'today' ? 'is due today' : `is due on ${formatDate(inv.dueDate!, 'UTC', b.locale)}` },
      });
      if (res === 'queued') {
        await recordAudit(tx, systemMeta('scheduler'), { action: AuditActions.reminderQueued, businessId: b.id, userId: null, resourceType: 'invoice', resourceId: id, metadata: { reminder: r.key, number: inv.number } });
        await recordFinanceEvent(tx, b.id, { entityType: 'invoice', entityId: id, type: 'invoice.reminder_sent', actor: { kind: 'SYSTEM', name: 'Scheduler' }, detail: { reminder: r.key } });
      }
      return res === 'queued';
    });
    if (queued) n++;
  }
  return n;
}

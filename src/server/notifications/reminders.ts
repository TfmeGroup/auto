import { formatDate } from '@/lib/format';
import { logger } from '@/lib/logger';
import { seq, withTenant, prisma } from '@/server/db/client';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { loadEffectiveSubscription } from '@/server/billing/subscriptions';
import { sendCustomerMessage } from './comms';
import { loadCommSettings } from './settings';

/**
 * Deterministic service and booking reminders. A service is due by the DATE and/or the MILEAGE set on the vehicle's service interval
 * (whichever comes first); nothing is predicted or estimated. A reminder goes out when the due point is within the business's lead
 * time (days / km), once per due point, honouring the customer's preferences and the vehicle's and customer's status.
 */
export interface IntervalFacts {
  everyKm: number | null;
  everyMonths: number | null;
  lastServiceAt: Date | null;
  lastServiceKm: number | null;
}

export interface DuePoint {
  dueDate: Date | null;
  dueKm: number | null;
}

/** Add whole calendar months, keeping the day of month where the target month has it (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(d: Date, months: number): Date {
  const out = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(d.getUTCDate(), last));
  return out;
}

export function nextServiceDue(i: IntervalFacts): DuePoint {
  return {
    dueDate: i.everyMonths && i.lastServiceAt ? addMonths(i.lastServiceAt, i.everyMonths) : null,
    dueKm: i.everyKm && i.lastServiceKm !== null ? i.lastServiceKm + i.everyKm : null,
  };
}

/** Is a reminder due now? `leadDays`/`leadKm` are how early to remind. Overdue counts as due. */
export function reminderIsDue(due: DuePoint, today: Date, currentKm: number | null, leadDays: number, leadKm: number): boolean {
  const byDate = due.dueDate ? today.getTime() >= due.dueDate.getTime() - leadDays * 86_400_000 : false;
  const byKm = due.dueKm !== null && currentKm !== null ? currentKm >= due.dueKm - leadKm : false;
  return byDate || byKm;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export const dueKeyOf = (due: DuePoint) => `due:${due.dueDate ? isoDay(due.dueDate) : '-'}:${due.dueKm ?? '-'}`;

export interface ReminderRunResult {
  considered: number;
  sent: number;
  skipped: number;
}

export async function runServiceReminders(businessId: string, now = new Date()): Promise<ReminderRunResult> {
  const out: ReminderRunResult = { considered: 0, sent: 0, skipped: 0 };
  const gate = await withTenant(businessId, async (tx) => {
    const settings = await loadCommSettings(tx, businessId);
    const sub = await loadEffectiveSubscription(tx, businessId);
    return { settings, ok: settings.serviceRemindersOn && sub.features.has('service_reminders') && sub.canWrite };
  });
  if (!gate.ok) return out;
  const { settings } = gate;
  const biz = await prisma().business.findUniqueOrThrow({ where: { id: businessId }, select: { locale: true } });

  const intervals = await withTenant(businessId, (tx) =>
    tx.serviceInterval.findMany({ where: { businessId, active: true, vehicle: { status: { in: ['ACTIVE', 'AWAITING_SERVICE'] } } }, include: { vehicle: true }, take: 500, orderBy: { createdAt: 'asc' } }),
  );
  for (const i of intervals) {
    const due = nextServiceDue(i);
    if (!reminderIsDue(due, now, i.vehicle.mileageKm, settings.serviceReminderDays, settings.serviceReminderKm)) continue;
    out.considered++;
    const dueKey = dueKeyOf(due);
    try {
      await withTenant(businessId, async (tx) => {
        const done = await tx.serviceReminderLog.findFirst({ where: { intervalId: i.id, dueKey } });
        if (done) return;
        const when = [due.dueDate ? `on ${formatDate(due.dueDate, 'UTC', biz.locale)}` : null, due.dueKm !== null ? `at ${due.dueKm.toLocaleString('en-ZA')} km` : null].filter(Boolean).join(' or ');
        const outcomes = await sendCustomerMessage(tx, businessId, {
          event: 'SERVICE_REMINDER', customerId: i.vehicle.customerId, vehicleId: i.vehicleId, entity: { type: 'vehicle', id: i.vehicleId },
          vars: { service_name: i.name, service_due: due.dueDate && due.dueKm !== null ? `${when}, whichever comes first` : when },
          dedupeKey: `svc:${i.id}:${dueKey}`,
        });
        const queued = outcomes.find((o) => o.status === 'queued');
        const optOut = outcomes.every((o) => o.status === 'skipped' && /opted out|not active/i.test(o.detail ?? ''));
        // Remember a reminder that went out, or was deliberately declined by the customer. If there was merely nowhere to send it
        // (no email yet) it is tried again on a later run, once an address exists.
        if (queued || optOut) {
          await tx.serviceReminderLog.create({ data: { businessId, vehicleId: i.vehicleId, intervalId: i.id, customerId: i.vehicle.customerId, dueKey, outcome: queued ? 'SENT' : 'SKIPPED', detail: queued ? null : outcomes[0]?.detail ?? null, communicationId: queued?.communicationId ?? null } });
          if (queued) await recordAudit(tx, undefined, { action: AuditActions.serviceReminderSent, businessId, resourceType: 'vehicle', resourceId: i.vehicleId, metadata: { interval: i.name, dueKey } });
          if (queued) out.sent++; else out.skipped++;
        }
      });
    } catch (err) {
      logger.error({ businessId, intervalId: i.id, err: String(err) }, 'service reminder failed');
    }
  }
  return out;
}

/** Upcoming appointments within the business's reminder window. Marks each booking so it is reminded once. */
export async function runBookingReminders(businessId: string, now = new Date()): Promise<number> {
  const settings = await withTenant(businessId, (tx) => loadCommSettings(tx, businessId));
  if (!settings.bookingRemindersOn) return 0;
  const until = new Date(now.getTime() + settings.bookingReminderHours * 3_600_000);
  const biz = await prisma().business.findUniqueOrThrow({ where: { id: businessId }, select: { locale: true, timezone: true } });
  const due = await withTenant(businessId, (tx) =>
    tx.booking.findMany({ where: { businessId, status: { in: ['CONFIRMED', 'RESCHEDULED'] }, reminderSentAt: null, startsAt: { gt: now, lte: until } }, orderBy: { startsAt: 'asc' }, take: 300 }),
  );
  let n = 0;
  for (const b of due) {
    try {
      await withTenant(businessId, async (tx) => {
        const fresh = await seq([tx.booking.findFirst({ where: { id: b.id, businessId } })]);
        const cur = fresh[0];
        if (!cur || cur.reminderSentAt || !['CONFIRMED', 'RESCHEDULED'].includes(cur.status)) return;
        const day = new Intl.DateTimeFormat(biz.locale, { timeZone: biz.timezone, weekday: 'long', day: 'numeric', month: 'long' }).format(cur.startsAt);
        const time = new Intl.DateTimeFormat(biz.locale, { timeZone: biz.timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(cur.startsAt);
        await sendCustomerMessage(tx, businessId, {
          event: 'BOOKING_REMINDER', customerId: cur.customerId, vehicleId: cur.vehicleId, entity: { type: 'booking', id: cur.id }, locationId: cur.locationId,
          vars: { service_name: cur.serviceLabel, appointment_date: day, appointment_time: time }, dedupeKey: `bkrem:${cur.id}:${cur.startsAt.getTime()}`,
        });
        // Whether or not the customer could be reached, the booking is marked so the scan does not look at it again.
        await tx.booking.update({ where: { id: cur.id }, data: { status: 'REMINDER_SENT', reminderSentAt: new Date() } });
        n++;
      });
    } catch (err) {
      logger.error({ businessId, bookingId: b.id, err: String(err) }, 'booking reminder failed');
    }
  }
  return n;
}


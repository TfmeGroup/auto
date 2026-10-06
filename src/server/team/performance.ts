import { z } from 'zod';
import { withTenant, type Tx } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { addDays, dayRange, parseIsoDate, todayIso, weekdayOf, zonedToUtc } from '@/lib/tz';
import { parseOrThrow, uuidSchema } from '@/lib/validation';
import { requireFeature } from '@/server/billing/features';
import { can, requirePermission } from '@/server/permissions/authorize';
import { listTechnicians } from '@/server/workshop/people';
import type { BusinessContext } from '@/server/context';

/**
 * Operational numbers about technicians, worked out from real records (jobs, bookings, time entries, labour lines). They describe
 * workload; they are not an assessment of a person and make no employment judgement. Revenue is shown only to people who may see labour
 * rates, and a person without "view team performance" sees only their own figures.
 */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-03-31');
export const rangeSchema = z.object({ from: day.optional(), to: day.optional() });
const MAX_DAYS = 366;

export function resolveRange(tz: string, q: { from?: string; to?: string }): { from: string; to: string; start: Date; end: Date } {
  const today = todayIso(tz);
  const to = q.to ?? today;
  const from = q.from ?? addDays(to, -29);
  if (to < from) throw Errors.validation({ to: 'The end date cannot be before the start date.' });
  if ((dayRange(to, tz).end.getTime() - dayRange(from, tz).start.getTime()) / 86_400_000 > MAX_DAYS) throw Errors.validation({ from: 'Choose a period of at most a year.' });
  return { from, to, start: dayRange(from, tz).start, end: dayRange(to, tz).end };
}

interface Window { start: Date; end: Date }

const overlap = (a: Window, b: Window) => Math.max(0, Math.min(a.end.getTime(), b.end.getTime()) - Math.max(a.start.getTime(), b.start.getTime()));

/**
 * Minutes a person could have worked between two dates: their own weekly hours (or the workshop's when they have none), minus time off.
 * The same two tables the booking calendar uses; nothing about availability is re-invented here.
 */
export async function capacityMinutes(tx: Tx, businessId: string, membershipId: string, tz: string, fromIso: string, toIso: string, range: Window): Promise<number> {
  const own = await tx.technicianSchedule.findMany({ where: { businessId, membershipId } });
  const hours = own.length ? own : await tx.workshopHours.findMany({ where: { businessId } });
  const off = await tx.technicianTimeOff.findMany({ where: { businessId, membershipId, startsAt: { lt: range.end }, endsAt: { gt: range.start } } });
  let total = 0;
  for (let d = fromIso; d <= toIso; d = addDays(d, 1)) {
    const p = parseIsoDate(d);
    if (!p) continue;
    const weekday = weekdayOf(d);
    for (const h of hours.filter((x) => x.weekday === weekday)) {
      const w: Window = { start: zonedToUtc(p.year, p.month, p.day, h.startMinute, tz), end: zonedToUtc(p.year, p.month, p.day, h.endMinute, tz) };
      let minutes = (w.end.getTime() - w.start.getTime()) / 60_000;
      // time off is merged first so overlapping leave is not subtracted twice
      const merged: Window[] = [];
      for (const o of [...off].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())) {
        const last = merged[merged.length - 1];
        if (last && o.startsAt <= last.end) last.end = new Date(Math.max(last.end.getTime(), o.endsAt.getTime()));
        else merged.push({ start: o.startsAt, end: o.endsAt });
      }
      for (const m of merged) minutes -= overlap(w, m) / 60_000;
      total += Math.max(0, minutes);
    }
  }
  return Math.round(total);
}

export interface TechnicianMetrics {
  membershipId: string;
  name: string;
  jobsCompleted: number;
  jobsOpen: number;
  bookings: number;
  bookedMinutes: number;
  workedMinutes: number;
  billableMinutes: number;
  avgCompletionHours: number | null;
  labourRevenueCents: number | null;
  capacityMinutes: number;
  /** worked / capacity, basis points (null when there is no capacity). */
  utilisationBps: number | null;
  /** billable / worked, basis points. */
  billableShareBps: number | null;
  partsFitted: number;
}

export async function metricsFor(tx: Tx, ctx: BusinessContext, membershipId: string, name: string, userId: string | null, r: ReturnType<typeof resolveRange>, withRevenue: boolean): Promise<TechnicianMetrics> {
  const bid = ctx.business.id;
  const onJob = { OR: [{ primaryTechnicianMembershipId: membershipId }, { technicians: { some: { membershipId } } }] };
  const completed = await tx.jobCard.findMany({ where: { businessId: bid, status: 'COMPLETED', completedAt: { gte: r.start, lt: r.end }, ...onJob }, select: { openedAt: true, completedAt: true } });
  const open = await tx.jobCard.count({ where: { businessId: bid, status: { notIn: ['COMPLETED', 'CANCELLED'] }, ...onJob } });
  const bookings = await tx.booking.findMany({ where: { businessId: bid, technicianMembershipId: membershipId, startsAt: { gte: r.start, lt: r.end }, status: { notIn: ['CANCELLED', 'NO_SHOW'] } }, select: { durationMin: true } });
  const worked = await tx.timeEntry.aggregate({ where: { businessId: bid, membershipId, status: 'COMPLETED', startedAt: { gte: r.start, lt: r.end } }, _sum: { durationMinutes: true } });
  const billable = await tx.timeEntry.aggregate({ where: { businessId: bid, membershipId, status: 'COMPLETED', billable: true, startedAt: { gte: r.start, lt: r.end } }, _sum: { durationMinutes: true } });
  const revenue = withRevenue ? await tx.jobLabour.aggregate({ where: { businessId: bid, technicianMembershipId: membershipId, archivedAt: null, createdAt: { gte: r.start, lt: r.end } }, _sum: { totalCents: true } }) : null;
  const fitted = userId ? await tx.jobPart.aggregate({ where: { businessId: bid, fittedById: userId, status: 'FITTED', fittedAt: { gte: r.start, lt: r.end } }, _sum: { quantity: true } }) : null;
  const capacity = await capacityMinutes(tx, bid, membershipId, ctx.business.timezone, r.from, r.to, r);
  const workedMin = worked._sum.durationMinutes ?? 0;
  const billableMin = billable._sum.durationMinutes ?? 0;
  const durations = completed.filter((j) => j.completedAt).map((j) => j.completedAt!.getTime() - j.openedAt.getTime());
  return {
    membershipId, name, jobsCompleted: completed.length, jobsOpen: open, bookings: bookings.length, bookedMinutes: bookings.reduce((s, b) => s + b.durationMin, 0), workedMinutes: workedMin, billableMinutes: billableMin,
    avgCompletionHours: durations.length ? Math.round((durations.reduce((s, v) => s + v, 0) / durations.length / 3_600_000) * 10) / 10 : null,
    labourRevenueCents: revenue ? (revenue._sum.totalCents ?? 0) : null, capacityMinutes: capacity,
    utilisationBps: capacity > 0 ? Math.round((workedMin * 10_000) / capacity) : null, billableShareBps: workedMin > 0 ? Math.round((billableMin * 10_000) / workedMin) : null, partsFitted: fitted?._sum.quantity ?? 0,
  };
}

/** One technician's figures. Someone without team-performance access can ask only about themselves. */
export async function getTechnicianMetrics(ctx: BusinessContext, membershipId: string, query: unknown) {
  requireFeature(ctx.subscription, 'technician_management');
  parseOrThrow(uuidSchema, membershipId);
  const q = parseOrThrow(rangeSchema, query);
  if (membershipId !== ctx.membership.id) requirePermission(ctx, 'employee.view_reports');
  const r = resolveRange(ctx.business.timezone, q);
  return withTenant(ctx.business.id, async (tx) => {
    const m = await tx.membership.findFirst({ where: { id: membershipId, businessId: ctx.business.id }, include: { user: { select: { id: true, name: true } } } });
    if (!m) throw Errors.notFound('Team member');
    const metrics = await metricsFor(tx, ctx, membershipId, m.user?.name ?? 'Former member', m.userId, r, can(ctx, 'labour.view_rates'));
    return { range: { from: r.from, to: r.to }, ...metrics };
  });
}

/** Everyone's workload side by side (managers). */
export async function getTeamWorkload(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'employee.view_reports');
  requireFeature(ctx.subscription, 'technician_management');
  const q = parseOrThrow(rangeSchema, query);
  const r = resolveRange(ctx.business.timezone, q);
  return withTenant(ctx.business.id, async (tx) => {
    const techs = await listTechnicians(tx, ctx.business.id);
    const members = await tx.membership.findMany({ where: { businessId: ctx.business.id, id: { in: techs.map((t) => t.membershipId) } }, select: { id: true, userId: true } });
    const uid = new Map(members.map((m) => [m.id, m.userId]));
    const rows: TechnicianMetrics[] = [];
    for (const t of techs) rows.push(await metricsFor(tx, ctx, t.membershipId, t.name, uid.get(t.membershipId) ?? null, r, can(ctx, 'labour.view_rates')));
    return { range: { from: r.from, to: r.to }, items: rows };
  });
}

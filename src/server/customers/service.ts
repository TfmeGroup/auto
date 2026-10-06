import { z } from 'zod';
import { withTenant, type Tx, seq } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import {
  escapeLike, optionalEmail, optionalPhone, optionalText, pageMeta, paginationSchema, parseOrThrow, phoneSchema, uuidSchema,
} from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { recordActivity } from '@/server/activity/service';
import { nextCustomerNumber } from '@/server/numbering/sequence';
import { can, requirePermission } from '@/server/permissions/authorize';
import type { BusinessContext } from '@/server/context';

/**
 * Customers. Every domain module follows this shape:
 *   permission check → validate → withTenant() transaction → business WHERE
 *   (on top of RLS) → audit + timeline event in the same transaction.
 *
 * A customer is never deleted: archiving hides them from lists but every job, booking and (later)
 * invoice keeps pointing at them.
 */

const contactMethod = z.enum(['PHONE', 'SMS', 'WHATSAPP', 'EMAIL']);
const optionalContact = z.union([z.literal(''), contactMethod]).optional().transform((v) => (v ? v : undefined));

const customerFields = {
  type: z.enum(['INDIVIDUAL', 'BUSINESS']).default('INDIVIDUAL'),
  firstName: z.string().trim().min(1, 'Enter a first name').max(80),
  lastName: z.string().trim().min(1, 'Enter a last name').max(80),
  mobile: phoneSchema,
  email: optionalEmail,
  companyName: optionalText(160),
  companyRegNumber: optionalText(40),
  idNumber: optionalText(30),
  altPhone: optionalPhone,
  preferredContact: optionalContact,
  marketingConsent: z.boolean().default(false),
  emergencyName: optionalText(120),
  emergencyPhone: optionalPhone,
  addressLine1: optionalText(160),
  addressLine2: optionalText(160),
  city: optionalText(80),
  province: optionalText(80),
  postalCode: optionalText(12),
  notes: optionalText(2000),
};

export const customerInputSchema = z.object(customerFields).superRefine((v, ctx) => {
  if (v.type === 'BUSINESS' && !v.companyName) ctx.addIssue({ code: 'custom', path: ['companyName'], message: 'Enter the business name' });
});

// `.partial()` alone would keep the defaults (type, marketing consent) and silently reset them on every edit.
export const customerUpdateSchema = z.object({ ...customerFields, type: z.enum(['INDIVIDUAL', 'BUSINESS']), marketingConsent: z.boolean() }).partial();

export const CUSTOMER_STATUSES = ['ACTIVE', 'INACTIVE', 'ARCHIVED'] as const;

export const customerListSchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  status: z.enum(CUSTOMER_STATUSES).default('ACTIVE'),
  type: z.enum(['INDIVIDUAL', 'BUSINESS']).optional(),
  hasActiveJob: z.enum(['true']).optional(),
  hasUpcomingBooking: z.enum(['true']).optional(),
  hasBalance: z.enum(['true']).optional(),
  sort: z.enum(['name', 'createdAt', 'customerNumber']).default('createdAt'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});

const SORT_SQL = { name: 'lower(c.name)', createdAt: 'c.created_at', customerNumber: 'c.customer_number' } as const;

export interface CustomerQuery {
  q?: string;
  status?: (typeof CUSTOMER_STATUSES)[number];
  type?: 'INDIVIDUAL' | 'BUSINESS';
  hasActiveJob?: boolean;
  hasUpcomingBooking?: boolean;
  /** Owes money on at least one issued invoice. */
  hasBalance?: boolean;
  limit: number;
  offset?: number;
  /** Chosen from SORT_SQL by callers, never from user input. */
  order?: string;
}

/**
 * Ids of customers matching a query, one page at a time. Free text is split into words and EVERY word
 * must match one of: first/last/full name, company, email, customer number, mobile or alternative phone
 * (phones are compared as digits, so "082 123" finds "0821234567"). ILIKE '%x%' is served by the trigram
 * GIN indexes. Runs inside withTenant(), so RLS limits it to the caller's business.
 */
export async function matchCustomerIds(tx: Tx, businessId: string, opts: CustomerQuery): Promise<{ ids: string[]; total: number }> {
  const params: unknown[] = [businessId];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where: string[] = ['c.business_id = $1::uuid'];
  if (opts.status) where.push(`c.status = ${p(opts.status)}::customer_status`);
  if (opts.type) where.push(`c.type = ${p(opts.type)}::customer_type`);

  for (const word of (opts.q ?? '').split(/\s+/).filter(Boolean).slice(0, 6)) {
    const like = p(`%${escapeLike(word)}%`);
    const digits = word.replace(/\D/g, '');
    const phoneClause = digits.length >= 3
      ? ` OR regexp_replace(c.mobile, '\\D', '', 'g') ILIKE ${p(`%${digits}%`)} OR regexp_replace(c.alt_phone, '\\D', '', 'g') ILIKE $${params.length}`
      : '';
    where.push(
      `(c.name ILIKE ${like} ESCAPE '\\' OR c.company_name ILIKE ${like} ESCAPE '\\' OR c.email ILIKE ${like} ESCAPE '\\'
        OR c.customer_number ILIKE ${like} ESCAPE '\\' OR c.mobile ILIKE ${like} ESCAPE '\\'${phoneClause})`,
    );
  }
  if (opts.hasActiveJob) {
    where.push(`EXISTS (SELECT 1 FROM job_cards j WHERE j.business_id = c.business_id AND j.customer_id = c.id AND j.status NOT IN ('COMPLETED','CANCELLED'))`);
  }
  if (opts.hasUpcomingBooking) {
    where.push(`EXISTS (SELECT 1 FROM bookings b WHERE b.business_id = c.business_id AND b.customer_id = c.id AND b.starts_at >= now() AND b.status NOT IN ('CANCELLED','NO_SHOW','COMPLETED','CHECKED_IN'))`);
  }
  if (opts.hasBalance) {
    where.push(`EXISTS (SELECT 1 FROM invoices i WHERE i.business_id = c.business_id AND i.customer_id = c.id AND i.finalised_at IS NOT NULL AND i.cancelled_at IS NULL AND i.written_off_at IS NULL AND i.outstanding_cents > 0)`);
  }
  const limit = p(opts.limit);
  const offset = p(opts.offset ?? 0);
  const rows = await tx.$queryRawUnsafe<{ id: string; total: bigint }[]>(
    `SELECT c.id, count(*) OVER () AS total FROM customers c WHERE ${where.join(' AND ')}
      ORDER BY ${opts.order ?? 'c.created_at DESC'}, c.id LIMIT ${limit} OFFSET ${offset}`,
    ...params,
  );
  return { ids: rows.map((r) => r.id), total: Number(rows[0]?.total ?? 0) };
}

export async function listCustomers(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'customer.view');
  const q = parseOrThrow(customerListSchema, query);
  // Filters that reveal job/booking information are only available to people who may see jobs/bookings.
  if (q.hasActiveJob && !can(ctx, 'job.view')) throw Errors.forbidden();
  if (q.hasUpcomingBooking && !can(ctx, 'booking.view')) throw Errors.forbidden();
  if (q.hasBalance && !can(ctx, 'invoice.view')) throw Errors.forbidden();

  return withTenant(ctx.business.id, async (tx) => {
    const order = `${SORT_SQL[q.sort]} ${q.dir === 'asc' ? 'ASC' : 'DESC'}`;
    const { ids, total } = await matchCustomerIds(tx, ctx.business.id, {
      q: q.q, status: q.status, type: q.type, hasActiveJob: !!q.hasActiveJob, hasUpcomingBooking: !!q.hasUpcomingBooking, hasBalance: !!q.hasBalance,
      limit: q.pageSize, offset: (q.page - 1) * q.pageSize, order,
    });
    const rows = await tx.customer.findMany({ where: { id: { in: ids }, businessId: ctx.business.id } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return { items: ids.map((id) => byId.get(id)).filter((r) => !!r), meta: pageMeta(q.page, q.pageSize, total) };
  });
}

export async function getCustomer(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'customer.view');
  const customerId = parseOrThrow(uuidSchema, id);
  return withTenant(ctx.business.id, async (tx) => {
    const c = await tx.customer.findFirst({ where: { id: customerId, businessId: ctx.business.id } });
    if (!c) throw Errors.notFound('Customer');
    return c;
  });
}

/**
 * The Customer 360 summary: live counts from the database, limited to what the caller may see.
 * Financial totals do not exist until invoicing is built (Part 4), so they are reported as unavailable
 * rather than as zero.
 */
export async function getCustomerOverview(ctx: BusinessContext, id: string) {
  const customer = await getCustomer(ctx, id);
  const businessId = ctx.business.id;
  return withTenant(businessId, async (tx) => {
    const seeVehicles = can(ctx, 'vehicle.view');
    const seeJobs = can(ctx, 'job.view');
    const seeBookings = can(ctx, 'booking.view');
    const [vehicleCount, totalJobs, activeJobs, lastCompleted, nextBooking] = await seq([
      seeVehicles ? tx.vehicle.count({ where: { businessId, customerId: customer.id, archivedAt: null } }) : null,
      seeJobs ? tx.jobCard.count({ where: { businessId, customerId: customer.id } }) : null,
      seeJobs ? tx.jobCard.count({ where: { businessId, customerId: customer.id, status: { notIn: ['COMPLETED', 'CANCELLED'] } } }) : null,
      seeJobs ? tx.jobCard.findFirst({ where: { businessId, customerId: customer.id, status: 'COMPLETED' }, orderBy: { completedAt: 'desc' }, select: { completedAt: true, jobNumber: true } }) : null,
      seeBookings
        ? tx.booking.findFirst({
            where: { businessId, customerId: customer.id, startsAt: { gte: new Date() }, status: { in: ['REQUESTED', 'CONFIRMED', 'REMINDER_SENT', 'RESCHEDULED'] } },
            orderBy: { startsAt: 'asc' }, select: { id: true, startsAt: true, bookingNumber: true },
          })
        : null,
    ]);
    const latestAny = await tx.activityEvent.findFirst({
      where: { businessId, customerId: customer.id, OR: activityPrefixes(ctx).map((t) => ({ type: { startsWith: t } })) },
      orderBy: { createdAt: 'desc' },
    });
    return {
      customer,
      vehicleCount,
      totalJobs,
      activeJobs,
      lastVisit: lastCompleted?.completedAt ?? null,
      nextBooking,
      latestActivity: latestAny ? { summary: latestAny.summary, at: latestAny.createdAt } : null,
      financial: { available: false as const },
    };
  });
}

const activityPrefixes = (ctx: BusinessContext): string[] => [
  'customer.',
  ...(can(ctx, 'vehicle.view') ? ['vehicle.'] : []),
  ...(can(ctx, 'booking.view') ? ['booking.'] : []),
  ...(can(ctx, 'job.view') ? ['job.', 'inspection.', 'diagnosis.', 'work.'] : []),
];

const displayName = (first: string, last: string) => `${first} ${last}`.replace(/\s+/g, ' ').trim();

export async function createCustomer(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'customer.create');
  const data = parseOrThrow(customerInputSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const customerNumber = await nextCustomerNumber(tx, ctx.business.id);
    const customer = await tx.customer.create({
      data: {
        ...data,
        name: displayName(data.firstName, data.lastName),
        marketingConsentAt: data.marketingConsent ? new Date() : null,
        businessId: ctx.business.id,
        customerNumber,
        createdById: ctx.user.id,
      },
    });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.customerCreated,
      businessId: ctx.business.id,
      userId: ctx.user.id,
      resourceType: 'customer',
      resourceId: customer.id,
      after: customer,
    });
    await recordActivity(tx, ctx.business.id, ctx.user.id, {
      type: 'customer.created', summary: `Customer ${customer.customerNumber} created`, customerId: customer.id,
    });
    return customer;
  });
}

export async function updateCustomer(ctx: BusinessContext, id: string, input: unknown) {
  requirePermission(ctx, 'customer.edit');
  const customerId = parseOrThrow(uuidSchema, id);
  const data = parseOrThrow(customerUpdateSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    // Lock the row so two people editing the same customer are applied one after the other, not interleaved.
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM customers WHERE id = ${customerId}::uuid AND business_id = ${ctx.business.id}::uuid FOR UPDATE`;
    if (locked.length === 0) throw Errors.notFound('Customer');
    const before = await tx.customer.findFirstOrThrow({ where: { id: customerId, businessId: ctx.business.id } });
    if (before.status === 'ARCHIVED') throw Errors.conflict('Restore this customer before editing them.');

    const patch = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) as Record<string, unknown>;
    const merged = { type: data.type ?? before.type, companyName: data.companyName ?? before.companyName };
    if (merged.type === 'BUSINESS' && !merged.companyName) throw Errors.validation({ companyName: 'Enter the business name' });
    const first = data.firstName ?? before.firstName;
    const last = data.lastName ?? before.lastName;
    if (data.firstName !== undefined || data.lastName !== undefined) patch.name = displayName(first, last);
    if (data.marketingConsent !== undefined && data.marketingConsent !== before.marketingConsent) {
      patch.marketingConsentAt = data.marketingConsent ? new Date() : null;
    }
    const after = await tx.customer.update({ where: { id: customerId }, data: patch });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.customerUpdated,
      businessId: ctx.business.id,
      userId: ctx.user.id,
      resourceType: 'customer',
      resourceId: customerId,
      before,
      after,
      metadata: data.marketingConsent !== undefined && data.marketingConsent !== before.marketingConsent ? { marketingConsent: data.marketingConsent } : undefined,
    });
    await recordActivity(tx, ctx.business.id, ctx.user.id, { type: 'customer.updated', summary: 'Customer details updated', customerId });
    return after;
  });
}

/** Set Active/Inactive. Archiving has its own function because it has extra rules. */
export async function setCustomerStatus(ctx: BusinessContext, id: string, status: unknown) {
  requirePermission(ctx, 'customer.edit');
  const customerId = parseOrThrow(uuidSchema, id);
  const next = parseOrThrow(z.enum(['ACTIVE', 'INACTIVE']), status);
  return withTenant(ctx.business.id, async (tx) => {
    const before = await tx.customer.findFirst({ where: { id: customerId, businessId: ctx.business.id } });
    if (!before) throw Errors.notFound('Customer');
    if (before.status === 'ARCHIVED') throw Errors.conflict('Restore this customer first.');
    if (before.status === next) return before;
    const after = await tx.customer.update({ where: { id: customerId }, data: { status: next } });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.customerStatusChanged, businessId: ctx.business.id, userId: ctx.user.id,
      resourceType: 'customer', resourceId: customerId, before: { status: before.status }, after: { status: after.status },
    });
    await recordActivity(tx, ctx.business.id, ctx.user.id, { type: 'customer.status_changed', summary: `Customer marked ${next.toLowerCase()}`, customerId });
    return after;
  });
}

/** Customers are archived, never hard-deleted, so jobs/invoices keep their history. */
export async function setCustomerArchived(ctx: BusinessContext, id: string, archived: boolean) {
  requirePermission(ctx, 'customer.archive');
  const customerId = parseOrThrow(uuidSchema, id);
  return withTenant(ctx.business.id, async (tx) => {
    const before = await tx.customer.findFirst({ where: { id: customerId, businessId: ctx.business.id } });
    if (!before) throw Errors.notFound('Customer');
    if (archived) {
      const openJobs = await tx.jobCard.count({ where: { businessId: ctx.business.id, customerId, status: { notIn: ['COMPLETED', 'CANCELLED'] } } });
      if (openJobs > 0) throw Errors.conflict(`This customer has ${openJobs} open job${openJobs === 1 ? '' : 's'}. Finish or cancel them before archiving.`);
    }
    const after = await tx.customer.update({
      where: { id: customerId },
      data: archived ? { status: 'ARCHIVED', archivedAt: new Date() } : { status: 'ACTIVE', archivedAt: null },
    });
    await recordAudit(tx, ctx.meta, {
      action: archived ? AuditActions.customerArchived : AuditActions.customerRestored,
      businessId: ctx.business.id,
      userId: ctx.user.id,
      resourceType: 'customer',
      resourceId: customerId,
      before: { status: before.status },
      after: { status: after.status },
    });
    await recordActivity(tx, ctx.business.id, ctx.user.id, {
      type: 'customer.status_changed', summary: archived ? 'Customer archived' : 'Customer restored', customerId,
    });
    return after;
  });
}

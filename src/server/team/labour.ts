import { z } from 'zod';
import { withTenant, type Tx } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { parseOrThrow, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { assertCanWrite } from '@/server/billing/subscriptions';
import { can, requirePermission } from '@/server/permissions/authorize';
import { loadFinanceSettings } from '@/server/finance/common';
import { listTechnicians } from '@/server/workshop/people';
import type { BusinessContext } from '@/server/context';

/**
 * Labour rates. The rate charged for an hour of someone's time is the first of:
 *   1. the technician's own billable rate
 *   2. the service type's rate (for the job's kind of work)
 *   3. the business's default labour rate
 * The rate in force is COPIED onto the labour line when it is recorded, so changing a rate later never touches a labour line or an
 * invoice that already exists. What an hour costs the business (internal cost) is separate and is never shown to customers.
 */

export type RateSource = 'technician' | 'service' | 'default' | 'none';

export async function resolveBillableRate(tx: Tx, businessId: string, o: { membershipId?: string | null; serviceTypeId?: string | null }): Promise<{ rateCentsPerHour: number | null; source: RateSource }> {
  if (o.membershipId) {
    const tp = await tx.technicianProfile.findFirst({ where: { businessId, membershipId: o.membershipId }, select: { billableRateCentsPerHour: true } });
    if (tp?.billableRateCentsPerHour != null) return { rateCentsPerHour: tp.billableRateCentsPerHour, source: 'technician' };
  }
  if (o.serviceTypeId) {
    const st = await tx.serviceType.findFirst({ where: { id: o.serviceTypeId, businessId }, select: { labourRateCentsPerHour: true } });
    if (st?.labourRateCentsPerHour != null) return { rateCentsPerHour: st.labourRateCentsPerHour, source: 'service' };
  }
  const s = await loadFinanceSettings(tx, businessId);
  if (s.defaultLabourRateCentsPerHour != null) return { rateCentsPerHour: s.defaultLabourRateCentsPerHour, source: 'default' };
  return { rateCentsPerHour: null, source: 'none' };
}

const rate = z.union([z.null(), z.literal(''), z.coerce.number().int('Enter whole cents').min(0).max(10_000_000)]).transform((v) => (v === '' ? null : v));

/** The labour rate card: the default, each service type's rate, and each technician's billable rate (and cost rate for those allowed to see costs). */
export async function getRateCard(ctx: BusinessContext) {
  if (!can(ctx, 'labour.view_rates') && !can(ctx, 'labour.manage_rates')) throw Errors.forbidden();
  const costs = can(ctx, 'labour.view_costs');
  return withTenant(ctx.business.id, async (tx) => {
    const s = await loadFinanceSettings(tx, ctx.business.id);
    const services = await tx.serviceType.findMany({ where: { businessId: ctx.business.id, status: 'ACTIVE' }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true, name: true, labourRateCentsPerHour: true } });
    const techs = await listTechnicians(tx, ctx.business.id);
    const profiles = await tx.technicianProfile.findMany({ where: { businessId: ctx.business.id, membershipId: { in: techs.map((t) => t.membershipId) } }, select: { membershipId: true, billableRateCentsPerHour: true } });
    const members = await tx.membership.findMany({ where: { businessId: ctx.business.id, id: { in: techs.map((t) => t.membershipId) } }, select: { id: true, labourCostCentsPerHour: true } });
    const p = new Map(profiles.map((x) => [x.membershipId, x.billableRateCentsPerHour]));
    const c = new Map(members.map((x) => [x.id, x.labourCostCentsPerHour]));
    return {
      defaultRateCentsPerHour: s.defaultLabourRateCentsPerHour,
      services,
      technicians: techs.map((t) => ({ membershipId: t.membershipId, name: t.name, billableRateCentsPerHour: p.get(t.membershipId) ?? null, costRateCentsPerHour: costs ? (c.get(t.membershipId) ?? null) : null })),
      canManage: can(ctx, 'labour.manage_rates'), canSeeCosts: costs,
    };
  });
}

export async function setDefaultLabourRate(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'labour.manage_rates');
  assertCanWrite(ctx.subscription);
  const d = parseOrThrow(z.object({ rateCentsPerHour: rate }), input);
  return withTenant(ctx.business.id, async (tx) => {
    const before = await loadFinanceSettings(tx, ctx.business.id);
    await tx.financeSettings.update({ where: { businessId: ctx.business.id }, data: { defaultLabourRateCentsPerHour: d.rateCentsPerHour, updatedById: ctx.user.id } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.labourRateChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'finance_settings', resourceId: ctx.business.id, before: { defaultRateCentsPerHour: before.defaultLabourRateCentsPerHour }, after: { defaultRateCentsPerHour: d.rateCentsPerHour }, metadata: { scope: 'default' } });
    return { rateCentsPerHour: d.rateCentsPerHour };
  });
}

export async function setServiceTypeRate(ctx: BusinessContext, serviceTypeId: string, input: unknown) {
  requirePermission(ctx, 'labour.manage_rates');
  assertCanWrite(ctx.subscription);
  parseOrThrow(uuidSchema, serviceTypeId);
  const d = parseOrThrow(z.object({ rateCentsPerHour: rate }), input);
  return withTenant(ctx.business.id, async (tx) => {
    const st = await tx.serviceType.findFirst({ where: { id: serviceTypeId, businessId: ctx.business.id } });
    if (!st) throw Errors.notFound('Service type');
    await tx.serviceType.update({ where: { id: serviceTypeId }, data: { labourRateCentsPerHour: d.rateCentsPerHour } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.labourRateChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'service_type', resourceId: serviceTypeId, before: { rateCentsPerHour: st.labourRateCentsPerHour }, after: { rateCentsPerHour: d.rateCentsPerHour }, metadata: { scope: 'service', name: st.name } });
    return { rateCentsPerHour: d.rateCentsPerHour };
  });
}

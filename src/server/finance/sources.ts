import { minutesAmount } from '@/lib/money';
import { Errors } from '@/lib/errors';
import { parseOrThrow, uuidSchema } from '@/lib/validation';
import { withTenant, type Tx } from '@/server/db/client';
import { requirePermission } from '@/server/permissions/authorize';
import type { BusinessContext } from '@/server/context';
import type { LineData } from './common';

/**
 * Where document lines come from when they are not typed in by hand. Both builders only READ the job; they never change
 * it, and they snapshot prices and costs onto the new lines so later catalogue or rate changes cannot rewrite them.
 */

const hours = (min: number) => `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;

export interface BuiltLines {
  lines: LineData[];
  warnings: string[];
}

/**
 * A QUOTE from a job: the recommended work (customer-visible, not declined, not removed), with its estimated labour and
 * parts, or the real parts added to the job for that work. Creating a quote never approves anything.
 */
export async function quoteLinesFromJob(tx: Tx, businessId: string, jobId: string): Promise<BuiltLines> {
  const job = await tx.jobCard.findFirst({ where: { id: jobId, businessId }, select: { id: true } });
  if (!job) throw Errors.validation({ jobId: 'Choose a job of this business.' });
  const work = await tx.recommendedWork.findMany({
    where: { businessId, jobId, archivedAt: null, customerVisible: true, approvalStatus: { not: 'DECLINED' } },
    orderBy: [{ createdAt: 'asc' }],
  });
  const parts = await tx.jobPart.findMany({ where: { businessId, jobId, archivedAt: null, status: { not: 'RETURNED' } }, orderBy: { createdAt: 'asc' } });
  const warnings: string[] = [];
  const lines: LineData[] = [];
  const partsByWork = new Map<string, typeof parts>();
  for (const p of parts) if (p.recommendedWorkId) partsByWork.set(p.recommendedWorkId, [...(partsByWork.get(p.recommendedWorkId) ?? []), p]);

  const partLine = (p: (typeof parts)[number], workId?: string): LineData => {
    if (p.sellPriceCents === null) warnings.push(`"${p.description}" has no selling price; it is on the quote at R0.00.`);
    return {
      lineType: 'PART', description: p.description, sku: p.partNumber ?? undefined, unit: undefined, quantityMilli: p.quantity * 1000,
      unitPriceCents: p.sellPriceCents ?? 0, discountType: 'NONE', discountValue: 0, taxTreatment: 'STANDARD', unitCostCents: p.costCents,
      jobPartId: p.id, inventoryItemId: p.inventoryItemId, recommendedWorkId: workId,
    };
  };

  for (const w of work) {
    const tag = w.quantity > 1 ? ` (x${w.quantity})` : '';
    const linked = partsByWork.get(w.id) ?? [];
    const hasLabour = (w.estimatedLabourCents ?? 0) > 0;
    const hasParts = linked.length > 0 || (w.estimatedPartsCents ?? 0) > 0;
    if (hasLabour || !hasParts) {
      if (!hasLabour) warnings.push(`"${w.description}" has no estimate; it is on the quote at R0.00.`);
      lines.push({
        lineType: hasLabour ? 'LABOUR' : 'SERVICE', description: `${w.description}${tag}${w.estimatedMinutes ? ` — est. ${hours(w.estimatedMinutes)} labour` : ''}`,
        quantityMilli: 1000, unitPriceCents: w.estimatedLabourCents ?? 0, discountType: 'NONE', discountValue: 0, taxTreatment: 'STANDARD', recommendedWorkId: w.id, minutes: w.estimatedMinutes,
      });
    }
    if (linked.length > 0) for (const p of linked) lines.push(partLine(p, w.id));
    else if ((w.estimatedPartsCents ?? 0) > 0) {
      lines.push({
        lineType: 'PART', description: `${w.partsDescription ?? w.description} — parts${tag}`, quantityMilli: 1000, unitPriceCents: w.estimatedPartsCents!,
        discountType: 'NONE', discountValue: 0, taxTreatment: 'STANDARD', recommendedWorkId: w.id,
      });
    }
  }
  // Parts added to the job that belong to no recommended work.
  for (const p of parts) if (!p.recommendedWorkId) lines.push(partLine(p));
  return { lines, warnings };
}

/**
 * An INVOICE from a job: what actually happened.
 *  - parts only when FITTED (reserved, requested or ordered parts were never used, so they are never billed; returned parts are out);
 *  - recorded labour at the rate and time recorded, with the technician's cost rate snapshotted for profit reporting;
 *  - additional charges (only) from the job's approved quote.
 * Recommended work that was not performed is NOT billed; if it should be, it is on the approved quote or added by hand.
 */
export async function invoiceLinesFromJob(tx: Tx, businessId: string, jobId: string): Promise<BuiltLines & { quoteId: string | null; quoteVersion: number | null }> {
  const job = await tx.jobCard.findFirst({ where: { id: jobId, businessId }, select: { id: true } });
  if (!job) throw Errors.validation({ jobId: 'Choose a job of this business.' });
  const warnings: string[] = [];
  const lines: LineData[] = [];

  const parts = await tx.jobPart.findMany({ where: { businessId, jobId, archivedAt: null, status: 'FITTED' }, orderBy: { createdAt: 'asc' } });
  for (const p of parts) {
    if (p.sellPriceCents === null) warnings.push(`Part "${p.description}" has no selling price; it is on the invoice at R0.00.`);
    lines.push({
      lineType: 'PART', description: p.description, sku: p.partNumber ?? undefined, quantityMilli: p.quantity * 1000, unitPriceCents: p.sellPriceCents ?? 0,
      discountType: 'NONE', discountValue: 0, taxTreatment: 'STANDARD', unitCostCents: p.costCents, jobPartId: p.id, inventoryItemId: p.inventoryItemId,
      recommendedWorkId: p.recommendedWorkId ?? undefined,
    });
  }
  const notFitted = await tx.jobPart.count({ where: { businessId, jobId, archivedAt: null, status: { in: ['REQUESTED', 'RESERVED', 'ORDERED'] } } });
  if (notFitted > 0) warnings.push(`${notFitted} part${notFitted === 1 ? '' : 's'} on the job ${notFitted === 1 ? 'was' : 'were'} not fitted and ${notFitted === 1 ? 'is' : 'are'} not billed.`);

  const labour = await tx.jobLabour.findMany({ where: { businessId, jobId, archivedAt: null }, orderBy: { createdAt: 'asc' } });
  const rates = new Map<string, number | null>();
  const techIds = [...new Set(labour.map((l) => l.technicianMembershipId).filter((v): v is string => !!v))];
  if (techIds.length) {
    const ms = await tx.membership.findMany({ where: { businessId, id: { in: techIds } }, select: { id: true, labourCostCentsPerHour: true } });
    for (const m of ms) rates.set(m.id, m.labourCostCentsPerHour);
  }
  for (const l of labour) {
    const price = l.totalCents ?? (l.rateCentsPerHour !== null ? minutesAmount(l.minutes, l.rateCentsPerHour) : null);
    if (price === null) warnings.push(`Labour "${l.description}" (${hours(l.minutes)}) has no rate; it is on the invoice at R0.00.`);
    const costRate = l.technicianMembershipId ? rates.get(l.technicianMembershipId) ?? null : null;
    lines.push({
      lineType: 'LABOUR', description: `${l.description} — ${hours(l.minutes)}${l.rateCentsPerHour !== null ? ` @ R${(l.rateCentsPerHour / 100).toFixed(2)}/h` : ''}`,
      quantityMilli: 1000, unitPriceCents: price ?? 0, discountType: 'NONE', discountValue: 0, taxTreatment: 'STANDARD',
      unitCostCents: costRate !== null ? minutesAmount(l.minutes, costRate) : null, jobLabourId: l.id, technicianMembershipId: l.technicianMembershipId, minutes: l.minutes,
    });
  }

  // Additional charges from the approved quote, if the job has one.
  const quote = await tx.quote.findFirst({ where: { businessId, jobId, status: { in: ['APPROVED', 'CONVERTED'] }, approvedVersion: { not: null } }, orderBy: { approvedAt: 'desc' } });
  let quoteId: string | null = null;
  let quoteVersion: number | null = null;
  if (quote?.approvedVersion) {
    const v = await tx.quoteVersion.findFirst({ where: { quoteId: quote.id, businessId, version: quote.approvedVersion }, include: { lines: { orderBy: { position: 'asc' } } } });
    if (v) {
      quoteId = quote.id;
      quoteVersion = v.version;
      for (const q of v.lines.filter((x) => x.lineType === 'CHARGE')) {
        lines.push({
          lineType: 'CHARGE', description: q.description, sku: q.sku ?? undefined, unit: q.unit ?? undefined, quantityMilli: q.quantityMilli, unitPriceCents: q.unitPriceCents,
          discountType: q.discountType, discountValue: q.discountValue, taxTreatment: q.taxTreatment, unitCostCents: q.unitCostCents, quoteLineId: q.id,
        });
      }
      if (v.discountType !== 'NONE') warnings.push(`Quote ${quote.number} had a discount; it is not applied automatically to what was actually done. Add it to the invoice if it still applies.`);
    }
  }
  if (lines.length === 0) warnings.push('Nothing billable has been recorded on this job yet (no fitted parts or labour).');
  return { lines, warnings, quoteId, quoteVersion };
}

/** The few facts a "create from job" screen needs (job number, customer, vehicle, status). Needs job.view. */
export async function jobSummary(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'job.view');
  const jobId = parseOrThrow(uuidSchema, id);
  return withTenant(ctx.business.id, async (tx) => {
    const j = await tx.jobCard.findFirst({ where: { id: jobId, businessId: ctx.business.id }, include: { customer: { select: { id: true, name: true, customerNumber: true, mobile: true, email: true } } } });
    if (!j) throw Errors.notFound('Job');
    return { id: j.id, jobNumber: j.jobNumber, status: j.status, vehicleId: j.vehicleId, customer: j.customer };
  });
}

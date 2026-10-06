import { z } from 'zod';
import { withTenant, seq, type Tx } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { parseOrThrow, uuidSchema } from '@/lib/validation';
import { can, requirePermission } from '@/server/permissions/authorize';
import { memberNames } from '@/server/workshop/people';
import { loadJob } from './common';
import { JOB_STATUS_LABEL, type JobStatus } from './transitions';
import type { BusinessContext } from '@/server/context';

/**
 * The structured inspection report. Two audiences from one source:
 *
 *   internal — everything the workshop recorded.
 *   customer — ONLY what was marked for the customer: items flagged customer-visible with their customer notes,
 *              photos classed customer-visible, recommended work flagged customer-visible, customer-visible job
 *              updates, and the technician's customer summaries. Internal notes, internal photos, fault codes and
 *              raw findings are never included, however they were recorded.
 *
 * The customer version is built by whitelisting fields, not by deleting internal ones, so a field added to the
 * database later cannot leak into it by accident.
 */

interface DiagnosisOut {
  date: Date;
  summary: string | null;
  // Only present in the internal version.
  symptoms?: string | null;
  faultCodes?: string[];
  testsPerformed?: string | null;
  findings?: string | null;
  diagnosis?: string | null;
  confirmed?: boolean;
  internalNotes?: string | null;
}

export const reportQuerySchema = z.object({ audience: z.enum(['internal', 'customer']).default('internal') });

const CATEGORY_LABEL: Record<string, string> = { EXTERIOR: 'Exterior / body', TYRES_WHEELS: 'Tyres / wheels', MECHANICAL: 'Mechanical', OTHER: 'Other' };
const CATEGORY_ORDER = ['EXTERIOR', 'TYRES_WHEELS', 'MECHANICAL', 'OTHER'];

export async function getInspectionReport(ctx: BusinessContext, id: string, query: unknown = {}) {
  requirePermission(ctx, 'job.view');
  const jobId = parseOrThrow(uuidSchema, id);
  const { audience } = parseOrThrow(reportQuerySchema, query);
  const pricing = can(ctx, 'job.view_pricing');

  return withTenant(ctx.business.id, async (tx) => {
    const base = await loadJob(tx, ctx, jobId);
    return buildInspectionReport(tx, ctx.business.id, base, { jobId, audience, pricing });
  });
}

/**
 * The report itself, from stored data only. It does not know who is asking: the caller decides the audience and whether prices
 * may appear. The same function therefore serves the screen, the printed report and the stored PDF, and they cannot differ.
 */
export async function buildInspectionReport(tx: Tx, businessId: string, base: Awaited<ReturnType<typeof loadJob>>, opts: { jobId: string; audience: 'internal' | 'customer'; pricing: boolean }) {
  const { jobId, audience, pricing } = opts;
  const customerView = audience === 'customer';
  {
    const [business, customer, vehicle, inspection, diagnoses, work, notes, photos] = await seq([
      tx.business.findUniqueOrThrow({ where: { id: businessId }, select: { name: true, tradingName: true, phone: true, email: true } }),
      tx.customer.findFirstOrThrow({ where: { id: base.customerId, businessId }, select: { name: true, customerNumber: true } }),
      tx.vehicle.findFirstOrThrow({ where: { id: base.vehicleId, businessId }, select: { registration: true, make: true, model: true, year: true, colour: true } }),
      tx.inspection.findFirst({ where: { jobId, businessId }, include: { items: { orderBy: { sortOrder: 'asc' } } } }),
      tx.diagnosis.findMany({ where: { jobId, businessId, archivedAt: null }, orderBy: { recordedAt: 'asc' } }),
      tx.recommendedWork.findMany({ where: { jobId, businessId, archivedAt: null }, orderBy: { createdAt: 'asc' } }),
      tx.jobNote.findMany({ where: { jobId, businessId, archivedAt: null, ...(customerView ? { visibility: 'CUSTOMER' } : {}) }, orderBy: { createdAt: 'asc' } }),
      tx.jobPhoto.findMany({ where: { jobId, businessId, archivedAt: null, ...(customerView ? { visibility: 'CUSTOMER' } : {}) }, orderBy: { createdAt: 'asc' } }),
    ]);
    if (!inspection) throw Errors.notFound('Inspection');
    const names = await memberNames(tx, businessId, [inspection.technicianMembershipId]);

    const items = inspection.items.filter((i) => (customerView ? i.customerVisible && i.status !== 'NOT_CHECKED' : true));
    const photosFor = (itemId: string) => photos.filter((p) => p.inspectionItemId === itemId).map((p) => ({ fileId: p.fileId, description: p.description }));
    const sections = CATEGORY_ORDER.map((cat) => ({
      category: cat,
      label: CATEGORY_LABEL[cat]!,
      items: items.filter((i) => i.category === cat).map((i) => ({
        label: i.label,
        status: i.status,
        measurement: i.measurementTenths !== null ? { value: i.measurementTenths / 10, unit: i.measurementUnit } : null,
        customerNotes: i.customerNotes,
        photos: photosFor(i.id),
        ...(customerView ? {} : { internalNotes: i.internalNotes, customerVisible: i.customerVisible }),
      })),
    })).filter((s) => s.items.length > 0);

    const workItems = work.filter((w) => (customerView ? w.customerVisible : true));
    const estimate = (w: (typeof work)[number]) => ((w.estimatedLabourCents ?? 0) + (w.estimatedPartsCents ?? 0));

    return {
      audience,
      generatedAt: new Date(),
      business: { name: business.tradingName ?? business.name, phone: business.phone, email: business.email },
      customer: { name: customer.name, customerNumber: customer.customerNumber },
      vehicle,
      job: { jobNumber: base.jobNumber, status: JOB_STATUS_LABEL[base.status as JobStatus], openedAt: base.openedAt, mileageInKm: base.mileageInKm },
      inspection: {
        status: inspection.status,
        date: inspection.completedAt ?? inspection.startedAt,
        technician: inspection.technicianMembershipId ? (names.get(inspection.technicianMembershipId) ?? null) : null,
        summary: inspection.customerSummary,
        ...(customerView ? {} : { internalNotes: inspection.internalNotes }),
        sections,
        totals: {
          good: items.filter((i) => i.status === 'GOOD').length,
          attention: items.filter((i) => i.status === 'ATTENTION').length,
          critical: items.filter((i) => i.status === 'CRITICAL').length,
        },
      },
      // Diagnosis: the customer sees only the summary the technician wrote for them.
      diagnoses: (customerView
        ? diagnoses.filter((d) => d.customerSummary).map((d): DiagnosisOut => ({ date: d.recordedAt, summary: d.customerSummary }))
        : diagnoses.map((d): DiagnosisOut => ({
            date: d.recordedAt, symptoms: d.symptoms, faultCodes: d.faultCodes, testsPerformed: d.testsPerformed, findings: d.findings,
            diagnosis: d.diagnosis, confirmed: !!d.confirmedAt, internalNotes: d.internalNotes, summary: d.customerSummary,
          }))) as DiagnosisOut[],
      recommendedWork: workItems.map((w) => ({
        description: w.description, priority: w.priority, quantity: w.quantity, approvalStatus: w.approvalStatus,
        estimatedMinutes: w.estimatedMinutes,
        ...(pricing ? { estimatedPriceCents: estimate(w) } : {}),
        ...(customerView ? {} : { notes: w.notes, customerVisible: w.customerVisible, partsDescription: w.partsDescription }),
      })),
      updates: notes.map((n) => ({ at: n.createdAt, body: n.body, ...(customerView ? {} : { visibility: n.visibility }) })),
      photos: photos.filter((p) => !p.inspectionItemId).map((p) => ({ fileId: p.fileId, category: p.category, description: p.description, ...(customerView ? {} : { visibility: p.visibility }) })),
    };
  }
}

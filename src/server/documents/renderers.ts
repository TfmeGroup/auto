import { Errors } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import { logger } from '@/lib/logger';
import { seq, type Tx } from '@/server/db/client';
import { currentBranding } from '@/server/finance/documents';
import { getStorage } from '@/server/storage';
import { buildInspectionReport } from '@/server/jobcards/reports';
import { JOB_STATUS_LABEL, type JobStatus } from '@/server/jobcards/transitions';
import { memberNames } from '@/server/workshop/people';
import { vehicleLabel } from '@/server/vehicles/service';
import { photoForPdf, type ReportModel, type ReportSection, type ReportStatus } from './report-pdf';

/**
 * Builders for the two narrative documents. Both are CUSTOMER documents: they are assembled from whitelisted, customer-safe fields
 * only (customer notes, customer summaries, customer-visible photos, fitted parts and recorded work without their prices or costs).
 * Internal notes, fault-code analysis, supplier costs, labour cost rates and margins are never read into them, so they cannot appear.
 */

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

/** Customer-visible, still-active photos as embeddable JPEGs. A photo that is missing or unreadable is left out (never fails the report). */
async function customerPhotos(tx: Tx, businessId: string, photos: { fileId: string; description: string | null; category?: string }[], limit = 12) {
  const out: { bytes: Buffer; caption: string }[] = [];
  for (const p of photos) {
    if (out.length >= limit) break;
    const f = await tx.file.findFirst({ where: { id: p.fileId, businessId, status: 'ACTIVE', visibility: 'CUSTOMER' } });
    if (!f || !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(f.mimeType)) continue;
    try {
      const { stream } = await getStorage().get(f.storageKey);
      const jpg = await photoForPdf(await readAll(stream));
      if (jpg) out.push({ bytes: jpg, caption: p.description ?? (p.category ? p.category.toLowerCase().replace(/_/g, ' ') : '') });
    } catch (err) {
      logger.warn({ err: String(err), fileId: f.id }, 'photo skipped in a generated document');
    }
  }
  return out;
}

const statusOf = (s: string): ReportStatus => (s === 'GOOD' || s === 'ATTENTION' || s === 'CRITICAL' ? s : 'NOT_CHECKED');
const hours = (min: number) => `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;

export async function inspectionReportModel(tx: Tx, businessId: string, jobId: string): Promise<{ model: ReportModel; filename: string; locationId: string | null }> {
  const job = await tx.jobCard.findFirst({ where: { id: jobId, businessId } });
  if (!job) throw Errors.notFound('Job');
  const inspection = await tx.inspection.findFirst({ where: { jobId, businessId }, select: { id: true, status: true } });
  if (!inspection) throw Errors.notFound('Inspection');
  if (inspection.status !== 'COMPLETED') throw Errors.conflict('The inspection must be completed before its report can be made.');
  const report = await buildInspectionReport(tx, businessId, job, { jobId, audience: 'customer', pricing: false });
  const { business, footer } = await currentBranding(tx, businessId);
  const day = (d: Date) => formatDate(d, 'UTC', business.locale);
  const v = report.vehicle;

  const sections: ReportSection[] = [
    {
      heading: 'Vehicle and customer', kind: 'facts',
      rows: [['Customer', report.customer.name], ['Vehicle', [v.make, v.model, v.year].filter(Boolean).join(' ') || '-'], ['Registration', v.registration ?? '-'], ['Colour', v.colour ?? '-'], ['Mileage', report.job.mileageInKm !== null ? `${report.job.mileageInKm.toLocaleString('en-ZA')} km` : '-'], ['Technician', report.inspection.technician ?? '-']],
    },
    {
      heading: 'Summary', kind: 'facts',
      rows: [['Good', String(report.inspection.totals.good)], ['Needs attention', String(report.inspection.totals.attention)], ['Critical', String(report.inspection.totals.critical)]],
    },
  ];
  if (report.inspection.summary) sections.push({ heading: 'Technician summary', kind: 'text', text: report.inspection.summary });
  for (const s of report.inspection.sections) {
    sections.push({
      heading: s.label, kind: 'items',
      items: s.items.map((i) => ({ label: i.label, status: statusOf(i.status), detail: [i.measurement ? `${i.measurement.value}${i.measurement.unit ? ` ${i.measurement.unit}` : ''}` : null, i.customerNotes].filter(Boolean).join(' - ') || null })),
    });
  }
  const diag = report.diagnoses.filter((d) => d.summary);
  if (diag.length) sections.push({ heading: 'Diagnosis', kind: 'text', text: diag.map((d) => `${day(d.date)}: ${d.summary}`).join('\n') });
  if (report.recommendedWork.length) {
    sections.push({ heading: 'Recommended work', kind: 'table', columns: [{ label: 'Work', width: 6 }, { label: 'Priority', width: 2 }, { label: 'Status', width: 2 }], rows: report.recommendedWork.map((w) => [w.description, String(w.priority).replace(/_/g, ' ').toLowerCase(), String(w.approvalStatus).replace(/_/g, ' ').toLowerCase()]) });
  }
  const allPhotos = [...report.inspection.sections.flatMap((s) => s.items.flatMap((i) => i.photos.map((p) => ({ fileId: p.fileId, description: p.description ? `${i.label}: ${p.description}` : i.label })))), ...report.photos.map((p) => ({ fileId: p.fileId, description: p.description, category: p.category }))];
  const photos = await customerPhotos(tx, businessId, allPhotos);
  if (photos.length) sections.push({ heading: 'Photos', kind: 'photos', photos });
  if (report.updates.length) sections.push({ heading: 'Updates from the workshop', kind: 'text', text: report.updates.map((u) => `${day(u.at)}: ${u.body}`).join('\n') });

  return {
    locationId: job.locationId,
    filename: `${job.jobNumber}-inspection-report.pdf`,
    model: { title: 'VEHICLE INSPECTION REPORT', number: job.jobNumber, facts: [['Inspection date', day(report.inspection.date)]], business, sections, footer },
  };
}

export async function jobSummaryModel(tx: Tx, businessId: string, jobId: string): Promise<{ model: ReportModel; filename: string; locationId: string | null }> {
  const job = await tx.jobCard.findFirst({ where: { id: jobId, businessId } });
  if (!job) throw Errors.notFound('Job');
  const [customer, vehicle, techs, labour, parts, qc, notes, photos, invoices, inspection, diagnoses] = await seq([
    tx.customer.findFirstOrThrow({ where: { id: job.customerId, businessId }, select: { name: true } }),
    tx.vehicle.findFirstOrThrow({ where: { id: job.vehicleId, businessId } }),
    tx.jobTechnician.findMany({ where: { jobId, businessId }, select: { membershipId: true } }),
    tx.jobLabour.findMany({ where: { jobId, businessId, archivedAt: null }, orderBy: { createdAt: 'asc' }, select: { description: true, minutes: true } }),
    tx.jobPart.findMany({ where: { jobId, businessId, archivedAt: null, status: 'FITTED' }, orderBy: { createdAt: 'asc' }, select: { description: true, partNumber: true, quantity: true } }),
    tx.jobQualityCheck.findFirst({ where: { jobId, businessId }, orderBy: { createdAt: 'desc' }, select: { passed: true, createdAt: true } }),
    tx.jobNote.findMany({ where: { jobId, businessId, archivedAt: null, visibility: 'CUSTOMER' }, orderBy: { createdAt: 'asc' } }),
    tx.jobPhoto.findMany({ where: { jobId, businessId, archivedAt: null, visibility: 'CUSTOMER' }, orderBy: { createdAt: 'asc' }, select: { fileId: true, description: true, category: true } }),
    tx.invoice.findMany({ where: { jobId, businessId, status: { notIn: ['DRAFT', 'CANCELLED'] } }, orderBy: { createdAt: 'asc' }, select: { number: true, paymentStatus: true } }),
    tx.inspection.findFirst({ where: { jobId, businessId }, select: { status: true, customerSummary: true } }),
    tx.diagnosis.findMany({ where: { jobId, businessId, archivedAt: null, customerSummary: { not: null } }, orderBy: { recordedAt: 'asc' }, select: { customerSummary: true, recordedAt: true } }),
  ]);
  const names = await memberNames(tx, businessId, [job.primaryTechnicianMembershipId, ...techs.map((t) => t.membershipId)]);
  const techNames = [...new Set([job.primaryTechnicianMembershipId, ...techs.map((t) => t.membershipId)].flatMap((id) => (id && names.get(id) ? [names.get(id)!] : [])))];
  const { business, footer } = await currentBranding(tx, businessId);
  const day = (d: Date) => formatDate(d, 'UTC', business.locale);

  const sections: ReportSection[] = [
    {
      heading: 'Vehicle and customer', kind: 'facts',
      rows: [['Customer', customer.name], ['Vehicle', vehicleLabel(vehicle)], ['Mileage in', job.mileageInKm !== null ? `${job.mileageInKm.toLocaleString('en-ZA')} km` : '-'], ...(job.mileageOutKm !== null ? [['Mileage out', `${job.mileageOutKm.toLocaleString('en-ZA')} km`] as [string, string]] : []), ['Technician', techNames.join(', ') || '-']],
    },
  ];
  if (job.complaint) sections.push({ heading: 'Reported problem', kind: 'text', text: job.complaint });
  if (inspection?.status === 'COMPLETED' && inspection.customerSummary) sections.push({ heading: 'Inspection', kind: 'text', text: inspection.customerSummary });
  if (diagnoses.length) sections.push({ heading: 'Diagnosis', kind: 'text', text: diagnoses.map((d) => `${day(d.recordedAt)}: ${d.customerSummary}`).join('\n') });
  sections.push({ heading: 'Work performed', kind: 'table', columns: [{ label: 'Work', width: 7 }, { label: 'Time', width: 2, align: 'right' }], rows: labour.map((l) => [l.description, hours(l.minutes)]) });
  sections.push({ heading: 'Parts used', kind: 'table', columns: [{ label: 'Part', width: 6 }, { label: 'Part number', width: 3 }, { label: 'Qty', width: 1, align: 'right' }], rows: parts.map((p) => [p.description, p.partNumber ?? '-', String(p.quantity)]) });
  sections.push({ heading: 'Quality check', kind: 'text', text: qc ? (qc.passed ? `Passed on ${day(qc.createdAt)}.` : 'The last quality check found something to put right; the work was corrected before completion.') : 'No quality check has been recorded.' });
  if (job.completionSummary) sections.push({ heading: 'Completion notes', kind: 'text', text: job.completionSummary });
  if (notes.length) sections.push({ heading: 'Updates from the workshop', kind: 'text', text: notes.map((n) => `${day(n.createdAt)}: ${n.body}`).join('\n') });
  if (invoices.length) sections.push({ heading: 'Invoice', kind: 'facts', rows: invoices.map((i) => [i.number ?? 'Invoice', String(i.paymentStatus).replace(/_/g, ' ').toLowerCase()] as [string, string]) });
  const pics = await customerPhotos(tx, businessId, photos);
  if (pics.length) sections.push({ heading: 'Photos', kind: 'photos', photos: pics });

  return {
    locationId: job.locationId,
    filename: `${job.jobNumber}-job-summary.pdf`,
    model: {
      title: 'JOB SUMMARY', number: job.jobNumber,
      facts: [['Status', JOB_STATUS_LABEL[job.status as JobStatus] ?? job.status], ['Opened', day(job.openedAt)], ...(job.completedAt ? [['Completed', day(job.completedAt)] as [string, string]] : [])],
      business, sections, footer,
    },
  };
}

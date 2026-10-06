import { z } from 'zod';
import { withTenant, type Tx } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { dayRange, todayIso } from '@/lib/tz';
import { toCsv, toXlsx, type Cell, type Column } from '@/lib/tabular';
import { parseOrThrow, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { requireFeature } from '@/server/billing/features';
import { can, requirePermission } from '@/server/permissions/authorize';
import { consume } from '@/server/security/rate-limit';
import { locationWhere, visibleLocationIds } from '@/server/workshop/people';
import type { BusinessContext } from '@/server/context';
import { ageBucket, AGE_LABEL } from './calc';
import { dateOnly, isoOf } from './common';

/**
 * Accounting-friendly exports of the financial records, as CSV or Excel. They respect permissions (finance.export AND the
 * permission to see that kind of record), the business's plan (data export), the caller's locations and the filters chosen, and
 * every export is recorded in the audit log with what was exported and how many rows. Costs are never exported to someone who
 * cannot see costs. A hard row limit keeps an export from loading unbounded data: narrow the dates instead.
 */

export const EXPORT_ROW_LIMIT = 20_000;
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-03-31');

export const exportQuerySchema = z.object({
  dataset: z.enum(['invoices', 'invoice_lines', 'payments', 'quotes', 'credit_notes', 'receipts', 'vat', 'ageing']),
  format: z.enum(['csv', 'xlsx']).default('csv'),
  from: isoDay.optional(),
  to: isoDay.optional(),
  status: z.string().max(100).optional(),
  customerId: uuidSchema.optional(),
  vehicleId: uuidSchema.optional(),
  locationId: uuidSchema.optional(),
});

interface Built {
  columns: Column[];
  rows: Cell[][];
  title: string;
}

const T: Column['kind'] = 'text';
const M: Column['kind'] = 'money';
const N: Column['kind'] = 'int';

const DATASET_PERMISSION: Record<string, 'invoice.view' | 'payment.view' | 'quote.view' | 'credit_note.view'> = {
  invoices: 'invoice.view', invoice_lines: 'invoice.view', payments: 'payment.view', quotes: 'quote.view', credit_notes: 'credit_note.view', receipts: 'payment.view', vat: 'invoice.view', ageing: 'invoice.view',
};

export async function exportFinanceData(ctx: BusinessContext, query: unknown): Promise<{ data: Buffer; filename: string; mime: string; rows: number }> {
  requirePermission(ctx, 'finance.export');
  const q = parseOrThrow(exportQuerySchema, query);
  requirePermission(ctx, DATASET_PERMISSION[q.dataset]!);
  requireFeature(ctx.subscription, 'data_export');
  await consume({ key: `finance-export:${ctx.business.id}`, limit: 20, windowSec: 3600 });
  const tz = ctx.business.timezone;
  const today = todayIso(tz);
  const from = q.from ?? `${today.slice(0, 4)}-01-01`;
  const to = q.to ?? today;
  if (to < from) throw Errors.validation({ to: 'The end date cannot be before the start date.' });
  const start = dayRange(from, tz).start;
  const end = dayRange(to, tz).end;

  const built = await withTenant(ctx.business.id, async (tx) => {
    const scope = await visibleLocationIds(tx, ctx);
    const loc = locationWhere(scope);
    const common = { businessId: ctx.business.id, ...(q.customerId ? { customerId: q.customerId } : {}), ...(q.locationId ? { locationId: q.locationId } : {}) };
    switch (q.dataset) {
      case 'invoices': return invoicesDataset(tx, ctx, { ...common, ...loc, ...(q.vehicleId ? { vehicleId: q.vehicleId } : {}), finalisedAt: { not: null }, invoiceDate: { gte: dateOnly(from), lte: dateOnly(to) } }, q.status);
      case 'invoice_lines': return invoiceLinesDataset(tx, ctx, { ...common, ...loc, ...(q.vehicleId ? { vehicleId: q.vehicleId } : {}), finalisedAt: { not: null }, cancelledAt: null, invoiceDate: { gte: dateOnly(from), lte: dateOnly(to) } });
      case 'payments': return paymentsDataset(tx, ctx, { businessId: ctx.business.id, ...(q.customerId ? { customerId: q.customerId } : {}), paidAt: { gte: start, lt: end }, ...(scope ? { OR: [{ invoiceId: null }, { invoice: loc }] } : {}) }, q.status);
      case 'quotes': return quotesDataset(tx, { ...common, ...loc, ...(q.vehicleId ? { vehicleId: q.vehicleId } : {}), quoteDate: { gte: dateOnly(from), lte: dateOnly(to) } }, q.status);
      case 'credit_notes': return creditNotesDataset(tx, { businessId: ctx.business.id, ...(q.customerId ? { customerId: q.customerId } : {}), createdAt: { gte: start, lt: end }, invoice: loc }, q.status);
      case 'receipts': return receiptsDataset(tx, { businessId: ctx.business.id, ...(q.customerId ? { customerId: q.customerId } : {}), issuedAt: { gte: start, lt: end } });
      case 'vat': return vatDataset(tx, ctx, { ...loc, ...(q.locationId ? { locationId: q.locationId } : {}) }, from, to, start, end);
      case 'ageing': return ageingDataset(tx, ctx, { ...common, ...loc }, today);
    }
  });

  if (built.rows.length > EXPORT_ROW_LIMIT) throw Errors.validation({ from: `That is more than ${EXPORT_ROW_LIMIT.toLocaleString('en-ZA')} rows. Choose a shorter period.` });
  const data = q.format === 'xlsx' ? toXlsx(built.title, built.columns, built.rows) : toCsv(built.columns, built.rows);
  const filename = `tfme-auto-${q.dataset}-${from}-to-${to}.${q.format}`;
  await withTenant(ctx.business.id, (tx) =>
    recordAudit(tx, ctx.meta, {
      action: AuditActions.financeExported, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'finance_export', resourceId: ctx.business.id,
      metadata: { dataset: q.dataset, format: q.format, from, to, status: q.status ?? null, customerId: q.customerId ?? null, vehicleId: q.vehicleId ?? null, locationId: q.locationId ?? null, rows: built.rows.length },
    }),
  );
  return { data, filename, mime: q.format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8', rows: built.rows.length };
}

const take = EXPORT_ROW_LIMIT + 1; // one more than allowed, so "too many" is detected without reading everything

async function invoicesDataset(tx: Tx, ctx: BusinessContext, where: object, status?: string): Promise<Built> {
  const statuses = status ? status.split(',').map((s) => s.trim().toUpperCase()) : null;
  const rows = await tx.invoice.findMany({
    where: { ...where, ...(statuses ? { status: { in: statuses as never[] } } : {}) } as never, orderBy: [{ invoiceDate: 'asc' }, { number: 'asc' }], take,
    include: { customer: { select: { name: true, customerNumber: true } }, vehicle: { select: { registration: true, vin: true } }, job: { select: { jobNumber: true } }, quote: { select: { number: true } } },
  });
  return {
    title: 'Invoices',
    columns: [['Invoice number', T], ['Status', T], ['Payment status', T], ['Invoice date', T], ['Due date', T], ['Customer', T], ['Customer number', T], ['Vehicle registration', T], ['VIN', T], ['Job', T], ['Quote', T], ['Subtotal', M], ['Discount', M], ['Taxable', M], ['VAT', M], ['Total', M], ['Paid', M], ['Credit applied', M], ['Credit notes', M], ['Written off', M], ['Outstanding', M], ['Issued at', T]].map(([header, kind]) => ({ header, kind })) as Column[],
    rows: rows.map((i) => [i.number, i.status, i.paymentStatus, isoOf(i.invoiceDate), isoOf(i.dueDate), i.customer.name, i.customer.customerNumber, i.vehicle?.registration, i.vehicle?.vin, i.job?.jobNumber, i.quote?.number, i.subtotalCents, i.discountCents, i.taxableCents, i.vatCents, i.totalCents, i.paidCents, i.creditAppliedCents, i.creditNotedCents, i.writtenOffCents, i.outstandingCents, i.finalisedAt?.toISOString()]),
  };
}

async function invoiceLinesDataset(tx: Tx, ctx: BusinessContext, where: object): Promise<Built> {
  const costs = can(ctx, 'finance.view_costs');
  const invoices = await tx.invoice.findMany({ where: where as never, orderBy: [{ invoiceDate: 'asc' }, { number: 'asc' }], take: EXPORT_ROW_LIMIT, include: { lines: { orderBy: { position: 'asc' } }, customer: { select: { name: true } } } });
  const columns: Column[] = [['Invoice number', T], ['Invoice date', T], ['Customer', T], ['Line', N], ['Type', T], ['Description', T], ['SKU', T], ['Quantity', T], ['Unit price', M], ['Discount', M], ['Tax treatment', T], ['VAT rate %', T], ['Taxable', M], ['VAT', M], ['Total', M], ...(costs ? ([['Unit cost', M]] as [string, Column['kind']][]) : [])].map(([header, kind]) => ({ header, kind })) as Column[];
  const rows: Cell[][] = [];
  for (const i of invoices) for (const l of i.lines) rows.push([i.number, isoOf(i.invoiceDate), i.customer.name, l.position, l.lineType, l.description, l.sku, String(l.quantityMilli / 1000), l.unitPriceCents, l.discountCents, l.taxTreatment, String(l.vatRateBps / 100), l.taxableCents, l.vatCents, l.totalCents, ...(costs ? [l.unitCostCents] : [])]);
  return { title: 'Invoice lines', columns, rows };
}

async function paymentsDataset(tx: Tx, ctx: BusinessContext, where: object, status?: string): Promise<Built> {
  const statuses = status ? status.split(',').map((s) => s.trim().toUpperCase()) : null;
  const rows = await tx.payment.findMany({
    where: { ...where, ...(statuses ? { status: { in: statuses as never[] } } : {}) } as never, orderBy: [{ paidAt: 'asc' }, { number: 'asc' }], take,
    include: { customer: { select: { name: true } }, invoice: { select: { number: true } }, receipt: { select: { number: true } } },
  });
  const users = new Map((await tx.user.findMany({ where: { id: { in: rows.map((r) => r.recordedById).filter((v): v is string => !!v) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  return {
    title: 'Payments',
    columns: [['Payment number', T], ['Date', T], ['Status', T], ['Method', T], ['Purpose', T], ['Amount', M], ['Applied to invoice', M], ['Kept as credit', M], ['Refunded', M], ['Reference', T], ['Provider', T], ['Provider reference', T], ['Invoice', T], ['Receipt', T], ['Customer', T], ['Reconciled', T], ['Recorded by', T]].map(([header, kind]) => ({ header, kind })) as Column[],
    rows: rows.map((p) => [p.number, p.paidAt?.toISOString(), p.status, p.method, p.purpose, p.amountCents, p.appliedCents, p.creditedCents, p.refundedAppliedCents + p.refundedCreditCents, p.reference, p.provider, p.providerReference, p.invoice?.number, p.receipt?.number, p.customer.name, p.reconciledAt ? 'Yes' : 'No', p.recordedById ? users.get(p.recordedById) : null]),
  };
}

async function quotesDataset(tx: Tx, where: object, status?: string): Promise<Built> {
  const statuses = status ? status.split(',').map((s) => s.trim().toUpperCase()) : null;
  const rows = await tx.quote.findMany({
    where: { ...where, ...(statuses ? { status: { in: statuses as never[] } } : {}) } as never, orderBy: [{ quoteDate: 'asc' }, { number: 'asc' }], take,
    include: { customer: { select: { name: true } }, vehicle: { select: { registration: true } }, job: { select: { jobNumber: true } } },
  });
  return {
    title: 'Quotes',
    columns: [['Quote number', T], ['Status', T], ['Version', N], ['Quote date', T], ['Valid until', T], ['Customer', T], ['Vehicle registration', T], ['Job', T], ['Title', T], ['Total', M]].map(([header, kind]) => ({ header, kind })) as Column[],
    rows: rows.map((r) => [r.number, r.status, r.currentVersion, isoOf(r.quoteDate), isoOf(r.validUntil), r.customer.name, r.vehicle?.registration, r.job?.jobNumber, r.title, r.totalCents]),
  };
}

async function creditNotesDataset(tx: Tx, where: object, status?: string): Promise<Built> {
  const rows = await tx.creditNote.findMany({
    where: { ...where, ...(status ? { status: status.toUpperCase() as never } : {}) } as never, orderBy: [{ createdAt: 'asc' }], take,
    include: { customer: { select: { name: true } }, invoice: { select: { number: true } } },
  });
  return {
    title: 'Credit notes',
    columns: [['Credit note', T], ['Status', T], ['Issued at', T], ['Invoice', T], ['Customer', T], ['Reason', T], ['Subtotal', M], ['VAT', M], ['Total', M], ['Applied to invoice', M], ['Added to customer credit', M]].map(([header, kind]) => ({ header, kind })) as Column[],
    rows: rows.map((c) => [c.number, c.status, c.issuedAt?.toISOString(), c.invoice.number, c.customer.name, c.reason, c.subtotalCents - c.discountCents, c.vatCents, c.totalCents, c.appliedCents, c.creditedCents]),
  };
}

async function receiptsDataset(tx: Tx, where: object): Promise<Built> {
  const rows = await tx.receipt.findMany({ where: where as never, orderBy: [{ issuedAt: 'asc' }], take, include: { payment: { select: { number: true } } } });
  const customers = new Map((await tx.customer.findMany({ where: { id: { in: rows.map((r) => r.customerId) } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  return {
    title: 'Receipts',
    columns: [['Receipt', T], ['Issued at', T], ['Payment', T], ['Customer', T], ['Amount', M], ['Method', T], ['Reference', T], ['Remaining on invoice', M]].map(([header, kind]) => ({ header, kind })) as Column[],
    rows: rows.map((r) => [r.number, r.issuedAt.toISOString(), r.payment.number, customers.get(r.customerId), r.amountCents, r.method, r.reference, r.remainingCents]),
  };
}

/** One row per tax rate per document: the VAT facts exactly as stored on each issued invoice and credit note. */
async function vatDataset(tx: Tx, ctx: BusinessContext, loc: object, from: string, to: string, start: Date, end: Date): Promise<Built> {
  const base = { businessId: ctx.business.id };
  const invoices = await tx.invoice.findMany({
    where: { ...base, ...loc, finalisedAt: { not: null }, cancelledAt: null, invoiceDate: { gte: dateOnly(from), lte: dateOnly(to) } } as never, orderBy: [{ invoiceDate: 'asc' }, { number: 'asc' }], take: EXPORT_ROW_LIMIT,
    include: { lines: true, customer: { select: { name: true } } },
  });
  const notes = await tx.creditNote.findMany({ where: { ...base, status: 'ISSUED', issuedAt: { gte: start, lt: end }, invoice: loc } as never, orderBy: [{ issuedAt: 'asc' }], take: EXPORT_ROW_LIMIT, include: { lines: true, customer: { select: { name: true } }, invoice: { select: { number: true } } } });
  const group = (lines: { taxTreatment: string; vatRateBps: number; taxableCents: number; vatCents: number; totalCents: number }[]) => {
    const m = new Map<string, { treatment: string; rate: number; taxable: number; vat: number; total: number }>();
    for (const l of lines) {
      const k = `${l.taxTreatment}:${l.vatRateBps}`;
      const g = m.get(k) ?? { treatment: l.taxTreatment, rate: l.vatRateBps, taxable: 0, vat: 0, total: 0 };
      g.taxable += l.taxableCents; g.vat += l.vatCents; g.total += l.totalCents;
      m.set(k, g);
    }
    return [...m.values()];
  };
  const rows: Cell[][] = [];
  for (const i of invoices) for (const g of group(i.lines)) rows.push(['Tax invoice', i.number, isoOf(i.invoiceDate), i.customer.name, '', g.treatment, String(g.rate / 100), g.taxable, g.vat, g.total]);
  for (const c of notes) for (const g of group(c.lines)) rows.push(['Credit note', c.number, isoOf(c.issuedAt), c.customer.name, c.invoice.number, g.treatment, String(g.rate / 100), -g.taxable, -g.vat, -g.total]);
  return { title: 'VAT', columns: [['Document', T], ['Number', T], ['Date', T], ['Customer', T], ['Against invoice', T], ['Tax treatment', T], ['VAT rate %', T], ['Taxable amount', M], ['VAT', M], ['Total', M]].map(([header, kind]) => ({ header, kind })) as Column[], rows };
}

async function ageingDataset(tx: Tx, ctx: BusinessContext, where: object, today: string): Promise<Built> {
  const rows = await tx.invoice.findMany({
    where: { ...where, finalisedAt: { not: null }, cancelledAt: null, writtenOffAt: null, outstandingCents: { gt: 0 } } as never, orderBy: [{ dueDate: 'asc' }], take,
    include: { customer: { select: { name: true, mobile: true, email: true } } },
  });
  return {
    title: 'Ageing',
    columns: [['Invoice', T], ['Customer', T], ['Phone', T], ['Email', T], ['Invoice date', T], ['Due date', T], ['Age bucket', T], ['Total', M], ['Outstanding', M]].map(([header, kind]) => ({ header, kind })) as Column[],
    rows: rows.map((i) => [i.number, i.customer.name, i.customer.mobile, i.customer.email, isoOf(i.invoiceDate), isoOf(i.dueDate), AGE_LABEL[ageBucket(isoOf(i.dueDate)!, today)], i.totalCents, i.outstandingCents]),
  };
}

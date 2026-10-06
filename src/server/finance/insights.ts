import { seq, withTenant } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { todayIso } from '@/lib/tz';
import { parseOrThrow, uuidSchema } from '@/lib/validation';
import { can } from '@/server/permissions/authorize';
import { locationWhere, visibleLocationIds } from '@/server/workshop/people';
import { vehicleLabel } from '@/server/vehicles/service';
import type { BusinessContext } from '@/server/context';
import { dateOnly, isoOf } from './common';
import { creditBalance } from './ledger';
import { buildStatement } from './statements';

/**
 * The money side of a customer and of a vehicle, aggregated from the real records every time (nothing is stored as a total).
 * Each section only appears if the caller may see that kind of record.
 */

const openWhere = { finalisedAt: { not: null }, cancelledAt: null, writtenOffAt: null, outstandingCents: { gt: 0 } } as const;

export async function getCustomerFinancials(ctx: BusinessContext, customerId: string) {
  if (!can(ctx, 'invoice.view') && !can(ctx, 'quote.view') && !can(ctx, 'payment.view')) throw Errors.forbidden();
  const id = parseOrThrow(uuidSchema, customerId);
  return withTenant(ctx.business.id, async (tx) => {
    const businessId = ctx.business.id;
    const customer = await tx.customer.findFirst({ where: { id, businessId }, select: { id: true } });
    if (!customer) throw Errors.notFound('Customer');
    const scope = await visibleLocationIds(tx, ctx);
    const today = todayIso(ctx.business.timezone);
    const loc = locationWhere(scope);
    const base = { businessId, customerId: id, finalisedAt: { not: null }, cancelledAt: null, ...loc } as const;
    const out: Record<string, unknown> = {};

    if (can(ctx, 'invoice.view')) {
      const all = await tx.invoice.aggregate({ where: base, _sum: { totalCents: true, paidCents: true, creditAppliedCents: true, creditNotedCents: true, writtenOffCents: true, outstandingCents: true }, _count: true });
      const overdue = await tx.invoice.aggregate({ where: { ...base, ...openWhere, dueDate: { lt: dateOnly(today) } }, _sum: { outstandingCents: true }, _count: true });
      const notesAgg = await tx.creditNote.aggregate({ where: { businessId, customerId: id, status: 'ISSUED' }, _sum: { totalCents: true } });
      const openAgg = await tx.invoice.aggregate({ where: { ...base, ...openWhere }, _sum: { outstandingCents: true } });
      const [openInv, paidInv] = await seq([
        tx.invoice.findMany({ where: { ...base, ...openWhere }, orderBy: { dueDate: 'asc' }, take: 20, select: { id: true, number: true, invoiceDate: true, dueDate: true, totalCents: true, outstandingCents: true, status: true } }),
        tx.invoice.findMany({ where: { ...base, paymentStatus: 'PAID' }, orderBy: { paidAt: 'desc' }, take: 10, select: { id: true, number: true, invoiceDate: true, totalCents: true, paidAt: true } }),
      ]);
      out.totals = {
        invoicedCents: all._sum.totalCents ?? 0, paidCents: (all._sum.paidCents ?? 0) + (all._sum.creditAppliedCents ?? 0), creditNotedCents: notesAgg._sum.totalCents ?? 0,
        writtenOffCents: all._sum.writtenOffCents ?? 0, outstandingCents: openAgg._sum.outstandingCents ?? 0,
        overdueCents: overdue._sum.outstandingCents ?? 0, overdueCount: overdue._count, invoiceCount: all._count,
      };
      out.openInvoices = openInv.map((i) => ({ ...i, invoiceDate: isoOf(i.invoiceDate), dueDate: isoOf(i.dueDate), overdue: !!i.dueDate && isoOf(i.dueDate)! < today }));
      out.paidInvoices = paidInv.map((i) => ({ ...i, invoiceDate: isoOf(i.invoiceDate) }));
      const month = `${today.slice(0, 4)}-01-01`;
      const s = await buildStatement(tx, businessId, ctx.business.timezone, id, month, today);
      out.accountBalanceCents = s.closingCents;
    }
    out.creditBalanceCents = await creditBalance(tx, businessId, id);
    if (can(ctx, 'payment.view')) {
      const pays = await tx.payment.findMany({ where: { businessId, customerId: id }, orderBy: { createdAt: 'desc' }, take: 10, include: { invoice: { select: { id: true, number: true } }, receipt: { select: { id: true, number: true } } } });
      out.recentPayments = pays.map((p) => ({ id: p.id, number: p.number, status: p.status, method: p.method, purpose: p.purpose, amountCents: p.amountCents, paidAt: p.paidAt, invoice: p.invoice, receipt: p.receipt }));
      const refunds = await tx.refund.findMany({ where: { businessId, customerId: id }, orderBy: { refundedAt: 'desc' }, take: 10 });
      out.refunds = refunds.map((r) => ({ id: r.id, number: r.number, amountCents: r.amountCents, reason: r.reason, refundedAt: r.refundedAt, paymentId: r.paymentId }));
    }
    if (can(ctx, 'quote.view')) {
      const quotes = await tx.quote.findMany({ where: { businessId, customerId: id, ...loc }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, number: true, status: true, totalCents: true, validUntil: true, currentVersion: true } });
      out.quotes = quotes.map((q) => ({ ...q, validUntil: isoOf(q.validUntil) }));
    }
    if (can(ctx, 'credit_note.view')) {
      out.creditNotes = await tx.creditNote.findMany({ where: { businessId, customerId: id, status: { not: 'CANCELLED' } }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, number: true, status: true, totalCents: true, issuedAt: true } });
    }
    return out;
  });
}

export async function getVehicleFinancials(ctx: BusinessContext, vehicleId: string) {
  if (!can(ctx, 'invoice.view') && !can(ctx, 'quote.view')) throw Errors.forbidden();
  const id = parseOrThrow(uuidSchema, vehicleId);
  return withTenant(ctx.business.id, async (tx) => {
    const businessId = ctx.business.id;
    const v = await tx.vehicle.findFirst({ where: { id, businessId } });
    if (!v) throw Errors.notFound('Vehicle');
    const scope = await visibleLocationIds(tx, ctx);
    const loc = locationWhere(scope);
    const today = todayIso(ctx.business.timezone);
    const out: Record<string, unknown> = { vehicle: { id: v.id, label: vehicleLabel(v) } };
    if (can(ctx, 'invoice.view')) {
      const base = { businessId, vehicleId: id, finalisedAt: { not: null }, cancelledAt: null, ...loc } as const;
      const all = await tx.invoice.aggregate({ where: base, _sum: { totalCents: true, taxableCents: true, paidCents: true, creditAppliedCents: true }, _count: true });
      const open = await tx.invoice.aggregate({ where: { ...base, ...openWhere }, _sum: { outstandingCents: true } });
      const invoices = await tx.invoice.findMany({ where: { businessId, vehicleId: id, ...loc }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, number: true, status: true, invoiceDate: true, dueDate: true, totalCents: true, outstandingCents: true, jobId: true, finalisedAt: true, cancelledAt: true, paidCents: true, creditAppliedCents: true, creditNotedCents: true, writtenOffCents: true, writtenOffAt: true, sentAt: true, viewedAt: true } });
      const jobs = await tx.jobCard.count({ where: { businessId, vehicleId: id } });
      out.totals = {
        // "Spend" = what was invoiced for this vehicle (ex-credit-notes), a property of the vehicle, not of the customer's account.
        invoicedCents: all._sum.totalCents ?? 0, spendExVatCents: all._sum.taxableCents ?? 0, paidCents: (all._sum.paidCents ?? 0) + (all._sum.creditAppliedCents ?? 0), outstandingCents: open._sum.outstandingCents ?? 0,
        invoiceCount: all._count, jobCount: jobs,
      };
      out.invoices = invoices.map((i) => ({ id: i.id, number: i.number, status: i.status, invoiceDate: isoOf(i.invoiceDate), dueDate: isoOf(i.dueDate), totalCents: i.totalCents, outstandingCents: i.outstandingCents, jobId: i.jobId, overdue: !!i.dueDate && i.outstandingCents > 0 && !!i.finalisedAt && !i.cancelledAt && !i.writtenOffAt && isoOf(i.dueDate)! < today }));
      if (can(ctx, 'payment.view')) {
        const pays = await tx.payment.findMany({ where: { businessId, status: { in: ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'] }, invoice: { vehicleId: id, ...loc } }, orderBy: { paidAt: 'desc' }, take: 20, include: { invoice: { select: { id: true, number: true } } } });
        out.payments = pays.map((p) => ({ id: p.id, number: p.number, method: p.method, amountCents: p.appliedCents, paidAt: p.paidAt, invoice: p.invoice }));
      }
    }
    if (can(ctx, 'quote.view')) {
      const quotes = await tx.quote.findMany({ where: { businessId, vehicleId: id, ...loc }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, number: true, status: true, totalCents: true, currentVersion: true } });
      out.quotes = quotes;
    }
    return out;
  });
}

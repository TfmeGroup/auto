import { Errors } from '@/lib/errors';
import { todayIso } from '@/lib/tz';
import type { Tx } from '@/server/db/client';
import { deriveInvoiceState } from './calc';
import { isoOf, lockRow } from './common';

/**
 * The ledger layer shared by invoices, payments, credit notes and refunds.
 *
 * Source of truth: the rows themselves (payments, credit-ledger entries, issued credit notes, the write-off). An invoice's
 * paid / credit / outstanding columns are a CACHE rebuilt from those rows here and nowhere else, always under the invoice's
 * row lock; the database refuses an invoice whose cached columns don't add up (migration 0006).
 */

export type CreditKind = 'DEPOSIT' | 'OVERPAYMENT' | 'CREDIT_NOTE' | 'APPLIED' | 'REFUND';

/** A customer's available credit: the sum of their append-only ledger. */
export async function creditBalance(tx: Tx, businessId: string, customerId: string): Promise<number> {
  const r = await tx.customerCreditEntry.aggregate({ where: { businessId, customerId }, _sum: { amountCents: true } });
  return r._sum.amountCents ?? 0;
}

/**
 * Add one entry to a customer's credit ledger. The customer row is locked first so two people can't spend the same credit,
 * and the database trigger independently refuses to let the balance go negative. An idempotency key makes a repeated
 * request a no-op that returns the first result.
 */
export async function addCreditEntry(
  tx: Tx,
  businessId: string,
  e: { customerId: string; kind: CreditKind; amountCents: number; invoiceId?: string | null; paymentId?: string | null; creditNoteId?: string | null; refundId?: string | null; jobId?: string | null; quoteId?: string | null; note?: string | null; idempotencyKey?: string | null; createdById?: string | null },
): Promise<{ created: boolean }> {
  await lockRow(tx, 'customers', businessId, e.customerId);
  if (e.idempotencyKey) {
    const dup = await tx.customerCreditEntry.findFirst({ where: { businessId, idempotencyKey: e.idempotencyKey }, select: { id: true } });
    if (dup) return { created: false };
  }
  if (e.amountCents < 0) {
    const bal = await creditBalance(tx, businessId, e.customerId);
    if (bal + e.amountCents < 0) throw Errors.conflict(`The customer only has ${(bal / 100).toFixed(2)} credit available.`, { availableCents: bal });
  }
  await tx.customerCreditEntry.create({
    data: {
      businessId, customerId: e.customerId, kind: e.kind, amountCents: e.amountCents, invoiceId: e.invoiceId ?? null, paymentId: e.paymentId ?? null, creditNoteId: e.creditNoteId ?? null,
      refundId: e.refundId ?? null, jobId: e.jobId ?? null, quoteId: e.quoteId ?? null, note: e.note ?? null, idempotencyKey: e.idempotencyKey ?? null, createdById: e.createdById ?? null,
    },
  });
  return { created: true };
}

type InvoiceRow = Awaited<ReturnType<Tx['invoice']['findFirstOrThrow']>>;

/**
 * Rebuild an invoice's balance and status from its payments, credit applications, issued credit notes and write-off.
 * Call with the invoice row locked. Returns the updated invoice.
 */
export async function recomputeInvoice(tx: Tx, businessId: string, invoiceId: string): Promise<InvoiceRow> {
  const inv = await tx.invoice.findFirstOrThrow({ where: { id: invoiceId, businessId } });
  const biz = await tx.business.findUniqueOrThrow({ where: { id: businessId }, select: { timezone: true } });

  const pays = await tx.payment.aggregate({
    where: { businessId, invoiceId, status: { in: ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'] } },
    _sum: { appliedCents: true, refundedAppliedCents: true },
  });
  const applied = await tx.customerCreditEntry.aggregate({ where: { businessId, invoiceId, kind: 'APPLIED' }, _sum: { amountCents: true } });
  const notes = await tx.creditNote.aggregate({ where: { businessId, invoiceId, status: 'ISSUED' }, _sum: { appliedCents: true } });

  const paidCents = (pays._sum.appliedCents ?? 0) - (pays._sum.refundedAppliedCents ?? 0);
  const creditAppliedCents = -(applied._sum.amountCents ?? 0);
  const creditNotedCents = notes._sum.appliedCents ?? 0;
  const writtenOffCents = inv.writtenOffAt ? inv.writtenOffCents : 0;

  const facts = {
    totalCents: inv.totalCents, paidCents, creditAppliedCents, creditNotedCents, writtenOffCents,
    finalised: inv.finalisedAt !== null, cancelled: inv.cancelledAt !== null, writtenOff: inv.writtenOffAt !== null, sent: inv.sentAt !== null, viewed: inv.viewedAt !== null, dueDate: isoOf(inv.dueDate),
  };
  const state = deriveInvoiceState(facts, todayIso(biz.timezone));
  if (state.outstandingCents < 0) throw new Error(`invoice ${invoiceId} would be over-settled (${state.outstandingCents})`);

  return tx.invoice.update({
    where: { id: invoiceId },
    data: {
      paidCents, creditAppliedCents, creditNotedCents, writtenOffCents, outstandingCents: state.outstandingCents, status: state.status, paymentStatus: state.paymentStatus,
      paidAt: state.status === 'PAID' ? (inv.paidAt ?? new Date()) : state.status === 'WRITTEN_OFF' ? inv.paidAt : null,
    },
  });
}

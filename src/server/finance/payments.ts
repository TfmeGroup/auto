import { z } from 'zod';
import { seq, withTenant, type Tx } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { formatMoney } from '@/lib/money';
import { escapeLike, optionalText, pageMeta, paginationSchema, parseOrThrow, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { recordActivity } from '@/server/activity/service';
import { assertCanWrite } from '@/server/billing/subscriptions';
import { can, requirePermission } from '@/server/permissions/authorize';
import { locationWhere, visibleLocationIds } from '@/server/workshop/people';
import type { BusinessContext, RequestMeta } from '@/server/context';
import { canMovePayment, paymentStatusAfterRefund, splitPayment, splitRefund } from './calc';
import { dateOnly, loadFinanceSettings, lockRow, nextDocumentNumber, recordFinanceEvent, staffActor, validateParties, type FinanceActor } from './common';
import { addCreditEntry, creditBalance, recomputeInvoice } from './ledger';
import { sendFinanceMessage } from './notify';
import { generateOrQueue } from '@/server/documents/generator';
import { notifyInternal } from '@/server/notifications/internal';

const clearable = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v === undefined ? undefined : v === null || v === '' ? null : v));
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-03-31');
const MIN_PAID_AT = new Date('2000-01-01T00:00:00Z');

export const recordPaymentSchema = z.object({
  purpose: z.enum(['INVOICE', 'DEPOSIT']).default('INVOICE'),
  invoiceId: uuidSchema.optional(),
  customerId: uuidSchema.optional(),
  jobId: uuidSchema.optional(),
  quoteId: uuidSchema.optional(),
  method: z.enum(['CARD', 'EFT', 'CASH', 'ONLINE', 'OTHER']),
  amountCents: z.coerce.number().int('Enter the amount in whole cents').min(1, 'Enter an amount greater than zero').max(2_000_000_000, 'That amount is too large'),
  reference: optionalText(100),
  paidAt: z.coerce.date().optional(),
  notes: optionalText(500),
  /** Generated once per form: sending the same key again returns the first payment instead of recording a second. */
  idempotencyKey: z.string().trim().min(8).max(80).optional(),
});

type PaymentRow = Awaited<ReturnType<Tx['payment']['findFirstOrThrow']>>;

const fmt = (ctx: { business: { currency: string; locale: string } }, cents: number) => formatMoney(cents, ctx.business.currency, ctx.business.locale);

interface Settlement {
  payment: PaymentRow;
  already: boolean;
  receiptId: string | null;
  receiptNumber: string | null;
  invoice: { id: string; number: string | null; status: string; outstandingCents: number; totalCents: number } | null;
}

/**
 * The one place a payment becomes COMPLETED and moves money, whether it was typed in by staff or confirmed by a payment
 * provider's webhook. In ONE transaction, with locks taken in a fixed order (customer, invoice, payment) so concurrent
 * requests wait their turn instead of deadlocking:
 *   split the amount (what the invoice still owes vs. any excess) -> mark the payment completed -> add any excess to the
 *   customer's credit ledger -> rebuild the invoice balance and status -> issue the receipt -> record the event and audit ->
 *   queue the customer's receipt email.
 * Doing it twice is harmless: a payment that is already completed returns as it is. If any step fails, the whole thing rolls back.
 */
export async function completePaymentTx(
  tx: Tx,
  businessId: string,
  paymentId: string,
  o: { actor: FinanceActor; actorUserId: string | null; meta?: RequestMeta; currency: string; locale: string; businessName: string; fromProvider?: boolean },
): Promise<Settlement> {
  const first = await tx.payment.findFirst({ where: { id: paymentId, businessId } });
  if (!first) throw Errors.notFound('Payment');
  await lockRow(tx, 'customers', businessId, first.customerId);
  if (first.invoiceId) await lockRow(tx, 'invoices', businessId, first.invoiceId);
  await lockRow(tx, 'payments', businessId, paymentId);
  const p = await tx.payment.findFirstOrThrow({ where: { id: paymentId, businessId } });

  if (['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(p.status)) {
    const r = await tx.receipt.findFirst({ where: { paymentId, businessId } });
    const inv = p.invoiceId ? await tx.invoice.findFirst({ where: { id: p.invoiceId, businessId } }) : null;
    return { payment: p, already: true, receiptId: r?.id ?? null, receiptNumber: r?.number ?? null, invoice: inv ? { id: inv.id, number: inv.number, status: inv.status, outstandingCents: inv.outstandingCents, totalCents: inv.totalCents } : null };
  }
  if (!canMovePayment(p.status, 'COMPLETED')) throw Errors.conflict(`A ${p.status.toLowerCase()} payment cannot be completed.`);

  let applied = 0;
  let credited = p.amountCents;
  if (p.invoiceId && p.purpose === 'INVOICE') {
    const inv = await recomputeInvoice(tx, businessId, p.invoiceId);
    // A payment that lands on an invoice that has since been cancelled, written off or settled is never lost: all of it becomes credit.
    const open = inv.finalisedAt && !inv.cancelledAt && !inv.writtenOffAt ? inv.outstandingCents : 0;
    ({ applied, credited } = splitPayment(p.amountCents, open));
  }
  const now = new Date();
  await tx.payment.update({ where: { id: paymentId }, data: { status: 'COMPLETED', appliedCents: applied, creditedCents: credited, paidAt: p.paidAt ?? now, failureReason: null } });
  if (credited > 0) {
    await addCreditEntry(tx, businessId, {
      customerId: p.customerId, kind: p.purpose === 'DEPOSIT' ? 'DEPOSIT' : 'OVERPAYMENT', amountCents: credited, invoiceId: p.invoiceId, paymentId, jobId: p.jobId, quoteId: p.quoteId,
      note: p.purpose === 'DEPOSIT' ? 'Deposit received' : 'Payment was more than the invoice balance', idempotencyKey: `pay:${paymentId}:credit`, createdById: o.actorUserId,
    });
  }
  const invoice = p.invoiceId ? await recomputeInvoice(tx, businessId, p.invoiceId) : null;

  const settings = await loadFinanceSettings(tx, businessId);
  const number = await nextDocumentNumber(tx, businessId, 'receipt', settings, invoice?.locationId ?? null);
  const receipt = await tx.receipt.create({
    data: {
      businessId, number, paymentId, invoiceId: p.invoiceId, customerId: p.customerId, amountCents: p.amountCents, method: p.method, reference: p.reference,
      invoiceTotalCents: invoice?.totalCents ?? null, invoicePaidCents: invoice ? invoice.paidCents + invoice.creditAppliedCents : null, remainingCents: invoice?.outstandingCents ?? null,
    },
  });

  await recordFinanceEvent(tx, businessId, { entityType: 'payment', entityId: paymentId, type: 'payment.completed', actor: o.actor, meta: o.meta, detail: { amountCents: p.amountCents, appliedCents: applied, creditedCents: credited, method: p.method, invoiceId: p.invoiceId, fromProvider: !!o.fromProvider } });
  await recordAudit(tx, o.meta, {
    action: AuditActions.paymentCompleted, businessId, userId: o.actorUserId, resourceType: 'payment', resourceId: paymentId,
    metadata: { number: p.number, amountCents: p.amountCents, appliedCents: applied, creditedCents: credited, method: p.method, invoiceId: p.invoiceId, receipt: number, provider: p.provider, fromProvider: !!o.fromProvider },
  });
  if (credited > 0) {
    await recordAudit(tx, o.meta, { action: AuditActions.customerCreditAdded, businessId, userId: o.actorUserId, resourceType: 'customer', resourceId: p.customerId, metadata: { paymentId, amountCents: credited, kind: p.purpose === 'DEPOSIT' ? 'DEPOSIT' : 'OVERPAYMENT' } });
  }
  await recordAudit(tx, o.meta, { action: AuditActions.receiptIssued, businessId, userId: o.actorUserId, resourceType: 'receipt', resourceId: receipt.id, metadata: { number, paymentId } });
  await recordActivity(tx, businessId, o.actorUserId, {
    type: 'payment.received', summary: `Payment ${p.number} of ${formatMoney(p.amountCents, o.currency, o.locale)} received${invoice?.number ? ` for invoice ${invoice.number}` : p.purpose === 'DEPOSIT' ? ' (deposit)' : ''}`,
    customerId: p.customerId, vehicleId: invoice?.vehicleId ?? p.vehicleId, jobId: invoice?.jobId ?? p.jobId, data: { paymentId },
  });
  await sendFinanceMessage(tx, businessId, {
    customerId: p.customerId, entityType: 'payment', entityId: paymentId, event: 'PAYMENT_RECEIVED', vehicleId: invoice?.vehicleId ?? p.vehicleId, dedupeKey: `payment:${paymentId}:receipt`,
    vars: { payment_amount: formatMoney(p.amountCents, o.currency, o.locale), receipt_number: number, invoice_number: invoice?.number ?? undefined, remaining_balance: invoice ? formatMoney(invoice.outstandingCents, o.currency, o.locale) : undefined },
  });

  if (invoice && invoice.outstandingCents === 0) {
    await notifyInternal(tx, businessId, 'INVOICE_PAID', { title: `Invoice ${invoice.number} was paid`, body: `Payment ${p.number} of ${formatMoney(p.amountCents, o.currency, o.locale)} settled it.`, linkUrl: `/invoices/${invoice.id}`, entity: { type: 'invoice', id: invoice.id }, excludeUserIds: o.actorUserId ? [o.actorUserId] : [] });
  }

  const done = await tx.payment.findFirstOrThrow({ where: { id: paymentId, businessId } });
  return { payment: done, already: false, receiptId: receipt.id, receiptNumber: number, invoice: invoice ? { id: invoice.id, number: invoice.number, status: invoice.status, outstandingCents: invoice.outstandingCents, totalCents: invoice.totalCents } : null };
}

/** After the transaction commits: file the receipt PDF in the document store (best effort; it can always be re-rendered). */
export async function fileReceiptPdf(businessId: string, userId: string | null, receiptId: string): Promise<void> {
  const fileId = await generateOrQueue(businessId, userId, 'receipt', receiptId, { dedupeKey: `receipt:${receiptId}:issued` });
  if (fileId) await withTenant(businessId, (tx) => tx.receipt.update({ where: { id: receiptId }, data: { fileId } }));
  // The invoice the payment settled gets a new stored version showing its new payment state.
  const inv = await withTenant(businessId, (tx) => tx.receipt.findFirst({ where: { id: receiptId, businessId }, select: { invoiceId: true } })).catch(() => null);
  if (inv?.invoiceId) await generateOrQueue(businessId, userId, 'invoice', inv.invoiceId, { dedupeKey: `invoice:${inv.invoiceId}:receipt:${receiptId}`, regenerate: true, reason: 'Payment received' });
}

// ───────────────────────── record (staff) ─────────────────────────

/**
 * Record a payment someone has received (cash, card machine, EFT that has landed, other). Validates ownership, amount, invoice
 * state and the enabled payment methods, then settles it atomically (see completePaymentTx). Sending the same idempotency key
 * twice returns the first payment: a double-click or a retried request records ONE payment.
 */
export async function recordPayment(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'payment.create');
  assertCanWrite(ctx.subscription);
  const d = parseOrThrow(recordPaymentSchema, input);
  if (d.paidAt && (d.paidAt < MIN_PAID_AT || d.paidAt.getTime() > Date.now() + 5 * 60_000)) throw Errors.validation({ paidAt: 'The payment date cannot be in the future.' });
  const out = await withTenant(ctx.business.id, async (tx) => {
    const businessId = ctx.business.id;
    const settings = await loadFinanceSettings(tx, businessId);
    if (!settings.enabledMethods.includes(d.method)) throw Errors.validation({ method: 'That payment method is not turned on for this business.' });

    // A repeated request key returns the first payment. Checked AFTER the customer and invoice are locked, so two simultaneous
    // submits cannot both get past it: the second waits, then finds the first.
    const replay = async (): Promise<Settlement | null> => {
      if (!d.idempotencyKey) return null;
      const dup = await tx.payment.findFirst({ where: { businessId, idempotencyKey: d.idempotencyKey } });
      if (!dup) return null;
      if (dup.amountCents !== d.amountCents || dup.invoiceId !== (d.invoiceId ?? null)) throw Errors.conflict('That request key was already used for a different payment.');
      const r = await tx.receipt.findFirst({ where: { paymentId: dup.id, businessId } });
      return { payment: dup, already: true, receiptId: r?.id ?? null, receiptNumber: r?.number ?? null, invoice: null };
    };

    let customerId: string;
    let vehicleId: string | null = null;
    let jobId: string | null = d.jobId ?? null;
    let quoteId: string | null = d.quoteId ?? null;
    let invoiceId: string | null = null;
    let locationId: string | null = null;
    if (d.purpose === 'INVOICE') {
      if (!d.invoiceId) throw Errors.validation({ invoiceId: 'Choose the invoice this payment is for.' });
      const scope = await visibleLocationIds(tx, ctx);
      const inv = await tx.invoice.findFirst({ where: { id: d.invoiceId, businessId, ...locationWhere(scope) } });
      if (!inv) throw Errors.notFound('Invoice');
      await lockRow(tx, 'customers', businessId, inv.customerId);
      await lockRow(tx, 'invoices', businessId, inv.id);
      const replayed = await replay();
      if (replayed) return replayed;
      const fresh = await recomputeInvoice(tx, businessId, inv.id);
      if (!fresh.finalisedAt) throw Errors.conflict('Issue the invoice before recording a payment against it.');
      if (fresh.cancelledAt) throw Errors.conflict('This invoice is cancelled.');
      if (fresh.writtenOffAt) throw Errors.conflict('This invoice has been written off.');
      if (fresh.outstandingCents <= 0) throw Errors.conflict('This invoice is already paid in full. To record money received in advance, record a deposit instead.', { code: 'INVOICE_ALREADY_PAID' });
      customerId = fresh.customerId; vehicleId = fresh.vehicleId; jobId = fresh.jobId; quoteId = fresh.quoteId; invoiceId = fresh.id; locationId = fresh.locationId;
      splitPayment(d.amountCents, fresh.outstandingCents); // validates the amount
    } else {
      if (!settings.depositsEnabled) throw Errors.validation({ purpose: 'Deposits are turned off for this business.' });
      if (!d.customerId) throw Errors.validation({ customerId: 'Choose the customer who paid the deposit.' });
      const parties = await validateParties(tx, businessId, { customerId: d.customerId, jobId });
      customerId = parties.customerId; vehicleId = parties.vehicleId; jobId = parties.jobId; locationId = parties.locationId;
      await lockRow(tx, 'customers', businessId, customerId);
      const replayed = await replay();
      if (replayed) return replayed;
      if (quoteId) {
        const q = await tx.quote.findFirst({ where: { id: quoteId, businessId, customerId } });
        if (!q) throw Errors.validation({ quoteId: 'Choose a quote for this customer.' });
        vehicleId = vehicleId ?? q.vehicleId;
      }
    }

    const number = await nextDocumentNumber(tx, businessId, 'payment', settings, locationId);
    const created = await tx.payment.create({
      data: {
        businessId, number, invoiceId, customerId, vehicleId, jobId, quoteId, purpose: d.purpose, method: d.method, status: 'PENDING', amountCents: d.amountCents, reference: d.reference ?? null,
        paidAt: d.paidAt ?? new Date(), notes: d.notes ?? null, idempotencyKey: d.idempotencyKey ?? null, recordedById: ctx.user.id,
      },
    });
    await recordFinanceEvent(tx, businessId, { entityType: 'payment', entityId: created.id, type: 'payment.recorded', actor: staffActor(ctx), meta: ctx.meta, detail: { amountCents: d.amountCents, method: d.method, purpose: d.purpose } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.paymentRecorded, businessId, userId: ctx.user.id, resourceType: 'payment', resourceId: created.id, metadata: { number, amountCents: d.amountCents, method: d.method, purpose: d.purpose, invoiceId, customerId } });
    return completePaymentTx(tx, businessId, created.id, { actor: staffActor(ctx), actorUserId: ctx.user.id, meta: ctx.meta, currency: ctx.business.currency, locale: ctx.business.locale, businessName: ctx.business.name });
  });
  if (!out.already && out.receiptId) await fileReceiptPdf(ctx.business.id, ctx.user.id, out.receiptId);
  return {
    id: out.payment.id, number: out.payment.number, status: out.payment.status, amountCents: out.payment.amountCents, appliedCents: out.payment.appliedCents, creditedCents: out.payment.creditedCents,
    receiptId: out.receiptId, receiptNumber: out.receiptNumber, invoice: out.invoice, alreadyRecorded: out.already,
  };
}

// ───────────────────────── customer credit ─────────────────────────

export const applyCreditSchema = z.object({
  amountCents: z.coerce.number().int().min(1, 'Enter an amount greater than zero').max(2_000_000_000),
  idempotencyKey: z.string().trim().min(8).max(80).optional(),
  note: optionalText(300),
});

/**
 * Use a customer's credit (deposit, overpayment, credit note) to pay down an invoice. The customer row is locked, the amount
 * is capped by both the credit available and the amount owing, and the ledger refuses to go below zero, so the same credit can
 * never be spent twice, even by two people clicking at once.
 */
export async function applyCredit(ctx: BusinessContext, invoiceId: string, input: unknown) {
  requirePermission(ctx, 'payment.apply_credit');
  assertCanWrite(ctx.subscription);
  const id = parseOrThrow(uuidSchema, invoiceId);
  const d = parseOrThrow(applyCreditSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const businessId = ctx.business.id;
    const scope = await visibleLocationIds(tx, ctx);
    const inv0 = await tx.invoice.findFirst({ where: { id, businessId, ...locationWhere(scope) } });
    if (!inv0) throw Errors.notFound('Invoice');
    await lockRow(tx, 'customers', businessId, inv0.customerId);
    await lockRow(tx, 'invoices', businessId, id);
    const key = d.idempotencyKey ? `apply:${id}:${d.idempotencyKey}` : null;
    if (key) {
      // A repeated request returns the first result (checked under the locks, before anything else can reject it).
      const dup = await tx.customerCreditEntry.findFirst({ where: { businessId, idempotencyKey: key } });
      if (dup) {
        const cur = await recomputeInvoice(tx, businessId, id);
        return { invoiceId: id, appliedCents: -dup.amountCents, status: cur.status, outstandingCents: cur.outstandingCents, alreadyApplied: true, creditRemainingCents: await creditBalance(tx, businessId, inv0.customerId) };
      }
    }
    const inv = await recomputeInvoice(tx, businessId, id);
    if (!inv.finalisedAt || inv.cancelledAt || inv.writtenOffAt) throw Errors.conflict('Credit can only be applied to an open, issued invoice.');
    if (inv.outstandingCents <= 0) throw Errors.conflict('This invoice is already settled.');
    if (d.amountCents > inv.outstandingCents) throw Errors.validation({ amountCents: `The invoice only has ${fmt(ctx, inv.outstandingCents)} outstanding.` });
    const available = await creditBalance(tx, businessId, inv.customerId);
    if (d.amountCents > available) throw Errors.conflict(`The customer only has ${fmt(ctx, available)} credit available.`, { availableCents: available });

    const { created } = await addCreditEntry(tx, businessId, { customerId: inv.customerId, kind: 'APPLIED', amountCents: -d.amountCents, invoiceId: id, note: d.note ?? 'Credit applied to invoice', idempotencyKey: key, createdById: ctx.user.id });
    const after = await recomputeInvoice(tx, businessId, id);
    if (created) {
      await recordFinanceEvent(tx, businessId, { entityType: 'invoice', entityId: id, type: 'invoice.credit_applied', actor: staffActor(ctx), meta: ctx.meta, detail: { amountCents: d.amountCents } });
      await recordAudit(tx, ctx.meta, { action: AuditActions.customerCreditApplied, businessId, userId: ctx.user.id, resourceType: 'invoice', resourceId: id, metadata: { amountCents: d.amountCents, customerId: inv.customerId, number: inv.number, outstandingAfterCents: after.outstandingCents } });
      await recordActivity(tx, businessId, ctx.user.id, { type: 'payment.credit_applied', summary: `${fmt(ctx, d.amountCents)} credit applied to invoice ${inv.number}`, customerId: inv.customerId, vehicleId: inv.vehicleId, jobId: inv.jobId, data: { invoiceId: id } });
    }
    return { invoiceId: id, appliedCents: d.amountCents, status: after.status, outstandingCents: after.outstandingCents, alreadyApplied: !created, creditRemainingCents: await creditBalance(tx, businessId, inv.customerId) };
  });
}

export async function getCustomerCredit(ctx: BusinessContext, customerId: string) {
  if (!can(ctx, 'payment.view') && !can(ctx, 'invoice.view')) throw Errors.forbidden();
  const id = parseOrThrow(uuidSchema, customerId);
  return withTenant(ctx.business.id, async (tx) => {
    const c = await tx.customer.findFirst({ where: { id, businessId: ctx.business.id }, select: { id: true } });
    if (!c) throw Errors.notFound('Customer');
    const balance = await creditBalance(tx, ctx.business.id, id);
    const entries = await tx.customerCreditEntry.findMany({ where: { businessId: ctx.business.id, customerId: id }, orderBy: { createdAt: 'desc' }, take: 50 });
    return { balanceCents: balance, entries: entries.map((e) => ({ id: e.id, kind: e.kind, amountCents: e.amountCents, invoiceId: e.invoiceId, paymentId: e.paymentId, creditNoteId: e.creditNoteId, jobId: e.jobId, note: e.note, at: e.createdAt })) };
  });
}

// ───────────────────────── refunds ─────────────────────────

export const refundSchema = z.object({
  amountCents: z.coerce.number().int().min(1, 'Enter an amount greater than zero').max(2_000_000_000),
  reason: z.string().trim().min(3, 'Give a reason').max(300),
  providerReference: optionalText(100),
  idempotencyKey: z.string().trim().min(8).max(80).optional(),
});

/**
 * Record a refund against a completed payment, in full or in part. The refundable amount is computed on the server from the
 * payment's own history (money already refunded is never refundable again); credit the payment created comes back first, then
 * the invoice it settled is reopened by the rest. Recording a refund does not move money by itself: it records that the
 * workshop has paid it back.
 */
export async function refundPayment(ctx: BusinessContext, paymentId: string, input: unknown) {
  requirePermission(ctx, 'payment.refund');
  assertCanWrite(ctx.subscription);
  const id = parseOrThrow(uuidSchema, paymentId);
  const d = parseOrThrow(refundSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const businessId = ctx.business.id;
    const first = await tx.payment.findFirst({ where: { id, businessId } });
    if (!first) throw Errors.notFound('Payment');
    if (first.invoiceId) {
      const scope = await visibleLocationIds(tx, ctx);
      const vis = await tx.invoice.count({ where: { id: first.invoiceId, businessId, ...locationWhere(scope) } });
      if (!vis) throw Errors.notFound('Payment');
    }
    await lockRow(tx, 'customers', businessId, first.customerId);
    if (first.invoiceId) await lockRow(tx, 'invoices', businessId, first.invoiceId);
    await lockRow(tx, 'payments', businessId, id);
    const p = await tx.payment.findFirstOrThrow({ where: { id, businessId } });

    if (d.idempotencyKey) {
      const dup = await tx.refund.findFirst({ where: { businessId, idempotencyKey: `${id}:${d.idempotencyKey}` } });
      if (dup) return { refundId: dup.id, number: dup.number, amountCents: dup.amountCents, status: p.status, alreadyRecorded: true };
    }
    if (!['COMPLETED', 'PARTIALLY_REFUNDED'].includes(p.status)) throw Errors.conflict(p.status === 'REFUNDED' ? 'This payment has already been refunded in full.' : 'Only a completed payment can be refunded.');

    const bal = await creditBalance(tx, businessId, p.customerId);
    const split = splitRefund(d.amountCents, p, bal);
    const settings = await loadFinanceSettings(tx, businessId);
    const number = await nextDocumentNumber(tx, businessId, 'refund', settings);
    const refund = await tx.refund.create({
      data: {
        businessId, number, paymentId: id, invoiceId: p.invoiceId, customerId: p.customerId, amountCents: d.amountCents, fromInvoiceCents: split.fromInvoice, fromCreditCents: split.fromCredit,
        reason: d.reason, providerReference: d.providerReference ?? null, idempotencyKey: d.idempotencyKey ? `${id}:${d.idempotencyKey}` : null, recordedById: ctx.user.id,
      },
    });
    const next = { ...p, refundedAppliedCents: p.refundedAppliedCents + split.fromInvoice, refundedCreditCents: p.refundedCreditCents + split.fromCredit };
    const status = paymentStatusAfterRefund(next);
    await tx.payment.update({ where: { id }, data: { refundedAppliedCents: next.refundedAppliedCents, refundedCreditCents: next.refundedCreditCents, status } });
    if (split.fromCredit > 0) {
      await addCreditEntry(tx, businessId, { customerId: p.customerId, kind: 'REFUND', amountCents: -split.fromCredit, paymentId: id, refundId: refund.id, invoiceId: p.invoiceId, note: `Refund ${number}: ${d.reason}`, idempotencyKey: `refund:${refund.id}`, createdById: ctx.user.id });
    }
    const inv = p.invoiceId ? await recomputeInvoice(tx, businessId, p.invoiceId) : null;
    await recordFinanceEvent(tx, businessId, { entityType: 'payment', entityId: id, type: 'payment.refunded', actor: staffActor(ctx), meta: ctx.meta, detail: { refundId: refund.id, number, amountCents: d.amountCents, fromInvoiceCents: split.fromInvoice, fromCreditCents: split.fromCredit, reason: d.reason } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.paymentRefunded, businessId, userId: ctx.user.id, resourceType: 'payment', resourceId: id, before: { status: p.status }, after: { status }, metadata: { refund: number, amountCents: d.amountCents, fromInvoiceCents: split.fromInvoice, fromCreditCents: split.fromCredit, reason: d.reason, invoiceId: p.invoiceId } });
    await recordActivity(tx, businessId, ctx.user.id, { type: 'payment.refunded', summary: `Refund of ${fmt(ctx, d.amountCents)} recorded against payment ${p.number}`, customerId: p.customerId, vehicleId: inv?.vehicleId ?? p.vehicleId, jobId: inv?.jobId ?? p.jobId, data: { paymentId: id } });
    await sendFinanceMessage(tx, businessId, {
      customerId: p.customerId, entityType: 'refund', entityId: refund.id, event: 'REFUND_PROCESSED', dedupeKey: `refund:${refund.id}`,
      vars: { refund_amount: fmt(ctx, d.amountCents), reason: d.reason },
    });
    return { refundId: refund.id, number, amountCents: d.amountCents, status, alreadyRecorded: false, invoiceStatus: inv?.status ?? null, invoiceOutstandingCents: inv?.outstandingCents ?? null };
  });
}

// ───────────────────────── reconcile ─────────────────────────

export const reconcileSchema = z.object({ reconciled: z.boolean(), note: clearable(300) });

/** Mark a payment as matched to the bank / card statement (a foundation for reconciliation, not accounting). */
export async function reconcilePayment(ctx: BusinessContext, paymentId: string, input: unknown) {
  requirePermission(ctx, 'payment.reconcile');
  assertCanWrite(ctx.subscription);
  const id = parseOrThrow(uuidSchema, paymentId);
  const d = parseOrThrow(reconcileSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const p = await tx.payment.findFirst({ where: { id, businessId: ctx.business.id } });
    if (!p) throw Errors.notFound('Payment');
    if (!['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(p.status)) throw Errors.conflict('Only a completed payment can be reconciled.');
    await tx.payment.update({ where: { id }, data: d.reconciled ? { reconciledAt: new Date(), reconciledById: ctx.user.id, reconciliationNote: d.note ?? null } : { reconciledAt: null, reconciledById: null, reconciliationNote: d.note ?? null } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.paymentReconciled, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'payment', resourceId: id, metadata: { reconciled: d.reconciled, note: d.note } });
    return { id, reconciled: d.reconciled };
  });
}

// ───────────────────────── read ─────────────────────────

export const paymentListSchema = paginationSchema.extend({
  q: z.string().trim().max(80).optional(),
  status: z.string().max(200).optional(),
  method: z.enum(['CARD', 'EFT', 'CASH', 'ONLINE', 'OTHER']).optional(),
  purpose: z.enum(['INVOICE', 'DEPOSIT']).optional(),
  provider: z.string().max(30).optional(),
  customerId: uuidSchema.optional(),
  invoiceId: uuidSchema.optional(),
  from: isoDay.optional(),
  to: isoDay.optional(),
  minCents: z.coerce.number().int().min(0).optional(),
  maxCents: z.coerce.number().int().min(0).optional(),
  reconciled: z.enum(['yes', 'no']).optional(),
  sort: z.enum(['paid_at', 'number', 'amount', 'status']).default('paid_at'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});

const PAYMENT_STATUSES = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'] as const;

export async function listPayments(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'payment.view');
  const q = parseOrThrow(paymentListSchema, query);
  return withTenant(ctx.business.id, async (tx) => {
    const businessId = ctx.business.id;
    const scope = await visibleLocationIds(tx, ctx);
    const words = (q.q ?? '').split(/\s+/).filter(Boolean).slice(0, 5);
    const statuses = (q.status ?? '').split(',').map((s) => s.trim().toUpperCase()).filter((s): s is (typeof PAYMENT_STATUSES)[number] => (PAYMENT_STATUSES as readonly string[]).includes(s));
    const and: object[] = [];
    if (scope) and.push({ OR: [{ invoiceId: null }, { invoice: locationWhere(scope) }] });
    for (const w of words) {
      const norm = w.toUpperCase().replace(/[^A-Z0-9]/g, '') || escapeLike(w);
      const like = escapeLike(w);
      and.push({
        OR: [
          { number: { contains: like, mode: 'insensitive' } }, { reference: { contains: like, mode: 'insensitive' } }, { providerReference: { contains: like, mode: 'insensitive' } },
          { customer: { OR: [{ name: { contains: like, mode: 'insensitive' } }, { mobile: { contains: like } }, { email: { contains: like, mode: 'insensitive' } }] } },
          { invoice: { OR: [{ number: { contains: like, mode: 'insensitive' } }, { vehicle: { OR: [{ registrationNorm: { contains: norm } }, { vin: { contains: norm, mode: 'insensitive' } }] } }, { job: { jobNumber: { contains: like, mode: 'insensitive' } } }] } },
        ],
      });
    }
    const where = {
      businessId,
      ...(statuses.length ? { status: { in: statuses } } : {}), ...(q.method ? { method: q.method } : {}), ...(q.purpose ? { purpose: q.purpose } : {}), ...(q.provider ? { provider: q.provider } : {}),
      ...(q.customerId ? { customerId: q.customerId } : {}), ...(q.invoiceId ? { invoiceId: q.invoiceId } : {}),
      ...(q.from || q.to ? { paidAt: { ...(q.from ? { gte: dateOnly(q.from) } : {}), ...(q.to ? { lt: new Date(dateOnly(q.to).getTime() + 86_400_000) } : {}) } } : {}),
      ...(q.minCents !== undefined || q.maxCents !== undefined ? { amountCents: { ...(q.minCents !== undefined ? { gte: q.minCents } : {}), ...(q.maxCents !== undefined ? { lte: q.maxCents } : {}) } } : {}),
      ...(q.reconciled === 'yes' ? { reconciledAt: { not: null } } : q.reconciled === 'no' ? { reconciledAt: null, status: { in: ['COMPLETED', 'PARTIALLY_REFUNDED'] as ('COMPLETED' | 'PARTIALLY_REFUNDED')[] } } : {}),
      AND: and,
    };
    const orderBy = { paid_at: { paidAt: q.dir }, number: { number: q.dir }, amount: { amountCents: q.dir }, status: { status: q.dir } }[q.sort];
    const [total, rows] = await seq([
      tx.payment.count({ where: where as never }),
      tx.payment.findMany({
        where: where as never, orderBy: [orderBy, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        include: { customer: { select: { id: true, name: true } }, invoice: { select: { id: true, number: true } }, receipt: { select: { id: true, number: true } } },
      }),
    ]);
    const names = new Map((await tx.user.findMany({ where: { id: { in: rows.map((r) => r.recordedById).filter((v): v is string => !!v) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    return {
      items: rows.map((r) => ({
        id: r.id, number: r.number, status: r.status, method: r.method, purpose: r.purpose, amountCents: r.amountCents, appliedCents: r.appliedCents, creditedCents: r.creditedCents, refundedCents: r.refundedAppliedCents + r.refundedCreditCents,
        reference: r.reference, provider: r.provider, providerReference: r.providerReference, paidAt: r.paidAt, customer: r.customer, invoice: r.invoice, receipt: r.receipt,
        recordedBy: r.recordedById ? names.get(r.recordedById) ?? null : null, reconciled: r.reconciledAt !== null, reconciledAt: r.reconciledAt,
      })),
      meta: pageMeta(q.page, q.pageSize, total),
    };
  });
}

export async function getPayment(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'payment.view');
  const paymentId = parseOrThrow(uuidSchema, id);
  return withTenant(ctx.business.id, async (tx) => {
    const businessId = ctx.business.id;
    const p = await tx.payment.findFirst({ where: { id: paymentId, businessId }, include: { refunds: { orderBy: { refundedAt: 'desc' } }, receipt: true, customer: { select: { id: true, name: true } }, invoice: { select: { id: true, number: true, totalCents: true, outstandingCents: true } } } });
    if (!p) throw Errors.notFound('Payment');
    if (p.invoiceId) {
      const scope = await visibleLocationIds(tx, ctx);
      if (!(await tx.invoice.count({ where: { id: p.invoiceId, businessId, ...locationWhere(scope) } }))) throw Errors.notFound('Payment');
    }
    const events = await tx.financeEvent.findMany({ where: { businessId, entityType: 'payment', entityId: paymentId }, orderBy: { createdAt: 'desc' }, take: 100 });
    const users = await tx.user.findMany({ where: { id: { in: [p.recordedById, p.reconciledById, ...events.map((e) => e.actorUserId)].filter((v): v is string => !!v) } }, select: { id: true, name: true } });
    const names = new Map(users.map((u) => [u.id, u.name]));
    return {
      payment: {
        id: p.id, number: p.number, status: p.status, method: p.method, purpose: p.purpose, amountCents: p.amountCents, appliedCents: p.appliedCents, creditedCents: p.creditedCents,
        refundedAppliedCents: p.refundedAppliedCents, refundedCreditCents: p.refundedCreditCents, refundableCents: ['COMPLETED', 'PARTIALLY_REFUNDED'].includes(p.status) ? p.amountCents - p.refundedAppliedCents - p.refundedCreditCents : 0,
        reference: p.reference, provider: p.provider, providerReference: p.providerReference, paidAt: p.paidAt, notes: p.notes, failureReason: p.failureReason, recordedBy: p.recordedById ? names.get(p.recordedById) ?? null : null,
        reconciled: p.reconciledAt !== null, reconciledAt: p.reconciledAt, reconciledBy: p.reconciledById ? names.get(p.reconciledById) ?? null : null, reconciliationNote: p.reconciliationNote, createdAt: p.createdAt,
      },
      customer: p.customer, invoice: p.invoice, receipt: p.receipt ? { id: p.receipt.id, number: p.receipt.number } : null,
      refunds: p.refunds.map((r) => ({ id: r.id, number: r.number, amountCents: r.amountCents, fromInvoiceCents: r.fromInvoiceCents, fromCreditCents: r.fromCreditCents, reason: r.reason, refundedAt: r.refundedAt })),
      events: events.map((e) => ({ id: e.id, type: e.type, actorKind: e.actorKind, actorName: e.actorUserId ? names.get(e.actorUserId) ?? e.actorName : e.actorName, at: e.createdAt, detail: e.detail })),
      actions: { refund: can(ctx, 'payment.refund') && ['COMPLETED', 'PARTIALLY_REFUNDED'].includes(p.status), reconcile: can(ctx, 'payment.reconcile') && ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(p.status) },
    };
  });
}

export const receiptListSchema = paginationSchema.extend({ q: z.string().trim().max(80).optional(), customerId: uuidSchema.optional(), from: isoDay.optional(), to: isoDay.optional() });

export async function listReceipts(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'payment.view');
  const q = parseOrThrow(receiptListSchema, query);
  return withTenant(ctx.business.id, async (tx) => {
    const like = q.q ? escapeLike(q.q) : null;
    const where = {
      businessId: ctx.business.id, ...(q.customerId ? { customerId: q.customerId } : {}),
      ...(q.from || q.to ? { issuedAt: { ...(q.from ? { gte: dateOnly(q.from) } : {}), ...(q.to ? { lt: new Date(dateOnly(q.to).getTime() + 86_400_000) } : {}) } } : {}),
      ...(like ? { OR: [{ number: { contains: like, mode: 'insensitive' as const } }, { payment: { number: { contains: like, mode: 'insensitive' as const } } }] } : {}),
    };
    const [total, rows] = await seq([tx.receipt.count({ where }), tx.receipt.findMany({ where, orderBy: { issuedAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { payment: { select: { number: true } } } })]);
    const customers = new Map((await tx.customer.findMany({ where: { id: { in: rows.map((r) => r.customerId) }, businessId: ctx.business.id }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
    return { items: rows.map((r) => ({ id: r.id, number: r.number, paymentNumber: r.payment.number, amountCents: r.amountCents, method: r.method, issuedAt: r.issuedAt, customer: { id: r.customerId, name: customers.get(r.customerId) ?? '' }, remainingCents: r.remainingCents })), meta: pageMeta(q.page, q.pageSize, total) };
  });
}


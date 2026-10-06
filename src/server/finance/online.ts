import { z } from 'zod';
import { Prisma, isUuid, prisma, withTenant, type Tx } from '@/server/db/client';
import { AppError, Errors } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { appUrl } from '@/lib/url';
import { parseOrThrow } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { canUseFeature } from '@/server/billing/features';
import { loadEffectiveSubscription } from '@/server/billing/subscriptions';
import { vehicleLabel } from '@/server/vehicles/service';
import { systemMeta, type RequestMeta } from '@/server/context';
import { canMovePayment } from './calc';
import { isoOf, loadFinanceSettings, lockRow, nextDocumentNumber, recordFinanceEvent } from './common';
import { createDocumentLink, withLink } from './links';
import { recomputeInvoice } from './ledger';
import { sendFinanceMessage } from './notify';
import { notifyInternal } from '@/server/notifications/internal';
import { completePaymentTx, fileReceiptPdf } from './payments';
import { getCustomerProvider, ProviderVerificationError, type VerifiedOnlinePayment } from './providers';
import { loadOnlineConfig } from './settings';
import { presentState } from './invoices';

/**
 * The customer's side of an invoice, and online payment.
 *
 *   customer opens the link -> chooses Pay online -> we create a PENDING payment and a provider checkout session ->
 *   the browser goes to the provider -> the provider calls our webhook -> we verify it (signature AND the provider's own
 *   confirmation) -> the payment completes in one transaction -> receipt, balance, audit and email follow.
 *
 * A browser coming back from the provider proves nothing and changes nothing: only a verified webhook completes a payment.
 */

export async function getPublicInvoice(token: string, meta: RequestMeta) {
  return withLink(token, 'INVOICE', async (tx, link) => {
    const businessId = link.businessId;
    let inv = await tx.invoice.findFirst({ where: { id: link.documentId, businessId }, include: { lines: { orderBy: { position: 'asc' } } } });
    if (!inv || !inv.finalisedAt || !inv.number) throw Errors.notFound('Invoice');
    if (!inv.viewedAt && !inv.cancelledAt) {
      await lockRow(tx, 'invoices', businessId, inv.id);
      await tx.invoice.update({ where: { id: inv.id }, data: { viewedAt: new Date() } });
      await recomputeInvoice(tx, businessId, inv.id);
      await recordFinanceEvent(tx, businessId, { entityType: 'invoice', entityId: inv.id, type: 'invoice.viewed', actor: { kind: 'CUSTOMER', name: 'Customer' }, meta });
      await recordAudit(tx, meta, { action: AuditActions.invoiceViewed, businessId, userId: null, resourceType: 'invoice', resourceId: inv.id, metadata: {} });
      inv = await tx.invoice.findFirstOrThrow({ where: { id: inv.id, businessId }, include: { lines: { orderBy: { position: 'asc' } } } });
    }
    const business = await tx.business.findUniqueOrThrow({ where: { id: businessId } });
    const state = presentState(inv, business.timezone);
    const customer = inv.customerSnapshot as { name: string } | null;
    const vehicle = inv.vehicleId ? await tx.vehicle.findFirst({ where: { id: inv.vehicleId, businessId } }) : null;
    const job = inv.jobId ? await tx.jobCard.findFirst({ where: { id: inv.jobId, businessId }, select: { jobNumber: true } }) : null;
    const quote = inv.quoteId ? await tx.quote.findFirst({ where: { id: inv.quoteId, businessId }, select: { number: true } }) : null;
    const settings = await loadFinanceSettings(tx, businessId);
    const payments = await tx.payment.findMany({ where: { businessId, invoiceId: inv.id, status: { in: ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'] } }, orderBy: { paidAt: 'asc' }, select: { paidAt: true, amountCents: true, method: true, appliedCents: true } });
    const sub = await loadEffectiveSubscription(tx, businessId);
    const config = canUseFeature(sub, 'online_payments') ? await loadOnlineConfig(tx, businessId) : null;
    const payable = state.outstandingCents > 0 && !inv.cancelledAt && !inv.writtenOffAt;
    const snap = (inv.businessSnapshot ?? {}) as { name?: string; tradingName?: string | null; legalName?: string | null; phone?: string | null; email?: string | null; address?: string | null; vatNumber?: string | null; registrationNumber?: string | null; paymentInstructions?: string | null };
    return {
      business: {
        name: snap.tradingName ?? snap.name ?? business.name, legalName: snap.legalName ?? null, phone: snap.phone ?? business.phone, email: snap.email ?? business.email, address: snap.address ?? null,
        vatNumber: snap.vatNumber ?? null, registrationNumber: snap.registrationNumber ?? null, hasLogo: !!business.logoFileId, currency: business.currency, locale: business.locale, timezone: business.timezone,
      },
      invoice: {
        number: inv.number, status: state.status, paymentStatus: state.paymentStatus, invoiceDate: isoOf(inv.invoiceDate), dueDate: isoOf(inv.dueDate), paymentTermsDays: inv.paymentTermsDays,
        title: inv.title, customerNotes: inv.customerNotes, terms: inv.terms, taxInvoice: inv.vatRegistered && !!snap.vatNumber,
      },
      customer: { name: customer?.name ?? '' },
      vehicle: vehicle ? { label: vehicleLabel(vehicle), registration: vehicle.registration } : null,
      jobNumber: job?.jobNumber ?? null, quoteNumber: quote?.number ?? null,
      lines: inv.lines.map((l) => ({ lineType: l.lineType, description: l.description, sku: l.sku, unit: l.unit, quantityMilli: l.quantityMilli, unitPriceCents: l.unitPriceCents, discountCents: l.discountCents, vatCents: l.vatCents, totalCents: l.totalCents })),
      totals: {
        subtotalCents: inv.subtotalCents, discountCents: inv.discountCents, taxableCents: inv.taxableCents, vatCents: inv.vatCents, totalCents: inv.totalCents, vatRegistered: inv.vatRegistered, vatRateBps: inv.vatRateBps,
        paidCents: inv.paidCents, creditCents: inv.creditAppliedCents + inv.creditNotedCents, writtenOffCents: inv.writtenOffCents, outstandingCents: state.outstandingCents,
      },
      payments: payments.map((p) => ({ at: p.paidAt, amountCents: p.appliedCents, method: p.method })),
      payment: {
        instructions: payable ? snap.paymentInstructions ?? settings.paymentInstructions : null,
        online: payable && !!config ? { provider: getCustomerProvider(config.provider)?.label ?? config.provider } : null,
      },
    };
  });
}

export const startOnlineSchema = z.object({ amountCents: z.coerce.number().int().min(1).max(2_000_000_000).optional() });

/** Create a pending payment and the provider's checkout session for a customer who clicked "Pay online". */
export async function startOnlinePayment(token: string, input: unknown, meta: RequestMeta) {
  const d = parseOrThrow(startOnlineSchema, input ?? {});
  return withLink(token, 'INVOICE', async (tx, link) => {
    const businessId = link.businessId;
    const first = await tx.invoice.findFirst({ where: { id: link.documentId, businessId } });
    if (!first || !first.finalisedAt) throw Errors.notFound('Invoice');
    await lockRow(tx, 'invoices', businessId, first.id);
    const inv = await recomputeInvoice(tx, businessId, first.id);
    if (inv.cancelledAt) throw Errors.conflict('This invoice has been cancelled.');
    if (inv.writtenOffAt || inv.outstandingCents <= 0) throw Errors.conflict('This invoice is already paid.', { code: 'INVOICE_ALREADY_PAID' });
    const sub = await loadEffectiveSubscription(tx, businessId);
    const cfg = canUseFeature(sub, 'online_payments') ? await loadOnlineConfig(tx, businessId) : null;
    const provider = cfg ? getCustomerProvider(cfg.provider) : null;
    if (!cfg || !provider) throw new AppError('CONFLICT', 409, 'Online payment is not available for this invoice. Please use the payment instructions instead.', { code: 'ONLINE_NOT_AVAILABLE' });

    const amount = d.amountCents ?? inv.outstandingCents;
    if (amount > inv.outstandingCents) throw Errors.validation({ amountCents: 'That is more than the amount outstanding.' });

    // A repeated click within two minutes for the same amount reuses the pending payment instead of creating another.
    const recent = await tx.payment.findFirst({ where: { businessId, invoiceId: inv.id, method: 'ONLINE', status: 'PENDING', amountCents: amount, createdAt: { gt: new Date(Date.now() - 120_000) } }, orderBy: { createdAt: 'desc' } });
    const customer = await tx.customer.findFirstOrThrow({ where: { id: inv.customerId, businessId } });
    let payment = recent;
    if (!payment) {
      const settings = await loadFinanceSettings(tx, businessId);
      const number = await nextDocumentNumber(tx, businessId, 'payment', settings, inv.locationId);
      payment = await tx.payment.create({
        data: { businessId, number, invoiceId: inv.id, customerId: inv.customerId, vehicleId: inv.vehicleId, jobId: inv.jobId, quoteId: inv.quoteId, purpose: 'INVOICE', method: 'ONLINE', status: 'PENDING', amountCents: amount, provider: provider.key },
      });
      await recordFinanceEvent(tx, businessId, { entityType: 'payment', entityId: payment.id, type: 'payment.online_started', actor: { kind: 'CUSTOMER', name: customer.name }, meta, detail: { amountCents: amount, provider: provider.key } });
      await recordAudit(tx, meta, { action: AuditActions.paymentOnlineStarted, businessId, userId: null, resourceType: 'payment', resourceId: payment.id, metadata: { number, invoiceId: inv.id, amountCents: amount, provider: provider.key } });
    }
    const base = appUrl('/pay/return');
    const session = provider.createSession({
      paymentId: payment.id, description: `Invoice ${inv.number}`, amountCents: amount, payer: { name: customer.name, email: customer.email },
      returnUrl: `${base}?b=${businessId}&ref=${payment.id}`, cancelUrl: `${base}?b=${businessId}&ref=${payment.id}&cancelled=1`, notifyUrl: appUrl(`/api/webhooks/payments/${provider.key}/${businessId}`),
      sandbox: cfg.sandbox, credentials: cfg.credentials,
    });
    return { paymentId: payment.id, session };
  });
}

/** What the "back from the provider" page may say. Reads state only; it never changes anything. */
export async function getPublicPaymentStatus(businessId: string, ref: string) {
  if (!isUuid(businessId) || !isUuid(ref)) throw Errors.notFound('Payment');
  return withTenant(businessId, async (tx) => {
    const p = await tx.payment.findFirst({ where: { id: ref, businessId, method: 'ONLINE' }, include: { invoice: { select: { number: true } } } });
    if (!p) throw Errors.notFound('Payment');
    const business = await tx.business.findUniqueOrThrow({ where: { id: businessId }, select: { name: true, tradingName: true, currency: true, locale: true, phone: true, email: true } });
    return {
      business: { name: business.tradingName ?? business.name, phone: business.phone, email: business.email, currency: business.currency, locale: business.locale },
      status: ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(p.status) ? 'COMPLETED' : p.status, amountCents: p.amountCents, invoiceNumber: p.invoice?.number ?? null,
    };
  });
}

// ───────────────────────── provider webhook ─────────────────────────

export type OnlineWebhookOutcome = { result: 'processed' } | { result: 'duplicate' } | { result: 'ignored'; reason: string } | { result: 'rejected' };

/**
 * Handle one inbound webhook from a business's payment provider, safely and idempotently:
 *  1. verify authenticity with that business's own credentials (signature + the provider's own confirmation);
 *  2. store the event under (provider, business, external id): a redelivery finds the same row;
 *  3. process inside one transaction holding a lock on the event row, so two simultaneous deliveries cannot both apply it;
 *  4. a failure rolls back and marks the event FAILED so the provider's retry is processed again.
 * Payment state changes only here, from verified provider data matched to a payment WE created, with an exact amount match.
 */
export async function handleOnlineWebhook(providerKey: string, businessId: string, rawBody: string, ctx: { ip?: string } = {}): Promise<OnlineWebhookOutcome> {
  if (!isUuid(businessId)) return { result: 'rejected' };
  const provider = getCustomerProvider(providerKey);
  if (!provider) return { result: 'rejected' };
  // The business id is in the URL, so it is untrusted: an unknown or closed business is simply rejected.
  const biz = await prisma().business.findUnique({ where: { id: businessId }, select: { status: true } });
  if (!biz || biz.status !== 'ACTIVE') return { result: 'rejected' };
  const cfg = await withTenant(businessId, (tx) => loadOnlineConfig(tx, businessId));
  if (!cfg || cfg.provider !== providerKey) return { result: 'rejected' };

  let event: VerifiedOnlinePayment;
  try {
    event = await provider.verifyWebhook(rawBody, { credentials: cfg.credentials, sandbox: cfg.sandbox, ip: ctx.ip });
  } catch (err) {
    if (err instanceof ProviderVerificationError) {
      logger.warn({ provider: providerKey, businessId, reason: err.message, ip: ctx.ip }, 'customer payment webhook rejected');
      return { result: 'rejected' };
    }
    throw err;
  }

  const store = { provider: `customer:${providerKey}`, externalId: `${businessId}:${event.externalId}` };
  await prisma().webhookEvent.createMany({ data: [{ ...store, eventType: event.eventType, payload: event.payload as Prisma.InputJsonValue, signatureValid: true }], skipDuplicates: true });

  let receiptToFile: string | null = null;
  try {
    const outcome = await withTenant(businessId, async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; status: string }[]>`SELECT id, status FROM webhook_events WHERE provider = ${store.provider} AND external_id = ${store.externalId} FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new Error('webhook event vanished');
      if (row.status === 'PROCESSED' || row.status === 'IGNORED') return { result: 'duplicate' } as OnlineWebhookOutcome;
      const r = await applyOnlineEvent(tx, businessId, providerKey, event);
      receiptToFile = r.receiptId ?? null;
      await tx.webhookEvent.update({ where: { id: row.id }, data: { status: r.outcome.result === 'processed' ? 'PROCESSED' : 'IGNORED', error: r.outcome.result === 'ignored' ? r.outcome.reason : null, processedAt: new Date() } });
      return r.outcome;
    });
    if (receiptToFile) await fileReceiptPdf(businessId, null, receiptToFile);
    return outcome;
  } catch (err) {
    await prisma().webhookEvent.update({ where: { provider_externalId: store }, data: { status: 'FAILED', error: String(err instanceof Error ? err.message : err).slice(0, 500) } }).catch(() => {});
    throw err; // the route answers 5xx so the provider retries
  }
}

async function applyOnlineEvent(tx: Tx, businessId: string, providerKey: string, e: VerifiedOnlinePayment): Promise<{ outcome: OnlineWebhookOutcome; receiptId?: string }> {
  const meta = systemMeta(`webhook:${providerKey}`);
  if (!isUuid(e.paymentId)) return { outcome: { result: 'ignored', reason: 'unknown payment reference' } };
  const payment = await tx.payment.findFirst({ where: { id: e.paymentId, businessId, method: 'ONLINE', provider: providerKey } });
  if (!payment) return { outcome: { result: 'ignored', reason: 'unknown payment reference' } };
  if (e.amountCents !== payment.amountCents) {
    logger.error({ paymentId: payment.id, expected: payment.amountCents, got: e.amountCents }, 'customer payment webhook amount mismatch');
    return { outcome: { result: 'ignored', reason: 'amount mismatch' } };
  }
  const business = await tx.business.findUniqueOrThrow({ where: { id: businessId }, select: { name: true, tradingName: true, currency: true, locale: true } });
  const actor = { kind: 'SYSTEM' as const, name: `${providerKey} webhook` };

  if (e.status === 'COMPLETE') {
    const clash = await tx.payment.findFirst({ where: { businessId, provider: providerKey, providerReference: e.providerReference, id: { not: payment.id } }, select: { id: true } });
    if (clash) return { outcome: { result: 'ignored', reason: 'provider reference already used by another payment' } };
    if (!payment.providerReference) await tx.payment.update({ where: { id: payment.id }, data: { providerReference: e.providerReference } });
    const s = await completePaymentTx(tx, businessId, payment.id, { actor, actorUserId: null, meta, currency: business.currency, locale: business.locale, businessName: business.tradingName ?? business.name, fromProvider: true });
    return { outcome: s.already ? { result: 'duplicate' } : { result: 'processed' }, receiptId: s.already ? undefined : (s.receiptId ?? undefined) };
  }

  if (e.status === 'PENDING') {
    if (payment.status === 'PENDING') await tx.payment.update({ where: { id: payment.id }, data: { status: 'PROCESSING', providerReference: payment.providerReference ?? e.providerReference } });
    return { outcome: { result: 'processed' } };
  }

  // FAILED or CANCELLED
  const to = e.status === 'FAILED' ? 'FAILED' : 'CANCELLED';
  if (!canMovePayment(payment.status, to) || ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'FAILED', 'CANCELLED'].includes(payment.status)) return { outcome: { result: 'ignored', reason: `payment is already ${payment.status.toLowerCase()}` } };
  await lockRow(tx, 'payments', businessId, payment.id);
  await tx.payment.update({ where: { id: payment.id }, data: { status: to, failureReason: `Provider reported ${e.status.toLowerCase()}`, providerReference: payment.providerReference ?? e.providerReference } });
  await recordFinanceEvent(tx, businessId, { entityType: 'payment', entityId: payment.id, type: `payment.${to.toLowerCase()}`, actor, meta, detail: { provider: providerKey } });
  await recordAudit(tx, meta, { action: to === 'FAILED' ? AuditActions.paymentFailed2 : AuditActions.paymentCancelled, businessId, userId: null, resourceType: 'payment', resourceId: payment.id, metadata: { provider: providerKey, invoiceId: payment.invoiceId, amountCents: payment.amountCents } });
  if (payment.invoiceId) {
    const inv = await tx.invoice.findFirst({ where: { id: payment.invoiceId, businessId }, select: { number: true } });
    const link = await createDocumentLink(tx, businessId, 'INVOICE', payment.invoiceId, null);
    await sendFinanceMessage(tx, businessId, {
      customerId: payment.customerId, entityType: 'payment', entityId: payment.id, event: 'PAYMENT_FAILED', dedupeKey: `payment:${payment.id}:failed`, link: link.url,
      vars: { invoice_number: inv?.number ?? '' },
    });
    await notifyInternal(tx, businessId, 'PAYMENT_FAILED', { title: `A customer payment for invoice ${inv?.number ?? ''} did not go through`, linkUrl: `/invoices/${payment.invoiceId}`, entity: { type: 'invoice', id: payment.invoiceId } });
  }
  return { outcome: { result: 'processed' } };
}


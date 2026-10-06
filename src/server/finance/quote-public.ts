import { z } from 'zod';
import { Errors } from '@/lib/errors';
import { appUrl } from '@/lib/url';
import { todayIso } from '@/lib/tz';
import { parseOrThrow } from '@/lib/validation';
import type { Tx } from '@/server/db/client';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { recordActivity } from '@/server/activity/service';
import { sha256Hex } from '@/server/security/crypto';
import { queueEmail } from '@/server/notifications/service';
import { templates } from '@/server/notifications/templates';
import { vehicleLabel } from '@/server/vehicles/service';
import type { RequestMeta } from '@/server/context';
import { isoOf, lockRow, recordFinanceEvent } from './common';
import { withLink, type LinkRow } from './links';
import { notifyStaff, sendFinanceMessage, usersWithPermission } from './notify';
import { finaliseApproval } from './quotes';

/**
 * The customer's side of a quote: open the link, read it, approve / decline / ask for changes. No sign-in. Everything the
 * customer sees is built by whitelisting fields (internal notes, costs and margins are never selected), and every decision is
 * recorded with who, when, which version, what they accepted, and the IP and device it came from.
 */

export const publicDecisionSchema = z.object({
  action: z.enum(['approve', 'decline', 'request_changes']),
  /** The version on screen. Approving a version that has since been revised is refused. */
  version: z.coerce.number().int().min(1),
  /** Typed name = electronic confirmation. */
  name: z.string().trim().min(2, 'Type your full name').max(120).optional(),
  acceptTerms: z.boolean().optional(),
  comment: z.string().trim().max(1000).optional(),
});

async function loadForLink(tx: Tx, link: LinkRow) {
  const quote = await tx.quote.findFirst({ where: { id: link.documentId, businessId: link.businessId } });
  if (!quote) throw Errors.notFound('Quote');
  const version = await tx.quoteVersion.findFirstOrThrow({ where: { quoteId: quote.id, businessId: link.businessId, version: quote.currentVersion }, include: { lines: { orderBy: { position: 'asc' } } } });
  const business = await tx.business.findUniqueOrThrow({ where: { id: link.businessId } });
  const customer = await tx.customer.findFirstOrThrow({ where: { id: quote.customerId, businessId: link.businessId } });
  const vehicle = quote.vehicleId ? await tx.vehicle.findFirst({ where: { id: quote.vehicleId, businessId: link.businessId } }) : null;
  const job = quote.jobId ? await tx.jobCard.findFirst({ where: { id: quote.jobId, businessId: link.businessId }, select: { jobNumber: true } }) : null;
  return { quote, version, business, customer, vehicle, job };
}

const isExpired = (validUntil: Date | null, tz: string) => !!validUntil && isoOf(validUntil)! < todayIso(tz);

export async function getPublicQuote(token: string, meta: RequestMeta) {
  return withLink(token, 'QUOTE', async (tx, link) => {
    const { quote, version, business, customer, vehicle, job } = await loadForLink(tx, link);
    if (quote.status === 'CANCELLED') throw Errors.notFound('Quote');
    // First time the customer opens the current version: Sent -> Viewed, recorded once.
    if (quote.status === 'SENT') {
      await lockRow(tx, 'quotes', link.businessId, quote.id);
      const fresh = await tx.quote.findFirstOrThrow({ where: { id: quote.id } });
      if (fresh.status === 'SENT') {
        await tx.quote.update({ where: { id: quote.id }, data: { status: 'VIEWED' } });
        await recordFinanceEvent(tx, link.businessId, { entityType: 'quote', entityId: quote.id, version: version.version, type: 'quote.viewed', actor: { kind: 'CUSTOMER', name: customer.name }, meta });
        await recordAudit(tx, meta, { action: AuditActions.quoteViewed, businessId: link.businessId, userId: null, resourceType: 'quote', resourceId: quote.id, metadata: { version: version.version } });
        quote.status = 'VIEWED';
      }
    }
    const decided = await tx.financeEvent.findFirst({ where: { businessId: link.businessId, entityType: 'quote', entityId: quote.id, version: version.version, type: { in: ['quote.approved', 'quote.declined'] } } });
    const expired = quote.status === 'EXPIRED' || (['SENT', 'VIEWED'].includes(quote.status) && isExpired(version.validUntil, business.timezone));
    return {
      business: {
        name: business.tradingName ?? business.name, legalName: business.legalName, phone: business.phone, email: business.email, vatNumber: business.vatRegistered ? business.vatNumber : null,
        address: [business.addressLine1, business.addressLine2, business.city, business.province, business.postalCode].filter(Boolean).join(', ') || null, hasLogo: !!business.logoFileId,
        currency: business.currency, locale: business.locale, timezone: business.timezone,
      },
      quote: {
        number: quote.number, status: expired && ['SENT', 'VIEWED'].includes(quote.status) ? 'EXPIRED' : quote.status, version: version.version, quoteDate: isoOf(version.quoteDate), validUntil: isoOf(version.validUntil),
        title: version.title, description: version.description, customerNotes: version.customerNotes, terms: version.terms, changeNote: version.changeNote, changesRequested: !!quote.changesRequestedAt,
      },
      customer: { name: customer.name },
      vehicle: vehicle ? { label: vehicleLabel(vehicle), registration: vehicle.registration } : null,
      jobNumber: job?.jobNumber ?? null,
      lines: version.lines.map((l) => ({
        lineType: l.lineType, description: l.description, sku: l.sku, unit: l.unit, quantityMilli: l.quantityMilli, unitPriceCents: l.unitPriceCents,
        discountCents: l.discountCents, vatCents: l.vatCents, taxableCents: l.taxableCents, totalCents: l.totalCents,
      })),
      totals: { subtotalCents: version.subtotalCents, discountCents: version.discountCents, taxableCents: version.taxableCents, vatCents: version.vatCents, totalCents: version.totalCents, vatRegistered: version.vatRegistered, vatRateBps: version.vatRateBps, pricesIncludeVat: version.pricesIncludeVat },
      canDecide: ['SENT', 'VIEWED'].includes(quote.status) && !expired && !decided,
      decision: decided ? { type: decided.type === 'quote.approved' ? 'APPROVED' : 'DECLINED', at: decided.createdAt, by: decided.actorName } : null,
    };
  });
}

type Decision = 'approved' | 'declined' | 'changes requested';

export async function decideQuotePublic(token: string, input: unknown, meta: RequestMeta) {
  const d = parseOrThrow(publicDecisionSchema, input);
  if (d.action === 'approve') {
    if (!d.acceptTerms) throw Errors.validation({ acceptTerms: 'Please confirm that you accept the quote and its terms.' });
    if (!d.name) throw Errors.validation({ name: 'Type your full name to confirm.' });
  }
  if (d.action === 'decline' && !d.name) throw Errors.validation({ name: 'Type your name.' });
  if (d.action === 'request_changes' && !d.comment) throw Errors.validation({ comment: 'Tell the workshop what you would like changed.' });

  return withLink(token, 'QUOTE', async (tx, link) => {
    const businessId = link.businessId;
    await lockRow(tx, 'quotes', businessId, link.documentId);
    const { quote, version, business, customer } = await loadForLink(tx, link);
    if (quote.status === 'CANCELLED') throw Errors.notFound('Quote');
    if (quote.currentVersion !== d.version) {
      throw Errors.conflict('This quote has been updated since you opened it. Please open the latest version from the newest email.', { code: 'QUOTE_VERSION_OUTDATED', currentVersion: quote.currentVersion });
    }
    const sameVersionDecision = await tx.financeEvent.findFirst({ where: { businessId, entityType: 'quote', entityId: quote.id, version: version.version, type: { in: ['quote.approved', 'quote.declined'] } } });
    // Idempotent: repeating the same decision returns the first one; nothing is written twice.
    if (sameVersionDecision) {
      const was = sameVersionDecision.type === 'quote.approved' ? 'approve' : 'decline';
      if (d.action === was) return { status: quote.status === 'DECLINED' ? 'DECLINED' : 'APPROVED', alreadyDecided: true };
      if (d.action !== 'request_changes') throw Errors.conflict(`You already ${was === 'approve' ? 'approved' : 'declined'} this quote. Contact ${business.name} if you changed your mind.`);
    }
    if (quote.status === 'EXPIRED' || isExpired(version.validUntil, business.timezone)) throw Errors.conflict('This quote has expired. Please contact the workshop for a new one.', { code: 'QUOTE_EXPIRED' });
    if (!['SENT', 'VIEWED'].includes(quote.status)) throw Errors.conflict('This quote can no longer be answered.');

    const actor = { kind: 'CUSTOMER' as const, name: d.name ?? customer.name };
    let decision: Decision;
    if (d.action === 'approve') {
      decision = 'approved';
      await finaliseApproval(tx, {
        businessId, quote, version, lines: version.lines, method: 'ELECTRONIC', actor, actorUserId: null, meta,
        detail: { signerName: d.name, acceptedTerms: true, termsSha256: sha256Hex(version.terms ?? ''), comment: d.comment ?? null },
      });
    } else if (d.action === 'decline') {
      decision = 'declined';
      const now = new Date();
      await recordFinanceEvent(tx, businessId, { entityType: 'quote', entityId: quote.id, version: version.version, type: 'quote.declined', actor, meta, detail: { comment: d.comment ?? null } });
      await tx.quote.update({ where: { id: quote.id }, data: { status: 'DECLINED', declinedAt: now } });
      const refs = version.lines.map((l) => l.recommendedWorkId).filter((v): v is string => !!v);
      if (quote.jobId && refs.length) {
        await tx.recommendedWork.updateMany({
          where: { businessId, jobId: quote.jobId, id: { in: refs }, approvalStatus: 'PENDING', completedAt: null },
          data: { approvalStatus: 'DECLINED', approvalMethod: 'ELECTRONIC', decidedAt: now, decisionNote: `Quote ${quote.number} declined by customer` },
        });
      }
      await recordAudit(tx, meta, { action: AuditActions.quoteDeclined, businessId, userId: null, resourceType: 'quote', resourceId: quote.id, metadata: { version: version.version, comment: d.comment ?? null } });
      await recordActivity(tx, businessId, null, { type: 'quote.declined', summary: `Quote ${quote.number} declined by the customer`, customerId: quote.customerId, vehicleId: quote.vehicleId, jobId: quote.jobId, data: { quoteId: quote.id } });
    } else {
      decision = 'changes requested';
      await recordFinanceEvent(tx, businessId, { entityType: 'quote', entityId: quote.id, version: version.version, type: 'quote.changes_requested', actor, meta, detail: { comment: d.comment } });
      await tx.quote.update({ where: { id: quote.id }, data: { changesRequestedAt: new Date() } });
      await recordAudit(tx, meta, { action: AuditActions.quoteChangesRequested, businessId, userId: null, resourceType: 'quote', resourceId: quote.id, metadata: { version: version.version, comment: d.comment } });
      await recordActivity(tx, businessId, null, { type: 'quote.changes_requested', summary: `Customer asked for changes to quote ${quote.number}`, customerId: quote.customerId, vehicleId: quote.vehicleId, jobId: quote.jobId, data: { quoteId: quote.id } });
    }

    // Tell the workshop (in-app for everyone who handles quotes, email to whoever made it) and confirm to the customer.
    const staff = await usersWithPermission(tx, businessId, 'quote.approve');
    const creator = quote.createdById ? await tx.user.findUnique({ where: { id: quote.createdById }, select: { id: true, email: true, name: true } }) : null;
    const url = appUrl(`/quotes/${quote.id}`);
    await notifyStaff(tx, businessId, [...staff.map((s) => s.id), ...(creator ? [creator.id] : [])], {
      type: d.action === 'approve' ? 'QUOTE_APPROVED' : d.action === 'decline' ? 'QUOTE_DECLINED' : 'QUOTE_CHANGES_REQUESTED', priority: d.action === 'approve' ? 'HIGH' : 'NORMAL', entity: { type: 'quote', id: quote.id }, title: `Quote ${quote.number} ${decision} by ${customer.name}`, body: d.comment, linkUrl: `/quotes/${quote.id}`,
    });
    if (creator?.email) {
      await queueEmail(tx, templates.staffQuoteDecision(creator.email, creator.name, business.name, { number: quote.number, customer: customer.name, decision, comment: d.comment, url }), {
        dedupeKey: `quote-decision:${quote.id}:v${version.version}:${d.action}:${sha256Hex(d.comment ?? '').slice(0, 8)}`, businessId,
      });
    }
    await sendFinanceMessage(tx, businessId, {
      customerId: quote.customerId, entityType: 'quote', entityId: quote.id, event: 'QUOTE_DECISION', vehicleId: quote.vehicleId, locationId: quote.locationId,
      dedupeKey: `quote:${quote.id}:v${version.version}:${d.action}:${sha256Hex(d.comment ?? '').slice(0, 8)}`,
      vars: { quote_number: quote.number, decision },
    });
    return { status: d.action === 'approve' ? 'APPROVED' : d.action === 'decline' ? 'DECLINED' : quote.status, alreadyDecided: false };
  });
}

import type { Tx } from '@/server/db/client';
import { sendCustomerMessage } from '@/server/notifications/comms';
import type { EventKey } from '@/server/notifications/events';
import { NotificationTypes } from '@/server/notifications/events';
import { notifyInApp } from '@/server/notifications/service';

/**
 * Money messages to a workshop's customers. They are TRANSACTIONAL (an invoice, a receipt, a reminder), never marketing, so the
 * customer's marketing consent is irrelevant. This is a thin adapter: the work (channels, preferences, templates, the queue, the
 * history, retries) is done by the shared communication service in notifications/comms.ts, which every module uses.
 *
 * Result:
 *  - 'queued'    at least one channel was queued;
 *  - 'duplicate' this exact message (same dedupe key) was already attempted: nothing is sent twice;
 *  - 'skipped'   nothing was sent, and why is recorded in the communication history (no address, customer preference, ...).
 */
export interface FinanceMessage {
  customerId: string;
  entityType: 'quote' | 'invoice' | 'payment' | 'credit_note' | 'refund';
  entityId: string;
  event: EventKey;
  vars: Record<string, string | undefined>;
  /** The private link to the customer-facing page for this record. */
  link?: string;
  vehicleId?: string | null;
  locationId?: string | null;
  attachmentFileIds?: string[];
  /** Same key = same message: it is sent at most once. */
  dedupeKey: string;
}

export async function sendFinanceMessage(tx: Tx, businessId: string, m: FinanceMessage): Promise<'queued' | 'skipped' | 'duplicate'> {
  const out = await sendCustomerMessage(tx, businessId, {
    event: m.event, customerId: m.customerId, entity: { type: m.entityType, id: m.entityId }, vars: m.vars, link: m.link ? { url: m.link } : undefined, vehicleId: m.vehicleId ?? undefined,
    locationId: m.locationId ?? null, attachmentFileIds: m.attachmentFileIds, dedupeKey: m.dedupeKey,
  });
  if (out.some((o) => o.status === 'queued')) return 'queued';
  if (out.every((o) => o.status === 'duplicate')) return 'duplicate';
  return 'skipped';
}

/** In-app note (bell) for the workshop's people who should hear about a customer's decision or a payment. */
export async function notifyStaff(tx: Tx, businessId: string, userIds: string[], n: { type: string; title: string; body?: string; linkUrl?: string; priority?: 'LOW' | 'NORMAL' | 'HIGH'; entity?: { type: string; id: string } }): Promise<void> {
  for (const userId of [...new Set(userIds)]) {
    await notifyInApp(tx, { businessId, userId, type: n.type, title: n.title, body: n.body, linkUrl: n.linkUrl, priority: n.priority, entityType: n.entity?.type, entityId: n.entity?.id });
  }
}

/** Active members holding a permission (their users), for "tell whoever handles this". */
export async function usersWithPermission(tx: Tx, businessId: string, permission: string): Promise<{ id: string; email: string; name: string }[]> {
  const rows = await tx.membership.findMany({
    where: { businessId, status: 'ACTIVE', user: { status: 'ACTIVE' }, role: { permissions: { some: { permission } } } },
    select: { user: { select: { id: true, email: true, name: true } } },
  });
  return rows.flatMap((r) => (r.user ? [r.user] : []));
}

export { NotificationTypes };

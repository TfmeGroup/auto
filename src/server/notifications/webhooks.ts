import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { appUrl } from '@/lib/url';
import { withTenant, withTx } from '@/server/db/client';
import { parseTwilioStatus, verifyTwilioSignature } from './providers/twilio';
import type { DeliveryReport } from './providers/types';

/**
 * Delivery reports from the messaging provider. The callback is accepted only if its signature verifies against the provider's
 * secret; the message is found by the provider's own reference; and the state only ever moves forward (the database refuses to move a
 * sent message backwards). A provider that only says "submitted" never produces "delivered".
 */
export async function applyDeliveryReport(r: DeliveryReport): Promise<'applied' | 'unknown' | 'ignored'> {
  // The reference identifies one provider message. The lookup runs under a narrow row-level-security rule that lets this request see
  // only the row carrying that reference (migration 0010), because no business is known yet.
  const row = await withTx(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.provider_ref', ${r.providerRef}, true)`;
    return tx.communication.findFirst({ where: { providerRef: r.providerRef }, select: { id: true, businessId: true, status: true } });
  });
  if (!row) return 'unknown';
  const rank: Record<string, number> = { QUEUED: 0, PROCESSING: 1, SENT: 2, DELIVERED: 3, VIEWED: 4 };
  const now = new Date();
  const data =
    r.state === 'delivered' && (rank[row.status] ?? 9) < 3 ? { status: 'DELIVERED' as const, deliveredAt: now }
    : r.state === 'viewed' && (rank[row.status] ?? 9) < 4 ? { status: 'VIEWED' as const, viewedAt: now, deliveredAt: now }
    : r.state === 'failed' && ['SENT', 'PROCESSING', 'QUEUED'].includes(row.status) ? { status: 'FAILED' as const, failedAt: now, statusDetail: (r.reason ?? 'The message could not be delivered.').slice(0, 200) }
    : null;
  if (!data) return 'ignored';
  await withTenant(row.businessId, (tx) => tx.communication.update({ where: { id: row.id }, data })).catch((e) => logger.warn({ err: String(e) }, 'delivery report could not be applied'));
  return 'applied';
}

/** Verify and apply a Twilio status callback. Returns false if the signature is wrong (the route answers 403). */
export async function handleTwilioCallback(params: Record<string, string>, signature: string | null): Promise<boolean> {
  const token = env().TWILIO_AUTH_TOKEN;
  if (!token || !signature) return false;
  if (!verifyTwilioSignature(token, appUrl('/api/public/webhooks/twilio'), params, signature)) return false;
  const report = parseTwilioStatus(params);
  if (report) await applyDeliveryReport(report);
  return true;
}

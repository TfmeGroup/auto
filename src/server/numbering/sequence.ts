import type { Tx } from '@/server/db/client';

/**
 * Next human-readable number for a document kind, e.g. CUS-000001 or JOB-0001045.
 *
 * One atomic upsert: concurrent callers serialise on the row lock, so two
 * requests can never receive the same number. Because it runs inside the
 * caller's transaction, a rollback also rolls the counter back (no gaps from
 * failed creates). Must be called within withTenant() (RLS scopes the table).
 *
 * The prefix is taken from the caller on every call, so the numbering format can
 * later become a business setting without a data migration (numbers already issued
 * are never rewritten; the counter simply continues).
 */
export async function nextNumber(tx: Tx, businessId: string, kind: string, prefix: string, pad = 4): Promise<string> {
  const rows = await tx.$queryRaw<{ n: number; prefix: string }[]>`
    INSERT INTO number_sequences (business_id, kind, prefix, next_value, updated_at)
    VALUES (${businessId}::uuid, ${kind}, ${prefix}, 2, now())
    ON CONFLICT (business_id, kind) DO UPDATE
      SET next_value = number_sequences.next_value + 1, prefix = EXCLUDED.prefix, updated_at = now()
    RETURNING next_value - 1 AS n, prefix`;
  const row = rows[0];
  if (!row) throw new Error('number sequence allocation failed');
  return `${row.prefix}-${String(row.n).padStart(pad, '0')}`;
}

/**
 * The number formats of the workshop records. The prefix and length are the business's setting (Settings, Numbering); a business that never
 * changed them gets CUS-000001 / BKG-000001 / JOB-0000001. The counter belongs to the kind, not the prefix, so changing a prefix never reuses a number.
 */
async function format(tx: Tx, businessId: string) {
  return tx.businessConfig.findUnique({ where: { businessId }, select: { customerPrefix: true, bookingPrefix: true, jobPrefix: true, customerPadding: true, bookingPadding: true, jobPadding: true } });
}
export const nextCustomerNumber = async (tx: Tx, businessId: string) => { const c = await format(tx, businessId); return nextNumber(tx, businessId, 'customer', c?.customerPrefix ?? 'CUS', c?.customerPadding ?? 6); };
export const nextBookingNumber = async (tx: Tx, businessId: string) => { const c = await format(tx, businessId); return nextNumber(tx, businessId, 'booking', c?.bookingPrefix ?? 'BKG', c?.bookingPadding ?? 6); };
export const nextJobNumber = async (tx: Tx, businessId: string) => { const c = await format(tx, businessId); return nextNumber(tx, businessId, 'job_card', c?.jobPrefix ?? 'JOB', c?.jobPadding ?? 7); };

import type { Tx } from '@/server/db/client';

/**
 * The per-business configuration row (numbering, labour rounding, job / vehicle / inventory options, report and security
 * preferences). Absent row = the column defaults, created on first read, so a business that existed before this table
 * behaves exactly as before until someone changes a setting. Always read inside the caller's tenant transaction.
 */
export type BusinessConfigRow = Awaited<ReturnType<Tx['businessConfig']['findFirstOrThrow']>>;

export async function loadConfig(tx: Tx, businessId: string): Promise<BusinessConfigRow> {
  const row = await tx.businessConfig.findUnique({ where: { businessId } });
  if (row) return row;
  // Created on first use. Two requests doing this at once must not fail: the loser's insert is simply ignored.
  await tx.businessConfig.createMany({ data: [{ businessId }], skipDuplicates: true });
  return tx.businessConfig.findUniqueOrThrow({ where: { businessId } });
}

/** Business session limit, in effect for people working in this business: a session older than this must sign in again. */
export async function sessionLimitHours(tx: Tx, businessId: string): Promise<number | null> {
  return (await tx.businessConfig.findUnique({ where: { businessId }, select: { sessionMaxHours: true } }))?.sessionMaxHours ?? null;
}

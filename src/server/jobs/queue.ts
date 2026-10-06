import { Prisma, type Db } from '@/server/db/client';

export interface EnqueueOptions {
  runAt?: Date;
  /** Same key twice => the second enqueue is a no-op (exactly-once enqueue). */
  dedupeKey?: string;
  maxAttempts?: number;
  businessId?: string;
}

/**
 * Add a job. Pass the caller's transaction so the job exists if and only if the
 * business change that caused it commits (transactional outbox pattern).
 * Returns false if a job with the same dedupeKey already existed.
 */
export async function enqueue(
  db: Db,
  type: string,
  payload: Record<string, unknown>,
  opts: EnqueueOptions = {},
): Promise<boolean> {
  const res = await db.job.createMany({
    data: [
      {
        type,
        payload: payload as Prisma.InputJsonValue,
        runAt: opts.runAt ?? new Date(),
        dedupeKey: opts.dedupeKey ?? null,
        maxAttempts: opts.maxAttempts ?? 5,
        businessId: opts.businessId ?? null,
      },
    ],
    skipDuplicates: true,
  });
  return res.count === 1;
}

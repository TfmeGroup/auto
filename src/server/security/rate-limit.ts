import { prisma } from '@/server/db/client';
import { Errors } from '@/lib/errors';

export interface RateLimitRule {
  /** Namespaced key, e.g. `login:ip:1.2.3.4`. */
  key: string;
  limit: number;
  windowSec: number;
}

/**
 * Fixed-window counter in Postgres: one atomic upsert per check, shared by every
 * app instance, no extra infrastructure. Throws RATE_LIMITED when exceeded.
 */
export async function consume(rule: RateLimitRule): Promise<void> {
  const rows = await prisma().$queryRaw<{ count: number; retry_after: number }[]>`
    INSERT INTO rate_limit_buckets (key, count, window_start)
    VALUES (${rule.key}, 1, now())
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN rate_limit_buckets.window_start < now() - (${rule.windowSec}::int * interval '1 second')
                   THEN 1 ELSE rate_limit_buckets.count + 1 END,
      window_start = CASE WHEN rate_limit_buckets.window_start < now() - (${rule.windowSec}::int * interval '1 second')
                          THEN now() ELSE rate_limit_buckets.window_start END
    RETURNING count,
      ceil(extract(epoch FROM (window_start + (${rule.windowSec}::int * interval '1 second') - now())))::int AS retry_after`;
  const row = rows[0];
  if (row && row.count > rule.limit) throw Errors.rateLimited(Math.max(1, row.retry_after));
}

/** Check several rules; the first one exceeded throws. */
export async function consumeAll(rules: RateLimitRule[]): Promise<void> {
  for (const r of rules) await consume(r);
}

/** Housekeeping: drop buckets whose window has long expired. */
export async function purgeStaleBuckets(olderThanHours = 24): Promise<number> {
  const res = await prisma().$executeRaw`
    DELETE FROM rate_limit_buckets WHERE window_start < now() - (${olderThanHours}::int * interval '1 hour')`;
  return res;
}

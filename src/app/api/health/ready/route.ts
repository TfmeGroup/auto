import { NextResponse } from 'next/server';
import { prisma } from '@/server/db/client';
import { getStorage } from '@/server/storage';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

/**
 * Readiness: can serve traffic (database and object storage reachable) and reports queue health for monitoring.
 * The two dependencies are checked independently, so one being down never hides the state of the other.
 * Provider flags say only whether a provider is configured, never anything about its credentials.
 */
export const dynamic = 'force-dynamic';

// A well-formed key that never exists: asking for it proves the storage backend answers, without touching real data.
const PROBE_KEY = '00000000-0000-0000-0000-000000000000/2000/00000000-0000-0000-0000-000000000000';

async function check(label: string, fn: () => Promise<unknown>): Promise<'up' | 'down'> {
  try {
    await fn();
    return 'up';
  } catch (err) {
    logger.error({ err: String(err), dependency: label }, 'readiness check failed');
    return 'down';
  }
}

export async function GET() {
  const headers = { 'cache-control': 'no-store' };
  const e = env();
  const providers = {
    email: e.EMAIL_DRIVER !== 'console' && e.EMAIL_DRIVER !== 'memory',
    payments: Boolean(e.PAYFAST_MERCHANT_ID && e.PAYFAST_MERCHANT_KEY && e.PAYFAST_PASSPHRASE),
    sms: e.SMS_DRIVER !== 'none' && e.SMS_DRIVER !== 'memory',
    whatsapp: e.WHATSAPP_DRIVER !== 'none' && e.WHATSAPP_DRIVER !== 'memory',
  };
  const [database, storage] = await Promise.all([
    check('database', () => prisma().$queryRaw`SELECT 1`),
    check('storage', () => getStorage().exists(PROBE_KEY)),
  ]);
  if (database !== 'up' || storage !== 'up') return NextResponse.json({ status: 'unavailable', database, storage }, { status: 503, headers });

  const due = { status: 'PENDING' as const, runAt: { lte: new Date() } };
  const [pending, dead, oldest] = await Promise.all([
    prisma().job.count({ where: due }),
    prisma().job.count({ where: { status: 'DEAD' } }),
    prisma().job.findFirst({ where: due, orderBy: { runAt: 'asc' }, select: { runAt: true } }),
  ]);
  return NextResponse.json(
    { status: 'ready', database, storage, providers, jobs: { due: pending, dead, oldestDueSeconds: oldest ? Math.round((Date.now() - oldest.runAt.getTime()) / 1000) : 0 } },
    { headers },
  );
}

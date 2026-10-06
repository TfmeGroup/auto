import { NextResponse } from 'next/server';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { handleOnlineWebhook } from '@/server/finance/online';
import { buildMeta } from '@/server/http/route';
import { consume } from '@/server/security/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Webhook for a workshop's own payment provider (/api/webhooks/payments/<provider>/<businessId>). Public by necessity, so
 * authenticity comes from the provider's signature and server-side confirmation using THAT business's credentials, never from
 * cookies. This is separate from /api/webhooks/<provider>, which carries TFME's own subscription billing.
 * 2xx = "received, do not retry"; 5xx = "retry later".
 */
export async function POST(req: Request, ctx: { params: Promise<{ provider: string; businessId: string }> }) {
  const { provider, businessId } = await ctx.params;
  const meta = buildMeta(req);
  try {
    await consume({ key: `webhook:customer:${provider}:${meta.ip ?? 'unknown'}`, limit: 120, windowSec: 60 });
    const raw = await req.text();
    if (raw.length > 20_000) return new NextResponse('too large', { status: 413 });
    const outcome = await handleOnlineWebhook(provider, businessId, raw, { ip: meta.ip });
    if (outcome.result === 'rejected') return new NextResponse('invalid', { status: 400 });
    return new NextResponse('OK', { status: 200 });
  } catch (err) {
    if (err instanceof AppError && err.code === 'RATE_LIMITED') return new NextResponse('slow down', { status: 429 });
    logger.error({ err: String(err), requestId: meta.requestId, provider }, 'customer payment webhook failed');
    return new NextResponse('error', { status: 500 });
  }
}

import { NextResponse } from 'next/server';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { getPaymentProviderByName } from '@/server/billing/provider';
import { handleWebhook } from '@/server/billing/webhooks';
import { buildMeta } from '@/server/http/route';
import { consume } from '@/server/security/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Payment-provider webhook endpoint (/api/webhooks/<provider>). Public by necessity, so
 * authenticity comes from the provider's signature + server-side confirmation (inside
 * handleWebhook), not from cookies. Only the CONFIGURED provider is served; anything else is 404.
 * 2xx = "received, don't retry"; 5xx = "retry later".
 */
export async function POST(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider: name } = await ctx.params;
  const provider = getPaymentProviderByName(name);
  if (!provider) return new NextResponse('not found', { status: 404 });

  const meta = buildMeta(req);
  try {
    await consume({ key: `webhook:${name}:${meta.ip ?? 'unknown'}`, limit: 120, windowSec: 60 });
    const raw = await req.text();
    if (raw.length > 20_000) return new NextResponse('too large', { status: 413 });

    const outcome = await handleWebhook(provider, raw, { ip: meta.ip });
    if (outcome.result === 'rejected') return new NextResponse('invalid', { status: 400 });
    return new NextResponse('OK', { status: 200 });
  } catch (err) {
    if (err instanceof AppError && err.code === 'RATE_LIMITED') return new NextResponse('slow down', { status: 429 });
    logger.error({ err: String(err), requestId: meta.requestId, provider: name }, 'webhook processing failed');
    return new NextResponse('error', { status: 500 });
  }
}

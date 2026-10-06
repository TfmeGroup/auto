import { randomUUID } from 'node:crypto';
import { headers } from 'next/headers';
import { env } from '@/lib/env';
import type { RequestMeta } from '@/server/context';

/** Request metadata (for audit) for pages a customer opens without signing in. The IP is only trusted behind a proxy we control. */
export async function publicMeta(): Promise<RequestMeta> {
  const h = await headers();
  const forwarded = h.get('x-forwarded-for')?.split(',')[0]?.trim();
  return { requestId: randomUUID(), ip: env().TRUST_PROXY ? (h.get('x-real-ip') ?? forwarded ?? undefined) : undefined, userAgent: h.get('user-agent') ?? undefined };
}

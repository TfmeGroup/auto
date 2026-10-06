import { route } from '@/server/http/route';
import { Errors } from '@/lib/errors';
import { handleTwilioCallback } from '@/server/notifications/webhooks';

export const dynamic = 'force-dynamic';

/** Delivery reports from the messaging provider. Signed by the provider; a callback that does not verify is refused. */
export const POST = route({ access: 'public', csrf: false, rateLimit: { name: 'twilio-callback', limit: 600, windowSec: 60, by: 'ip' } }, async ({ req }) => {
  const text = await req.text();
  if (text.length > 20_000) throw Errors.badRequest('Too large.');
  const params = Object.fromEntries(new URLSearchParams(text).entries());
  const okSig = await handleTwilioCallback(params, req.headers.get('x-twilio-signature'));
  if (!okSig) throw Errors.forbidden();
  return new Response('', { status: 204 });
});

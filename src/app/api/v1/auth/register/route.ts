import { ok, readBody, route } from '@/server/http/route';
import { register } from '@/server/auth/service';

export const dynamic = 'force-dynamic';

// Same 202 whether or not the email already exists (no account enumeration).
export const POST = route({ access: 'public' }, async ({ req, meta }) => {
  await register(await readBody(req), meta);
  return ok({ message: 'Check your email to verify your address.' }, undefined, { status: 202 });
});

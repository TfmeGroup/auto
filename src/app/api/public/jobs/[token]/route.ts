import { ok, route } from '@/server/http/route';
import { getPublicJob } from '@/server/documents/customer';

export const dynamic = 'force-dynamic';

/** A customer opens their job link. No sign-in: the secret in the link is the credential. */
export const GET = route({ access: 'public', rateLimit: { name: 'public-job', limit: 60, windowSec: 60, by: 'ip' } }, async ({ params, meta }) => ok(await getPublicJob(params.token ?? '', meta)));

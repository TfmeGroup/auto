import { created, route } from '@/server/http/route';
import { createJobCustomerLink } from '@/server/documents/customer';

export const dynamic = 'force-dynamic';

/** A private link to this job's customer page. Shows only what is marked for the customer. */
export const POST = route({ access: 'business', permission: 'document.share', write: true, rateLimit: { name: 'job-link', limit: 60, windowSec: 3600 } }, async ({ ctx, params }) => created(await createJobCustomerLink(ctx, params.id ?? '')));

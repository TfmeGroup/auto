import { created, readBody, route } from '@/server/http/route';
import { createJobFromTemplate } from '@/server/settings/catalogue';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'job.create', write: true, feature: 'advanced_settings' }, async ({ req, ctx }) => {
  const r = await createJobFromTemplate(ctx, await readBody(req));
  return created({ ...r.job, copied: r.copied });
});

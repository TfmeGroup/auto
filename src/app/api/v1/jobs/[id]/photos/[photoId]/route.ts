import { ok, readBody, route } from '@/server/http/route';
import { setJobPhotoVisibility, removeJobPhoto } from '@/server/jobcards/items';

export const dynamic = 'force-dynamic';

export const PATCH = route({ access: 'business', permission: 'job.edit', write: true }, async ({ req, ctx, params }) =>
  ok(await setJobPhotoVisibility(ctx, params.id ?? '', params.photoId ?? '', (await readBody(req) as { visibility?: unknown }).visibility)),
);

export const DELETE = route({ access: 'business', permission: 'job.edit', write: true }, async ({ ctx, params }) =>
  ok(await removeJobPhoto(ctx, params.id ?? '', params.photoId ?? '').then(() => null)),
);

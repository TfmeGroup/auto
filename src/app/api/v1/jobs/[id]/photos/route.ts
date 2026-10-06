import { created, ok, route } from '@/server/http/route';
import { Errors } from '@/lib/errors';
import { env } from '@/lib/env';
import { addJobPhoto, listJobPhotos } from '@/server/jobcards/items';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'job.view' }, async ({ ctx, params }) => ok(await listJobPhotos(ctx, params.id ?? '')));

/** multipart/form-data: file, plus category, visibility, description, inspectionItemId, diagnosisId (all optional). */
export const POST = route(
  { access: 'business', permission: 'job.edit', write: true, rateLimit: { name: 'upload', limit: 60, windowSec: 60 } },
  async ({ req, ctx, params }) => {
    const declared = Number(req.headers.get('content-length') ?? 0);
    if (declared > (env().MAX_UPLOAD_MB + 1) * 1024 * 1024) throw Errors.tooLarge(env().MAX_UPLOAD_MB);
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw Errors.badRequest('Expected multipart form data.');
    }
    const file = form.get('file');
    if (!(file instanceof File)) throw Errors.validation({ file: 'Choose a photo to upload.' });
    const meta: Record<string, string> = {};
    for (const k of ['category', 'visibility', 'description', 'inspectionItemId', 'diagnosisId']) {
      const v = form.get(k);
      if (typeof v === 'string' && v) meta[k] = v;
    }
    return created(await addJobPhoto(ctx, params.id ?? '', { data: Buffer.from(await file.arrayBuffer()), filename: file.name }, meta));
  },
);

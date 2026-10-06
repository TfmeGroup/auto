import { created, ok, route } from '@/server/http/route';
import { Errors } from '@/lib/errors';
import { env } from '@/lib/env';
import { listVersions, uploadNewVersion } from '@/server/files/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'document.view' }, async ({ ctx, params }) => ok(await listVersions(ctx, params.id ?? '')));

/** multipart/form-data: file. The current file becomes an earlier version of the new one. */
export const POST = route({ access: 'business', permission: 'document.upload', write: true, rateLimit: { name: 'upload', limit: 120, windowSec: 60 } }, async ({ req, ctx, params }) => {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > (env().MAX_UPLOAD_MB + 1) * 1024 * 1024) throw Errors.tooLarge(env().MAX_UPLOAD_MB);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw Errors.badRequest('Expected multipart form data.');
  }
  const file = form.get('file');
  if (!(file instanceof File)) throw Errors.validation({ file: 'Choose a file to upload.' });
  return created(await uploadNewVersion(ctx, params.id ?? '', { data: Buffer.from(await file.arrayBuffer()), filename: file.name }));
});

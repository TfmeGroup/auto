import { created, ok, rawQuery, route } from '@/server/http/route';
import { Errors } from '@/lib/errors';
import { env } from '@/lib/env';
import { uploadFile } from '@/server/files/service';
import { searchDocuments } from '@/server/files/search';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'document.view' }, async ({ req, ctx }) => {
  const r = await searchDocuments(ctx, rawQuery(req));
  return ok(r.items, r.meta);
});

/** multipart/form-data: file, plus resourceType + resourceId, category, visibility, description, displayName (all optional). */
export const POST = route(
  { access: 'business', permission: 'document.upload', write: true, rateLimit: { name: 'upload', limit: 120, windowSec: 60 } },
  async ({ req, ctx }) => {
    // Reject oversized bodies before buffering them.
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
    const text = (k: string) => {
      const v = form.get(k);
      return typeof v === 'string' && v ? v : undefined;
    };
    const visibility = text('visibility');
    return created(
      await uploadFile(ctx, {
        data: Buffer.from(await file.arrayBuffer()), filename: file.name, resourceType: text('resourceType'), resourceId: text('resourceId'), category: text('category'),
        visibility: visibility === 'INTERNAL' || visibility === 'CUSTOMER' || visibility === 'RESTRICTED' ? visibility : undefined, description: text('description'), displayName: text('displayName'),
      }),
    );
  },
);

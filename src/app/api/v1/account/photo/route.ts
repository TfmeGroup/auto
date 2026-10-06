import { Readable } from 'node:stream';
import { ok, route } from '@/server/http/route';
import { Errors } from '@/lib/errors';
import { openOwnPhoto, removeProfilePhoto, setProfilePhoto } from '@/server/account/service';

export const dynamic = 'force-dynamic';

/** The signed-in person's own profile photo. */
export const GET = route({ access: 'user' }, async ({ ctx }) => {
  const { stream, size } = await openOwnPhoto(ctx.user.id);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: { 'content-length': String(size), 'content-type': 'image/jpeg', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'private, max-age=60' },
  });
});

export const POST = route({ access: 'user', rateLimit: { name: 'photo', limit: 20, windowSec: 3600 } }, async ({ req, ctx }) => {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw Errors.badRequest('Expected multipart form data.');
  }
  const file = form.get('photo');
  if (!(file instanceof File)) throw Errors.validation({ photo: 'Choose a photo.' });
  await setProfilePhoto(ctx, Buffer.from(await file.arrayBuffer()), file.name);
  return ok(null);
});

export const DELETE = route({ access: 'user' }, async ({ ctx }) => {
  await removeProfilePhoto(ctx);
  return ok(null);
});

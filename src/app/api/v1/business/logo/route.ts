import { Readable } from 'node:stream';
import { ok, route } from '@/server/http/route';
import { Errors } from '@/lib/errors';
import { openBusinessLogo, setBusinessLogo } from '@/server/businesses/logo';

export const dynamic = 'force-dynamic';

/** Any active member may see the business logo (it appears in the app header). */
export const GET = route({ access: 'business', permission: null }, async ({ ctx }) => {
  const { stream, size, mime } = await openBusinessLogo(ctx);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: { 'content-type': mime, 'content-length': String(size), 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'private, max-age=60' },
  });
});

export const POST = route({ access: 'business', permission: 'business.edit', write: true }, async ({ req, ctx }) => {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw Errors.badRequest('Expected multipart form data.');
  }
  const file = form.get('logo');
  if (!(file instanceof File)) throw Errors.validation({ logo: 'Choose an image.' });
  await setBusinessLogo(ctx, Buffer.from(await file.arrayBuffer()), file.name);
  return ok(null);
});

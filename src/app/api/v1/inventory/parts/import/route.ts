import { ok, route } from '@/server/http/route';
import { importParts } from '@/server/inventory/import';
import { Errors } from '@/lib/errors';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'inventory.import', write: true, feature: 'bulk_inventory', rateLimit: { name: 'inventory-import', limit: 30, windowSec: 3600 } }, async ({ req, ctx }) => {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > 12 * 1024 * 1024) throw Errors.tooLarge(8);
  let form: FormData;
  try { form = await req.formData(); } catch { throw Errors.badRequest('Expected multipart form data.'); }
  const file = form.get('file');
  if (!(file instanceof File)) throw Errors.validation({ file: 'Choose a file to import.' });
  const text = (k: string) => { const v = form.get(k); return typeof v === 'string' ? v : undefined; };
  let mapping: unknown = {};
  try { mapping = JSON.parse(text('mapping') || '{}'); } catch { throw Errors.validation({ mapping: 'The column mapping could not be read.' }); }
  return ok(await importParts(ctx, {
    filename: file.name, content: Buffer.from(await file.arrayBuffer()).toString('base64'), mapping, mode: text('mode') === 'commit' ? 'commit' : 'preview',
    onDuplicate: text('onDuplicate') === 'update' ? 'update' : 'error', skipInvalid: text('skipInvalid') === 'true', confirmPriceChanges: text('confirmPriceChanges') === 'true',
  }));
});

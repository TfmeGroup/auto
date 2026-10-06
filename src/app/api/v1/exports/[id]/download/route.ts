import { Readable } from 'node:stream';
import { route } from '@/server/http/route';
import { openExport } from '@/server/exports/service';

export const dynamic = 'force-dynamic';

/** Authenticated, permission-checked, audited download of a finished export. Expired exports are gone. */
export const GET = route({ access: 'business', permission: 'business.export' }, async ({ ctx, params }) => {
  const { stream, size, filename } = await openExport(ctx, params.id ?? '');
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      'content-type': 'application/json',
      'content-length': String(size),
      'content-disposition': `attachment; filename="${filename}"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    },
  });
});

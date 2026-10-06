import { route } from '@/server/http/route';
import { fileResponse } from '@/server/finance/http';
import { importProblemsCsv } from '@/server/imports/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'data.import' }, async ({ ctx, params }) => {
  const r = await importProblemsCsv(ctx, params.id ?? '');
  return fileResponse(r.data, 'text/csv; charset=utf-8', r.filename);
});

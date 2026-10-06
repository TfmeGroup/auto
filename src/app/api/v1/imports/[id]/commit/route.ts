import { ok, readBody, route } from '@/server/http/route';
import { commitImport } from '@/server/imports/service';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'data.import', write: true }, async ({ req, ctx, params }) => ok(await commitImport(ctx, params.id ?? '', await readBody(req))));

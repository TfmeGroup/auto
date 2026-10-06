import { created, ok, readBody, route } from '@/server/http/route';
import { availableKinds, listImports, startImport } from '@/server/imports/service';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'data.import' }, async ({ ctx }) => ok({ kinds: availableKinds(ctx), imports: await listImports(ctx) }));
export const POST = route({ access: 'business', permission: 'data.import', write: true }, async ({ req, ctx }) => created(await startImport(ctx, await readBody(req))));

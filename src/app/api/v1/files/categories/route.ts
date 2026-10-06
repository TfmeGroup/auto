import { created, ok, readBody, route } from '@/server/http/route';
import { createCategory, listCategories } from '@/server/files/categories';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'document.view' }, async ({ ctx }) => ok(await listCategories(ctx)));
export const POST = route({ access: 'business', permission: 'document.manage', write: true, feature: 'advanced_documents' }, async ({ req, ctx }) => created(await createCategory(ctx, await readBody(req))));

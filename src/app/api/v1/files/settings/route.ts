import { ok, readBody, route } from '@/server/http/route';
import { getDocumentSettings, updateDocumentSettings } from '@/server/files/settings';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'business', permission: 'document.view' }, async ({ ctx }) => ok(await getDocumentSettings(ctx)));
export const PUT = route({ access: 'business', permission: 'document.manage', write: true, feature: 'advanced_documents' }, async ({ req, ctx }) => ok(await updateDocumentSettings(ctx, await readBody(req))));

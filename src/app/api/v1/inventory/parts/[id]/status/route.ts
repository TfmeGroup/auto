import { ok, readBody, route } from '@/server/http/route';
import { setPartStatus } from '@/server/inventory/parts';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'inventory.edit', write: true }, async ({ req, ctx, params }) => {
  const b = (await readBody(req)) as { status?: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED'; reason?: string }; return ok(await setPartStatus(ctx, params.id ?? '', b.status as 'ACTIVE', b.reason));
});

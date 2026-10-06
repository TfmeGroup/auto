import { ok, route } from '@/server/http/route';
import { retryGeneration } from '@/server/documents/generator';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'document.manage', write: true }, async ({ ctx, params }) => ok(await retryGeneration(ctx, params.id ?? '')));

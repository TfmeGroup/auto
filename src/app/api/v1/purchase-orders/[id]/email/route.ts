import { ok, route } from '@/server/http/route';
import { emailPurchaseOrder } from '@/server/inventory/purchasing';

export const dynamic = 'force-dynamic';

export const POST = route({ access: 'business', permission: 'inventory.purchase', write: true, feature: 'purchase_orders', rateLimit: { name: 'po-email', limit: 30, windowSec: 3600 } }, async ({ ctx, params }) => ok(await emailPurchaseOrder(ctx, params.id ?? '')));

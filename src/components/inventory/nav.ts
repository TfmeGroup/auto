import type { BusinessContext } from '@/server/context';
import type { InvTab } from './shared';

/** The stock-area tabs this person may use: decided on the server from their permissions and the plan, never from what the browser asks for. */
export function inventoryTabs(ctx: BusinessContext): InvTab[] {
  const can = (p: Parameters<BusinessContext['permissions']['has']>[0]) => ctx.permissions.has(p);
  const feature = (f: Parameters<BusinessContext['subscription']['features']['has']>[0]) => ctx.subscription.features.has(f);
  return [
    { key: 'overview', label: 'Overview', href: '/inventory', show: can('inventory.view') },
    { key: 'parts', label: 'Parts', href: '/inventory/parts', show: can('inventory.view') },
    { key: 'suppliers', label: 'Suppliers', href: '/inventory/suppliers', show: can('inventory.view') },
    { key: 'orders', label: 'Purchase orders', href: '/purchase-orders', show: can('inventory.view') && feature('purchase_orders') },
    { key: 'transfers', label: 'Transfers', href: '/inventory/transfers', show: can('inventory.view') && feature('multi_location') },
    { key: 'movements', label: 'Movements', href: '/inventory/movements', show: can('inventory.view') },
    { key: 'reports', label: 'Reports', href: '/inventory/reports', show: can('inventory.view') },
  ];
}

import type { SearchProvider } from '@/server/search/registry';
import { matchCustomerIds } from './service';

export const customerSearchProvider: SearchProvider = {
  key: 'customers',
  label: 'Customers',
  permission: 'customer.view',
  async search(tx, businessId, query, limit) {
    const { ids } = await matchCustomerIds(tx, businessId, { q: query, status: 'ACTIVE', limit, order: 'lower(c.name) ASC' });
    if (ids.length === 0) return [];
    const rows = await tx.customer.findMany({ where: { id: { in: ids }, businessId } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((id) => {
      const c = byId.get(id);
      return c
        ? [{
            id: c.id,
            title: c.name,
            subtitle: [c.customerNumber, c.mobile, c.email].filter(Boolean).join(' · '),
            href: `/customers/${c.id}`,
          }]
        : [];
    });
  },
};

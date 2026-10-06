import type { SearchProvider } from '@/server/search/registry';
import { matchVehicleIds, vehicleLabel } from './service';

export const vehicleSearchProvider: SearchProvider = {
  key: 'vehicles',
  label: 'Vehicles',
  permission: 'vehicle.view',
  async search(tx, businessId, query, limit) {
    const { ids } = await matchVehicleIds(tx, businessId, { q: query, limit, order: 'v.registration_norm ASC' });
    if (ids.length === 0) return [];
    const rows = await tx.vehicle.findMany({ where: { id: { in: ids }, businessId }, include: { customer: { select: { name: true } } } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((id) => {
      const v = byId.get(id);
      return v ? [{ id: v.id, title: vehicleLabel(v), subtitle: [v.customer.name, v.vin].filter(Boolean).join(' · '), href: `/vehicles/${v.id}` }] : [];
    });
  },
};

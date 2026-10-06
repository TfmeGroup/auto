import { withTenant } from '@/server/db/client';
import { listTechnicians, visibleLocationIds } from '@/server/workshop/people';
import type { BusinessContext } from '@/server/context';
import type { FilterKey } from './types';

/** The pick-lists a report's filter form needs, loaded only for the filters that report declares and limited to what the caller may use. */
export interface FilterOptions {
  locations: { value: string; label: string }[];
  technicians: { value: string; label: string }[];
  services: { value: string; label: string }[];
  suppliers: { value: string; label: string }[];
  categories: { value: string; label: string }[];
  roles: { value: string; label: string }[];
  members: { value: string; label: string }[];
}

export async function filterOptions(ctx: BusinessContext, filters: FilterKey[]): Promise<FilterOptions> {
  const bid = ctx.business.id;
  const want = (k: FilterKey) => filters.includes(k);
  return withTenant(bid, async (tx) => {
    const scope = await visibleLocationIds(tx, ctx);
    const out: FilterOptions = { locations: [], technicians: [], services: [], suppliers: [], categories: [], roles: [], members: [] };
    if (want('location')) {
      const locs = await tx.location.findMany({ where: { businessId: bid, status: 'ACTIVE', ...(scope ? { id: { in: scope } } : {}) }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }], select: { id: true, name: true } });
      out.locations = locs.map((l) => ({ value: l.id, label: l.name }));
    }
    if (want('technician')) out.technicians = (await listTechnicians(tx, bid)).map((t) => ({ value: t.membershipId, label: t.name }));
    if (want('serviceType')) out.services = (await tx.serviceType.findMany({ where: { businessId: bid }, orderBy: [{ status: 'asc' }, { name: 'asc' }], select: { id: true, name: true } })).map((s) => ({ value: s.id, label: s.name }));
    if (want('supplier')) out.suppliers = (await tx.supplier.findMany({ where: { businessId: bid, status: { not: 'ARCHIVED' } }, orderBy: { name: 'asc' }, select: { id: true, name: true } })).map((s) => ({ value: s.id, label: s.name }));
    if (want('category')) out.categories = (await tx.partCategory.findMany({ where: { businessId: bid, status: 'ACTIVE' }, orderBy: { name: 'asc' }, select: { id: true, name: true } })).map((c) => ({ value: c.id, label: c.name }));
    return out;
  });
}

/** Roles and active members a saved report can be shared with, and who a schedule can be sent to. */
export async function sharingOptions(ctx: BusinessContext) {
  return withTenant(ctx.business.id, async (tx) => {
    const roles = await tx.role.findMany({ where: { OR: [{ businessId: null }, { businessId: ctx.business.id }], archivedAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true } });
    const members = await tx.membership.findMany({ where: { businessId: ctx.business.id, status: 'ACTIVE', userId: { not: null } }, select: { id: true, user: { select: { name: true } } } });
    return { roles: roles.map((r) => ({ value: r.id, label: r.name })), members: members.map((m) => ({ value: m.id, label: m.user?.name ?? 'Member' })).sort((a, b) => a.label.localeCompare(b.label)) };
  });
}

import type { Metadata } from 'next';
import { EmptyState, LinkButton, PageHeader, Pagination } from '@/components/ui';
import { Chips, qs } from '@/components/workshop/layout';
import { VehicleList } from '@/components/workshop/Lists';
import { vehicleStatusLabel } from '@/components/workshop/badges';
import { listVehicles, VEHICLE_STATUSES } from '@/server/vehicles/service';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Vehicles' };
export const dynamic = 'force-dynamic';

type Search = { q?: string; page?: string; status?: string; make?: string; model?: string; archived?: string };

export default async function VehiclesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'vehicle.view');
  const sp = await searchParams;
  const status = (VEHICLE_STATUSES as readonly string[]).includes(sp.status ?? '') ? sp.status : undefined;
  const archived = sp.archived === '1';
  const { items, meta } = await listVehicles(ctx, { q: sp.q, page: sp.page, status, make: sp.make, model: sp.model, archived: archived ? 'true' : undefined, pageSize: 25, sort: sp.q ? 'registration' : 'createdAt', dir: sp.q ? 'asc' : 'desc' });

  const base = { q: sp.q, status, make: sp.make, model: sp.model, archived: archived ? '1' : undefined };
  const href = (over: Record<string, string | undefined>) => `/vehicles${qs(base, { page: undefined, ...over })}`;
  const filtered = !!(sp.q || status || sp.make || sp.model || archived);

  return (
    <>
      <PageHeader title="Vehicles" description="Every vehicle you work on, with its owner and history." actions={ctx.permissions.has('vehicle.create') ? <LinkButton href="/vehicles/new">Add vehicle</LinkButton> : undefined} />

      <form action="/vehicles" className="mb-3 grid gap-2 sm:grid-cols-[1fr_9rem_9rem_auto]" role="search">
        <input name="q" defaultValue={sp.q} type="search" placeholder="Search registration, VIN, make, model or owner" aria-label="Search vehicles" className="block min-h-11 w-full min-w-0 rounded-lg border border-line bg-surface px-3 py-2 md:min-h-10" />
        <input name="make" defaultValue={sp.make} placeholder="Make" aria-label="Make" className="block min-h-11 w-full min-w-0 rounded-lg border border-line bg-surface px-3 py-2 md:min-h-10" />
        <input name="model" defaultValue={sp.model} placeholder="Model" aria-label="Model" className="block min-h-11 w-full min-w-0 rounded-lg border border-line bg-surface px-3 py-2 md:min-h-10" />
        {status && <input type="hidden" name="status" value={status} />}
        {archived && <input type="hidden" name="archived" value="1" />}
        <button className="min-h-11 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white md:min-h-10">Search</button>
      </form>
      <div className="mb-4">
        <Chips items={[
          { label: 'All', href: href({ status: undefined, archived: undefined }), active: !status && !archived },
          ...VEHICLE_STATUSES.map((s) => ({ label: vehicleStatusLabel(s), href: href({ status: s, archived: undefined }), active: status === s })),
          { label: 'Archived', href: href({ archived: '1', status: undefined }), active: archived },
        ]} />
      </div>

      {items.length === 0 ? (
        <EmptyState title={filtered ? 'No vehicles match' : 'No vehicles yet'} action={!filtered && ctx.permissions.has('vehicle.create') ? <LinkButton href="/vehicles/new">Add a vehicle</LinkButton> : filtered ? <LinkButton href="/vehicles" variant="secondary">Clear filters</LinkButton> : undefined}>
          {filtered ? 'Try different words, or clear the filters.' : 'Add the vehicles your customers bring in.'}
        </EmptyState>
      ) : (
        <>
          <VehicleList items={items as never} />
          <Pagination page={meta.page} totalPages={meta.totalPages} total={meta.total} hrefFor={(p) => href({ page: String(p) })} />
        </>
      )}
    </>
  );
}

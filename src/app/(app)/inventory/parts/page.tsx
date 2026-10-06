import type { Metadata } from 'next';
import { EmptyState, LinkButton, PageHeader, Pagination } from '@/components/ui';
import { InventoryNav } from '@/components/inventory/shared';
import { inventoryTabs } from '@/components/inventory/nav';
import { categoryOptions } from '@/components/inventory/shared';
import { PartsList } from '@/components/inventory/PartsList';
import { Chips, qs } from '@/components/workshop/layout';
import { listCategories } from '@/server/inventory/categories';
import { listParts } from '@/server/inventory/parts';
import { listSuppliers } from '@/server/inventory/suppliers';
import { accessibleLocationsFor } from '@/server/inventory/queries';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Parts' };
export const dynamic = 'force-dynamic';

type Search = { q?: string; page?: string; status?: string; categoryId?: string; supplierId?: string; locationId?: string; stock?: string; sort?: string; dir?: string; make?: string; model?: string; year?: string };
const field = 'block min-h-11 w-full rounded-lg border border-line bg-surface px-3 md:min-h-10';

const CHIPS: { label: string; over: Partial<Search> }[] = [
  { label: 'All', over: { stock: undefined, status: undefined } },
  { label: 'In stock', over: { stock: 'in', status: undefined } },
  { label: 'Low stock', over: { stock: 'low', status: undefined } },
  { label: 'Out of stock', over: { stock: 'out', status: undefined } },
  { label: 'Reserved', over: { stock: 'reserved', status: undefined } },
  { label: 'Inactive', over: { stock: undefined, status: 'INACTIVE' } },
  { label: 'Archived', over: { stock: undefined, status: 'ARCHIVED' } },
];

export default async function PartsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'inventory.view');
  const sp = await searchParams;
  const fmt = { currency: ctx.business.currency, locale: ctx.business.locale };
  const sort = ['name', 'sku', 'available', 'on_hand', 'updated', 'created'].includes(sp.sort ?? '') ? sp.sort : 'name';
  const dir = sp.dir === 'desc' ? 'desc' : 'asc';
  const [{ items, meta }, categories, suppliers, locations] = await Promise.all([
    listParts(ctx, { q: sp.q, page: sp.page, status: sp.status || undefined, categoryId: sp.categoryId || undefined, supplierId: sp.supplierId || undefined, locationId: sp.locationId || undefined, stock: sp.stock || undefined, make: sp.make || undefined, model: sp.model || undefined, year: sp.year || undefined, sort, dir, pageSize: 25 }),
    listCategories(ctx),
    listSuppliers(ctx, { pageSize: 100 }),
    accessibleLocationsFor(ctx),
  ]);
  const base = { q: sp.q, status: sp.status, categoryId: sp.categoryId, supplierId: sp.supplierId, locationId: sp.locationId, stock: sp.stock, make: sp.make, model: sp.model, year: sp.year, sort: sp.sort, dir: sp.dir };
  const href = (over: Partial<Search>) => `/inventory/parts${qs(base, { page: undefined, ...over })}`;
  const filtered = !!(sp.q || sp.status || sp.categoryId || sp.supplierId || sp.locationId || sp.stock || sp.make || sp.model || sp.year);
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  const bulk = can('inventory.edit') && ctx.subscription.features.has('bulk_inventory') && ctx.subscription.canWrite;
  const activeChip = (c: (typeof CHIPS)[number]) => (c.over.stock ?? '') === (sp.stock ?? '') && (c.over.status ?? '') === (sp.status ?? '');

  return (
    <>
      <PageHeader
        title="Parts"
        description="Your parts catalogue. Search by name, SKU, part number, barcode, brand or supplier part number."
        actions={<>
          {can('inventory.create') && <LinkButton href="/inventory/parts/new">Add part</LinkButton>}
          <LinkButton href="/inventory/scan" variant="secondary">Scan</LinkButton>
          {can('inventory.edit') && <LinkButton href="/inventory/categories" variant="secondary">Categories</LinkButton>}
          {can('inventory.import') && ctx.subscription.features.has('bulk_inventory') && <LinkButton href="/inventory/import" variant="secondary">Import</LinkButton>}
          {can('inventory.export') && <LinkButton href={`/api/v1/inventory/export?dataset=stock_list&format=xlsx${sp.q ? `&q=${encodeURIComponent(sp.q)}` : ''}`} variant="secondary">Export</LinkButton>}
        </>}
      />
      <InventoryNav tabs={inventoryTabs(ctx)} active="parts" />
      <form action="/inventory/parts" className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-6" role="search">
        <input name="q" defaultValue={sp.q} type="search" placeholder="Name, SKU, part number, barcode, brand" aria-label="Search parts" className={`${field} lg:col-span-2`} />
        <select name="categoryId" defaultValue={sp.categoryId ?? ''} aria-label="Category" className={field}><option value="">Any category</option>{categoryOptions(categories).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</select>
        <select name="supplierId" defaultValue={sp.supplierId ?? ''} aria-label="Supplier" className={field}><option value="">Any supplier</option>{suppliers.items.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        {locations.length > 1 && <select name="locationId" defaultValue={sp.locationId ?? ''} aria-label="Location" className={field}><option value="">All my locations</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>}
        <input name="make" defaultValue={sp.make} placeholder="Fits make" aria-label="Fits make" className={field} />
        <input name="model" defaultValue={sp.model} placeholder="Fits model" aria-label="Fits model" className={field} />
        <input name="year" defaultValue={sp.year} placeholder="Fits year" inputMode="numeric" aria-label="Fits year" className={field} />
        {sp.stock && <input type="hidden" name="stock" value={sp.stock} />}{sp.status && <input type="hidden" name="status" value={sp.status} />}
        <button className="min-h-11 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white md:min-h-10">Search</button>
      </form>
      <div className="mb-4"><Chips items={CHIPS.map((c) => ({ label: c.label, href: href(c.over), active: activeChip(c) }))} /></div>

      {items.length === 0 ? (
        <EmptyState title={filtered ? 'No parts match' : 'No parts yet'} action={!filtered && can('inventory.create') ? <LinkButton href="/inventory/parts/new">Add a part</LinkButton> : filtered ? <LinkButton href="/inventory/parts" variant="secondary">Clear filters</LinkButton> : undefined}>
          {filtered ? 'Try different words or clear the filters.' : 'Add the parts you stock, or import them from a spreadsheet.'}
        </EmptyState>
      ) : (
        <>
          <PartsList items={items} fmt={fmt} showCost={can('inventory.view_costs')} bulk={bulk} categories={categoryOptions(categories)} />
          <Pagination page={meta.page} totalPages={meta.totalPages} total={meta.total} hrefFor={(p) => href({ page: String(p) } as Partial<Search>)} />
        </>
      )}
    </>
  );
}

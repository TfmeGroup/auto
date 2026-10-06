import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, EmptyState, LinkButton, PageHeader, Pagination } from '@/components/ui';
import { InventoryNav, PoStatusBadge, money } from '@/components/inventory/shared';
import { inventoryTabs } from '@/components/inventory/nav';
import { Chips, qs } from '@/components/workshop/layout';
import { formatDate } from '@/lib/format';
import { requireFeature } from '@/server/billing/features';
import { listPurchaseOrders } from '@/server/inventory/purchasing';
import { accessibleLocationsFor } from '@/server/inventory/queries';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Purchase orders' };
export const dynamic = 'force-dynamic';

type Search = { q?: string; page?: string; status?: string; open?: string; late?: string; locationId?: string; from?: string; to?: string; supplierId?: string };
const field = 'block min-h-11 w-full rounded-lg border border-line bg-surface px-3 md:min-h-10';
const CHIPS: { label: string; over: Partial<Search> }[] = [
  { label: 'All', over: { status: undefined, open: undefined, late: undefined } },
  { label: 'Draft', over: { status: 'DRAFT', open: undefined, late: undefined } },
  { label: 'Awaiting approval', over: { status: 'PENDING_APPROVAL', open: undefined, late: undefined } },
  { label: 'On order', over: { status: undefined, open: '1', late: undefined } },
  { label: 'Late', over: { status: undefined, open: undefined, late: '1' } },
  { label: 'Received', over: { status: 'RECEIVED', open: undefined, late: undefined } },
  { label: 'Cancelled', over: { status: 'CANCELLED', open: undefined, late: undefined } },
];

export default async function PurchaseOrdersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'inventory.view');
  const sp = await searchParams;
  const fmt = { currency: ctx.business.currency, locale: ctx.business.locale };
  if (!ctx.subscription.features.has('purchase_orders')) {
    return (
      <>
        <PageHeader title="Purchase orders" />
        <InventoryNav tabs={inventoryTabs(ctx)} active="orders" />
        <Alert tone="warn">Purchase orders, receiving and supplier returns are included from the Team plan. {ctx.permissions.has('settings.manage_billing') ? <Link href="/settings/billing" className="font-medium underline">See plans</Link> : 'Ask an owner to upgrade.'}</Alert>
      </>
    );
  }
  requireFeature(ctx.subscription, 'purchase_orders');
  const [{ items, meta }, locations] = await Promise.all([
    listPurchaseOrders(ctx, { q: sp.q, page: sp.page, status: sp.status, open: sp.open === '1' ? '1' : undefined, late: sp.late === '1' ? '1' : undefined, locationId: sp.locationId || undefined, from: sp.from || undefined, to: sp.to || undefined, supplierId: sp.supplierId || undefined, pageSize: 25 }),
    accessibleLocationsFor(ctx),
  ]);
  const base = { q: sp.q, status: sp.status, open: sp.open, late: sp.late, locationId: sp.locationId, from: sp.from, to: sp.to, supplierId: sp.supplierId };
  const href = (over: Partial<Search>) => `/purchase-orders${qs(base, { page: undefined, ...over })}`;
  const filtered = !!(sp.q || sp.status || sp.open || sp.late || sp.locationId || sp.from || sp.to || sp.supplierId);
  const active = (c: (typeof CHIPS)[number]) => (c.over.status ?? '') === (sp.status ?? '') && (c.over.open ?? '') === (sp.open ?? '') && (c.over.late ?? '') === (sp.late ?? '');
  const canCreate = ctx.permissions.has('inventory.purchase');

  return (
    <>
      <PageHeader title="Purchase orders" description="What you have ordered from suppliers, and what has arrived." actions={<>{canCreate && <LinkButton href="/purchase-orders/new">New purchase order</LinkButton>}{ctx.permissions.has('inventory.export') && <LinkButton href="/api/v1/inventory/export?dataset=purchase_orders&format=xlsx" variant="secondary">Export</LinkButton>}</>} />
      <InventoryNav tabs={inventoryTabs(ctx)} active="orders" />
      <form action="/purchase-orders" className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5" role="search">
        <input name="q" defaultValue={sp.q} type="search" placeholder="PO number or supplier" aria-label="Search purchase orders" className={`${field} lg:col-span-2`} />
        <label className="grid gap-1 text-xs text-muted">From<input name="from" type="date" defaultValue={sp.from} className={field} /></label>
        <label className="grid gap-1 text-xs text-muted">To<input name="to" type="date" defaultValue={sp.to} className={field} /></label>
        {locations.length > 1 && <label className="grid gap-1 text-xs text-muted">Deliver to<select name="locationId" defaultValue={sp.locationId ?? ''} className={field}><option value="">All my locations</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>}
        {sp.status && <input type="hidden" name="status" value={sp.status} />}{sp.open && <input type="hidden" name="open" value="1" />}{sp.late && <input type="hidden" name="late" value="1" />}
        <button className="min-h-11 self-end rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white md:min-h-10">Apply</button>
      </form>
      <div className="mb-4"><Chips items={CHIPS.map((c) => ({ label: c.label, href: href(c.over), active: active(c) }))} /></div>
      {items.length === 0 ? (
        <EmptyState title={filtered ? 'No purchase orders match' : 'No purchase orders yet'} action={!filtered && canCreate ? <LinkButton href="/purchase-orders/new">Create a purchase order</LinkButton> : filtered ? <LinkButton href="/purchase-orders" variant="secondary">Clear filters</LinkButton> : undefined}>
          {filtered ? 'Try different words or clear the filters.' : 'Order stock from a supplier, then receive it here as it arrives.'}
        </EmptyState>
      ) : (
        <>
          <ul className="space-y-2 md:hidden">
            {items.map((o) => (
              <li key={o.id}>
                <Link href={`/purchase-orders/${o.id}`} className="block rounded-xl border border-line bg-surface p-3 shadow-sm">
                  <div className="flex items-start justify-between gap-2"><p className="font-semibold">{o.number}</p><PoStatusBadge status={o.status} /></div>
                  <p className="text-sm">{o.supplierName}</p>
                  <div className="mt-1 flex items-center justify-between text-sm"><span className="text-muted">{o.received}/{o.ordered} received{o.expectedDate ? ` · due ${formatDate(`${o.expectedDate}T12:00:00Z`, 'UTC', ctx.business.locale)}` : ''}{o.late ? ' · late' : ''}</span>{o.totalCents !== null && <span className="font-semibold tabular-nums">{money(o.totalCents, fmt)}</span>}</div>
                </Link>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-hidden rounded-xl border border-line bg-surface md:block">
            <table className="w-full text-sm">
              <thead className="bg-canvas text-left text-xs uppercase tracking-wide text-muted"><tr><th className="px-3 py-2 font-medium">Order</th><th className="px-3 py-2 font-medium">Supplier</th><th className="px-3 py-2 font-medium">Status</th><th className="px-3 py-2 font-medium">Ordered</th><th className="px-3 py-2 font-medium">Expected</th><th className="px-3 py-2 text-right font-medium">Received</th>{items[0]?.totalCents !== null && <th className="px-3 py-2 text-right font-medium">Total</th>}</tr></thead>
              <tbody className="divide-y divide-line">
                {items.map((o) => (
                  <tr key={o.id} className="hover:bg-canvas">
                    <td className="px-3 py-2.5"><Link href={`/purchase-orders/${o.id}`} className="font-semibold text-brand-700 hover:underline">{o.number}</Link></td>
                    <td className="px-3 py-2.5">{o.supplierName}</td><td className="px-3 py-2.5"><PoStatusBadge status={o.status} /></td>
                    <td className="px-3 py-2.5">{o.poDate ? formatDate(`${o.poDate}T12:00:00Z`, 'UTC', ctx.business.locale) : '—'}</td>
                    <td className={`px-3 py-2.5 ${o.late ? 'font-medium text-danger' : ''}`}>{o.expectedDate ? formatDate(`${o.expectedDate}T12:00:00Z`, 'UTC', ctx.business.locale) : '—'}{o.late ? ' (late)' : ''}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{o.received}/{o.ordered}</td>
                    {o.totalCents !== null && <td className="px-3 py-2.5 text-right tabular-nums">{money(o.totalCents, fmt)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={meta.page} totalPages={meta.totalPages} total={meta.total} hrefFor={(p) => href({ page: String(p) })} />
        </>
      )}
    </>
  );
}

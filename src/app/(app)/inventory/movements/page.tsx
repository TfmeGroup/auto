import type { Metadata } from 'next';
import Link from 'next/link';
import { EmptyState, LinkButton, PageHeader, Pagination } from '@/components/ui';
import { InventoryNav, MovementBadge, money, signed } from '@/components/inventory/shared';
import { inventoryTabs } from '@/components/inventory/nav';
import { Chips, qs } from '@/components/workshop/layout';
import { formatDateTime } from '@/lib/format';
import { accessibleLocationsFor } from '@/server/inventory/queries';
import { listMovements } from '@/server/inventory/stock';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Stock movements' };
export const dynamic = 'force-dynamic';

type Search = { q?: string; page?: string; type?: string; locationId?: string; from?: string; to?: string };
const field = 'block min-h-11 w-full rounded-lg border border-line bg-surface px-3 md:min-h-10';
const CHIPS = [['All', undefined], ['Received', 'RECEIVED'], ['Used', 'USED,SOLD'], ['Reserved', 'RESERVED,UNRESERVED'], ['Returned', 'RETURNED,SUPPLIER_RETURN'], ['Adjusted', 'ADJUSTED,DAMAGED,LOST'], ['Transfers', 'TRANSFER_IN,TRANSFER_OUT']] as const;

export default async function MovementsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'inventory.view');
  const sp = await searchParams;
  const fmt = { currency: ctx.business.currency, locale: ctx.business.locale };
  const [{ items, meta }, locations] = await Promise.all([
    listMovements(ctx, { q: sp.q, page: sp.page, type: sp.type, locationId: sp.locationId || undefined, from: sp.from || undefined, to: sp.to || undefined, pageSize: 30 }),
    accessibleLocationsFor(ctx),
  ]);
  const base = { q: sp.q, type: sp.type, locationId: sp.locationId, from: sp.from, to: sp.to };
  const href = (over: Partial<Search>) => `/inventory/movements${qs(base, { page: undefined, ...over })}`;
  const costs = ctx.permissions.has('inventory.view_costs');
  const filtered = !!(sp.q || sp.type || sp.locationId || sp.from || sp.to);

  return (
    <>
      <PageHeader title="Stock movements" description="Every change to stock, newest first. Movements are never edited: a mistake is corrected by another movement." actions={ctx.permissions.has('inventory.export') && <LinkButton href={`/api/v1/inventory/export?dataset=movements&format=xlsx${sp.from ? `&from=${sp.from}` : ''}${sp.to ? `&to=${sp.to}` : ''}`} variant="secondary">Export</LinkButton>} />
      <InventoryNav tabs={inventoryTabs(ctx)} active="movements" />
      <form action="/inventory/movements" className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5" role="search">
        <input name="q" defaultValue={sp.q} type="search" placeholder="Part name or SKU" aria-label="Search movements" className={`${field} lg:col-span-2`} />
        <label className="grid gap-1 text-xs text-muted">From<input name="from" type="date" defaultValue={sp.from} className={field} /></label>
        <label className="grid gap-1 text-xs text-muted">To<input name="to" type="date" defaultValue={sp.to} className={field} /></label>
        {locations.length > 1 && <label className="grid gap-1 text-xs text-muted">Location<select name="locationId" defaultValue={sp.locationId ?? ''} className={field}><option value="">All my locations</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>}
        {sp.type && <input type="hidden" name="type" value={sp.type} />}
        <button className="min-h-11 self-end rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white md:min-h-10">Apply</button>
      </form>
      <div className="mb-4"><Chips items={CHIPS.map(([label, type]) => ({ label, href: href({ type }), active: (type ?? '') === (sp.type ?? '') }))} /></div>
      {items.length === 0 ? (
        <EmptyState title={filtered ? 'No movements match' : 'No stock movements yet'}>{filtered ? 'Try different filters.' : 'Stock activity will appear here as parts are received, reserved, used and adjusted.'}</EmptyState>
      ) : (
        <>
          <ul className="space-y-2 md:hidden">
            {items.map((m) => (
              <li key={m.id} className="rounded-xl border border-line bg-surface p-3 text-sm">
                <div className="flex items-center justify-between gap-2"><MovementBadge type={m.type} /><strong className="tabular-nums">{signed(m.onHandDelta !== 0 ? m.onHandDelta : m.reservedDelta)}</strong></div>
                <Link href={`/inventory/parts/${m.partId}`} className="mt-1 block truncate font-medium text-brand-700">{m.sku} — {m.partName}</Link>
                <p className="text-xs text-muted">{formatDateTime(m.createdAt, ctx.business.timezone, ctx.business.locale)}{m.by ? ` · ${m.by}` : ''}{m.jobNumber ? ` · job ${m.jobNumber}` : ''}</p>
                {m.reason && <p className="text-xs text-muted">{m.reason}</p>}
              </li>
            ))}
          </ul>
          <div className="hidden overflow-hidden rounded-xl border border-line bg-surface md:block">
            <table className="w-full text-sm">
              <thead className="bg-canvas text-left text-xs uppercase tracking-wide text-muted"><tr><th className="px-3 py-2 font-medium">When</th><th className="px-3 py-2 font-medium">Part</th><th className="px-3 py-2 font-medium">Movement</th><th className="px-3 py-2 text-right font-medium">Change</th><th className="px-3 py-2 text-right font-medium">On hand after</th><th className="px-3 py-2 text-right font-medium">Reserved after</th><th className="px-3 py-2 font-medium">Where / who / why</th>{costs && <th className="px-3 py-2 text-right font-medium">Unit cost</th>}</tr></thead>
              <tbody className="divide-y divide-line">
                {items.map((m) => (
                  <tr key={m.id} className="hover:bg-canvas">
                    <td className="whitespace-nowrap px-3 py-2.5 text-muted">{formatDateTime(m.createdAt, ctx.business.timezone, ctx.business.locale)}</td>
                    <td className="px-3 py-2.5"><Link href={`/inventory/parts/${m.partId}`} className="font-medium text-brand-700 hover:underline">{m.sku}</Link><span className="block max-w-56 truncate text-xs text-muted">{m.partName}</span></td>
                    <td className="px-3 py-2.5"><MovementBadge type={m.type} />{m.wentNegative && <span className="ml-1 text-xs text-danger">below zero</span>}</td>
                    <td className="px-3 py-2.5 text-right font-semibold tabular-nums">{signed(m.onHandDelta !== 0 ? m.onHandDelta : m.reservedDelta)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{m.onHandAfter}</td><td className="px-3 py-2.5 text-right tabular-nums">{m.reservedAfter}</td>
                    <td className="px-3 py-2.5 text-xs text-muted">{[m.locationName, m.by, m.jobNumber && `job ${m.jobNumber}`, m.reason].filter(Boolean).join(' · ')}</td>
                    {costs && <td className="px-3 py-2.5 text-right tabular-nums">{money(m.unitCostCents, fmt)}</td>}
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

import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Card, EmptyState, LinkButton, PageHeader } from '@/components/ui';
import { InventoryNav, Kpi, MovementBadge, PoStatusBadge, money, signed } from '@/components/inventory/shared';
import { inventoryTabs } from '@/components/inventory/nav';
import { formatDate, formatDateTime } from '@/lib/format';
import { getInventoryDashboard } from '@/server/inventory/reports';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Stock' };
export const dynamic = 'force-dynamic';

export default async function InventoryPage({ searchParams }: { searchParams: Promise<{ location?: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'inventory.view');
  const sp = await searchParams;
  const d = await getInventoryDashboard(ctx, { locationId: sp.location || undefined });
  const fmt = { currency: ctx.business.currency, locale: ctx.business.locale };
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  const empty = d.kpis.totalItems === 0;

  return (
    <>
      <PageHeader
        title="Stock"
        description="Parts, quantities and purchasing. Available means on hand minus what is reserved for jobs."
        actions={<>
          {can('inventory.create') && <LinkButton href="/inventory/parts/new">Add part</LinkButton>}
          <LinkButton href="/inventory/scan" variant="secondary">Scan</LinkButton>
        </>}
      />
      <InventoryNav tabs={inventoryTabs(ctx)} active="overview" />

      {d.locations.length > 1 && (
        <form className="mb-4 flex items-center gap-2 text-sm" method="get">
          <label htmlFor="loc" className="text-muted">Location</label>
          <select id="loc" name="location" defaultValue={sp.location ?? ''} className="min-h-11 rounded-lg border border-line bg-surface px-3 md:min-h-10">
            <option value="">All my locations</option>
            {d.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <button className="min-h-11 rounded-lg border border-line bg-surface px-3 font-medium md:min-h-10">Show</button>
        </form>
      )}

      {empty ? (
        <EmptyState title="No parts yet" action={can('inventory.create') ? <div className="flex flex-wrap justify-center gap-2"><LinkButton href="/inventory/parts/new">Add a part</LinkButton>{can('inventory.import') && ctx.subscription.features.has('bulk_inventory') && <LinkButton href="/inventory/import" variant="secondary">Import parts</LinkButton>}</div> : undefined}>
          Add the parts you stock to track quantities, reserve them for jobs and reorder from suppliers.
        </EmptyState>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Parts" value={d.kpis.totalItems} hint={`${d.kpis.onHandUnits.toLocaleString('en-ZA')} units on hand`} href="/inventory/parts" />
            <Kpi label="Low stock" value={d.kpis.lowStock} tone={d.kpis.lowStock ? 'warn' : undefined} href="/inventory/parts?stock=low" />
            <Kpi label="Out of stock" value={d.kpis.outOfStock} tone={d.kpis.outOfStock ? 'danger' : undefined} href="/inventory/parts?stock=out" />
            <Kpi label="Reserved for jobs" value={d.kpis.reservedUnits} hint={`${d.kpis.reservedParts} part${d.kpis.reservedParts === 1 ? '' : 's'}`} href="/inventory/parts?stock=reserved" />
            {ctx.subscription.features.has('purchase_orders') && <Kpi label="Open orders" value={d.kpis.openOrders} hint={d.kpis.lateOrders ? `${d.kpis.lateOrders} late` : undefined} tone={d.kpis.lateOrders ? 'warn' : undefined} href="/purchase-orders?open=1" />}
            {d.kpis.pendingApproval > 0 && <Kpi label="Awaiting approval" value={d.kpis.pendingApproval} href="/purchase-orders?status=PENDING_APPROVAL" />}
            {d.valuation && <Kpi label="Stock value" value={money(d.valuation.valueCents, fmt)} hint={d.valuation.partsWithoutCost ? `${d.valuation.partsWithoutCost} part${d.valuation.partsWithoutCost === 1 ? '' : 's'} have no cost and are not included` : 'Operational figure'} />}
          </div>
          {d.valuation && <p className="text-xs text-muted">{d.valuation.note}</p>}

          {d.needsAttention.length > 0 && (
            <Card>
              <h2 className="mb-2 text-base font-semibold">Needs restocking</h2>
              <ul className="divide-y divide-line">
                {d.needsAttention.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <Link href={`/inventory/parts/${p.id}`} className="min-w-0 truncate font-medium text-brand-700 hover:underline">{p.sku} — {p.name}</Link>
                    <span className="shrink-0 text-right"><strong className={p.available <= 0 ? 'text-danger' : 'text-warn'}>{Math.max(0, p.available)} available</strong>{p.suggestedOrder > 0 && <span className="block text-xs text-muted">suggest ordering {p.suggestedOrder}</span>}</span>
                  </li>
                ))}
              </ul>
              <Link href="/inventory/reports?report=low" className="mt-2 inline-block text-sm font-medium text-brand-700 hover:underline">Full low-stock report</Link>
            </Card>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <h2 className="mb-2 text-base font-semibold">Recent movements</h2>
              {d.recentMovements.length === 0 ? <p className="text-sm text-muted">Stock activity will appear here.</p> : (
                <ul className="divide-y divide-line">
                  {d.recentMovements.map((m) => (
                    <li key={m.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                      <span className="min-w-0"><span className="block truncate font-medium">{m.sku} — {m.partName}</span><span className="text-xs text-muted">{formatDateTime(m.at, ctx.business.timezone, ctx.business.locale)}</span></span>
                      <span className="flex shrink-0 items-center gap-2"><MovementBadge type={m.type} /><strong className="w-10 text-right tabular-nums">{signed(m.delta)}</strong></span>
                    </li>
                  ))}
                </ul>
              )}
              <Link href="/inventory/movements" className="mt-2 inline-block text-sm font-medium text-brand-700 hover:underline">All movements</Link>
            </Card>
            {ctx.subscription.features.has('purchase_orders') && (
              <Card>
                <h2 className="mb-2 text-base font-semibold">Deliveries to expect</h2>
                {d.pendingDeliveries.length === 0 ? <p className="text-sm text-muted">No open purchase orders.</p> : (
                  <ul className="divide-y divide-line">
                    {d.pendingDeliveries.map((o) => (
                      <li key={o.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                        <span className="min-w-0"><Link href={`/purchase-orders/${o.id}`} className="font-semibold text-brand-700 hover:underline">{o.number}</Link><span className="block truncate text-xs text-muted">{o.supplierName}{o.expectedDate ? ` · due ${formatDate(`${o.expectedDate}T12:00:00Z`, 'UTC', ctx.business.locale)}` : ''}{o.late ? ' · late' : ''}</span></span>
                        <PoStatusBadge status={o.status} />
                      </li>
                    ))}
                  </ul>
                )}
                {d.recentPurchases.length > 0 && <p className="mt-2 text-xs text-muted">Last delivery: {d.recentPurchases[0]!.number} from {d.recentPurchases[0]!.supplierName}, {formatDate(d.recentPurchases[0]!.receivedAt, ctx.business.timezone, ctx.business.locale)}.</p>}
              </Card>
            )}
            <Card>
              <h2 className="mb-2 text-base font-semibold">Most used (90 days)</h2>
              {d.frequentlyUsed.length === 0 ? <p className="text-sm text-muted">Parts used on jobs will be ranked here.</p> : (
                <ol className="space-y-1.5 text-sm">{d.frequentlyUsed.map((u) => <li key={u.partId} className="flex justify-between gap-2"><Link href={`/inventory/parts/${u.partId}`} className="truncate text-brand-700 hover:underline">{u.name}</Link><strong className="tabular-nums">{u.units}</strong></li>)}</ol>
              )}
            </Card>
            <Card>
              <h2 className="mb-2 text-base font-semibold">Slow-moving</h2>
              {!d.slowMoving.enoughHistory ? <p className="text-sm text-muted">Not enough history yet: this appears once there is more than {d.slowMoving.windowDays} days of stock movements.</p> : d.slowMoving.items.length === 0 ? <p className="text-sm text-muted">Everything in stock has moved in the last {d.slowMoving.windowDays} days.</p> : (
                <ul className="space-y-1.5 text-sm">{d.slowMoving.items.map((s) => <li key={s.id} className="flex justify-between gap-2"><Link href={`/inventory/parts/${s.id}`} className="truncate text-brand-700 hover:underline">{s.name}</Link><span className="text-muted">{s.onHand} on hand</span></li>)}</ul>
              )}
              <p className="mt-2 text-xs text-muted">On hand and not used or sold in {d.slowMoving.windowDays} days.</p>
            </Card>
          </div>
        </div>
      )}
      {!ctx.subscription.canWrite && <div className="mt-4"><Alert tone="warn">Your subscription is read-only: you can look at stock but not change it.</Alert></div>}
    </>
  );
}

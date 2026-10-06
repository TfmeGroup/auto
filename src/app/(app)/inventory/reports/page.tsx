import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Card, EmptyState, LinkButton, PageHeader } from '@/components/ui';
import { InventoryNav, MOVEMENT_LABEL, StockBadge, money, signed } from '@/components/inventory/shared';
import { inventoryTabs } from '@/components/inventory/nav';
import { Chips, qs } from '@/components/workshop/layout';
import { lowStockReport, marginReport, movementSummary, purchaseSummary, usageReport, valuationReport } from '@/server/inventory/reports';
import { accessibleLocationsFor } from '@/server/inventory/queries';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Stock reports' };
export const dynamic = 'force-dynamic';

type Search = { report?: string; from?: string; to?: string; locationId?: string; by?: string };
const field = 'block min-h-11 w-full rounded-lg border border-line bg-surface px-3 md:min-h-10';

export default async function InventoryReportsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'inventory.view');
  const sp = await searchParams;
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  const advanced = ctx.subscription.features.has('inventory_reports');
  const costs = can('inventory.view_costs');
  const fmt = { currency: ctx.business.currency, locale: ctx.business.locale };
  const reports = [
    { key: 'low', label: 'Low stock', show: true },
    { key: 'usage', label: 'Part usage', show: true },
    { key: 'movements', label: 'Movement summary', show: true },
    { key: 'valuation', label: 'Valuation', show: costs },
    { key: 'margins', label: 'Margins', show: costs },
    { key: 'purchases', label: 'Purchasing', show: costs && ctx.subscription.features.has('purchase_orders') },
  ].filter((r) => r.show);
  const report = reports.find((r) => r.key === sp.report)?.key ?? 'low';
  const locations = await accessibleLocationsFor(ctx);
  const base = { from: sp.from, to: sp.to, locationId: sp.locationId, by: sp.by };
  const gated = ['valuation', 'margins', 'purchases'].includes(report) && !advanced;
  const exportLink = (dataset: string, extra = '') => can('inventory.export') ? <LinkButton href={`/api/v1/inventory/export?dataset=${dataset}&format=xlsx${sp.from ? `&from=${sp.from}` : ''}${sp.to ? `&to=${sp.to}` : ''}${sp.locationId ? `&locationId=${sp.locationId}` : ''}${extra}`} variant="secondary">Export</LinkButton> : null;

  return (
    <>
      <PageHeader title="Stock reports" description="Worked out from your real stock movements, deliveries and invoices." />
      <InventoryNav tabs={inventoryTabs(ctx)} active="reports" />
      <div className="mb-3"><Chips items={reports.map((r) => ({ label: r.label, href: `/inventory/reports${qs({ report: r.key, ...base })}`, active: r.key === report }))} /></div>
      <form action="/inventory/reports" className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5" role="search">
        <input type="hidden" name="report" value={report} />
        {['usage', 'movements', 'margins', 'purchases'].includes(report) && <><label className="grid gap-1 text-xs text-muted">From<input name="from" type="date" defaultValue={sp.from} className={field} /></label><label className="grid gap-1 text-xs text-muted">To<input name="to" type="date" defaultValue={sp.to} className={field} /></label></>}
        {locations.length > 1 && <label className="grid gap-1 text-xs text-muted">Location<select name="locationId" defaultValue={sp.locationId ?? ''} className={field}><option value="">All my locations</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>}
        {report === 'margins' && <label className="grid gap-1 text-xs text-muted">Group by<select name="by" defaultValue={sp.by ?? 'part'} className={field}>{['part', 'job', 'customer', 'vehicle', 'invoice'].map((b) => <option key={b} value={b}>{b}</option>)}</select></label>}
        {report === 'valuation' && <label className="grid gap-1 text-xs text-muted">Group by<select name="by" defaultValue={sp.by ?? 'category'} className={field}>{['category', 'supplier', 'location'].map((b) => <option key={b} value={b}>{b}</option>)}</select></label>}
        <button className="min-h-11 self-end rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white md:min-h-10">Apply</button>
      </form>

      {gated ? <Alert tone="warn">This report is part of advanced inventory reporting, included from the Business plan. {can('settings.manage_billing') ? <Link href="/settings/billing" className="font-medium underline">See plans</Link> : 'Ask an owner to upgrade.'}</Alert> : (
        <>
          {report === 'low' && await (async () => {
            const rows = await lowStockReport(ctx, { locationId: sp.locationId || undefined });
            return rows.length === 0 ? <EmptyState title="Nothing is low on stock">Parts at or below their minimum or reorder level will be listed here.</EmptyState> : (
              <Card>
                <div className="mb-2 flex items-center justify-between gap-2"><p className="text-sm text-muted">{rows.length} part{rows.length === 1 ? '' : 's'} need attention</p>{exportLink('low_stock')}</div>
                <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="text-left text-xs uppercase tracking-wide text-muted"><tr><th className="py-2 font-medium">Part</th><th className="py-2 text-right font-medium">Available</th><th className="py-2 text-right font-medium">Minimum</th><th className="py-2 font-medium">State</th><th className="py-2 font-medium">Supplier</th><th className="py-2 text-right font-medium">Suggested order</th>{costs && <th className="py-2 text-right font-medium">Est. cost</th>}</tr></thead>
                  <tbody className="divide-y divide-line">{rows.map((r) => <tr key={r.id}><td className="py-2"><Link href={`/inventory/parts/${r.id}`} className="font-medium text-brand-700 hover:underline">{r.sku}</Link><span className="block text-xs text-muted">{r.name}</span></td><td className="py-2 text-right tabular-nums">{r.available}<span className="block text-xs text-muted">{r.onHand} on hand</span></td><td className="py-2 text-right tabular-nums">{Math.max(r.minStock, r.reorderLevel ?? 0)}</td><td className="py-2"><StockBadge state={r.state} /></td><td className="py-2 text-muted">{r.supplier ?? '—'}</td><td className="py-2 text-right tabular-nums">{r.suggestedOrder || '—'}</td>{costs && <td className="py-2 text-right tabular-nums">{money(r.estimatedCostCents, fmt)}</td>}</tr>)}</tbody></table></div>
              </Card>
            );
          })()}
          {report === 'usage' && await (async () => {
            const r = await usageReport(ctx, { from: sp.from, to: sp.to, locationId: sp.locationId || undefined });
            return r.items.length === 0 ? <EmptyState title="No parts used in this period" /> : (
              <Card>
                <div className="mb-2 flex items-center justify-between gap-2"><p className="text-sm text-muted">{r.range.from} to {r.range.to}</p>{exportLink('part_usage')}</div>
                <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="text-left text-xs uppercase tracking-wide text-muted"><tr><th className="py-2 font-medium">Part</th><th className="py-2 text-right font-medium">Units used</th><th className="py-2 text-right font-medium">Jobs</th>{costs && <th className="py-2 text-right font-medium">Cost</th>}</tr></thead>
                  <tbody className="divide-y divide-line">{r.items.map((i) => <tr key={i.partId}><td className="py-2"><Link href={`/inventory/parts/${i.partId}`} className="font-medium text-brand-700 hover:underline">{i.sku}</Link><span className="block text-xs text-muted">{i.name}</span></td><td className="py-2 text-right tabular-nums">{i.units}</td><td className="py-2 text-right tabular-nums">{i.jobs}</td>{costs && <td className="py-2 text-right tabular-nums">{money(i.costCents, fmt)}</td>}</tr>)}</tbody></table></div>
              </Card>
            );
          })()}
          {report === 'movements' && await (async () => {
            const r = await movementSummary(ctx, { from: sp.from, to: sp.to, locationId: sp.locationId || undefined });
            return r.items.length === 0 ? <EmptyState title="No stock movements in this period" /> : (
              <Card>
                <div className="mb-2 flex items-center justify-between gap-2"><p className="text-sm text-muted">{r.range.from} to {r.range.to}</p>{exportLink('movements')}</div>
                <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="text-left text-xs uppercase tracking-wide text-muted"><tr><th className="py-2 font-medium">Movement</th><th className="py-2 text-right font-medium">Count</th><th className="py-2 text-right font-medium">Change in stock on hand</th><th className="py-2 text-right font-medium">Change in reserved</th></tr></thead>
                  <tbody className="divide-y divide-line">{r.items.map((i) => <tr key={i.type}><td className="py-2">{MOVEMENT_LABEL[i.type] ?? i.type}</td><td className="py-2 text-right tabular-nums">{i.movements}</td><td className="py-2 text-right tabular-nums">{signed(i.onHandChange)}</td><td className="py-2 text-right tabular-nums">{signed(i.reservedChange)}</td></tr>)}</tbody></table></div>
              </Card>
            );
          })()}
          {report === 'valuation' && await (async () => {
            const r = await valuationReport(ctx, { locationId: sp.locationId || undefined, by: sp.by === 'supplier' || sp.by === 'location' ? sp.by : 'category' });
            return (
              <Card>
                <div className="mb-2 flex items-center justify-between gap-2"><p className="text-sm text-muted">{r.note}</p>{exportLink('valuation', `&by=${r.by}`)}</div>
                <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="text-left text-xs uppercase tracking-wide text-muted"><tr><th className="py-2 font-medium capitalize">{r.by}</th><th className="py-2 text-right font-medium">Parts</th><th className="py-2 text-right font-medium">Units</th><th className="py-2 text-right font-medium">Value</th><th className="py-2 text-right font-medium">No cost recorded</th></tr></thead>
                  <tbody className="divide-y divide-line">{r.rows.map((x) => <tr key={x.label}><td className="py-2">{x.label}</td><td className="py-2 text-right tabular-nums">{x.parts}</td><td className="py-2 text-right tabular-nums">{x.units}</td><td className="py-2 text-right tabular-nums">{money(x.valueCents, fmt)}</td><td className="py-2 text-right tabular-nums">{x.partsWithoutCost || '—'}</td></tr>)}</tbody>
                  <tfoot><tr className="border-t border-line font-bold"><td className="py-2" colSpan={3}>Total</td><td className="py-2 text-right tabular-nums">{money(r.totalCents, fmt)}</td><td /></tr></tfoot></table></div>
              </Card>
            );
          })()}
          {report === 'margins' && await (async () => {
            const r = await marginReport(ctx, { from: sp.from, to: sp.to, by: ['part', 'job', 'customer', 'vehicle', 'invoice'].includes(sp.by ?? '') ? sp.by : 'part' });
            return r.items.length === 0 ? <EmptyState title="No invoiced parts in this period">Margins come from finalised invoices that include parts.</EmptyState> : (
              <Card>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><p className="text-sm text-muted">{r.range.from} to {r.range.to} · revenue excludes VAT{r.totals.linesWithoutCost > 0 ? ` · ${r.totals.linesWithoutCost} line${r.totals.linesWithoutCost === 1 ? '' : 's'} have no recorded cost and count as zero cost` : ''}</p>{exportLink('profitability', `&by=${r.by}`)}</div>
                <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="text-left text-xs uppercase tracking-wide text-muted"><tr><th className="py-2 font-medium capitalize">{r.by}</th><th className="py-2 text-right font-medium">Revenue</th><th className="py-2 text-right font-medium">Cost</th><th className="py-2 text-right font-medium">Margin</th><th className="py-2 text-right font-medium">%</th></tr></thead>
                  <tbody className="divide-y divide-line">{r.items.map((x) => <tr key={x.key ?? 'none'}><td className="py-2">{x.label}</td><td className="py-2 text-right tabular-nums">{money(x.revenueCents, fmt)}</td><td className="py-2 text-right tabular-nums">{money(x.costCents, fmt)}</td><td className="py-2 text-right font-medium tabular-nums">{money(x.marginCents, fmt)}</td><td className="py-2 text-right tabular-nums">{x.marginBps === null ? '—' : `${(x.marginBps / 100).toFixed(1)}%`}</td></tr>)}</tbody>
                  <tfoot><tr className="border-t border-line font-bold"><td className="py-2">Total</td><td className="py-2 text-right tabular-nums">{money(r.totals.revenueCents, fmt)}</td><td className="py-2 text-right tabular-nums">{money(r.totals.costCents, fmt)}</td><td className="py-2 text-right tabular-nums">{money(r.totals.marginCents, fmt)}</td><td className="py-2 text-right tabular-nums">{r.totals.marginBps === null ? '—' : `${(r.totals.marginBps / 100).toFixed(1)}%`}</td></tr></tfoot></table></div>
              </Card>
            );
          })()}
          {report === 'purchases' && await (async () => {
            const r = await purchaseSummary(ctx, { from: sp.from, to: sp.to, locationId: sp.locationId || undefined });
            return r.items.length === 0 ? <EmptyState title="No purchases in this period" /> : (
              <Card>
                <p className="mb-2 text-sm text-muted">{r.range.from} to {r.range.to}</p>
                <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="text-left text-xs uppercase tracking-wide text-muted"><tr><th className="py-2 font-medium">Supplier</th><th className="py-2 text-right font-medium">Orders</th><th className="py-2 text-right font-medium">Ordered</th><th className="py-2 text-right font-medium">Delivered</th></tr></thead>
                  <tbody className="divide-y divide-line">{r.items.map((x) => <tr key={x.supplierId}><td className="py-2"><Link href={`/inventory/suppliers/${x.supplierId}`} className="font-medium text-brand-700 hover:underline">{x.name}</Link></td><td className="py-2 text-right tabular-nums">{x.orders}</td><td className="py-2 text-right tabular-nums">{money(x.orderedCents, fmt)}</td><td className="py-2 text-right tabular-nums">{money(x.receivedCents, fmt)}</td></tr>)}</tbody></table></div>
              </Card>
            );
          })()}
        </>
      )}
    </>
  );
}

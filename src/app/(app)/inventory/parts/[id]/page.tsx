import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, Badge, Card, EmptyState, LinkButton, PageHeader, Pagination } from '@/components/ui';
import { ActionButton } from '@/components/forms/RowActions';
import { InlineForm } from '@/components/forms/InlineForm';
import { AdjustStockForm, BinForm } from '@/components/inventory/StockForms';
import { MovementBadge, RecordStatusBadge, StockBadge, StockNumbers, money, signed } from '@/components/inventory/shared';
import { PartFilesPanel } from '@/components/inventory/PartFilesPanel';
import { Row, Stat, Tabs, qs } from '@/components/workshop/layout';
import { formatDate, formatDateTime } from '@/lib/format';
import { isAppError } from '@/lib/errors';
import { getPart, listPartActivity, listPartJobs, listPartPrices, listPartPurchases } from '@/server/inventory/parts';
import { listMovements } from '@/server/inventory/stock';
import { assertCan, requireBusiness } from '@/server/web/session';
import { listSuppliers } from '@/server/inventory/suppliers';

export const metadata: Metadata = { title: 'Part' };
export const dynamic = 'force-dynamic';

const ACTION_LABEL: Record<string, string> = {
  'part.created': 'Part added', 'part.updated': 'Details changed', 'part.price_changed': 'Price or cost changed', 'part.archived': 'Archived', 'part.restored': 'Restored',
  'part.supplier_changed': 'Supplier changed', 'part.compatibility_changed': 'Compatibility changed', 'parts.imported': 'Imported',
};

export default async function PartPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; page?: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'inventory.view');
  const { id } = await params;
  const sp = await searchParams;
  let d;
  try {
    d = await getPart(ctx, id);
  } catch (e) {
    if (isAppError(e) && (e.status === 404 || e.status === 422)) notFound();
    throw e;
  }
  const p = d.part;
  const fmt = { currency: ctx.business.currency, locale: ctx.business.locale };
  const can = (x: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(x);
  const writable = ctx.subscription.canWrite;
  const costs = d.canSeeCosts;
  const tabs = [
    { key: 'overview', label: 'Overview' }, { key: 'stock', label: 'Stock' }, { key: 'movements', label: 'Movements' }, { key: 'jobs', label: 'Jobs' }, { key: 'purchases', label: 'Purchases' },
    { key: 'suppliers', label: `Suppliers${d.suppliers.length ? ` (${d.suppliers.filter((s) => s.status === 'ACTIVE').length})` : ''}` },
    ...(costs ? [{ key: 'pricing', label: 'Pricing' }] : []),
    { key: 'compatibility', label: `Compatibility${d.compatibility.length ? ` (${d.compatibility.length})` : ''}` }, { key: 'documents', label: 'Documents' }, { key: 'photos', label: 'Photos' }, { key: 'activity', label: 'Activity' },
  ];
  const tab = tabs.find((t) => t.key === sp.tab)?.key ?? 'overview';
  const page = Math.max(1, Number(sp.page) || 1);
  const hrefTab = (key: string) => `/inventory/parts/${p.id}${qs({ tab: key === 'overview' ? undefined : key })}`;
  const pager = (meta: { page: number; totalPages: number; total: number }) => <Pagination page={meta.page} totalPages={meta.totalPages} total={meta.total} hrefFor={(n) => `${hrefTab(tab)}${hrefTab(tab).includes('?') ? '&' : '?'}page=${n}`} />;
  const locs = d.stock.map((s) => ({ id: s.locationId, name: s.locationName, bin: s.bin, storageArea: s.storageArea }));

  return (
    <>
      <PageHeader
        title={p.name}
        description={[p.sku, p.partNumber, p.brand, p.categoryName].filter(Boolean).join(' · ')}
        actions={<>{can('inventory.edit') && p.status !== 'ARCHIVED' && <LinkButton href={`/inventory/parts/${p.id}/edit`} variant="secondary">Edit</LinkButton>}<LinkButton href="/inventory/parts" variant="secondary">All parts</LinkButton></>}
      />
      <div className="mb-3 flex flex-wrap items-center gap-2"><StockBadge state={p.state} /><RecordStatusBadge status={p.status} />{d.onOrder > 0 && <Badge tone="brand">{d.onOrder} on order</Badge>}</div>
      <Tabs tabs={tabs} active={tab} hrefFor={hrefTab} />

      {tab === 'overview' && (
        <div className="space-y-4">
          <Card className="space-y-3">
            <StockNumbers onHand={p.onHand} reserved={p.reserved} available={p.available} unit={p.unit} />
            <p className="text-xs text-muted">Available is what can still be promised to a job: on hand minus what is reserved. Reserved stock is still on the shelf until the part is fitted.</p>
            {p.available <= 0 && p.status === 'ACTIVE' && <Alert tone="warn">None available.{d.suggestedReorder > 0 ? ` Suggested order: ${d.suggestedReorder}.` : ''}{can('inventory.purchase') && ctx.subscription.features.has('purchase_orders') ? <> <Link href={`/purchase-orders/new?partId=${p.id}`} className="font-medium underline">Order more</Link></> : null}</Alert>}
          </Card>
          <Card>
            <dl className="divide-y divide-line">
              <Row label="Selling price">{money(p.sellPriceCents, fmt)}{p.taxTreatment !== 'STANDARD' ? ` (${p.taxTreatment.toLowerCase().replace('_', ' ')})` : ''}</Row>
              {costs && <Row label="Cost price">{money(p.costCents, fmt)}</Row>}
              {costs && p.costCents !== null && p.sellPriceCents !== null && p.sellPriceCents > 0 && <Row label="Margin">{money(p.sellPriceCents - p.costCents, fmt)} ({Math.round(((p.sellPriceCents - p.costCents) * 100) / p.sellPriceCents)}%)</Row>}
              <Row label="Minimum stock">{p.minStock}</Row>
              <Row label="Reorder">{p.reorderLevel != null || p.reorderQuantity != null ? `level ${p.reorderLevel ?? '—'}, quantity ${p.reorderQuantity ?? '—'}` : null}</Row>
              <Row label="Barcode">{p.barcode}</Row>
              <Row label="Manufacturer">{p.manufacturer}</Row>
              <Row label="Main supplier">{p.primarySupplierId ? <Link href={`/inventory/suppliers/${p.primarySupplierId}`} className="text-brand-700 hover:underline">{p.primarySupplierName}</Link> : null}</Row>
              <Row label="Description">{p.description}</Row>
              <Row label="Notes">{p.notes}</Row>
              <Row label="Added">{formatDate(p.createdAt, ctx.business.timezone, ctx.business.locale)}{d.createdByName ? ` by ${d.createdByName}` : ''}</Row>
              <Row label="Last changed">{formatDate(p.updatedAt, ctx.business.timezone, ctx.business.locale)}{d.updatedByName ? ` by ${d.updatedByName}` : ''}</Row>
            </dl>
          </Card>
          {can('inventory.edit') && writable && (
            <Card className="flex flex-wrap gap-2">
              {p.status === 'ACTIVE' && <ActionButton label="Make inactive" variant="secondary" path={`/api/v1/inventory/parts/${p.id}/status`} body={{ status: 'INACTIVE' }} confirm="Inactive parts stay in the catalogue but cannot be added to new jobs or orders." />}
              {p.status !== 'ACTIVE' && <ActionButton label="Make active" variant="secondary" path={`/api/v1/inventory/parts/${p.id}/status`} body={{ status: 'ACTIVE' }} />}
              {p.status !== 'ARCHIVED' && <ActionButton label="Archive" variant="ghost" path={`/api/v1/inventory/parts/${p.id}/status`} body={{ status: 'ARCHIVED' }} confirm="Archive this part? It must have no stock. Its history is kept." />}
            </Card>
          )}
        </div>
      )}

      {tab === 'stock' && (
        <div className="space-y-4">
          <Card>
            <h2 className="mb-2 text-base font-semibold">By location</h2>
            <ul className="space-y-2">
              {d.stock.map((s) => (
                <li key={s.locationId} className="rounded-lg border border-line p-3">
                  <p className="mb-2 text-sm font-semibold">{s.locationName}{s.storageArea || s.bin ? <span className="font-normal text-muted"> · {[s.storageArea, s.bin].filter(Boolean).join(' → ')}</span> : null}</p>
                  <StockNumbers onHand={s.onHand} reserved={s.reserved} available={s.available} compact />
                </li>
              ))}
            </ul>
          </Card>
          {can('inventory.adjust') && writable && p.status !== 'ARCHIVED' && <Card><h2 className="mb-2 text-base font-semibold">Adjust stock</h2><AdjustStockForm partId={p.id} locations={locs} unit={p.unit} /></Card>}
          {can('inventory.edit') && writable && <Card><h2 className="mb-2 text-base font-semibold">Where it is kept</h2><BinForm partId={p.id} locations={locs} /></Card>}
        </div>
      )}

      {tab === 'movements' && await (async () => {
        const r = await listMovements(ctx, { partId: p.id, page });
        return r.items.length === 0 ? <EmptyState title="No stock movements">Stock activity will appear here.</EmptyState> : (
          <>
            <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
              {r.items.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
                  <span className="min-w-0"><MovementBadge type={m.type} /> <span className="text-muted">{m.locationName}{m.jobNumber ? ` · job ${m.jobNumber}` : ''}{m.reason ? ` · ${m.reason}` : ''}</span><span className="block text-xs text-muted">{formatDateTime(m.createdAt, ctx.business.timezone, ctx.business.locale)}{m.by ? ` · ${m.by}` : ''}{m.wentNegative ? ' · went below zero' : ''}</span></span>
                  <span className="text-right tabular-nums"><strong>{signed(m.onHandDelta !== 0 ? m.onHandDelta : m.reservedDelta)}</strong><span className="block text-xs text-muted">{m.onHandDelta !== 0 ? `${m.onHandBefore} → ${m.onHandAfter} on hand` : `${m.reservedBefore} → ${m.reservedAfter} reserved`}</span></span>
                </li>
              ))}
            </ul>
            {pager(r.meta)}
          </>
        );
      })()}

      {tab === 'jobs' && await (async () => {
        if (!can('job.view')) return <p className="text-sm text-muted">You do not have access to jobs.</p>;
        const r = await listPartJobs(ctx, p.id, { page });
        return r.items.length === 0 ? <EmptyState title="Not used on any job yet">Jobs that reserve or use this part will be listed here.</EmptyState> : (
          <>
            <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
              {r.items.map((j) => (
                <li key={j.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
                  <span><Link href={`/jobs/${j.jobId}`} className="font-semibold text-brand-700 hover:underline">{j.jobNumber}</Link> <span className="text-muted">{j.registration ?? ''}</span></span>
                  <span className="flex items-center gap-2"><span className="tabular-nums">{j.quantity} ×</span><Badge>{j.status.toLowerCase()}</Badge></span>
                </li>
              ))}
            </ul>
            {pager(r.meta)}
          </>
        );
      })()}

      {tab === 'purchases' && await (async () => {
        const r = await listPartPurchases(ctx, p.id, { page });
        return r.items.length === 0 ? <EmptyState title="No deliveries yet">Deliveries received against purchase orders will be listed here with the price actually paid.</EmptyState> : (
          <>
            <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
              {r.items.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
                  <span className="min-w-0"><Link href={`/purchase-orders/${b.orderId}`} className="font-semibold text-brand-700 hover:underline">{b.orderNumber}</Link> <span className="text-muted">· {b.receiptNumber} · {b.supplierName}</span><span className="block text-xs text-muted">{formatDate(b.receivedAt, ctx.business.timezone, ctx.business.locale)}</span></span>
                  <span className="text-right tabular-nums">{b.quantityReceived} received{b.quantityDamaged ? `, ${b.quantityDamaged} damaged` : ''}{b.quantityReturned ? `, ${b.quantityReturned} returned` : ''}{costs && <span className="block text-xs text-muted">paid {money(b.unitCostCents, fmt)} each</span>}</span>
                </li>
              ))}
            </ul>
            {pager(r.meta)}
          </>
        );
      })()}

      {tab === 'suppliers' && await (async () => {
        const all = (await listSuppliers(ctx, { pageSize: 100 })).items;
        return (
          <div className="space-y-4">
            <Card>
              <h2 className="mb-2 text-base font-semibold">Who supplies it</h2>
              {d.suppliers.length === 0 ? <p className="text-sm text-muted">No suppliers linked yet.</p> : (
                <ul className="divide-y divide-line">
                  {d.suppliers.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                      <span><Link href={`/inventory/suppliers/${s.supplierId}`} className="font-semibold text-brand-700 hover:underline">{s.supplierName}</Link> {s.preferred && <Badge tone="brand">Preferred</Badge>} {s.status !== 'ACTIVE' && <Badge>inactive</Badge>}<span className="block text-xs text-muted">{[s.supplierPartNumber && `their no. ${s.supplierPartNumber}`, costs && s.supplierCostCents != null && `quoted ${money(s.supplierCostCents, fmt)}`, s.leadTimeDays != null && `${s.leadTimeDays} day lead time`].filter(Boolean).join(' · ')}</span></span>
                      {can('inventory.edit') && writable && s.status === 'ACTIVE' && <ActionButton label="Remove" variant="ghost" method="DELETE" path={`/api/v1/inventory/parts/${p.id}/suppliers/${s.supplierId}`} confirm="Stop listing this supplier for the part? Past purchases keep their history." />}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-xs text-muted">A supplier&apos;s quoted cost here never changes what was paid on purchases already made.</p>
            </Card>
            {can('inventory.edit') && writable && (
              <Card>
                <h2 className="mb-2 text-base font-semibold">Add or update a supplier</h2>
                <InlineForm endpoint={`/api/v1/inventory/parts/${p.id}/suppliers`} submitLabel="Save supplier" fields={[
                  { name: 'supplierId', label: 'Supplier', type: 'select', required: true, options: [{ value: '', label: 'Choose…' }, ...all.filter((s) => s.status === 'ACTIVE').map((s) => ({ value: s.id, label: s.name }))] },
                  { name: 'supplierPartNumber', label: 'Their part number' },
                  ...(costs ? [{ name: 'supplierCostCents', label: 'Their cost (rand)', inputMode: 'decimal' as const, parse: 'cents' as const }] : []),
                  { name: 'leadTimeDays', label: 'Lead time (days)', type: 'number' as const }, { name: 'preferred', label: 'Preferred supplier for this part', type: 'checkbox' as const },
                ]} />
              </Card>
            )}
          </div>
        );
      })()}

      {tab === 'pricing' && costs && await (async () => {
        const r = await listPartPrices(ctx, p.id, { page });
        return (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3"><Stat label="Selling price" value={money(p.sellPriceCents, fmt)} /><Stat label="Cost price" value={money(p.costCents, fmt)} /></div>
            {r.items.length === 0 ? <EmptyState title="No price history yet" /> : (
              <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
                {r.items.map((h) => (
                  <li key={h.id} className="px-3 py-2.5 text-sm">
                    <p className="flex flex-wrap justify-between gap-2"><span>{h.previousCostCents !== h.newCostCents && <span>Cost {money(h.previousCostCents, fmt)} → <strong>{money(h.newCostCents, fmt)}</strong> </span>}{h.previousSellCents !== h.newSellCents && <span>Price {money(h.previousSellCents, fmt)} → <strong>{money(h.newSellCents, fmt)}</strong></span>}</span><span className="text-xs text-muted">{formatDate(h.changedAt, ctx.business.timezone, ctx.business.locale)}</span></p>
                    <p className="text-xs text-muted">{h.source.toLowerCase()}{h.changedByName ? ` · ${h.changedByName}` : ''}{h.reason ? ` · ${h.reason}` : ''}</p>
                  </li>
                ))}
              </ul>
            )}
            {pager(r.meta)}
          </div>
        );
      })()}

      {tab === 'compatibility' && (
        <div className="space-y-4">
          <Card>
            <h2 className="mb-2 text-base font-semibold">Fits these vehicles</h2>
            {d.compatibility.length === 0 ? <p className="text-sm text-muted">No fitment information yet. Add the makes, models and years this part is used on to find it by vehicle.</p> : (
              <ul className="divide-y divide-line">
                {d.compatibility.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                    <span>{[c.make, c.model, c.variant].filter(Boolean).join(' ') || 'Any vehicle'}{c.yearFrom || c.yearTo ? ` · ${c.yearFrom ?? '…'}–${c.yearTo ?? '…'}` : ''}<span className="block text-xs text-muted">{[c.engine, c.engineSizeCc && `${c.engineSizeCc} cc`, c.fuelType?.toLowerCase(), c.transmission?.toLowerCase(), c.notes].filter(Boolean).join(' · ')}</span></span>
                    {can('inventory.edit') && writable && <ActionButton label="Remove" variant="ghost" method="DELETE" path={`/api/v1/inventory/parts/${p.id}/compatibility/${c.id}`} />}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-muted">This helps staff find parts. It is a search aid, not a fitment guarantee: the technician decides what fits.</p>
          </Card>
          {can('inventory.edit') && writable && (
            <Card>
              <h2 className="mb-2 text-base font-semibold">Add a vehicle</h2>
              <InlineForm endpoint={`/api/v1/inventory/parts/${p.id}/compatibility`} submitLabel="Add" fields={[
                { name: 'make', label: 'Make' }, { name: 'model', label: 'Model' }, { name: 'yearFrom', label: 'From year', type: 'number' }, { name: 'yearTo', label: 'To year', type: 'number' },
                { name: 'variant', label: 'Variant' }, { name: 'engine', label: 'Engine' }, { name: 'engineSizeCc', label: 'Engine size (cc)', type: 'number' },
                { name: 'fuelType', label: 'Fuel', type: 'select', options: [{ value: '', label: 'Any' }, ...['PETROL', 'DIESEL', 'HYBRID', 'ELECTRIC', 'LPG', 'OTHER'].map((v) => ({ value: v, label: v.charAt(0) + v.slice(1).toLowerCase() }))] },
                { name: 'transmission', label: 'Transmission', type: 'select', options: [{ value: '', label: 'Any' }, ...['MANUAL', 'AUTOMATIC', 'CVT', 'DCT', 'OTHER'].map((v) => ({ value: v, label: v.charAt(0) + v.slice(1).toLowerCase() }))] },
                { name: 'notes', label: 'Notes', span: 'full' },
              ]} />
            </Card>
          )}
        </div>
      )}

      {tab === 'documents' && <PartFilesPanel ctx={ctx} resourceType="part" resourceId={p.id} kind="documents" title="Documents (warranty, datasheets, labels)" />}
      {tab === 'photos' && <PartFilesPanel ctx={ctx} resourceType="part" resourceId={p.id} kind="photos" />}

      {tab === 'activity' && await (async () => {
        const r = await listPartActivity(ctx, p.id, { page });
        return r.items.length === 0 ? <EmptyState title="No activity yet" /> : (
          <>
            <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
              {r.items.map((a) => (
                <li key={a.id} className="px-3 py-2.5 text-sm">
                  <p className="flex flex-wrap justify-between gap-2"><span className="font-medium">{ACTION_LABEL[a.action] ?? a.action}</span><span className="text-xs text-muted">{formatDateTime(a.at, ctx.business.timezone, ctx.business.locale)}{a.by ? ` · ${a.by}` : ''}</span></p>
                  {(a.fields.length > 0 || a.reason) && <p className="text-xs text-muted">{a.fields.length > 0 && `Changed: ${a.fields.join(', ')}`}{a.reason ? ` · ${a.reason}` : ''}</p>}
                </li>
              ))}
            </ul>
            {pager(r.meta)}
          </>
        );
      })()}
    </>
  );
}

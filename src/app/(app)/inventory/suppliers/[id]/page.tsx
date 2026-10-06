import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, Card, EmptyState, LinkButton, PageHeader, Pagination } from '@/components/ui';
import { ActionButton } from '@/components/forms/RowActions';
import { PartFilesPanel } from '@/components/inventory/PartFilesPanel';
import { PoStatusBadge, RecordStatusBadge, money } from '@/components/inventory/shared';
import { Row, Stat, Tabs, qs } from '@/components/workshop/layout';
import { formatDate, formatDateTime } from '@/lib/format';
import { isAppError } from '@/lib/errors';
import { getSupplier, supplierPurchaseHistory } from '@/server/inventory/suppliers';
import { listReceipts, listSupplierReturns } from '@/server/inventory/receiving';
import { assertCan, requireBusiness } from '@/server/web/session';
import { withTenant } from '@/server/db/client';

export const metadata: Metadata = { title: 'Supplier' };
export const dynamic = 'force-dynamic';

export default async function SupplierPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; page?: string; status?: string; from?: string; to?: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'inventory.view');
  const { id } = await params;
  const sp = await searchParams;
  let d;
  try {
    d = await getSupplier(ctx, id);
  } catch (e) {
    if (isAppError(e) && (e.status === 404 || e.status === 422)) notFound();
    throw e;
  }
  const s = d.supplier;
  const fmt = { currency: ctx.business.currency, locale: ctx.business.locale };
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  const hasPO = ctx.subscription.features.has('purchase_orders');
  const tabs = [
    { key: 'overview', label: 'Overview' }, { key: 'parts', label: `Parts supplied${d.parts.length ? ` (${d.parts.length})` : ''}` },
    ...(hasPO ? [{ key: 'orders', label: 'Purchase orders' }, { key: 'deliveries', label: 'Deliveries & returns' }] : []),
    { key: 'documents', label: 'Documents' }, { key: 'activity', label: 'Activity' },
  ];
  const tab = tabs.find((t) => t.key === sp.tab)?.key ?? 'overview';
  const page = Math.max(1, Number(sp.page) || 1);
  const hrefTab = (key: string) => `/inventory/suppliers/${s.id}${qs({ tab: key === 'overview' ? undefined : key })}`;
  const pager = (meta: { page: number; totalPages: number; total: number }) => <Pagination page={meta.page} totalPages={meta.totalPages} total={meta.total} hrefFor={(n) => `${hrefTab(tab)}${hrefTab(tab).includes('?') ? '&' : '?'}page=${n}${sp.status ? `&status=${sp.status}` : ''}${sp.from ? `&from=${sp.from}` : ''}${sp.to ? `&to=${sp.to}` : ''}`} />;

  return (
    <>
      <PageHeader
        title={s.name}
        description={[s.tradingName, s.contactPerson].filter(Boolean).join(' · ') || undefined}
        actions={<>{can('inventory.manage_suppliers') && <LinkButton href={`/inventory/suppliers/${s.id}/edit`} variant="secondary">Edit</LinkButton>}{hasPO && can('inventory.purchase') && s.status === 'ACTIVE' && <LinkButton href={`/purchase-orders/new?supplierId=${s.id}`}>New purchase order</LinkButton>}</>}
      />
      <div className="mb-3 flex flex-wrap items-center gap-2"><RecordStatusBadge status={s.status} />{d.summary.openOrders > 0 && <Badge tone="brand">{d.summary.openOrders} open order{d.summary.openOrders === 1 ? '' : 's'}</Badge>}</div>
      <Tabs tabs={tabs} active={tab} hrefFor={hrefTab} />

      {tab === 'overview' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Orders" value={d.summary.orderCount} /><Stat label="Returns" value={d.summary.returns} />
            {d.canSeeCosts && <Stat label="Ordered in total" value={money(d.summary.orderedTotalCents, fmt)} />}
            <Stat label="Last delivery" value={d.summary.lastDelivery ? formatDate(d.summary.lastDelivery.receivedAt, ctx.business.timezone, ctx.business.locale) : '—'} hint={d.summary.lastDelivery?.number} />
          </div>
          <Card>
            <dl className="divide-y divide-line">
              <Row label="Phone">{s.phone && <a href={`tel:${s.phone}`} className="text-brand-700 hover:underline">{s.phone}</a>}</Row>
              <Row label="Email">{s.email && <a href={`mailto:${s.email}`} className="text-brand-700 hover:underline">{s.email}</a>}</Row>
              <Row label="Address">{s.address}</Row>
              <Row label="Our account no.">{s.accountNumber}</Row>
              <Row label="VAT number">{s.vatNumber}</Row>
              <Row label="Registration">{s.registrationNumber}</Row>
              <Row label="Payment terms">{s.paymentTerms}</Row>
              <Row label="Notes">{s.notes}</Row>
              <Row label="Added">{formatDate(s.createdAt, ctx.business.timezone, ctx.business.locale)}{d.createdByName ? ` by ${d.createdByName}` : ''}</Row>
            </dl>
          </Card>
          {can('inventory.manage_suppliers') && ctx.subscription.canWrite && (
            <Card className="flex flex-wrap gap-2">
              {s.status === 'ACTIVE' && <ActionButton label="Make inactive" variant="secondary" path={`/api/v1/inventory/suppliers/${s.id}/status`} body={{ status: 'INACTIVE' }} confirm="Inactive suppliers cannot be chosen for new orders. Open orders must be finished first." />}
              {s.status !== 'ACTIVE' && <ActionButton label="Make active" variant="secondary" path={`/api/v1/inventory/suppliers/${s.id}/status`} body={{ status: 'ACTIVE' }} />}
              {s.status !== 'ARCHIVED' && <ActionButton label="Archive" variant="ghost" path={`/api/v1/inventory/suppliers/${s.id}/status`} body={{ status: 'ARCHIVED' }} confirm="Archive this supplier? Their history is kept." />}
            </Card>
          )}
        </div>
      )}

      {tab === 'parts' && (d.parts.length === 0 ? <EmptyState title="No parts linked yet">Link this supplier to a part from the part&apos;s Suppliers tab.</EmptyState> : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {d.parts.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
              <span className="min-w-0"><Link href={`/inventory/parts/${p.id}`} className="font-semibold text-brand-700 hover:underline">{p.name}</Link> {p.preferred && <Badge tone="brand">Preferred</Badge>}<span className="block text-xs text-muted">{p.sku}{p.supplierPartNumber ? ` · their no. ${p.supplierPartNumber}` : ''}{p.leadTimeDays != null ? ` · ${p.leadTimeDays} day lead time` : ''}</span></span>
              {d.canSeeCosts && p.supplierCostCents != null && <span className="tabular-nums">{money(p.supplierCostCents, fmt)}</span>}
            </li>
          ))}
        </ul>
      ))}

      {tab === 'orders' && await (async () => {
        const r = await supplierPurchaseHistory(ctx, s.id, { page, status: sp.status, from: sp.from, to: sp.to });
        return (
          <div className="space-y-3">
            <form action={`/inventory/suppliers/${s.id}`} className="grid gap-2 sm:grid-cols-4" role="search">
              <input type="hidden" name="tab" value="orders" />
              <select name="status" defaultValue={sp.status ?? ''} aria-label="Status" className="min-h-11 rounded-lg border border-line bg-surface px-3 md:min-h-10"><option value="">Any status</option><option value="DRAFT">Draft</option><option value="ORDERED,PARTIALLY_RECEIVED">Open</option><option value="RECEIVED">Received</option><option value="CANCELLED">Cancelled</option></select>
              <input type="date" name="from" defaultValue={sp.from} aria-label="From" className="min-h-11 rounded-lg border border-line bg-surface px-3 md:min-h-10" />
              <input type="date" name="to" defaultValue={sp.to} aria-label="To" className="min-h-11 rounded-lg border border-line bg-surface px-3 md:min-h-10" />
              <button className="min-h-11 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white md:min-h-10">Filter</button>
            </form>
            {r.items.length === 0 ? <EmptyState title="No purchase orders match" /> : (
              <>
                <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
                  {r.items.map((o) => (
                    <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
                      <span><Link href={`/purchase-orders/${o.id}`} className="font-semibold text-brand-700 hover:underline">{o.number}</Link> <span className="text-xs text-muted">{formatDate(o.poDate, 'UTC', ctx.business.locale)} · {o.received}/{o.ordered} received</span></span>
                      <span className="flex items-center gap-2">{d.canSeeCosts && <span className="tabular-nums">{money(o.totalCents, fmt)}</span>}<PoStatusBadge status={o.status} /></span>
                    </li>
                  ))}
                </ul>
                {pager(r.meta)}
              </>
            )}
            {can('inventory.export') && <p className="text-xs"><a className="font-medium text-brand-700 hover:underline" href={`/api/v1/inventory/export?dataset=supplier_history&supplierId=${s.id}&format=xlsx`}>Export this history</a></p>}
          </div>
        );
      })()}

      {tab === 'deliveries' && await (async () => {
        const [rec, ret] = await Promise.all([listReceipts(ctx, { supplierId: s.id, page }), listSupplierReturns(ctx, { supplierId: s.id })]);
        return (
          <div className="space-y-4">
            <Card>
              <h2 className="mb-2 text-base font-semibold">Recent deliveries</h2>
              {rec.items.length === 0 ? <p className="text-sm text-muted">No deliveries yet.</p> : (
                <ul className="divide-y divide-line">
                  {rec.items.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                      <span><Link href={`/purchase-orders/${r.orderId}`} className="font-semibold text-brand-700 hover:underline">{r.number}</Link> <span className="text-xs text-muted">for {r.orderNumber} · {formatDate(r.receivedAt, ctx.business.timezone, ctx.business.locale)}</span></span>
                      <span className="tabular-nums">{r.received} received{r.damaged ? `, ${r.damaged} damaged` : ''}{d.canSeeCosts ? ` · ${money(r.valueCents, fmt)}` : ''}</span>
                    </li>
                  ))}
                </ul>
              )}
              {pager(rec.meta)}
            </Card>
            <Card>
              <h2 className="mb-2 text-base font-semibold">Returns to this supplier</h2>
              {ret.items.length === 0 ? <p className="text-sm text-muted">No returns.</p> : (
                <ul className="divide-y divide-line">
                  {ret.items.map((r) => <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"><span><strong>{r.number}</strong> <span className="text-xs text-muted">{formatDateTime(r.createdAt, ctx.business.timezone, ctx.business.locale)} · {r.reason}</span></span><span className="tabular-nums">{r.units} unit{r.units === 1 ? '' : 's'}</span></li>)}
                </ul>
              )}
            </Card>
          </div>
        );
      })()}

      {tab === 'documents' && <PartFilesPanel ctx={ctx} resourceType="supplier" resourceId={s.id} kind="all" title="Documents (supplier invoices, agreements, price lists)" />}

      {tab === 'activity' && await (async () => {
        const rows = await withTenant(ctx.business.id, (tx) => tx.auditLog.findMany({ where: { businessId: ctx.business.id, resourceType: 'supplier', resourceId: s.id }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, action: true, createdAt: true } }));
        return rows.length === 0 ? <EmptyState title="No activity yet" /> : (
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface">{rows.map((a) => <li key={a.id} className="flex justify-between gap-2 px-3 py-2.5 text-sm"><span>{a.action.replace('supplier.', '').replace(/_/g, ' ')}</span><span className="text-xs text-muted">{formatDateTime(a.createdAt, ctx.business.timezone, ctx.business.locale)}</span></li>)}</ul>
        );
      })()}
    </>
  );
}

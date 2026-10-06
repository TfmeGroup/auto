import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, Card, PageHeader } from '@/components/ui';
import { PartFilesPanel } from '@/components/inventory/PartFilesPanel';
import { PoActions, ReturnGoodsForm, type ReturnableLine } from '@/components/inventory/PoPanels';
import { PoStatusBadge, money } from '@/components/inventory/shared';
import { Row } from '@/components/workshop/layout';
import { formatDate, formatDateTime } from '@/lib/format';
import { isAppError } from '@/lib/errors';
import { accessibleLocationsFor } from '@/server/inventory/queries';
import { getPurchaseOrder } from '@/server/inventory/purchasing';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Purchase order' };
export const dynamic = 'force-dynamic';

export default async function PurchaseOrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ received?: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'inventory.view');
  const { id } = await params;
  const sp = await searchParams;
  let d;
  try {
    d = await getPurchaseOrder(ctx, id);
  } catch (e) {
    if (isAppError(e) && (e.status === 404 || e.status === 422)) notFound();
    throw e;
  }
  const o = d.order;
  const fmt = { currency: ctx.business.currency, locale: ctx.business.locale };
  const day = (s: string | null) => (s ? formatDate(`${s}T12:00:00Z`, 'UTC', ctx.business.locale) : '—');
  const costs = d.canSeeCosts;
  const locations = await accessibleLocationsFor(ctx);
  const returnable: ReturnableLine[] = d.can.returns
    ? d.receipts.flatMap((r) => r.lines.flatMap((l) => {
        const po = d.lines.find((x) => x.id === l.poLineId);
        const left = l.received - l.returned;
        return po?.partId && left > 0 ? [{ receiptLineId: l.id, partId: po.partId, label: l.description, returnable: left, receiptNumber: r.number }] : [];
      }))
    : [];

  return (
    <>
      <PageHeader title={o.number} description={`${d.supplier.name} · deliver to ${o.locationName}`} />
      <div className="mb-3 flex flex-wrap items-center gap-2"><PoStatusBadge status={o.status} />{o.late && <span className="text-sm font-medium text-danger">Late: was due {day(o.expectedDate)}</span>}{o.closedShort && <span className="text-xs text-muted">closed short</span>}</div>
      {sp.received === '1' && <div className="mb-3"><Alert tone="ok">Delivery saved. Stock has been updated; you can attach the delivery note or photos below.</Alert></div>}
      {o.rejectedReason && o.status === 'DRAFT' && <div className="mb-3"><Alert tone="warn">Sent back: {o.rejectedReason}</Alert></div>}
      {o.status === 'PENDING_APPROVAL' && <div className="mb-3"><Alert tone="warn">Waiting for someone with approval permission to approve this order.</Alert></div>}
      <div className="mb-4"><PoActions id={o.id} status={o.status} can={d.can} supplierEmail={d.supplier.email} canSeeCosts={costs} writable={ctx.subscription.canWrite} /></div>

      <div className="space-y-4">
        <Card>
          <h2 className="mb-2 text-base font-semibold">Lines</h2>
          <ul className="space-y-2 md:hidden">
            {d.lines.map((l) => (
              <li key={l.id} className="rounded-lg border border-line p-3 text-sm">
                <p className="font-semibold">{l.description}</p>
                <p className="text-xs text-muted">{[l.sku, l.supplierPartNumber && `their no. ${l.supplierPartNumber}`].filter(Boolean).join(' · ')}</p>
                <p className="mt-1 tabular-nums">{l.quantityReceived}/{l.quantityOrdered} received{l.remaining > 0 && ['ORDERED', 'PARTIALLY_RECEIVED'].includes(o.status) ? ` · ${l.remaining} outstanding` : ''}{l.quantityDamaged ? ` · ${l.quantityDamaged} damaged` : ''}{l.quantityCancelled ? ` · ${l.quantityCancelled} cancelled` : ''}</p>
                {costs && <p className="tabular-nums">{money(l.unitCostCents, fmt)} each · {money(l.totalCents, fmt)}</p>}
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted"><tr><th className="py-2 font-medium">Item</th><th className="py-2 text-right font-medium">Ordered</th><th className="py-2 text-right font-medium">Received</th><th className="py-2 text-right font-medium">Outstanding</th>{costs && <><th className="py-2 text-right font-medium">Unit cost</th><th className="py-2 text-right font-medium">Total</th></>}</tr></thead>
              <tbody className="divide-y divide-line">
                {d.lines.map((l) => (
                  <tr key={l.id}>
                    <td className="py-2.5">{l.partId ? <Link href={`/inventory/parts/${l.partId}`} className="font-medium text-brand-700 hover:underline">{l.description}</Link> : l.description}<span className="block text-xs text-muted">{[l.sku, l.supplierPartNumber && `their no. ${l.supplierPartNumber}`].filter(Boolean).join(' · ')}</span></td>
                    <td className="py-2.5 text-right tabular-nums">{l.quantityOrdered}</td>
                    <td className="py-2.5 text-right tabular-nums">{l.quantityReceived}{l.quantityDamaged ? <span className="block text-xs text-danger">{l.quantityDamaged} damaged</span> : null}</td>
                    <td className="py-2.5 text-right tabular-nums">{l.remaining}{l.quantityCancelled ? <span className="block text-xs text-muted">{l.quantityCancelled} cancelled</span> : null}</td>
                    {costs && <><td className="py-2.5 text-right tabular-nums">{money(l.unitCostCents, fmt)}</td><td className="py-2.5 text-right tabular-nums">{money(l.totalCents, fmt)}</td></>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {costs && (
            <div className="mt-3 ml-auto max-w-xs space-y-1 text-sm">
              <div className="flex justify-between"><span className="text-muted">Subtotal</span><span className="tabular-nums">{money(o.subtotalCents, fmt)}</span></div>
              {o.vatRegistered && <div className="flex justify-between"><span className="text-muted">VAT</span><span className="tabular-nums">{money(o.vatCents, fmt)}</span></div>}
              <div className="flex justify-between border-t border-line pt-1 font-bold"><span>Total</span><span className="tabular-nums">{money(o.totalCents, fmt)}</span></div>
            </div>
          )}
        </Card>

        <Card>
          <dl className="divide-y divide-line">
            <Row label="Supplier"><Link href={`/inventory/suppliers/${d.supplier.id}`} className="text-brand-700 hover:underline">{d.supplier.name}</Link></Row>
            <Row label="Order date">{day(o.poDate)}</Row><Row label="Expected">{day(o.expectedDate)}</Row>
            <Row label="Created">{formatDateTime(o.createdAt, ctx.business.timezone, ctx.business.locale)}{o.createdByName ? ` by ${o.createdByName}` : ''}</Row>
            {o.approvedAt && <Row label="Approved">{formatDateTime(o.approvedAt, ctx.business.timezone, ctx.business.locale)}{o.approvedByName ? ` by ${o.approvedByName}` : ''}</Row>}
            {o.orderedAt && <Row label="Ordered">{formatDateTime(o.orderedAt, ctx.business.timezone, ctx.business.locale)}{o.orderedByName ? ` by ${o.orderedByName}` : ''}</Row>}
            {o.sentToSupplierAt && <Row label="Sent to supplier">{formatDateTime(o.sentToSupplierAt, ctx.business.timezone, ctx.business.locale)}</Row>}
            {o.cancelledAt && <Row label="Cancelled">{formatDateTime(o.cancelledAt, ctx.business.timezone, ctx.business.locale)}{o.cancelReason ? ` — ${o.cancelReason}` : ''}</Row>}
            <Row label="Notes">{o.notes}</Row><Row label="Internal notes">{o.internalNotes}</Row><Row label="Terms">{o.terms}</Row>
          </dl>
        </Card>

        <Card>
          <h2 className="mb-2 text-base font-semibold">Deliveries</h2>
          {d.receipts.length === 0 ? <p className="text-sm text-muted">Nothing has been received yet.</p> : (
            <ul className="space-y-3">
              {d.receipts.map((r) => (
                <li key={r.id} className="rounded-lg border border-line p-3 text-sm">
                  <p className="flex flex-wrap justify-between gap-2"><strong>{r.number}</strong><span className="text-xs text-muted">{formatDateTime(r.receivedAt, ctx.business.timezone, ctx.business.locale)}{r.receivedByName ? ` · ${r.receivedByName}` : ''}</span></p>
                  {(r.deliveryNoteRef || r.notes) && <p className="text-xs text-muted">{[r.deliveryNoteRef && `delivery note ${r.deliveryNoteRef}`, r.notes].filter(Boolean).join(' · ')}</p>}
                  <ul className="mt-1 space-y-0.5">{r.lines.map((l) => <li key={l.id} className="tabular-nums">{l.description}: <strong>{l.received}</strong> received{l.damaged ? `, ${l.damaged} damaged` : ''}{l.incorrect ? `, ${l.incorrect} wrong item` : ''}{l.notDelivered ? `, ${l.notDelivered} not delivered` : ''}{l.returned ? `, ${l.returned} returned` : ''}{costs && l.unitCostCents !== null ? ` · paid ${money(l.unitCostCents, fmt)} each` : ''}{l.notes ? <span className="text-xs text-muted"> — {l.notes}</span> : null}</li>)}</ul>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {d.can.returns && ctx.subscription.canWrite && (
          <Card>
            <h2 className="mb-2 text-base font-semibold">Return goods to the supplier</h2>
            <ReturnGoodsForm lines={returnable} locations={locations} defaultLocationId={o.locationId} />
            {d.returns.length > 0 && <ul className="mt-3 space-y-1 border-t border-line pt-3 text-sm">{d.returns.map((r) => <li key={r.id}><strong>{r.number}</strong> <span className="text-xs text-muted">{formatDate(r.createdAt, ctx.business.timezone, ctx.business.locale)} · {r.reason}</span></li>)}</ul>}
          </Card>
        )}

        <PartFilesPanel ctx={ctx} resourceType="purchase_order" resourceId={o.id} kind="all" title="Documents and photos (supplier invoice, delivery note, damage)" />
      </div>
    </>
  );
}

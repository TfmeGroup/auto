import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Alert, Card, PageHeader } from '@/components/ui';
import { PurchaseOrderForm } from '@/components/inventory/PurchaseOrderForm';
import { newLineKey } from '@/components/inventory/shared';
import { centsToRand } from '@/components/inventory/shared';
import { isAppError } from '@/lib/errors';
import { accessibleLocationsFor } from '@/server/inventory/queries';
import { getPurchaseOrder } from '@/server/inventory/purchasing';
import { listSuppliers } from '@/server/inventory/suppliers';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Edit purchase order' };
export const dynamic = 'force-dynamic';

export default async function EditPurchaseOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'inventory.purchase');
  const { id } = await params;
  let d;
  try {
    d = await getPurchaseOrder(ctx, id);
  } catch (e) {
    if (isAppError(e) && (e.status === 404 || e.status === 422)) notFound();
    throw e;
  }
  const o = d.order;
  if (o.status !== 'DRAFT') return <><PageHeader title={o.number} /><Alert tone="warn">Only a draft order can be edited. {o.status === 'APPROVED' ? 'Send it back to draft from the order page first.' : ''}</Alert></>;
  if (!d.canSeeCosts) return <Alert tone="warn">Editing a purchase order needs permission to see costs.</Alert>;
  const [suppliers, locations] = await Promise.all([listSuppliers(ctx, { pageSize: 100 }), accessibleLocationsFor(ctx)]);
  return (
    <>
      <PageHeader title={`Edit ${o.number}`} />
      <Card className="max-w-4xl">
        <PurchaseOrderForm
          mode="edit" suppliers={suppliers.items.filter((s) => s.status === 'ACTIVE' || s.id === o.supplierId)} locations={locations} fmt={{ currency: ctx.business.currency, locale: ctx.business.locale }} vat={{ registered: o.vatRegistered || ctx.business.vatRegistered, rateBps: o.vatRateBps || ctx.business.vatRateBps }}
          defaults={{ id: o.id, supplierId: o.supplierId, locationId: o.locationId, poDate: o.poDate ?? undefined, expectedDate: o.expectedDate, notes: o.notes, internalNotes: o.internalNotes, terms: o.terms, lines: d.lines.map((l) => ({ key: newLineKey(), partId: l.partId, label: l.sku ? `${l.sku} — ${l.description}` : l.description, description: l.partId ? '' : l.description, supplierPartNumber: l.supplierPartNumber ?? '', quantity: String(l.quantityOrdered), costRand: centsToRand(l.unitCostCents), taxTreatment: l.taxTreatment })) }}
        />
      </Card>
    </>
  );
}

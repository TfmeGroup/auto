import type { Metadata } from 'next';
import { Alert, Card, PageHeader } from '@/components/ui';
import { PurchaseOrderForm, type PoLineDraft } from '@/components/inventory/PurchaseOrderForm';
import { newLineKey } from '@/components/inventory/shared';
import { centsToRand } from '@/components/inventory/shared';
import { getPart } from '@/server/inventory/parts';
import { accessibleLocationsFor } from '@/server/inventory/queries';
import { listSuppliers } from '@/server/inventory/suppliers';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'New purchase order' };
export const dynamic = 'force-dynamic';

export default async function NewPurchaseOrderPage({ searchParams }: { searchParams: Promise<{ supplierId?: string; partId?: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'inventory.purchase');
  const sp = await searchParams;
  if (!ctx.subscription.features.has('purchase_orders')) return <Alert tone="warn">Purchase orders are included from the Team plan.</Alert>;
  if (!ctx.permissions.has('inventory.view_costs')) return <Alert tone="warn">Creating a purchase order means entering costs, which needs permission to see costs.</Alert>;
  const [suppliers, locations] = await Promise.all([listSuppliers(ctx, { pageSize: 100 }), accessibleLocationsFor(ctx)]);
  let lines: PoLineDraft[] = [];
  let supplierId = sp.supplierId;
  if (sp.partId) {
    try {
      const d = await getPart(ctx, sp.partId);
      const link = d.suppliers.find((s) => s.status === 'ACTIVE' && s.supplierId === (supplierId ?? d.part.primarySupplierId));
      supplierId = supplierId ?? d.part.primarySupplierId ?? undefined;
      lines = [{ key: newLineKey(), partId: d.part.id, label: `${d.part.sku} — ${d.part.name}`, description: '', supplierPartNumber: link?.supplierPartNumber ?? '', quantity: String(Math.max(1, d.suggestedReorder)), costRand: centsToRand(link?.supplierCostCents ?? d.part.costCents), taxTreatment: d.part.taxTreatment }];
    } catch { /* an unknown part id just starts an empty order */ }
  }
  return (
    <>
      <PageHeader title="New purchase order" description="Save it as a draft, review it, then place the order." />
      <Card className="max-w-4xl">
        <PurchaseOrderForm mode="create" suppliers={suppliers.items.filter((s) => s.status === 'ACTIVE')} locations={locations} defaults={{ supplierId, lines }} fmt={{ currency: ctx.business.currency, locale: ctx.business.locale }} vat={{ registered: ctx.business.vatRegistered, rateBps: ctx.business.vatRateBps }} />
      </Card>
    </>
  );
}

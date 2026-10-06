import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Alert, Card, PageHeader } from '@/components/ui';
import { PartForm } from '@/components/inventory/PartForm';
import { isAppError } from '@/lib/errors';
import { listCategories } from '@/server/inventory/categories';
import { getPart } from '@/server/inventory/parts';
import { listSuppliers } from '@/server/inventory/suppliers';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Edit part' };
export const dynamic = 'force-dynamic';

export default async function EditPartPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'inventory.edit');
  const { id } = await params;
  let d;
  try {
    d = await getPart(ctx, id);
  } catch (e) {
    if (isAppError(e) && (e.status === 404 || e.status === 422)) notFound();
    throw e;
  }
  const [categories, suppliers] = await Promise.all([listCategories(ctx), listSuppliers(ctx, { pageSize: 100 })]);
  const p = d.part;
  return (
    <>
      <PageHeader title={`Edit ${p.sku}`} description={p.name} />
      {p.status === 'ARCHIVED' ? <Alert tone="warn">This part is archived. Restore it before editing.</Alert> : (
        <Card className="max-w-3xl">
          <PartForm
            mode="edit" categories={categories} suppliers={suppliers.items} locations={[]} canSeeCosts={d.canSeeCosts} canAdjust={false}
            defaults={{ id: p.id, sku: p.sku, partNumber: p.partNumber, name: p.name, description: p.description, categoryId: p.categoryId, brand: p.brand, manufacturer: p.manufacturer, barcode: p.barcode, unit: p.unit, costCents: p.costCents, sellPriceCents: p.sellPriceCents, taxTreatment: p.taxTreatment, minStock: p.minStock, reorderLevel: p.reorderLevel, reorderQuantity: p.reorderQuantity, primarySupplierId: p.primarySupplierId, notes: p.notes }}
          />
        </Card>
      )}
    </>
  );
}

import type { Metadata } from 'next';
import { Card, PageHeader } from '@/components/ui';
import { PartForm } from '@/components/inventory/PartForm';
import { listCategories } from '@/server/inventory/categories';
import { accessibleLocationsFor } from '@/server/inventory/queries';
import { listSuppliers } from '@/server/inventory/suppliers';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Add part' };
export const dynamic = 'force-dynamic';

export default async function NewPartPage() {
  const ctx = await requireBusiness();
  assertCan(ctx, 'inventory.create');
  const [categories, suppliers, locations] = await Promise.all([listCategories(ctx), listSuppliers(ctx, { pageSize: 100 }), accessibleLocationsFor(ctx)]);
  return (
    <>
      <PageHeader title="Add part" description="A part in your catalogue. Quantities are tracked from the moment you add stock." />
      <Card className="max-w-3xl">
        <PartForm mode="create" categories={categories} suppliers={suppliers.items} locations={locations} canSeeCosts={ctx.permissions.has('inventory.view_costs')} canAdjust={ctx.permissions.has('inventory.adjust')} />
      </Card>
    </>
  );
}

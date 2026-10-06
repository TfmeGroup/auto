import type { Metadata } from 'next';
import { Card, PageHeader } from '@/components/ui';
import { SupplierForm } from '@/components/inventory/SupplierForm';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Add supplier' };
export const dynamic = 'force-dynamic';

export default async function NewSupplierPage() {
  const ctx = await requireBusiness();
  assertCan(ctx, 'inventory.manage_suppliers');
  return (
    <>
      <PageHeader title="Add supplier" />
      <Card className="max-w-3xl"><SupplierForm mode="create" /></Card>
    </>
  );
}

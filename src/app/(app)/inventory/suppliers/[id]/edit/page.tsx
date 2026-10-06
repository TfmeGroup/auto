import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Card, PageHeader } from '@/components/ui';
import { SupplierForm } from '@/components/inventory/SupplierForm';
import { isAppError } from '@/lib/errors';
import { getSupplier } from '@/server/inventory/suppliers';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Edit supplier' };
export const dynamic = 'force-dynamic';

export default async function EditSupplierPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'inventory.manage_suppliers');
  const { id } = await params;
  let d;
  try {
    d = await getSupplier(ctx, id);
  } catch (e) {
    if (isAppError(e) && (e.status === 404 || e.status === 422)) notFound();
    throw e;
  }
  const s = d.supplier;
  return (
    <>
      <PageHeader title={`Edit ${s.name}`} />
      <Card className="max-w-3xl"><SupplierForm mode="edit" defaults={s} /></Card>
    </>
  );
}

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Card, PageHeader } from '@/components/ui';
import { VehicleForm } from '@/components/forms/VehicleForm';
import { getVehicle, vehicleLabel } from '@/server/vehicles/service';
import { assertCan, requireBusiness } from '@/server/web/session';
import { isAppError } from '@/lib/errors';

export const metadata: Metadata = { title: 'Edit vehicle' };
export const dynamic = 'force-dynamic';

export default async function EditVehiclePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'vehicle.edit');
  const { id } = await params;
  let v;
  try {
    v = await getVehicle(ctx, id);
  } catch (e) {
    if (isAppError(e) && (e.status === 404 || e.status === 422)) notFound();
    throw e;
  }
  return (
    <>
      <PageHeader title={`Edit ${vehicleLabel(v)}`} />
      <Card>
        <VehicleForm initial={v} customer={{ id: v.customer.id, name: v.customer.name, customerNumber: v.customer.customerNumber, mobile: v.customer.mobile }} canSubmit={ctx.subscription.canWrite && !v.archivedAt} />
      </Card>
    </>
  );
}

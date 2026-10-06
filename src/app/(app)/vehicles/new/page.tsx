import type { Metadata } from 'next';
import { Card, PageHeader } from '@/components/ui';
import { VehicleForm } from '@/components/forms/VehicleForm';
import { getCustomer } from '@/server/customers/service';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Add vehicle' };
export const dynamic = 'force-dynamic';

export default async function NewVehiclePage({ searchParams }: { searchParams: Promise<{ customerId?: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'vehicle.create');
  const { customerId } = await searchParams;
  const customer = customerId ? await getCustomer(ctx, customerId).catch(() => null) : null;
  return (
    <>
      <PageHeader title="Add vehicle" />
      <Card>
        <VehicleForm
          customer={customer ? { id: customer.id, name: customer.name, customerNumber: customer.customerNumber, mobile: customer.mobile } : null}
          canCreateCustomer={ctx.permissions.has('customer.create')}
          canSubmit={ctx.subscription.canWrite}
        />
      </Card>
    </>
  );
}

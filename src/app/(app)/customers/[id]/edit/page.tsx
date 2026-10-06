import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Card, PageHeader } from '@/components/ui';
import { CustomerForm } from '@/components/forms/CustomerForm';
import { getCustomer } from '@/server/customers/service';
import { assertCan, requireBusiness } from '@/server/web/session';
import { isAppError } from '@/lib/errors';

export const metadata: Metadata = { title: 'Edit customer' };
export const dynamic = 'force-dynamic';

export default async function EditCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'customer.edit');
  const { id } = await params;
  let customer;
  try {
    customer = await getCustomer(ctx, id);
  } catch (e) {
    if (isAppError(e) && (e.status === 404 || e.status === 422)) notFound();
    throw e;
  }
  return (
    <>
      <PageHeader title={`Edit ${customer.name}`} description={customer.customerNumber} />
      <Card>
        <CustomerForm initial={customer} canSubmit={ctx.subscription.canWrite} />
      </Card>
    </>
  );
}

import type { Metadata } from 'next';
import { Card, PageHeader } from '@/components/ui';
import { CustomerForm } from '@/components/forms/CustomerForm';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'New customer' };
export const dynamic = 'force-dynamic';

export default async function NewCustomerPage() {
  const ctx = await requireBusiness();
  assertCan(ctx, 'customer.create');
  return (
    <>
      <PageHeader title="New customer" />
      <Card>
        <CustomerForm canSubmit={ctx.subscription.canWrite} />
      </Card>
    </>
  );
}

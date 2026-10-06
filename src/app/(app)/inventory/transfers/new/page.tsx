import type { Metadata } from 'next';
import { Alert, Card, PageHeader } from '@/components/ui';
import { TransferForm } from '@/components/inventory/TransferForm';
import { withTenant } from '@/server/db/client';
import { loadInventorySettings } from '@/server/inventory/common';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'New transfer' };
export const dynamic = 'force-dynamic';

export default async function NewTransferPage() {
  const ctx = await requireBusiness();
  assertCan(ctx, 'inventory.transfer');
  if (!ctx.subscription.features.has('multi_location')) return <Alert tone="warn">Moving stock between locations needs a plan with more than one location.</Alert>;
  const { locations, approval } = await withTenant(ctx.business.id, async (tx) => ({
    locations: await tx.location.findMany({ where: { businessId: ctx.business.id, status: 'ACTIVE' }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }], select: { id: true, name: true } }),
    approval: (await loadInventorySettings(tx, ctx.business.id)).transferApprovalRequired,
  }));
  return (
    <>
      <PageHeader title="New transfer" description="Choose where the stock is going and what to move." />
      {locations.length < 2 ? <Alert tone="warn">You need at least two locations to move stock between them.</Alert> : <Card className="max-w-3xl"><TransferForm locations={locations} approvalRequired={approval} /></Card>}
    </>
  );
}

import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, PageHeader } from '@/components/ui';
import { ImportWizard } from '@/components/inventory/ImportWizard';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Import parts' };
export const dynamic = 'force-dynamic';

export default async function ImportPage() {
  const ctx = await requireBusiness();
  assertCan(ctx, 'inventory.import');
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  return (
    <>
      <PageHeader title="Import parts" description="Bring your parts in from a spreadsheet. Nothing is imported until you have checked the preview and confirmed." />
      {!ctx.subscription.features.has('bulk_inventory') ? (
        <Alert tone="warn">Importing and bulk changes are included from the Business plan. {can('settings.manage_billing') ? <Link href="/settings/billing" className="font-medium underline">See plans</Link> : 'Ask an owner to upgrade.'} You can still add parts one at a time.</Alert>
      ) : (
        <div className="max-w-4xl"><ImportWizard canCost={can('inventory.view_costs')} canAdjust={can('inventory.adjust')} /></div>
      )}
    </>
  );
}

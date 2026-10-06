import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui';
import { ScanWorkbench } from '@/components/inventory/ScanWorkbench';
import { accessibleLocationsFor } from '@/server/inventory/queries';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Scan a part' };
export const dynamic = 'force-dynamic';

export default async function ScanPage() {
  const ctx = await requireBusiness();
  assertCan(ctx, 'inventory.view');
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  const locations = await accessibleLocationsFor(ctx);
  return (
    <>
      <PageHeader title="Find a part" description={ctx.subscription.features.has('barcode_workflows') ? 'Scan a barcode with the camera or a scanner, or type to search.' : 'Type a barcode, SKU, part number or name. Camera scanning is available on the Team plan and above.'} />
      <div className="max-w-xl">
        <ScanWorkbench
          fmt={{ currency: ctx.business.currency, locale: ctx.business.locale }} canAdjust={can('inventory.adjust') && ctx.subscription.canWrite} canAddToJob={can('job.edit') && ctx.subscription.canWrite}
          showCost={can('inventory.view_costs')} locations={locations} barcode={ctx.subscription.features.has('barcode_workflows')}
        />
      </div>
    </>
  );
}

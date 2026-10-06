import type { Metadata } from 'next';
import { Card, PageHeader } from '@/components/ui';
import { InventorySettingsForm } from '@/components/inventory/InventorySettingsForm';
import { InventoryDefaultsForm } from '@/components/settings/ConfigForms';
import { getInventorySettings } from '@/server/inventory/settings';
import { getInventoryDefaults } from '@/server/settings/config-service';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Stock settings' };
export const dynamic = 'force-dynamic';

export default async function InventorySettingsPage() {
  const ctx = await requireBusiness();
  assertCan(ctx, 'inventory.view');
  const s = await getInventorySettings(ctx);
  const defaults = await getInventoryDefaults(ctx);
  return (
    <>
      <PageHeader title="Stock settings" description="How parts, stock and purchasing behave in your workshop." />
      <Card className="max-w-3xl">
        <InventorySettingsForm s={s} canEdit={s.canEdit && ctx.subscription.canWrite} canNegative={s.canAllowNegative} hasPurchasing={ctx.subscription.features.has('purchase_orders')} multiLocation={ctx.subscription.features.has('multi_location')} />
      </Card>
      <Card className="mt-4 max-w-3xl">
        <h2 className="mb-3 text-base font-semibold">Defaults for new parts</h2>
        <InventoryDefaultsForm initial={defaults} canEdit={ctx.permissions.has('inventory.manage_settings') && ctx.subscription.canWrite} />
      </Card>
    </>
  );
}

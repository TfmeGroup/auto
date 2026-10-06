import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui';
import { VehicleConfigForm } from '@/components/settings/ConfigForms';
import { DRIVE, FUEL, TRANSMISSION, VEHICLE_FIELDS, getVehicleConfig } from '@/server/settings/config-service';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Vehicle settings' };
export const dynamic = 'force-dynamic';

const nice = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());

export default async function VehicleSettingsPage() {
  const ctx = await requireBusiness();
  assertCan(ctx, 'settings.view');
  const c = await getVehicleConfig(ctx);
  return (
    <>
      <PageHeader title="Vehicles" description="What must be recorded for a vehicle, which options are offered, and default service intervals. Vehicles you already have are never invalidated." />
      <VehicleConfigForm
        initial={c} fieldOptions={Object.entries(VEHICLE_FIELDS).map(([value, label]) => ({ value, label }))}
        fuel={FUEL.map((v) => ({ value: v, label: nice(v) }))} transmission={TRANSMISSION.map((v) => ({ value: v, label: nice(v) }))} drive={DRIVE.map((v) => ({ value: v, label: v === 'FOUR_BY_FOUR' ? '4x4' : v }))}
        canEdit={ctx.permissions.has('settings.manage_workshop') && ctx.subscription.canWrite} locked={!ctx.subscription.features.has('advanced_settings')}
      />
    </>
  );
}

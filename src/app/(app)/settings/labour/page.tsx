import type { Metadata } from 'next';
import { Card, PageHeader } from '@/components/ui';
import { RateCardForm } from '@/components/team/TeamForms';
import { LabourRulesForm } from '@/components/settings/ConfigForms';
import { getConfig } from '@/server/settings/config-service';
import { getRateCard } from '@/server/team/labour';
import { requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Labour rates' };
export const dynamic = 'force-dynamic';

export default async function LabourRatesPage() {
  const ctx = await requireBusiness();
  const card = await getRateCard(ctx);
  const cfg = await getConfig(ctx).catch(() => null);
  return (
    <>
      <PageHeader title="Labour rates" description="What an hour of labour is charged at. The rate in force is copied onto each labour line when it is recorded, so changing a rate never rewrites earlier work or invoices." />
      <Card className="max-w-2xl">
        <RateCardForm defaultRate={card.defaultRateCentsPerHour} services={card.services} technicians={card.technicians} canManage={card.canManage && ctx.subscription.canWrite} canSeeCosts={card.canSeeCosts} />
      </Card>
      {cfg && (
        <Card className="mt-4 max-w-2xl">
          <h2 className="mb-3 text-base font-semibold">Time rounding and minimum</h2>
          <LabourRulesForm initial={{ minBillableMinutes: cfg.minBillableMinutes, timeRoundingMinutes: cfg.timeRoundingMinutes, timeRoundingMode: cfg.timeRoundingMode }} canEdit={ctx.permissions.has('labour.manage_rates') && ctx.subscription.canWrite} locked={!ctx.subscription.features.has('advanced_settings')} />
        </Card>
      )}
    </>
  );
}

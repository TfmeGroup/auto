import type { Metadata } from 'next';
import { Card, PageHeader } from '@/components/ui';
import { ReportingForm } from '@/components/settings/ConfigForms';
import { PRESETS, PRESET_LABEL } from '@/server/reports/range';
import { DASHBOARD_KPIS, getReportingSettings } from '@/server/settings/config-service';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Reporting settings' };
export const dynamic = 'force-dynamic';

export default async function ReportingSettingsPage() {
  const ctx = await requireBusiness();
  assertCan(ctx, 'settings.view');
  const s = await getReportingSettings(ctx);
  return (
    <>
      <PageHeader title="Reporting" description={'Defaults for reports and the dashboard. Time zone: ' + s.timezone + '.'} />
      <Card>
        <ReportingForm initial={s} ranges={PRESETS.filter((p) => p !== 'CUSTOM').map((p) => ({ value: p, label: PRESET_LABEL[p] }))} kpis={Object.entries(DASHBOARD_KPIS).map(([value, label]) => ({ value, label }))} canEdit={ctx.permissions.has('settings.edit') && ctx.subscription.canWrite} />
      </Card>
      <p className="mt-3 text-sm text-muted">Who can see which report is decided by roles (Settings, Roles), never by these preferences. Scheduled report recipients are chosen on the schedule itself.</p>
    </>
  );
}

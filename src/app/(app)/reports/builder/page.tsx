import type { Metadata } from 'next';
import { Alert, PageHeader } from '@/components/ui';
import { ReportBuilder } from '@/components/reports/ReportBuilder';
import { canUseFeature } from '@/server/billing/features';
import { filterOptions, sharingOptions } from '@/server/reports/options';
import { schemaFor } from '@/server/reports/custom/schema';
import { getSavedReport } from '@/server/reports/saved';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Custom report' };
export const dynamic = 'force-dynamic';

export default async function BuilderPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'report.create_custom');
  const sp = await searchParams;
  if (!canUseFeature(ctx.subscription, 'custom_reports')) {
    return (<><PageHeader title="Custom report" /><Alert tone="warn">The custom report builder is included from the Business plan.</Alert></>);
  }
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  const sources = schemaFor((p) => can(p), ctx.subscription.features);
  const [options, sharing] = [await filterOptions(ctx, ['location']), await sharingOptions(ctx)];
  const existing = sp.id ? await getSavedReport(ctx, sp.id).catch(() => null) : null;
  return (
    <>
      <PageHeader title={existing ? `Edit: ${existing.name}` : 'Custom report'} description="Choose a data source, fields, filters and totals from the approved list. Nothing is run until you press Run report." />
      <ReportBuilder
        sources={sources} roles={sharing.roles} members={sharing.members} locations={options.locations} canShare canBusinessWide={can('report.manage')} currency={ctx.business.currency} locale={ctx.business.locale}
        initial={existing && existing.kind === 'CUSTOM' && existing.canManage ? { id: existing.id, name: existing.name, description: existing.description, visibility: existing.visibility, sharedRoleIds: existing.sharedRoleIds, sharedMembershipIds: existing.sharedMembershipIds, config: existing.config as never } : undefined}
      />
    </>
  );
}

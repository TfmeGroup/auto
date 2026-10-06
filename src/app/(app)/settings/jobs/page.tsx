import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui';
import { JobConfigForm } from '@/components/settings/ConfigForms';
import { JOB_STATUSES, JOB_STATUS_LABEL } from '@/server/jobcards/transitions';
import { JOB_REQUIRED_FIELDS, PRIORITIES, DEFAULT_PRIORITY_LABEL, RETIRABLE_STATUSES, getJobConfig } from '@/server/settings/config-service';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Job settings' };
export const dynamic = 'force-dynamic';

export default async function JobSettingsPage() {
  const ctx = await requireBusiness();
  assertCan(ctx, 'settings.view');
  const c = await getJobConfig(ctx);
  return (
    <>
      <PageHeader title="Jobs" description="Names, optional steps and required details for job cards. History is never rewritten: a job keeps the stage it was in, whatever it is called now." />
      <JobConfigForm
        statuses={JOB_STATUSES.map((s) => ({ value: s, label: JOB_STATUS_LABEL[s] }))} priorities={PRIORITIES.map((p) => ({ value: p, label: DEFAULT_PRIORITY_LABEL[p] }))}
        labels={c.status} priorityLabels={c.priority} retired={c.retired} required={c.requiredFields}
        retirable={RETIRABLE_STATUSES.map((s) => ({ value: s, label: JOB_STATUS_LABEL[s] }))} requiredOptions={Object.entries(JOB_REQUIRED_FIELDS).map(([value, label]) => ({ value, label }))}
        canEdit={ctx.permissions.has('settings.manage_workshop') && ctx.subscription.canWrite} locked={!ctx.subscription.features.has('advanced_settings')}
      />
    </>
  );
}

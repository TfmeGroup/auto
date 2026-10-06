import type { Metadata } from 'next';
import { Alert, Badge, Card, EmptyState, LinkButton, PageHeader } from '@/components/ui';
import { ActionButton } from '@/components/forms/RowActions';
import { ScheduleForm } from '@/components/reports/ScheduleForm';
import { formatDateTime } from '@/lib/format';
import { canUseFeature } from '@/server/billing/features';
import { sharingOptions } from '@/server/reports/options';
import { listSavedReports } from '@/server/reports/saved';
import { listSchedules } from '@/server/reports/schedules';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Scheduled reports' };
export const dynamic = 'force-dynamic';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TONE = { SENT: 'ok', PARTIAL: 'warn', FAILED: 'danger', RUNNING: 'brand', QUEUED: 'neutral' } as const;

export default async function SchedulesPage() {
  const ctx = await requireBusiness();
  assertCan(ctx, 'report.manage_scheduled');
  if (!canUseFeature(ctx.subscription, 'scheduled_reports')) {
    return (<><PageHeader title="Scheduled reports" /><EmptyState title="Not included in your plan" action={ctx.permissions.has('settings.manage_billing') ? <LinkButton href="/settings/billing">See plans</LinkButton> : undefined}>Scheduled reports are part of the Business plan.</EmptyState></>);
  }
  const [schedules, saved, people] = [await listSchedules(ctx), await listSavedReports(ctx), await sharingOptions(ctx)];
  const when = (d: Date | string) => formatDateTime(d, ctx.business.timezone, ctx.business.locale);
  const describe = (s: (typeof schedules)[number]) => `${s.frequency === 'DAILY' ? 'Every day' : s.frequency === 'WEEKLY' ? `Every ${DAYS[s.weekday ?? 1]}` : `On day ${s.monthDay} of every month`} at ${String(s.hour).padStart(2, '0')}:00 · ${s.format === 'XLSX' ? 'Excel' : s.format}`;
  return (
    <>
      <PageHeader title="Scheduled reports" description="Reports are emailed on schedule. Each person gets their own copy made with their own permissions, so nobody receives more than they could open themselves." />
      <div className="space-y-4">
        <ScheduleForm reports={saved.filter((s) => s.canManage || true).map((s) => ({ value: s.id, label: s.name }))} members={people.members} selfId={ctx.membership.id} />
        {schedules.length === 0 ? <EmptyState title="No schedules yet" /> : (
          <ul className="grid gap-2">
            {schedules.map((s) => (
              <li key={s.id}>
                <Card>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">{s.report} {s.status === 'PAUSED' && <Badge>Paused</Badge>}</p>
                      <p className="text-sm text-muted">{describe(s)}</p>
                      <p className="mt-1 text-xs text-muted">To: {s.recipients.map((r) => r.name).join(', ')} · next {s.status === 'ACTIVE' ? when(s.nextRunAt) : 'paused'}{s.lastRunAt ? ` · last ${when(s.lastRunAt)}` : ''}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <ActionButton label={s.status === 'ACTIVE' ? 'Pause' : 'Resume'} method="PATCH" path={`/api/v1/reports/schedules/${s.id}`} body={{ status: s.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' }} />
                      <ActionButton label="Remove" variant="ghost" method="DELETE" path={`/api/v1/reports/schedules/${s.id}`} confirm="Remove this schedule and its run history?" />
                    </div>
                  </div>
                  {s.runs.length > 0 && (
                    <details className="mt-2"><summary className="min-h-11 cursor-pointer text-sm font-medium leading-[2.75rem] text-brand-700">Recent runs</summary>
                      <ul className="divide-y divide-line text-sm">
                        {s.runs.map((r) => (
                          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                            <span>{when(r.dueAt)}</span>
                            <span className="flex items-center gap-2"><Badge tone={TONE[r.status as keyof typeof TONE] ?? 'neutral'}>{r.status.toLowerCase()}</Badge><span className="text-xs text-muted">{r.sent} sent{r.skipped ? `, ${r.skipped} skipped` : ''}</span></span>
                            {r.error && <p className="w-full text-xs text-danger">{r.error}</p>}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        )}
        <Alert tone="ok">A scheduled report that cannot be made or delivered is retried, then recorded as failed and the person who set it up is told in the app. It is never shown as sent when it was not.</Alert>
      </div>
    </>
  );
}

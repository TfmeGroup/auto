import { AppShell } from '@/components/layout/AppShell';
import { JobLabelsProvider } from '@/components/workshop/job-labels';
import { getJobLabels } from '@/server/settings/config-service';
import { requireBusiness } from '@/server/web/session';

export const dynamic = 'force-dynamic';

/** Everything under (app) requires a signed-in user acting in a business. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireBusiness();
  const labels = await getJobLabels(ctx).catch(() => null);
  return <AppShell ctx={ctx}>{labels ? <JobLabelsProvider labels={{ status: labels.status, priority: labels.priority }}>{children}</JobLabelsProvider> : children}</AppShell>;
}

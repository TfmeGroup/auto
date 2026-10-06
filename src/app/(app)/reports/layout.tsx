import { SettingsNav, type SettingsTab } from '@/components/layout/SettingsNav';
import { requireBusiness } from '@/server/web/session';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/** The Reports area. Every tab is hidden unless the person's role (and plan) allows it; the pages and the API check again. */
export default async function ReportsLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireBusiness();
  if (!ctx.permissions.has('report.view')) redirect('/forbidden');
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  const tabs: (SettingsTab & { show: boolean })[] = [
    { href: '/reports', label: 'All reports', show: true },
    { href: '/reports/saved', label: 'Saved', show: true },
    { href: '/reports/builder', label: 'Custom report', show: can('report.create_custom') },
    { href: '/reports/schedules', label: 'Schedules', show: can('report.manage_scheduled') },
  ];
  return (
    <>
      <SettingsNav tabs={tabs.filter((t) => t.show)} />
      {children}
    </>
  );
}

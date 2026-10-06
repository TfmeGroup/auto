import { redirect } from 'next/navigation';
import { SettingsNav, type SettingsTab } from '@/components/layout/SettingsNav';
import { requireBusiness } from '@/server/web/session';

export const dynamic = 'force-dynamic';

/** Business administration (not platform administration: nothing here can reach another business or the platform). */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireBusiness();
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  if (!can('admin.view') && !can('data.import') && !can('business.export')) redirect('/forbidden');
  const adv = ctx.subscription.features.has('advanced_admin');
  const tabs: (SettingsTab & { show: boolean })[] = [
    { href: '/admin', label: 'Overview', show: can('admin.view') },
    { href: '/admin/setup', label: 'Setup check', show: can('settings.view') },
    { href: '/audit', label: 'Audit log', show: can('audit.view') },
    { href: '/admin/security', label: 'Security', show: can('security.view_events') && adv },
    { href: '/admin/archive', label: 'Archive', show: can('admin.view') && adv },
    { href: '/admin/search', label: 'Search', show: can('admin.view') && adv },
    { href: '/admin/import', label: 'Import', show: can('data.import') },
    { href: '/admin/export', label: 'Export', show: can('business.export') },
  ];
  return (
    <>
      <SettingsNav tabs={tabs.filter((t) => t.show)} />
      {children}
    </>
  );
}

import { SettingsNav, type SettingsTab } from '@/components/layout/SettingsNav';
import { requireBusiness } from '@/server/web/session';

export const dynamic = 'force-dynamic';

/** The business-administration area. Each tab shows only if the person's role grants it. */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireBusiness();
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  const tabs: (SettingsTab & { show: boolean })[] = [
    { href: '/settings/all', label: 'All settings', show: true },
    { href: '/settings', label: 'Business', show: can('settings.view') || can('business.view') },
    { href: '/team', label: 'Team', show: can('employee.view') },
    { href: '/settings/roles', label: 'Roles', show: can('employee.view') },
    { href: '/settings/locations', label: 'Locations', show: can('settings.view') },
    { href: '/settings/workshop', label: 'Bookings', show: can('booking.manage') || can('booking.view') },
    { href: '/settings/jobs', label: 'Jobs', show: can('settings.view') },
    { href: '/settings/services', label: 'Services', show: can('settings.view') },
    { href: '/settings/vehicles', label: 'Vehicles', show: can('settings.view') },
    { href: '/settings/numbering', label: 'Numbering', show: can('settings.view') },
    { href: '/settings/finance', label: 'Quotes & invoices', show: can('settings.view') },
    { href: '/settings/inventory', label: 'Stock', show: can('inventory.view') },
    { href: '/settings/labour', label: 'Labour rates', show: can('labour.view_rates') || can('labour.manage_rates') },
    { href: '/settings/documents', label: 'Documents', show: can('document.manage') || can('document.view') },
    { href: '/settings/communication', label: 'Communication', show: can('notification.manage_settings') || can('notification.manage_templates') },
    { href: '/settings/reporting', label: 'Reporting', show: can('settings.view') },
    { href: '/settings/billing', label: 'Billing', show: can('settings.manage_billing') },
    { href: '/settings/security', label: 'Security', show: can('settings.manage_security') || can('business.transfer_ownership') || can('business.close') },
    { href: '/settings/data', label: 'Data', show: can('settings.view') },
    { href: '/settings/export', label: 'Data export', show: can('business.export') },
  ];
  return (
    <>
      <SettingsNav tabs={tabs.filter((t) => t.show)} />
      {children}
    </>
  );
}

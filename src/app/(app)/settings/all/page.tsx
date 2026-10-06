import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, PageHeader } from '@/components/ui';
import { requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'All settings' };
export const dynamic = 'force-dynamic';

type P = Parameters<Awaited<ReturnType<typeof requireBusiness>>['permissions']['has']>[0];
const SECTIONS: { title: string; items: { href: string; label: string; text: string; any: P[] }[] }[] = [
  { title: 'Business', items: [
    { href: '/settings', label: 'Business profile', text: 'Name, contact details, VAT, logo, time zone and currency.', any: ['settings.view', 'business.view'] },
    { href: '/settings/locations', label: 'Locations', text: 'Branches, their contact details and document codes.', any: ['settings.view'] },
    { href: '/team', label: 'Team and invitations', text: 'Members, locations and suspensions.', any: ['employee.view'] },
    { href: '/settings/roles', label: 'Roles and permissions', text: 'What each role may do.', any: ['employee.view'] },
  ] },
  { title: 'Workshop', items: [
    { href: '/settings/workshop', label: 'Bookings and hours', text: 'Opening hours, bays, buffers, lead time, daily limit, walk-ins, waiting list and cancellation window.', any: ['booking.manage', 'booking.view'] },
    { href: '/settings/jobs', label: 'Jobs', text: 'Status and priority names, optional steps and required fields.', any: ['settings.view'] },
    { href: '/settings/services', label: 'Services and job templates', text: 'The service catalogue and ready-made jobs.', any: ['settings.view', 'job.view'] },
    { href: '/settings/vehicles', label: 'Vehicles', text: 'Required details, option lists and default service intervals.', any: ['settings.view'] },
    { href: '/settings/labour', label: 'Labour', text: 'Labour rates, time rounding and minimum billable time.', any: ['labour.view_rates', 'labour.manage_rates'] },
  ] },
  { title: 'Money', items: [
    { href: '/settings/finance', label: 'Quotes, invoices and payments', text: 'Terms, payment methods, bank details, VAT treatment, reminders and online payments.', any: ['settings.view'] },
    { href: '/settings/numbering', label: 'Numbering', text: 'Prefixes and lengths for every kind of record.', any: ['settings.view'] },
    { href: '/settings/inventory', label: 'Stock', text: 'Costing, reservations, negative stock and defaults.', any: ['inventory.view'] },
  ] },
  { title: 'Communication and documents', items: [
    { href: '/settings/communication', label: 'Communication', text: 'Sender name, reminders, who is told about what, and templates.', any: ['notification.manage_settings', 'notification.manage_templates'] },
    { href: '/settings/documents', label: 'Documents', text: 'Storage, categories and retention of files.', any: ['document.manage', 'document.view'] },
  ] },
  { title: 'Reports, data and security', items: [
    { href: '/settings/reporting', label: 'Reporting', text: 'Default period, thresholds and dashboard preferences.', any: ['settings.view'] },
    { href: '/settings/data', label: 'Data and retention', text: 'Import, export and how long things are kept.', any: ['settings.view'] },
    { href: '/settings/security', label: 'Security', text: 'Two-factor, session length, invitations, ownership and closing the business.', any: ['settings.manage_security', 'business.transfer_ownership', 'business.close'] },
    { href: '/settings/billing', label: 'Subscription', text: 'Plan, usage and invoices.', any: ['settings.manage_billing'] },
    { href: '/admin', label: 'Administration', text: 'Setup check, alerts, security events, archive, search and the audit log.', any: ['admin.view'] },
  ] },
];

export default async function AllSettingsPage() {
  const ctx = await requireBusiness();
  const groups = SECTIONS.map((g) => ({ ...g, items: g.items.filter((i) => i.any.some((p) => ctx.permissions.has(p))) })).filter((g) => g.items.length > 0);
  return (
    <>
      <PageHeader title="Settings" description="Everything you can configure, in one place. Each setting changes how the app really behaves, and every change is recorded in the audit log." />
      <div className="space-y-6">
        {groups.map((g) => (
          <section key={g.title} aria-labelledby={'g-' + g.title}>
            <h2 id={'g-' + g.title} className="mb-2 text-base font-semibold">{g.title}</h2>
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {g.items.map((i) => (
                <li key={i.href}><Link href={i.href}><Card className="h-full transition-colors hover:border-brand-500"><p className="font-medium">{i.label}</p><p className="mt-1 text-sm text-muted">{i.text}</p></Card></Link></li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}

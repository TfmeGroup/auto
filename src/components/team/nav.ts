import type { BusinessContext } from '@/server/context';
import type { InvTab } from '@/components/inventory/shared';

/** Tabs across the team area, by permission and plan. */
export function teamTabs(ctx: BusinessContext): InvTab[] {
  const can = (p: Parameters<BusinessContext['permissions']['has']>[0]) => ctx.permissions.has(p);
  const tech = ctx.subscription.features.has('technician_management');
  return [
    { key: 'directory', label: 'People', href: '/team', show: can('employee.view') },
    { key: 'workload', label: 'Workload', href: '/team/workload', show: can('employee.view_reports') && tech },
    { key: 'time', label: 'Time', href: '/team/time', show: (can('time.view_all') || can('time.record')) && tech },
    { key: 'rates', label: 'Labour rates', href: '/settings/labour', show: can('labour.view_rates') || can('labour.manage_rates') },
    { key: 'roles', label: 'Roles', href: '/settings/roles', show: can('employee.view') },
  ];
}

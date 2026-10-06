import type { Metadata } from 'next';
import { Badge, Card, PageHeader } from '@/components/ui';
import { listRoles } from '@/server/roles/service';
import { PERMISSIONS, permissionGroups } from '@/server/permissions/catalog';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Roles' };
export const dynamic = 'force-dynamic';

const GROUP_LABEL: Record<string, string> = {
  customer: 'Customers', vehicle: 'Vehicles', job: 'Jobs', booking: 'Bookings', quote: 'Quotes', invoice: 'Invoices', payment: 'Payments',
  inventory: 'Inventory', employee: 'Team', document: 'Documents', report: 'Reports', settings: 'Settings', business: 'Business', audit: 'Audit',
};

export default async function RolesPage() {
  const ctx = await requireBusiness();
  assertCan(ctx, 'employee.view');
  const roles = (await listRoles(ctx)).filter((r) => !r.archived);
  const groups = permissionGroups();

  return (
    <>
      <PageHeader title="Roles & permissions" description="What each role can do. Access is decided by these permissions — never by a role's name." />
      {!ctx.subscription.features.has('custom_roles') && <p className="mb-3 text-sm text-muted">Custom roles are available on the Business plan and above.</p>}
      <ul className="grid gap-3">
        {roles.map((r) => (
          <li key={r.id}>
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold">{r.name} {r.isSystem ? <Badge tone="neutral">System</Badge> : <Badge tone="brand">Custom</Badge>}</h2>
                <span className="text-xs text-muted">{r.memberCount} member{r.memberCount === 1 ? '' : 's'}</span>
              </div>
              {r.description && <p className="mt-1 text-sm text-muted">{r.description}</p>}
              <details className="mt-3">
                <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-brand-600">{r.permissions.length} permissions</summary>
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  {Object.entries(groups).map(([g, perms]) => {
                    const have = perms.filter((p) => r.permissions.includes(p));
                    return have.length ? (
                      <div key={g}>
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted">{GROUP_LABEL[g] ?? g}</p>
                        <ul className="mt-1 space-y-0.5 text-sm">{have.map((p) => <li key={p}>{PERMISSIONS[p]}</li>)}</ul>
                      </div>
                    ) : null;
                  })}
                </div>
              </details>
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}

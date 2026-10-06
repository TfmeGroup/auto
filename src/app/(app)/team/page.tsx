import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Badge, Card, EmptyState, LinkButton, PageHeader, Pagination } from '@/components/ui';
import { InvNavShim } from '@/components/team/InvNavShim';
import { InviteForm, MemberActions } from '@/components/forms/TeamControls';
import { Chips, qs } from '@/components/workshop/layout';
import { formatDate } from '@/lib/format';
import { listLocations } from '@/server/locations/service';
import { listAssignableRoles } from '@/server/memberships/service';
import { getSeatUsage, listEmployees } from '@/server/team/directory';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Team' };
export const dynamic = 'force-dynamic';

type Search = { q?: string; page?: string; status?: string; technician?: string; roleId?: string };
const field = 'block min-h-11 w-full rounded-lg border border-line bg-surface px-3 md:min-h-10';
const TONE = { ACTIVE: 'ok', INVITED: 'brand', SUSPENDED: 'warn', ARCHIVED: 'neutral' } as const;
const CHIPS = [['Current', undefined, undefined], ['Technicians', undefined, '1'], ['Invited', 'INVITED', undefined], ['Suspended', 'SUSPENDED', undefined], ['Removed', 'ARCHIVED', undefined]] as const;

export default async function TeamPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'employee.view');
  const sp = await searchParams;
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  const [{ items, meta }, seats, roles, locations] = await Promise.all([
    listEmployees(ctx, { q: sp.q, page: sp.page, status: sp.status || undefined, technician: sp.technician || undefined, roleId: sp.roleId || undefined, pageSize: 25 }),
    getSeatUsage(ctx),
    listAssignableRoles(ctx),
    can('settings.view') && ctx.subscription.features.has('multi_location') ? listLocations(ctx) : Promise.resolve([]),
  ]);
  const full = seats.used >= seats.limit;
  const href = (over: Partial<Search>) => `/team${qs({ q: sp.q, status: sp.status, technician: sp.technician, roleId: sp.roleId }, { page: undefined, ...over })}`;
  const when = (d: Date | null) => (d ? formatDate(d, ctx.business.timezone, ctx.business.locale) : null);

  return (
    <>
      <PageHeader
        title="Team"
        description={`${seats.used} of ${seats.limit} seat${seats.limit === 1 ? '' : 's'} used on the ${seats.plan} plan. Suspended and removed people do not use a seat.`}
        actions={can('report.export') && ctx.subscription.features.has('data_export') && <LinkButton href="/api/v1/team/export?dataset=directory&format=xlsx" variant="secondary">Export</LinkButton>}
      />
      <InvNavShim ctx={ctx} active="directory" />
      {seats.over && <div className="mb-4"><Alert tone="warn">Your plan allows {seats.limit} team member{seats.limit === 1 ? '' : 's'} but {seats.used} are active. Nobody has been removed, but you cannot add or reactivate anyone until you are within the limit. {can('settings.manage_billing') ? <Link href="/settings/billing" className="font-medium underline">See plans</Link> : 'Ask an owner to upgrade.'}</Alert></div>}
      {!seats.over && full && <div className="mb-4"><Alert tone="warn">You have reached your plan&apos;s limit of {seats.limit} team member{seats.limit === 1 ? '' : 's'}. {can('settings.manage_billing') ? <Link href="/settings/billing" className="font-medium underline">Upgrade to add more people</Link> : 'Ask an owner to upgrade.'}</Alert></div>}

      {can('employee.invite') && ctx.subscription.canWrite && !full && (
        <Card className="mb-4"><h2 className="mb-3 text-base font-semibold">Invite someone</h2><InviteForm roles={roles} locations={locations.filter((l) => l.status === 'ACTIVE')} /><p className="mt-2 text-xs text-muted">They get a single-use link by email, sign in with their own account (or create one), and join with the role you choose. Invitations expire after 7 days.</p></Card>
      )}

      <form action="/team" className="mb-3 grid gap-2 sm:grid-cols-3" role="search">
        <input name="q" defaultValue={sp.q} type="search" placeholder="Name or email" aria-label="Search the team" className={`${field} sm:col-span-2`} />
        <select name="roleId" defaultValue={sp.roleId ?? ''} aria-label="Role" className={field}><option value="">Any role</option>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
        {sp.status && <input type="hidden" name="status" value={sp.status} />}{sp.technician && <input type="hidden" name="technician" value="1" />}
        <button className="min-h-11 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white md:min-h-10 sm:col-span-3">Search</button>
      </form>
      <div className="mb-4"><Chips items={CHIPS.map(([label, status, technician]) => ({ label, href: href({ status, technician }), active: (status ?? '') === (sp.status ?? '') && (technician ?? '') === (sp.technician ?? '') }))} /></div>

      {items.length === 0 ? <EmptyState title={sp.q || sp.status ? 'Nobody matches' : 'No team members yet'}>{sp.q || sp.status ? 'Try different words.' : 'Invite people to join your workshop.'}</EmptyState> : (
        <>
          <ul className="grid gap-2">
            {items.map((m) => (
              <li key={m.id}>
                <Card className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <Link href={`/team/${m.id}`} className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{m.name ?? m.email} {m.isOwner && <Badge tone="brand">Owner</Badge>} {m.isTechnician && m.status === 'ACTIVE' && <Badge>Technician</Badge>}</p>
                    {m.name && <p className="truncate text-sm text-muted">{[m.email, m.phone].filter(Boolean).join(' · ')}</p>}
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                      <Badge tone={TONE[m.status]}>{m.status === 'ARCHIVED' ? 'removed' : m.status.toLowerCase()}</Badge><span>{m.role.name}</span>
                      {m.status !== 'INVITED' && m.locations !== 'All locations' && <span>{m.locations}</span>}
                      {when(m.joinedAt) && <span>Joined {when(m.joinedAt)}</span>}
                      {m.lastActiveAt && <span>Last active {when(m.lastActiveAt)}</span>}
                      {m.status === 'INVITED' && m.inviteExpiresAt && <span className={m.inviteExpired ? 'text-danger' : ''}>{m.inviteExpired ? 'Invitation expired' : `Invite expires ${when(m.inviteExpiresAt)}`}</span>}
                    </div>
                  </Link>
                  <MemberActions id={m.id} status={m.status} isSelf={m.id === ctx.membership.id} isOwner={m.isOwner} canSuspend={can('employee.suspend')} canInvite={can('employee.invite')} />
                </Card>
              </li>
            ))}
          </ul>
          <Pagination page={meta.page} totalPages={meta.totalPages} total={meta.total} hrefFor={(p) => href({ page: String(p) })} />
        </>
      )}
    </>
  );
}

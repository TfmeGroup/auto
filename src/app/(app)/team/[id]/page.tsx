import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, Badge, Card, EmptyState, LinkButton, PageHeader, Pagination } from '@/components/ui';
import { MemberActions, RoleSelect } from '@/components/forms/TeamControls';
import { PartFilesPanel } from '@/components/inventory/PartFilesPanel';
import { MemberLocationsForm, TechnicianForm } from '@/components/team/TeamForms';
import { TimeEntryActions } from '@/components/team/TimeEntryForm';
import { JobStatusBadge } from '@/components/workshop/badges';
import { Row, Stat, Tabs, qs } from '@/components/workshop/layout';
import { formatDate, formatDateTime } from '@/lib/format';
import { isAppError } from '@/lib/errors';
import { listAssignableRoles } from '@/server/memberships/service';
import { getEmployee } from '@/server/team/directory';
import { getTechnicianMetrics } from '@/server/team/performance';
import { getTechnician } from '@/server/team/technicians';
import { listTimeEntries } from '@/server/team/time';
import { withTenant } from '@/server/db/client';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Team member' };
export const dynamic = 'force-dynamic';

const TONE = { ACTIVE: 'ok', INVITED: 'brand', SUSPENDED: 'warn', ARCHIVED: 'neutral' } as const;
const EVENT: Record<string, string> = {
  'member.invited': 'Invited', 'member.invite_resent': 'Invitation sent again', 'member.invite_revoked': 'Invitation cancelled or expired', 'member.joined': 'Joined', 'member.role_changed': 'Role changed',
  'member.suspended': 'Suspended', 'member.reactivated': 'Reactivated', 'member.removed': 'Removed', 'member.locations_changed': 'Locations changed', 'technician.settings_changed': 'Technician settings changed',
  'technician.deactivated': 'Technician deactivated', 'technician.reactivated': 'Technician reactivated', 'labour.rate_changed': 'Labour rate changed', 'finance.labour_cost_rate_changed': 'Labour cost rate changed',
};
const hours = (m: number | null | undefined) => (m == null ? '—' : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`);

export default async function EmployeePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; page?: string; from?: string; to?: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'employee.view');
  const { id } = await params;
  const sp = await searchParams;
  let e;
  try {
    e = await getEmployee(ctx, id);
  } catch (err) {
    if (isAppError(err) && (err.status === 404 || err.status === 422)) notFound();
    throw err;
  }
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  const techFeature = ctx.subscription.features.has('technician_management');
  const writable = ctx.subscription.canWrite;
  const tabs = [
    { key: 'overview', label: 'Overview' },
    ...(e.status === 'ACTIVE' ? [{ key: 'technician', label: 'Technician' }, { key: 'jobs', label: `Jobs${e.openJobs.length ? ` (${e.openJobs.length})` : ''}` }] : []),
    ...(techFeature && e.status === 'ACTIVE' && (can('time.view_all')) ? [{ key: 'time', label: 'Time' }] : []),
    { key: 'activity', label: 'Activity' }, { key: 'documents', label: 'Documents' },
  ];
  const tab = tabs.find((t) => t.key === sp.tab)?.key ?? 'overview';
  const page = Math.max(1, Number(sp.page) || 1);
  const hrefTab = (key: string) => `/team/${e.id}${qs({ tab: key === 'overview' ? undefined : key })}`;
  const roles = can('employee.manage_roles') ? await listAssignableRoles(ctx) : [];
  const title = e.name ?? e.email ?? 'Team member';

  return (
    <>
      <PageHeader title={title} description={[e.email, e.phone].filter(Boolean).join(' · ')} actions={<LinkButton href="/team" variant="secondary">All people</LinkButton>} />
      <div className="mb-3 flex flex-wrap items-center gap-2"><Badge tone={TONE[e.status]}>{e.status === 'ARCHIVED' ? 'removed' : e.status.toLowerCase()}</Badge><Badge>{e.role.name}</Badge>{e.isOwner && <Badge tone="brand">Owner</Badge>}{e.isTechnician && <Badge>Technician</Badge>}</div>
      <Tabs tabs={tabs} active={tab} hrefFor={hrefTab} />

      {tab === 'overview' && (
        <div className="space-y-4">
          <Card>
            <dl className="divide-y divide-line">
              <Row label="Role">{e.role.name}<span className="block text-xs text-muted">{e.role.description}</span></Row>
              <Row label="Status">{e.status === 'ARCHIVED' ? 'Removed' : e.status.toLowerCase()}</Row>
              <Row label="Locations">{e.allLocations ? 'All locations' : e.locations.map((l) => l.name).join(', ') || 'None'}</Row>
              <Row label="Joined">{e.joinedAt ? formatDate(e.joinedAt, ctx.business.timezone, ctx.business.locale) : null}</Row>
              <Row label="Last active">{e.lastActiveAt ? formatDateTime(e.lastActiveAt, ctx.business.timezone, ctx.business.locale) : null}</Row>
              {e.status === 'INVITED' && <Row label="Invitation expires">{e.inviteExpiresAt ? formatDateTime(e.inviteExpiresAt, ctx.business.timezone, ctx.business.locale) : null}</Row>}
              <Row label="Completed jobs">{e.completedJobs}</Row>
            </dl>
            <p className="mt-2 text-xs text-muted">This person&apos;s account (password, sign-in and security settings) belongs to them. You only see what they have chosen to share with this business.</p>
          </Card>
          {(e.can.manageRoles || e.can.suspend) && writable && (
            <Card className="space-y-3">
              <h2 className="text-base font-semibold">Access</h2>
              <div className="flex flex-wrap items-center gap-2">
                {e.can.manageRoles && e.status === 'ACTIVE' && <RoleSelect membershipId={e.id} currentRoleId={e.role.id} roles={roles} />}
                <MemberActions id={e.id} status={e.status} isSelf={e.id === ctx.membership.id} isOwner={e.isOwner} canSuspend={can('employee.suspend')} canInvite={can('employee.invite')} />
              </div>
              <p className="text-xs text-muted">Suspending or removing someone ends their access immediately. Their account, the jobs they worked on, their time and the audit trail all stay.</p>
            </Card>
          )}
          {e.can.edit && ctx.subscription.features.has('multi_location') && writable && e.status === 'ACTIVE' && !e.isOwner && (
            <Card><h2 className="mb-2 text-base font-semibold">Where they work</h2><LocationsEditor ctx={ctx} e={e} /></Card>
          )}
          <Card>
            <h2 className="mb-2 text-base font-semibold">What their role allows</h2>
            <ul className="space-y-2 text-sm">{e.permissionSummary.map((g) => <li key={g.area}><strong className="capitalize">{g.area.replace('_', ' ')}</strong> <span className="text-muted">({g.granted.length} of {g.total})</span><span className="block text-xs text-muted">{g.granted.join(' · ')}</span></li>)}</ul>
          </Card>
        </div>
      )}

      {tab === 'technician' && await (async () => {
        const t = await getTechnician(ctx, e.id);
        const m = techFeature && (can('employee.view_reports') || e.id === ctx.membership.id) ? await getTechnicianMetrics(ctx, e.id, { from: sp.from, to: sp.to }).catch(() => null) : null;
        const services = await withTenant(ctx.business.id, (tx) => tx.serviceType.findMany({ where: { businessId: ctx.business.id, status: 'ACTIVE' }, orderBy: { name: 'asc' }, select: { id: true, name: true } }));
        const fmtMoney = (c: number | null) => (c === null ? '—' : new Intl.NumberFormat(ctx.business.locale, { style: 'currency', currency: ctx.business.currency }).format(c / 100));
        const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const hhmm = (m2: number) => `${String(Math.floor(m2 / 60)).padStart(2, '0')}:${String(m2 % 60).padStart(2, '0')}`;
        return (
          <div className="space-y-4">
            {m && (
              <>
                <form action={`/team/${e.id}`} className="flex flex-wrap items-end gap-2"><input type="hidden" name="tab" value="technician" /><label className="grid gap-1 text-xs text-muted">From<input type="date" name="from" defaultValue={m.range.from} className="min-h-11 rounded-lg border border-line bg-surface px-3 md:min-h-10" /></label><label className="grid gap-1 text-xs text-muted">To<input type="date" name="to" defaultValue={m.range.to} className="min-h-11 rounded-lg border border-line bg-surface px-3 md:min-h-10" /></label><button className="min-h-11 rounded-lg border border-line bg-surface px-3 text-sm font-medium md:min-h-10">Update</button></form>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Stat label="Jobs completed" value={m.jobsCompleted} hint={`${m.jobsOpen} open now`} /><Stat label="Worked" value={hours(m.workedMinutes)} hint={`${hours(m.billableMinutes)} billable`} />
                  <Stat label="Booked" value={hours(m.bookedMinutes)} hint={`${m.bookings} booking${m.bookings === 1 ? '' : 's'}`} /><Stat label="Utilisation" value={m.utilisationBps === null ? '—' : `${(m.utilisationBps / 100).toFixed(0)}%`} hint={`of ${hours(m.capacityMinutes)} available`} />
                  <Stat label="Avg. time to complete" value={m.avgCompletionHours === null ? '—' : `${m.avgCompletionHours} h`} /><Stat label="Parts fitted" value={m.partsFitted} />
                  {m.labourRevenueCents !== null && <Stat label="Labour recorded" value={fmtMoney(m.labourRevenueCents)} />}
                </div>
                <p className="text-xs text-muted">Workload figures from jobs, bookings and time entries in this period. They describe workload and are not an assessment of the person.</p>
              </>
            )}
            <Card>
              <h2 className="mb-2 text-base font-semibold">Working hours</h2>
              {t.usesWorkshopHours ? <p className="text-sm text-muted">Follows the workshop&apos;s opening hours.</p> : (
                <ul className="text-sm">{day.map((d, i) => { const iv = t.schedule.filter((s) => s.weekday === i); return <li key={d} className="flex justify-between gap-2 py-0.5"><span className="w-12 text-muted">{d}</span><span>{iv.length ? iv.map((s) => `${hhmm(s.startMinute)}–${hhmm(s.endMinute)}`).join(', ') : 'off'}</span></li>; })}</ul>
              )}
              {t.timeOff.length > 0 && <div className="mt-3 border-t border-line pt-2"><p className="text-xs font-medium uppercase tracking-wide text-muted">Leave and days off</p><ul className="text-sm">{t.timeOff.map((o) => <li key={o.id}>{formatDate(o.startsAt, ctx.business.timezone, ctx.business.locale)} – {formatDate(o.endsAt, ctx.business.timezone, ctx.business.locale)} · {o.kind.toLowerCase().replace('_', ' ')}{o.reason ? ` · ${o.reason}` : ''}</li>)}</ul></div>}
              {can('booking.manage') && <p className="mt-2 text-xs"><Link href="/settings/workshop" className="font-medium text-brand-700 hover:underline">Edit hours and leave in the workshop settings</Link> (the booking calendar uses the same hours).</p>}
            </Card>
            {t.upcomingBookings.length > 0 && <Card><h2 className="mb-2 text-base font-semibold">Upcoming bookings</h2><ul className="divide-y divide-line text-sm">{t.upcomingBookings.map((b) => <li key={b.id} className="flex justify-between gap-2 py-1.5"><Link href={`/bookings/${b.id}`} className="font-medium text-brand-700 hover:underline">{b.bookingNumber}</Link><span className="text-muted">{formatDateTime(b.startsAt, ctx.business.timezone, ctx.business.locale)} · {b.serviceLabel}</span></li>)}</ul></Card>}
            {t.canManage && techFeature && writable ? (
              <Card><h2 className="mb-3 text-base font-semibold">Technician settings</h2>
                <TechnicianForm membershipId={e.id} isTechnician={t.isTechnician} status={t.status} skills={t.skills} serviceTypeIds={t.serviceTypes.map((s) => s.id)} services={services} notes={t.notes} billable={t.billableRateCentsPerHour} cost={t.labourCostCentsPerHour} canRates={t.canManageRates} canSeeCost={can('labour.view_costs')} />
              </Card>
            ) : <Card><dl className="divide-y divide-line"><Row label="Technician">{t.isTechnician ? 'Yes' : 'No'}{t.status === 'INACTIVE' ? ' (inactive)' : ''}</Row><Row label="Skills">{t.skills.join(', ')}</Row><Row label="Services">{t.serviceTypes.map((s) => s.name).join(', ')}</Row>{t.billableRateCentsPerHour !== null && <Row label="Billable rate">{fmtMoney(t.billableRateCentsPerHour)} per hour</Row>}</dl>{!techFeature && <p className="mt-2 text-xs text-muted">Technician management (profiles, time tracking, performance) is included from the Team plan.</p>}</Card>}
          </div>
        );
      })()}

      {tab === 'jobs' && (e.openJobs.length === 0 ? <EmptyState title="No assigned jobs">Open jobs this person is working on will appear here.</EmptyState> : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">{e.openJobs.map((j) => <li key={j.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm"><span><Link href={`/jobs/${j.id}`} className="font-semibold text-brand-700 hover:underline">{j.jobNumber}</Link> <span className="text-muted">{[j.vehicle.registration, [j.vehicle.make, j.vehicle.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ')}</span></span><JobStatusBadge status={j.status} /></li>)}</ul>
      ))}

      {tab === 'time' && await (async () => {
        const r = await listTimeEntries(ctx, { membershipId: e.id, page, from: sp.from, to: sp.to });
        return (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3"><Stat label="Logged" value={hours(r.totals.minutes)} /><Stat label="Billable" value={hours(r.totals.billableMinutes)} /></div>
            {r.items.length === 0 ? <EmptyState title="No time logged" /> : (
              <>
                <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
                  {r.items.map((t) => (
                    <li key={t.id} className="space-y-1 px-3 py-2.5 text-sm">
                      <div className="flex flex-wrap justify-between gap-2"><span><Link href={`/jobs/${t.jobId}?tab=parts`} className="font-semibold text-brand-700 hover:underline">{t.jobNumber}</Link> · {hours(t.durationMinutes)}{t.status === 'RUNNING' ? ' (running)' : ''}{!t.billable ? ' · not billable' : ''}</span><span className="text-xs text-muted">{formatDateTime(t.startedAt, ctx.business.timezone, ctx.business.locale)}</span></div>
                      {t.notes && <p className="text-xs text-muted">{t.notes}</p>}
                      <TimeEntryActions id={t.id} status={t.status} posted={t.posted} approved={t.approved} canEdit={can('time.edit') && writable} canApprove={can('time.approve') && writable} canPost={can('time.edit') && writable} />
                    </li>
                  ))}
                </ul>
                <Pagination page={r.meta.page} totalPages={r.meta.totalPages} total={r.meta.total} hrefFor={(n) => `${hrefTab('time')}&page=${n}`} />
              </>
            )}
          </div>
        );
      })()}

      {tab === 'activity' && (e.history.length === 0 ? <EmptyState title="No activity yet" /> : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">{e.history.map((h) => <li key={h.id} className="px-3 py-2.5 text-sm"><p className="flex flex-wrap justify-between gap-2"><span className="font-medium">{EVENT[h.action] ?? h.action}</span><span className="text-xs text-muted">{formatDateTime(h.at, ctx.business.timezone, ctx.business.locale)}{h.by ? ` · ${h.by}` : ''}</span></p>{h.reason && <p className="text-xs text-muted">{h.reason}</p>}</li>)}</ul>
      ))}

      {tab === 'documents' && (can('document.manage_employee') ? <PartFilesPanel ctx={ctx} resourceType="employee" resourceId={e.id} kind="documents" title="Documents (certificates, licences, training records)" /> : <Alert tone="warn">You do not have permission to see this person&apos;s documents.</Alert>)}
    </>
  );
}

async function LocationsEditor({ ctx, e }: { ctx: Awaited<ReturnType<typeof requireBusiness>>; e: Awaited<ReturnType<typeof getEmployee>> }) {
  const all = await withTenant(ctx.business.id, (tx) => tx.location.findMany({ where: { businessId: ctx.business.id, status: 'ACTIVE' }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }], select: { id: true, name: true } }));
  return <MemberLocationsForm membershipId={e.id} all={e.allLocations} chosen={e.locations.map((l) => l.id)} locations={all} />;
}

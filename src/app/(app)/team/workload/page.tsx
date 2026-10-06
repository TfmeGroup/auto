import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Card, EmptyState, LinkButton, PageHeader } from '@/components/ui';
import { InvNavShim } from '@/components/team/InvNavShim';
import { getTeamWorkload } from '@/server/team/performance';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Team workload' };
export const dynamic = 'force-dynamic';

const hours = (m: number) => `${(m / 60).toFixed(1)} h`;
const field = 'min-h-11 rounded-lg border border-line bg-surface px-3 md:min-h-10';

export default async function WorkloadPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'employee.view_reports');
  const sp = await searchParams;
  if (!ctx.subscription.features.has('technician_management')) return <><PageHeader title="Workload" /><InvNavShim ctx={ctx} active="workload" /><Alert tone="warn">Technician workload and performance are included from the Team plan.</Alert></>;
  const w = await getTeamWorkload(ctx, { from: sp.from, to: sp.to });
  const money = (c: number | null) => (c === null ? '—' : new Intl.NumberFormat(ctx.business.locale, { style: 'currency', currency: ctx.business.currency }).format(c / 100));
  const showRevenue = ctx.permissions.has('labour.view_rates');
  return (
    <>
      <PageHeader title="Workload" description="Jobs, bookings and hours per technician, from real records. These describe workload; they are not an assessment of anyone." actions={ctx.permissions.has('report.export') && ctx.subscription.features.has('data_export') && <LinkButton href={`/api/v1/team/export?dataset=workload&format=xlsx&from=${w.range.from}&to=${w.range.to}`} variant="secondary">Export</LinkButton>} />
      <InvNavShim ctx={ctx} active="workload" />
      <form action="/team/workload" className="mb-4 flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-xs text-muted">From<input type="date" name="from" defaultValue={w.range.from} className={field} /></label>
        <label className="grid gap-1 text-xs text-muted">To<input type="date" name="to" defaultValue={w.range.to} className={field} /></label>
        <button className="min-h-11 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white md:min-h-10">Apply</button>
      </form>
      {w.items.length === 0 ? <EmptyState title="No technicians yet">Set people up as technicians on their profile.</EmptyState> : (
        <>
          <ul className="space-y-2 md:hidden">
            {w.items.map((t) => (
              <li key={t.membershipId}><Card className="space-y-1 text-sm"><Link href={`/team/${t.membershipId}?tab=technician`} className="font-semibold text-brand-700 hover:underline">{t.name}</Link>
                <p className="text-muted">{t.jobsCompleted} completed · {t.jobsOpen} open · {t.bookings} booking{t.bookings === 1 ? '' : 's'}</p><p className="text-muted">Worked {hours(t.workedMinutes)} ({hours(t.billableMinutes)} billable) of {hours(t.capacityMinutes)} available{t.utilisationBps !== null ? ` · ${(t.utilisationBps / 100).toFixed(0)}%` : ''}</p>{showRevenue && <p className="tabular-nums">Labour recorded {money(t.labourRevenueCents)}</p>}</Card></li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto rounded-xl border border-line bg-surface md:block">
            <table className="w-full text-sm">
              <thead className="bg-canvas text-left text-xs uppercase tracking-wide text-muted"><tr><th className="px-3 py-2 font-medium">Technician</th><th className="px-3 py-2 text-right font-medium">Completed</th><th className="px-3 py-2 text-right font-medium">Open</th><th className="px-3 py-2 text-right font-medium">Bookings</th><th className="px-3 py-2 text-right font-medium">Booked</th><th className="px-3 py-2 text-right font-medium">Worked</th><th className="px-3 py-2 text-right font-medium">Billable</th><th className="px-3 py-2 text-right font-medium">Available</th><th className="px-3 py-2 text-right font-medium">Utilisation</th><th className="px-3 py-2 text-right font-medium">Parts fitted</th>{showRevenue && <th className="px-3 py-2 text-right font-medium">Labour</th>}</tr></thead>
              <tbody className="divide-y divide-line">
                {w.items.map((t) => (
                  <tr key={t.membershipId} className="hover:bg-canvas">
                    <td className="px-3 py-2.5"><Link href={`/team/${t.membershipId}?tab=technician`} className="font-medium text-brand-700 hover:underline">{t.name}</Link></td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{t.jobsCompleted}</td><td className="px-3 py-2.5 text-right tabular-nums">{t.jobsOpen}</td><td className="px-3 py-2.5 text-right tabular-nums">{t.bookings}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{hours(t.bookedMinutes)}</td><td className="px-3 py-2.5 text-right tabular-nums">{hours(t.workedMinutes)}</td><td className="px-3 py-2.5 text-right tabular-nums">{hours(t.billableMinutes)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{hours(t.capacityMinutes)}</td><td className="px-3 py-2.5 text-right tabular-nums">{t.utilisationBps === null ? '—' : `${(t.utilisationBps / 100).toFixed(0)}%`}</td><td className="px-3 py-2.5 text-right tabular-nums">{t.partsFitted}</td>
                    {showRevenue && <td className="px-3 py-2.5 text-right tabular-nums">{money(t.labourRevenueCents)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted">Available hours come from each person&apos;s working hours (or the workshop&apos;s), less leave. Utilisation is worked time as a share of available time.</p>
        </>
      )}
    </>
  );
}

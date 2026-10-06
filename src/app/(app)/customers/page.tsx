import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Card, EmptyState, LinkButton, PageHeader, Pagination } from '@/components/ui';
import { Chips, qs } from '@/components/workshop/layout';
import { CustomerStatusBadge } from '@/components/workshop/badges';
import { listCustomers } from '@/server/customers/service';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Customers' };
export const dynamic = 'force-dynamic';

type Search = { q?: string; page?: string; status?: string; type?: string; job?: string; booking?: string; owing?: string };

export default async function CustomersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'customer.view');
  const sp = await searchParams;
  const status = (['ACTIVE', 'INACTIVE', 'ARCHIVED'] as const).find((s) => s === sp.status) ?? 'ACTIVE';
  const type = sp.type === 'INDIVIDUAL' || sp.type === 'BUSINESS' ? sp.type : undefined;
  // Filters that reveal job or booking information only exist for people who may see jobs or bookings.
  const canJobs = ctx.permissions.has('job.view');
  const canBookings = ctx.permissions.has('booking.view');
  const hasJob = canJobs && sp.job === '1';
  const hasBooking = canBookings && sp.booking === '1';
  const canMoney = ctx.permissions.has('invoice.view');
  const owing = canMoney && sp.owing === '1';
  const { items, meta } = await listCustomers(ctx, {
    q: sp.q, page: sp.page, status, type, pageSize: 25, hasActiveJob: hasJob ? 'true' : undefined, hasUpcomingBooking: hasBooking ? 'true' : undefined, hasBalance: owing ? 'true' : undefined, sort: sp.q ? 'name' : 'createdAt', dir: sp.q ? 'asc' : 'desc',
  });

  const base = { q: sp.q, status: status === 'ACTIVE' ? undefined : status, type, job: hasJob ? '1' : undefined, booking: hasBooking ? '1' : undefined, owing: owing ? '1' : undefined };
  const href = (over: Record<string, string | undefined>) => `/customers${qs(base, { page: undefined, ...over })}`;
  const filtered = !!(sp.q || type || hasJob || hasBooking || owing || status !== 'ACTIVE');

  return (
    <>
      <PageHeader
        title="Customers"
        description="Everyone you service, in one place."
        actions={ctx.permissions.has('customer.create') ? <LinkButton href="/customers/new">New customer</LinkButton> : undefined}
      />

      <form action="/customers" className="mb-3 flex flex-col gap-2 sm:flex-row" role="search">
        <input name="q" defaultValue={sp.q} type="search" placeholder="Search name, phone, email, company or number" aria-label="Search customers" className="block min-h-11 w-full min-w-0 rounded-lg border border-line bg-surface px-3 py-2 sm:flex-1 md:min-h-10" />
        {status !== 'ACTIVE' && <input type="hidden" name="status" value={status} />}
        {type && <input type="hidden" name="type" value={type} />}
        {hasJob && <input type="hidden" name="job" value="1" />}
        {hasBooking && <input type="hidden" name="booking" value="1" />}
        {owing && <input type="hidden" name="owing" value="1" />}
        <button className="min-h-11 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white md:min-h-10">Search</button>
      </form>
      <div className="mb-4 space-y-2">
        <Chips items={[
          { label: 'Active', href: href({ status: undefined }), active: status === 'ACTIVE' },
          { label: 'Inactive', href: href({ status: 'INACTIVE' }), active: status === 'INACTIVE' },
          { label: 'Archived', href: href({ status: 'ARCHIVED' }), active: status === 'ARCHIVED' },
        ]} />
        <Chips items={[
          { label: 'Any type', href: href({ type: undefined }), active: !type },
          { label: 'Individual', href: href({ type: 'INDIVIDUAL' }), active: type === 'INDIVIDUAL' },
          { label: 'Business', href: href({ type: 'BUSINESS' }), active: type === 'BUSINESS' },
          ...(canJobs ? [{ label: 'Has active job', href: href({ job: hasJob ? undefined : '1' }), active: hasJob }] : []),
          ...(canBookings ? [{ label: 'Has upcoming booking', href: href({ booking: hasBooking ? undefined : '1' }), active: hasBooking }] : []),
          ...(canMoney ? [{ label: 'Owes money', href: href({ owing: owing ? undefined : '1' }), active: owing }] : []),
        ]} />
      </div>

      {items.length === 0 ? (
        <EmptyState
          title={filtered ? 'No customers match' : 'No customers yet'}
          action={!filtered && ctx.permissions.has('customer.create') ? <LinkButton href="/customers/new">Add your first customer</LinkButton> : filtered ? <LinkButton href="/customers" variant="secondary">Clear filters</LinkButton> : undefined}
        >
          {filtered ? 'Try different words, or clear the filters.' : 'Customers you add will show up here.'}
        </EmptyState>
      ) : (
        <>
          <ul className="grid gap-2 md:hidden">
            {items.map((c) => (
              <li key={c!.id}>
                <Link href={`/customers/${c!.id}`}>
                  <Card className="transition-colors hover:border-brand-500">
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-semibold">{c!.name}</p>
                      <span className="text-xs text-muted">{c!.customerNumber}</span>
                    </div>
                    {c!.companyName && <p className="text-sm text-muted">{c!.companyName}</p>}
                    <p className="mt-1 text-sm text-muted">{[c!.mobile, c!.email].filter(Boolean).join(' · ') || 'No contact details'}</p>
                    <div className="mt-1.5 flex gap-1.5"><CustomerStatusBadge status={c!.status} />{c!.type === 'BUSINESS' && <Badge>Business</Badge>}</div>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>

          <div className="hidden overflow-x-auto rounded-xl border border-line bg-surface md:block">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead className="border-b border-line bg-canvas text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2.5 font-medium">Number</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Name</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Mobile</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Email</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Type</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map((c) => (
                  <tr key={c!.id} className="hover:bg-canvas/60">
                    <td className="px-4 py-3 text-muted">{c!.customerNumber}</td>
                    <td className="px-4 py-3 font-medium">
                      <Link href={`/customers/${c!.id}`} className="text-brand-700 hover:underline">{c!.name}</Link>
                      {c!.companyName && <span className="block text-xs font-normal text-muted">{c!.companyName}</span>}
                    </td>
                    <td className="px-4 py-3">{c!.mobile ?? '—'}</td>
                    <td className="px-4 py-3">{c!.email ?? '—'}</td>
                    <td className="px-4 py-3"><div className="flex gap-1.5"><Badge>{c!.type === 'BUSINESS' ? 'Business' : 'Individual'}</Badge><CustomerStatusBadge status={c!.status} /></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={meta.page} totalPages={meta.totalPages} total={meta.total} hrefFor={(p) => href({ page: String(p) })} />
        </>
      )}
    </>
  );
}

import type { Metadata } from 'next';
import Link from 'next/link';
import { EmptyState, LinkButton, PageHeader, Pagination } from '@/components/ui';
import { QuoteStatusBadge, money } from '@/components/finance/shared';
import { Chips, qs } from '@/components/workshop/layout';
import { formatDate } from '@/lib/format';
import { listQuotes } from '@/server/finance/quotes';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Quotes' };
export const dynamic = 'force-dynamic';

type Search = { q?: string; page?: string; status?: string; from?: string; to?: string; min?: string; max?: string; expiring?: string; sort?: string; dir?: string };

const STATUSES: [string, string][] = [['', 'All'], ['DRAFT', 'Draft'], ['SENT,VIEWED', 'Awaiting customer'], ['APPROVED', 'Approved'], ['DECLINED', 'Declined'], ['EXPIRED', 'Expired'], ['CONVERTED', 'Invoiced'], ['CANCELLED', 'Cancelled']];
const field = 'block min-h-11 w-full rounded-lg border border-line bg-surface px-3 md:min-h-10';

const cents = (v?: string) => {
  if (!v) return undefined;
  const n = Number(v.replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? String(Math.round(n * 100)) : undefined;
};

export default async function QuotesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'quote.view');
  const sp = await searchParams;
  const fmt = { currency: ctx.business.currency, locale: ctx.business.locale };
  const status = sp.status ?? '';
  const sort = ['created', 'number', 'total', 'valid_until', 'status'].includes(sp.sort ?? '') ? sp.sort : 'created';
  const dir = sp.dir === 'asc' ? 'asc' : 'desc';
  const { items, meta } = await listQuotes(ctx, { q: sp.q, page: sp.page, status: status || undefined, from: sp.from || undefined, to: sp.to || undefined, minCents: cents(sp.min), maxCents: cents(sp.max), expiring: sp.expiring, sort, dir, pageSize: 25 });
  const base = { q: sp.q, status: sp.status, from: sp.from, to: sp.to, min: sp.min, max: sp.max, expiring: sp.expiring, sort: sp.sort, dir: sp.dir };
  const href = (over: Record<string, string | undefined>) => `/quotes${qs(base, { page: undefined, ...over })}`;
  const sortHref = (key: string) => href({ sort: key, dir: sort === key && dir === 'desc' ? 'asc' : 'desc' });
  const filtered = !!(sp.q || sp.status || sp.from || sp.to || sp.min || sp.max || sp.expiring);
  const day = (d: string | null) => (d ? formatDate(`${d}T12:00:00Z`, 'UTC', ctx.business.locale) : '—');

  return (
    <>
      <PageHeader title="Quotes" description="Quotes sent to customers, with their approval status." actions={ctx.permissions.has('quote.create') && <LinkButton href="/quotes/new">New quote</LinkButton>} />
      <form action="/quotes" className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-6" role="search">
        <input name="q" defaultValue={sp.q} type="search" placeholder="Quote number, customer, phone, registration, VIN, job" aria-label="Search quotes" className={`${field} lg:col-span-2`} />
        <label className="grid gap-1 text-xs text-muted">From<input name="from" type="date" defaultValue={sp.from} className={field} /></label>
        <label className="grid gap-1 text-xs text-muted">To<input name="to" type="date" defaultValue={sp.to} className={field} /></label>
        <label className="grid gap-1 text-xs text-muted">Min amount<input name="min" inputMode="decimal" defaultValue={sp.min} className={field} /></label>
        <label className="grid gap-1 text-xs text-muted">Max amount<input name="max" inputMode="decimal" defaultValue={sp.max} className={field} /></label>
        {sp.status && <input type="hidden" name="status" value={sp.status} />}
        <button className="min-h-11 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white md:min-h-10">Apply filters</button>
      </form>
      <div className="mb-4">
        <Chips items={[...STATUSES.map(([v, l]) => ({ label: l, href: href({ status: v || undefined }), active: status === v })), { label: 'Expiring this week', href: href({ expiring: sp.expiring ? undefined : '1' }), active: !!sp.expiring }]} />
      </div>

      {items.length === 0 ? (
        <EmptyState title={filtered ? 'No quotes match' : 'No quotes yet'} action={!filtered && ctx.permissions.has('quote.create') ? <LinkButton href="/quotes/new">Create a quote</LinkButton> : filtered ? <LinkButton href="/quotes" variant="secondary">Clear filters</LinkButton> : undefined}>
          {filtered ? 'Try different words or clear the filters.' : 'Quotes let customers review and approve work online before you start.'}
        </EmptyState>
      ) : (
        <>
          <ul className="space-y-2 md:hidden">
            {items.map((q) => (
              <li key={q.id}>
                <Link href={`/quotes/${q.id}`} className="block rounded-xl border border-line bg-surface p-3 shadow-sm">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-semibold">{q.number}{q.version > 1 ? ` · v${q.version}` : ''}</p>
                    <QuoteStatusBadge status={q.status} />
                  </div>
                  <p className="mt-0.5 text-sm">{q.customer.name}{q.vehicle ? ` · ${q.vehicle.registration ?? q.vehicle.label}` : ''}</p>
                  <div className="mt-1 flex items-center justify-between text-sm">
                    <span className="text-muted">{q.validUntil ? `Valid until ${day(q.validUntil)}` : ''}{q.changesRequested ? ' · changes requested' : ''}</span>
                    <span className="font-semibold tabular-nums">{money(q.totalCents, fmt)}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-hidden rounded-xl border border-line bg-surface md:block">
            <table className="w-full text-sm">
              <thead className="bg-canvas text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium"><Link href={sortHref('number')}>Quote</Link></th>
                  <th className="px-3 py-2 font-medium">Customer</th>
                  <th className="px-3 py-2 font-medium">Vehicle</th>
                  <th className="px-3 py-2 font-medium"><Link href={sortHref('status')}>Status</Link></th>
                  <th className="px-3 py-2 font-medium"><Link href={sortHref('valid_until')}>Valid until</Link></th>
                  <th className="px-3 py-2 text-right font-medium"><Link href={sortHref('total')}>Total</Link></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map((q) => (
                  <tr key={q.id} className="hover:bg-canvas">
                    <td className="px-3 py-2.5"><Link href={`/quotes/${q.id}`} className="font-semibold text-brand-700 hover:underline">{q.number}</Link>{q.version > 1 && <span className="ml-1 text-xs text-muted">v{q.version}</span>}</td>
                    <td className="px-3 py-2.5">{q.customer.name}</td>
                    <td className="px-3 py-2.5">{q.vehicle?.registration ?? '—'}</td>
                    <td className="px-3 py-2.5"><QuoteStatusBadge status={q.status} />{q.changesRequested && <span className="ml-1 text-xs text-warn">changes requested</span>}</td>
                    <td className="px-3 py-2.5">{day(q.validUntil)}</td>
                    <td className="px-3 py-2.5 text-right font-medium tabular-nums">{money(q.totalCents, fmt)}</td>
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

import type { Metadata } from 'next';
import Link from 'next/link';
import { EmptyState, LinkButton, PageHeader, Pagination } from '@/components/ui';
import { InvoiceStatusBadge, money } from '@/components/finance/shared';
import { Chips, qs } from '@/components/workshop/layout';
import { formatDate } from '@/lib/format';
import { listInvoices } from '@/server/finance/invoices';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Invoices' };
export const dynamic = 'force-dynamic';

type Search = { q?: string; page?: string; status?: string; payment?: string; overdue?: string; method?: string; from?: string; to?: string; min?: string; max?: string; sort?: string; dir?: string };

const CHIPS: { label: string; over: Record<string, string | undefined> }[] = [
  { label: 'All', over: { status: undefined, payment: undefined, overdue: undefined } },
  { label: 'Draft', over: { status: 'DRAFT', payment: undefined, overdue: undefined } },
  { label: 'Unpaid', over: { status: undefined, payment: 'unpaid', overdue: undefined } },
  { label: 'Overdue', over: { status: undefined, payment: undefined, overdue: '1' } },
  { label: 'Part paid', over: { status: 'PARTIALLY_PAID', payment: undefined, overdue: undefined } },
  { label: 'Paid', over: { status: undefined, payment: 'paid', overdue: undefined } },
  { label: 'Cancelled / written off', over: { status: 'CANCELLED,WRITTEN_OFF', payment: undefined, overdue: undefined } },
];
const field = 'block min-h-11 w-full rounded-lg border border-line bg-surface px-3 md:min-h-10';
const cents = (v?: string) => {
  if (!v) return undefined;
  const n = Number(v.replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? String(Math.round(n * 100)) : undefined;
};

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'invoice.view');
  const sp = await searchParams;
  const fmt = { currency: ctx.business.currency, locale: ctx.business.locale };
  const sort = ['created', 'number', 'total', 'outstanding', 'invoice_date', 'due_date', 'status'].includes(sp.sort ?? '') ? sp.sort : 'created';
  const dir = sp.dir === 'asc' ? 'asc' : 'desc';
  const payment = sp.payment === 'paid' || sp.payment === 'unpaid' ? sp.payment : undefined;
  const method = ['CARD', 'EFT', 'CASH', 'ONLINE', 'OTHER'].includes(sp.method ?? '') ? sp.method : undefined;
  const { items, meta } = await listInvoices(ctx, {
    q: sp.q, page: sp.page, status: sp.status || undefined, payment, overdue: sp.overdue === '1' ? '1' : undefined, method, from: sp.from || undefined, to: sp.to || undefined,
    minCents: cents(sp.min), maxCents: cents(sp.max), sort, dir, pageSize: 25,
  });
  const base = { q: sp.q, status: sp.status, payment, overdue: sp.overdue, method, from: sp.from, to: sp.to, min: sp.min, max: sp.max, sort: sp.sort, dir: sp.dir };
  const href = (over: Record<string, string | undefined>) => `/invoices${qs(base, { page: undefined, ...over })}`;
  const sortHref = (key: string) => href({ sort: key, dir: sort === key && dir === 'desc' ? 'asc' : 'desc' });
  const filtered = !!(sp.q || sp.status || payment || sp.overdue || method || sp.from || sp.to || sp.min || sp.max);
  const day = (d: string | null) => (d ? formatDate(`${d}T12:00:00Z`, 'UTC', ctx.business.locale) : '—');
  const activeChip = (c: (typeof CHIPS)[number]) => (c.over.status ?? '') === (sp.status ?? '') && (c.over.payment ?? '') === (payment ?? '') && (c.over.overdue ?? '') === (sp.overdue ?? '');

  return (
    <>
      <PageHeader title="Invoices" description="Invoices issued to customers, and what is still owed." actions={ctx.permissions.has('invoice.create') && <LinkButton href="/invoices/new">New invoice</LinkButton>} />
      <form action="/invoices" className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-6" role="search">
        <input name="q" defaultValue={sp.q} type="search" placeholder="Invoice or quote number, customer, phone, registration, VIN, job" aria-label="Search invoices" className={`${field} lg:col-span-2`} />
        <label className="grid gap-1 text-xs text-muted">From<input name="from" type="date" defaultValue={sp.from} className={field} /></label>
        <label className="grid gap-1 text-xs text-muted">To<input name="to" type="date" defaultValue={sp.to} className={field} /></label>
        <label className="grid gap-1 text-xs text-muted">Min amount<input name="min" inputMode="decimal" defaultValue={sp.min} className={field} /></label>
        <label className="grid gap-1 text-xs text-muted">Max amount<input name="max" inputMode="decimal" defaultValue={sp.max} className={field} /></label>
        <label className="grid gap-1 text-xs text-muted">Paid with
          <select name="method" defaultValue={method ?? ''} className={field}><option value="">Any method</option><option value="EFT">EFT</option><option value="CARD">Card</option><option value="CASH">Cash</option><option value="ONLINE">Online</option><option value="OTHER">Other</option></select>
        </label>
        {sp.status && <input type="hidden" name="status" value={sp.status} />}
        {payment && <input type="hidden" name="payment" value={payment} />}
        {sp.overdue && <input type="hidden" name="overdue" value="1" />}
        <button className="min-h-11 self-end rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white md:min-h-10">Apply filters</button>
      </form>
      <div className="mb-4"><Chips items={CHIPS.map((c) => ({ label: c.label, href: href(c.over), active: activeChip(c) }))} /></div>

      {items.length === 0 ? (
        <EmptyState title={filtered ? 'No invoices match' : 'No invoices yet'} action={!filtered && ctx.permissions.has('invoice.create') ? <LinkButton href="/invoices/new">Create an invoice</LinkButton> : filtered ? <LinkButton href="/invoices" variant="secondary">Clear filters</LinkButton> : undefined}>
          {filtered ? 'Try different words or clear the filters.' : 'Invoice a finished job or approved quote, or create one by hand.'}
        </EmptyState>
      ) : (
        <>
          <ul className="space-y-2 md:hidden">
            {items.map((i) => (
              <li key={i.id}>
                <Link href={`/invoices/${i.id}`} className="block rounded-xl border border-line bg-surface p-3 shadow-sm">
                  <div className="flex items-start justify-between gap-2"><p className="font-semibold">{i.number ?? 'Draft'}</p><InvoiceStatusBadge status={i.status} /></div>
                  <p className="mt-0.5 text-sm">{i.customer.name}{i.vehicle ? ` · ${i.vehicle.registration ?? i.vehicle.label}` : ''}</p>
                  <div className="mt-1 flex items-center justify-between text-sm">
                    <span className="text-muted">{i.dueDate ? `Due ${day(i.dueDate)}` : ''}</span>
                    <span className="text-right"><span className="font-semibold tabular-nums">{money(i.totalCents, fmt)}</span>{i.outstandingCents > 0 && i.number && <span className="block text-xs text-danger tabular-nums">{money(i.outstandingCents, fmt)} due</span>}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-hidden rounded-xl border border-line bg-surface md:block">
            <table className="w-full text-sm">
              <thead className="bg-canvas text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium"><Link href={sortHref('number')}>Invoice</Link></th>
                  <th className="px-3 py-2 font-medium">Customer</th>
                  <th className="px-3 py-2 font-medium">Vehicle</th>
                  <th className="px-3 py-2 font-medium"><Link href={sortHref('status')}>Status</Link></th>
                  <th className="px-3 py-2 font-medium"><Link href={sortHref('due_date')}>Due</Link></th>
                  <th className="px-3 py-2 text-right font-medium"><Link href={sortHref('total')}>Total</Link></th>
                  <th className="px-3 py-2 text-right font-medium"><Link href={sortHref('outstanding')}>Outstanding</Link></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map((i) => (
                  <tr key={i.id} className="hover:bg-canvas">
                    <td className="px-3 py-2.5"><Link href={`/invoices/${i.id}`} className="font-semibold text-brand-700 hover:underline">{i.number ?? 'Draft'}</Link></td>
                    <td className="px-3 py-2.5">{i.customer.name}</td>
                    <td className="px-3 py-2.5">{i.vehicle?.registration ?? '—'}</td>
                    <td className="px-3 py-2.5"><InvoiceStatusBadge status={i.status} /></td>
                    <td className="px-3 py-2.5">{day(i.dueDate)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{money(i.totalCents, fmt)}</td>
                    <td className={`px-3 py-2.5 text-right font-medium tabular-nums ${i.outstandingCents > 0 && i.number ? 'text-danger' : 'text-muted'}`}>{i.number ? money(i.outstandingCents, fmt) : '—'}</td>
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

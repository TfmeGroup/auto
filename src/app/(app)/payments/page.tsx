import type { Metadata } from 'next';
import Link from 'next/link';
import { EmptyState, LinkButton, PageHeader, Pagination } from '@/components/ui';
import { METHOD_LABEL, PaymentStatusBadge, money } from '@/components/finance/shared';
import { Chips, qs } from '@/components/workshop/layout';
import { formatDateTime } from '@/lib/format';
import { listPayments } from '@/server/finance/payments';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Payments' };
export const dynamic = 'force-dynamic';

type Search = { q?: string; page?: string; status?: string; method?: string; reconciled?: string; purpose?: string; from?: string; to?: string; min?: string; max?: string; sort?: string; dir?: string };

const field = 'block min-h-11 w-full rounded-lg border border-line bg-surface px-3 md:min-h-10';
const cents = (v?: string) => {
  if (!v) return undefined;
  const n = Number(v.replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? String(Math.round(n * 100)) : undefined;
};

export default async function PaymentsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'payment.view');
  const sp = await searchParams;
  const fmt = { currency: ctx.business.currency, locale: ctx.business.locale };
  const method = ['CARD', 'EFT', 'CASH', 'ONLINE', 'OTHER'].includes(sp.method ?? '') ? sp.method : undefined;
  const purpose = sp.purpose === 'DEPOSIT' ? 'DEPOSIT' : undefined;
  const reconciled = sp.reconciled === 'yes' || sp.reconciled === 'no' ? sp.reconciled : undefined;
  const sort = ['paid_at', 'number', 'amount', 'status'].includes(sp.sort ?? '') ? sp.sort : 'paid_at';
  const dir = sp.dir === 'asc' ? 'asc' : 'desc';
  const { items, meta } = await listPayments(ctx, { q: sp.q, page: sp.page, status: sp.status || undefined, method, purpose, reconciled, from: sp.from || undefined, to: sp.to || undefined, minCents: cents(sp.min), maxCents: cents(sp.max), sort, dir, pageSize: 25 });
  const base = { q: sp.q, status: sp.status, method, purpose, reconciled, from: sp.from, to: sp.to, min: sp.min, max: sp.max, sort: sp.sort, dir: sp.dir };
  const href = (over: Record<string, string | undefined>) => `/payments${qs(base, { page: undefined, ...over })}`;
  const sortHref = (key: string) => href({ sort: key, dir: sort === key && dir === 'desc' ? 'asc' : 'desc' });
  const filtered = !!(sp.q || sp.status || method || purpose || reconciled || sp.from || sp.to || sp.min || sp.max);
  const dt = (d: Date | string | null) => (d ? formatDateTime(d, ctx.business.timezone, ctx.business.locale) : '—');

  return (
    <>
      <PageHeader title="Payments" description="Money received, refunds and reconciliation." actions={ctx.permissions.has('payment.create') && <LinkButton href="/payments/new">Record payment</LinkButton>} />
      <form action="/payments" className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-6" role="search">
        <input name="q" defaultValue={sp.q} type="search" placeholder="Payment or receipt number, reference, customer, invoice" aria-label="Search payments" className={`${field} lg:col-span-2`} />
        <label className="grid gap-1 text-xs text-muted">From<input name="from" type="date" defaultValue={sp.from} className={field} /></label>
        <label className="grid gap-1 text-xs text-muted">To<input name="to" type="date" defaultValue={sp.to} className={field} /></label>
        <label className="grid gap-1 text-xs text-muted">Method
          <select name="method" defaultValue={method ?? ''} className={field}><option value="">Any</option><option value="EFT">EFT</option><option value="CARD">Card</option><option value="CASH">Cash</option><option value="ONLINE">Online</option><option value="OTHER">Other</option></select>
        </label>
        <label className="grid gap-1 text-xs text-muted">Min amount<input name="min" inputMode="decimal" defaultValue={sp.min} className={field} /></label>
        {sp.status && <input type="hidden" name="status" value={sp.status} />}
        {reconciled && <input type="hidden" name="reconciled" value={reconciled} />}
        {purpose && <input type="hidden" name="purpose" value={purpose} />}
        <button className="min-h-11 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white md:min-h-10">Apply filters</button>
      </form>
      <div className="mb-4">
        <Chips items={[
          { label: 'All', href: href({ status: undefined, reconciled: undefined, purpose: undefined }), active: !sp.status && !reconciled && !purpose },
          { label: 'Completed', href: href({ status: 'COMPLETED', reconciled: undefined, purpose: undefined }), active: sp.status === 'COMPLETED' },
          { label: 'Pending / failed', href: href({ status: 'PENDING,PROCESSING,FAILED,CANCELLED', reconciled: undefined, purpose: undefined }), active: sp.status === 'PENDING,PROCESSING,FAILED,CANCELLED' },
          { label: 'Refunded', href: href({ status: 'REFUNDED,PARTIALLY_REFUNDED', reconciled: undefined, purpose: undefined }), active: sp.status === 'REFUNDED,PARTIALLY_REFUNDED' },
          { label: 'Not reconciled', href: href({ reconciled: reconciled === 'no' ? undefined : 'no', status: undefined, purpose: undefined }), active: reconciled === 'no' },
          { label: 'Deposits', href: href({ purpose: purpose ? undefined : 'DEPOSIT', status: undefined, reconciled: undefined }), active: !!purpose },
        ]} />
      </div>

      {items.length === 0 ? (
        <EmptyState title={filtered ? 'No payments match' : 'No payments yet'} action={!filtered && ctx.permissions.has('payment.create') ? <LinkButton href="/payments/new">Record a payment</LinkButton> : filtered ? <LinkButton href="/payments" variant="secondary">Clear filters</LinkButton> : undefined}>
          {filtered ? 'Try different words or clear the filters.' : 'Payments you record, and online payments customers make, appear here.'}
        </EmptyState>
      ) : (
        <>
          <ul className="space-y-2 md:hidden">
            {items.map((p) => (
              <li key={p.id}>
                <Link href={`/payments/${p.id}`} className="block rounded-xl border border-line bg-surface p-3 shadow-sm">
                  <div className="flex items-start justify-between gap-2"><p className="font-semibold">{p.number}</p><PaymentStatusBadge status={p.status} /></div>
                  <p className="mt-0.5 text-sm">{p.customer.name}{p.invoice?.number ? ` · ${p.invoice.number}` : p.purpose === 'DEPOSIT' ? ' · deposit' : ''}</p>
                  <div className="mt-1 flex items-center justify-between text-sm">
                    <span className="text-muted">{METHOD_LABEL[p.method]}{p.reference ? ` · ${p.reference}` : ''}</span>
                    <span className="font-semibold tabular-nums">{money(p.amountCents, fmt)}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-hidden rounded-xl border border-line bg-surface md:block">
            <table className="w-full text-sm">
              <thead className="bg-canvas text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium"><Link href={sortHref('number')}>Payment</Link></th>
                  <th className="px-3 py-2 font-medium"><Link href={sortHref('paid_at')}>Date</Link></th>
                  <th className="px-3 py-2 font-medium">Customer</th>
                  <th className="px-3 py-2 font-medium">Invoice</th>
                  <th className="px-3 py-2 font-medium">Method / reference</th>
                  <th className="px-3 py-2 font-medium"><Link href={sortHref('status')}>Status</Link></th>
                  <th className="px-3 py-2 font-medium">Reconciled</th>
                  <th className="px-3 py-2 text-right font-medium"><Link href={sortHref('amount')}>Amount</Link></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map((p) => (
                  <tr key={p.id} className="hover:bg-canvas">
                    <td className="px-3 py-2.5"><Link href={`/payments/${p.id}`} className="font-semibold text-brand-700 hover:underline">{p.number}</Link></td>
                    <td className="px-3 py-2.5">{dt(p.paidAt)}</td>
                    <td className="px-3 py-2.5">{p.customer.name}</td>
                    <td className="px-3 py-2.5">{p.invoice ? <Link href={`/invoices/${p.invoice.id}`} className="text-brand-700 hover:underline">{p.invoice.number}</Link> : <span className="text-muted">{p.purpose === 'DEPOSIT' ? 'Deposit' : '—'}</span>}</td>
                    <td className="px-3 py-2.5">{METHOD_LABEL[p.method]}{p.reference ? <span className="text-muted"> · {p.reference}</span> : ''}{p.provider ? <span className="text-muted"> · {p.provider}</span> : ''}</td>
                    <td className="px-3 py-2.5"><PaymentStatusBadge status={p.status} /></td>
                    <td className="px-3 py-2.5">{p.reconciled ? 'Yes' : <span className="text-muted">No</span>}</td>
                    <td className="px-3 py-2.5 text-right font-medium tabular-nums">{money(p.amountCents, fmt)}</td>
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

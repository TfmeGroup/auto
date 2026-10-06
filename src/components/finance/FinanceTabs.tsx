import Link from 'next/link';
import type { ReactNode } from 'react';
import { Card, EmptyState, LinkButton, Pagination } from '@/components/ui';
import { CreditNoteStatusBadge, InvoiceStatusBadge, METHOD_LABEL, PaymentStatusBadge, QuoteStatusBadge, money } from '@/components/finance/shared';
import { Kpi } from '@/components/finance/shared';
import { formatDate, formatDateTime } from '@/lib/format';
import { listInvoices } from '@/server/finance/invoices';
import { getCustomerFinancials, getVehicleFinancials } from '@/server/finance/insights';
import { getCustomerCredit, listPayments } from '@/server/finance/payments';
import { listQuotes } from '@/server/finance/quotes';
import { getStatement } from '@/server/finance/statements';
import { todayIso } from '@/lib/tz';
import type { BusinessContext } from '@/server/context';

// The shapes of the rows these tabs read from the financial summaries (the services return them as loosely-typed JSON).
interface OpenInvoiceRow { id: string; number: string | null; status: string; overdue?: boolean; dueDate: string | null; outstandingCents: number }
interface PaymentRow { id: string; number: string; status: string; method: string; purpose?: string; invoice?: { number: string | null } | null; amountCents: number }
interface CreditNoteRow { id: string; number: string | null; status: string; totalCents: number }
interface RefundRow { id: string; number: string; paymentId: string; reason?: string | null; amountCents: number }
interface VehicleInvoiceRow { id: string; number: string | null; status: string; overdue?: boolean; dueDate?: string | null; totalCents: number }
interface VehicleQuoteRow { id: string; number: string; status: string; totalCents: number }


/** The money tabs on the customer and vehicle screens. Every list is paged on the server and limited to what the viewer may see. */

type Fmt = { currency: string; locale: string };
const fmtOf = (ctx: BusinessContext): Fmt => ({ currency: ctx.business.currency, locale: ctx.business.locale });
const day = (ctx: BusinessContext, d: string | null) => (d ? formatDate(`${d}T12:00:00Z`, 'UTC', ctx.business.locale) : '—');

function Rows({ children }: { children: ReactNode }) {
  return <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">{children}</ul>;
}
function RowLink({ href, left, sub, right }: { href: string; left: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <li>
      <Link href={href} className="flex items-center justify-between gap-3 px-3 py-3 hover:bg-canvas">
        <div className="min-w-0"><p className="text-sm font-semibold">{left}</p>{sub && <p className="truncate text-xs text-muted">{sub}</p>}</div>
        {right && <span className="shrink-0 text-right text-sm font-semibold tabular-nums">{right}</span>}
      </Link>
    </li>
  );
}

export async function QuotesTab({ ctx, scope, page, hrefFor, canCreate }: { ctx: BusinessContext; scope: { customerId?: string; vehicleId?: string; jobId?: string }; page: number; hrefFor: (p: number) => string; canCreate: boolean }) {
  const f = fmtOf(ctx);
  const { items, meta } = await listQuotes(ctx, { ...scope, page, pageSize: 20 });
  const newHref = `/quotes/new?${new URLSearchParams(Object.entries(scope).filter(([, v]) => v) as [string, string][]).toString()}`;
  if (items.length === 0) return <EmptyState title="No quotes yet" action={canCreate ? <LinkButton href={newHref}>New quote</LinkButton> : undefined}>Quotes you prepare appear here.</EmptyState>;
  return (
    <div className="space-y-3">
      {canCreate && <div className="flex justify-end"><LinkButton href={newHref} variant="secondary">New quote</LinkButton></div>}
      <Rows>{items.map((q) => <RowLink key={q.id} href={`/quotes/${q.id}`} left={<>{q.number} <QuoteStatusBadge status={q.status} /></>} sub={`${q.title ?? ''}${q.validUntil ? ` · valid until ${day(ctx, q.validUntil)}` : ''}`} right={money(q.totalCents, f)} />)}</Rows>
      <Pagination page={meta.page} totalPages={meta.totalPages} total={meta.total} hrefFor={hrefFor} />
    </div>
  );
}

export async function InvoicesTab({ ctx, scope, page, hrefFor, canCreate }: { ctx: BusinessContext; scope: { customerId?: string; vehicleId?: string; jobId?: string }; page: number; hrefFor: (p: number) => string; canCreate: boolean }) {
  const f = fmtOf(ctx);
  const { items, meta } = await listInvoices(ctx, { ...scope, page, pageSize: 20 });
  const newHref = `/invoices/new?${new URLSearchParams(Object.entries(scope).filter(([, v]) => v) as [string, string][]).toString()}`;
  if (items.length === 0) return <EmptyState title="No invoices yet" action={canCreate ? <LinkButton href={newHref}>New invoice</LinkButton> : undefined}>Invoices appear here once created.</EmptyState>;
  return (
    <div className="space-y-3">
      {canCreate && <div className="flex justify-end"><LinkButton href={newHref} variant="secondary">New invoice</LinkButton></div>}
      <Rows>{items.map((i) => <RowLink key={i.id} href={`/invoices/${i.id}`} left={<>{i.number ?? 'Draft'} <InvoiceStatusBadge status={i.status} /></>} sub={i.dueDate ? `Due ${day(ctx, i.dueDate)}` : undefined} right={<>{money(i.totalCents, f)}{i.outstandingCents > 0 && i.number && <span className="block text-xs text-danger">{money(i.outstandingCents, f)} due</span>}</>} />)}</Rows>
      <Pagination page={meta.page} totalPages={meta.totalPages} total={meta.total} hrefFor={hrefFor} />
    </div>
  );
}

export async function PaymentsTab({ ctx, customerId, page, hrefFor, canRecord }: { ctx: BusinessContext; customerId: string; page: number; hrefFor: (p: number) => string; canRecord: boolean }) {
  const f = fmtOf(ctx);
  const { items, meta } = await listPayments(ctx, { customerId, page, pageSize: 20 });
  const credit = await getCustomerCredit(ctx, customerId).catch(() => null);
  return (
    <div className="space-y-3">
      {credit && credit.balanceCents > 0 && <Card><p className="text-sm">Customer credit available: <strong className="tabular-nums">{money(credit.balanceCents, f)}</strong> <span className="text-muted">(deposits, overpayments and credit notes not yet used)</span></p></Card>}
      {canRecord && <div className="flex justify-end"><LinkButton href="/payments/new" variant="secondary">Record payment or deposit</LinkButton></div>}
      {items.length === 0 ? <EmptyState title="No payments yet">Payments from this customer appear here.</EmptyState> : (
        <>
          <Rows>{items.map((p) => <RowLink key={p.id} href={`/payments/${p.id}`} left={<>{p.number} <PaymentStatusBadge status={p.status} /></>} sub={`${METHOD_LABEL[p.method]}${p.invoice?.number ? ` · ${p.invoice.number}` : p.purpose === 'DEPOSIT' ? ' · deposit' : ''}${p.paidAt ? ` · ${formatDateTime(p.paidAt, ctx.business.timezone, ctx.business.locale)}` : ''}`} right={money(p.amountCents, f)} />)}</Rows>
          <Pagination page={meta.page} totalPages={meta.totalPages} total={meta.total} hrefFor={hrefFor} />
        </>
      )}
    </div>
  );
}

/** The customer's whole financial picture: totals, what is open, recent payments, credit notes, refunds and a statement. */
export async function CustomerFinancialTab({ ctx, customerId, from, to }: { ctx: BusinessContext; customerId: string; from?: string; to?: string }) {
  const f = fmtOf(ctx);
  const fin = (await getCustomerFinancials(ctx, customerId)) as Record<string, unknown>;
  const today = todayIso(ctx.business.timezone);
  const stFrom = from ?? `${today.slice(0, 4)}-01-01`;
  const stTo = to ?? today;
  const statement = ctx.permissions.has('invoice.view') ? await getStatement(ctx, customerId, { from: stFrom, to: stTo }).catch(() => null) : null;
  const t = fin.totals as { invoicedCents: number; paidCents: number; outstandingCents: number; overdueCents: number; overdueCount: number; creditNotedCents: number; writtenOffCents: number } | undefined;
  return (
    <div className="space-y-4">
      {t && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi label="Total invoiced" value={money(t.invoicedCents, f)} />
          <Kpi label="Total paid" value={money(t.paidCents, f)} tone="ok" />
          <Kpi label="Outstanding" value={money(t.outstandingCents, f)} />
          <Kpi label="Overdue" value={money(t.overdueCents, f)} tone={t.overdueCents > 0 ? 'danger' : undefined} hint={t.overdueCount ? `${t.overdueCount} invoice${t.overdueCount === 1 ? '' : 's'}` : undefined} />
          <Kpi label="Customer credit" value={money(fin.creditBalanceCents as number, f)} />
          <Kpi label="Credit notes" value={money(t.creditNotedCents, f)} />
          <Kpi label="Written off" value={money(t.writtenOffCents, f)} />
          {fin.accountBalanceCents !== undefined && <Kpi label="Account balance" value={money(fin.accountBalanceCents as number, f)} hint="owed less credit" />}
        </div>
      )}
      {(fin.openInvoices as OpenInvoiceRow[] | undefined)?.length ? (
        <Card><h2 className="mb-2 text-base font-semibold">Open invoices</h2><Rows>{(fin.openInvoices as OpenInvoiceRow[]).map((i) => <RowLink key={i.id} href={`/invoices/${i.id}`} left={<>{i.number} <InvoiceStatusBadge status={i.overdue ? 'OVERDUE' : i.status} /></>} sub={`Due ${day(ctx, i.dueDate)}`} right={money(i.outstandingCents, f)} />)}</Rows></Card>
      ) : null}
      {(fin.recentPayments as PaymentRow[] | undefined)?.length ? (
        <Card><h2 className="mb-2 text-base font-semibold">Recent payments</h2><Rows>{(fin.recentPayments as PaymentRow[]).map((p) => <RowLink key={p.id} href={`/payments/${p.id}`} left={<>{p.number} <PaymentStatusBadge status={p.status} /></>} sub={`${METHOD_LABEL[p.method]}${p.invoice?.number ? ` · ${p.invoice.number}` : p.purpose === 'DEPOSIT' ? ' · deposit' : ''}`} right={money(p.amountCents, f)} />)}</Rows></Card>
      ) : null}
      {(fin.creditNotes as CreditNoteRow[] | undefined)?.length ? (
        <Card><h2 className="mb-2 text-base font-semibold">Credit notes</h2><Rows>{(fin.creditNotes as CreditNoteRow[]).map((c) => <RowLink key={c.id} href={`/credit-notes/${c.id}`} left={<>{c.number ?? 'Draft'} <CreditNoteStatusBadge status={c.status} /></>} right={money(c.totalCents, f)} />)}</Rows></Card>
      ) : null}
      {(fin.refunds as RefundRow[] | undefined)?.length ? (
        <Card><h2 className="mb-2 text-base font-semibold">Refunds</h2><Rows>{(fin.refunds as RefundRow[]).map((r) => <RowLink key={r.id} href={`/payments/${r.paymentId}`} left={r.number} sub={r.reason} right={money(r.amountCents, f)} />)}</Rows></Card>
      ) : null}
      {statement && (
        <Card>
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <h2 className="text-base font-semibold">Statement</h2>
            <form action={`/customers/${customerId}`} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="tab" value="financial" />
              <label className="grid gap-1 text-xs text-muted">From<input name="from" type="date" defaultValue={stFrom} className="block min-h-10 rounded-lg border border-line bg-surface px-2" /></label>
              <label className="grid gap-1 text-xs text-muted">To<input name="to" type="date" defaultValue={stTo} className="block min-h-10 rounded-lg border border-line bg-surface px-2" /></label>
              <button className="min-h-10 rounded-lg border border-line bg-surface px-3 text-sm font-semibold">Show</button>
              <a className="inline-flex min-h-10 items-center rounded-lg bg-brand-600 px-3 text-sm font-semibold text-white" href={`/api/v1/customers/${customerId}/statement/pdf?from=${stFrom}&to=${stTo}&download=1`}>PDF</a>
            </form>
          </div>
          <ul className="divide-y divide-line text-sm">
            <li className="flex justify-between py-2 font-semibold"><span>Opening balance</span><span className="tabular-nums">{money(statement.openingCents, f)}</span></li>
            {statement.rows.map((r, i) => (
              <li key={i} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0"><p>{r.description}</p><p className="text-xs text-muted">{day(ctx, r.date)} · {r.document}</p></div>
                <div className="shrink-0 text-right tabular-nums"><p className={r.creditCents ? 'text-ok' : ''}>{r.chargeCents ? money(r.chargeCents, f) : `−${money(r.creditCents, f)}`}</p><p className="text-xs text-muted">{money(r.balanceCents, f)}</p></div>
              </li>
            ))}
            <li className="flex justify-between py-2 font-bold"><span>{statement.closingCents > 0 ? 'Balance due' : statement.closingCents < 0 ? 'Account in credit' : 'Closing balance'}</span><span className="tabular-nums">{money(Math.abs(statement.closingCents), f)}</span></li>
          </ul>
        </Card>
      )}
    </div>
  );
}

export async function VehicleFinancialTab({ ctx, vehicleId }: { ctx: BusinessContext; vehicleId: string }) {
  const f = fmtOf(ctx);
  const v = (await getVehicleFinancials(ctx, vehicleId)) as Record<string, unknown>;
  const t = v.totals as { invoicedCents: number; spendExVatCents: number; paidCents: number; outstandingCents: number; invoiceCount: number; jobCount: number } | undefined;
  return (
    <div className="space-y-4">
      {t && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi label="Total spend (ex VAT)" value={money(t.spendExVatCents, f)} hint={`${t.invoiceCount} invoice${t.invoiceCount === 1 ? '' : 's'} · ${t.jobCount} job${t.jobCount === 1 ? '' : 's'}`} />
          <Kpi label="Total invoiced" value={money(t.invoicedCents, f)} />
          <Kpi label="Paid" value={money(t.paidCents, f)} tone="ok" />
          <Kpi label="Outstanding" value={money(t.outstandingCents, f)} tone={t.outstandingCents > 0 ? 'danger' : undefined} />
        </div>
      )}
      <p className="text-xs text-muted">These figures belong to this vehicle only. The customer’s account balance covers all of their vehicles.</p>
      {(v.invoices as VehicleInvoiceRow[] | undefined)?.length ? <Card><h2 className="mb-2 text-base font-semibold">Invoices</h2><Rows>{(v.invoices as VehicleInvoiceRow[]).map((i) => <RowLink key={i.id} href={`/invoices/${i.id}`} left={<>{i.number ?? 'Draft'} <InvoiceStatusBadge status={i.overdue ? 'OVERDUE' : i.status} /></>} sub={i.dueDate ? `Due ${day(ctx, i.dueDate)}` : undefined} right={money(i.totalCents, f)} />)}</Rows></Card> : null}
      {(v.quotes as VehicleQuoteRow[] | undefined)?.length ? <Card><h2 className="mb-2 text-base font-semibold">Quotes</h2><Rows>{(v.quotes as VehicleQuoteRow[]).map((q) => <RowLink key={q.id} href={`/quotes/${q.id}`} left={<>{q.number} <QuoteStatusBadge status={q.status} /></>} right={money(q.totalCents, f)} />)}</Rows></Card> : null}
      {(v.payments as PaymentRow[] | undefined)?.length ? <Card><h2 className="mb-2 text-base font-semibold">Payments</h2><Rows>{(v.payments as PaymentRow[]).map((p) => <RowLink key={p.id} href={`/payments/${p.id}`} left={p.number} sub={`${METHOD_LABEL[p.method]}${p.invoice?.number ? ` · ${p.invoice.number}` : ''}`} right={money(p.amountCents, f)} />)}</Rows></Card> : null}
    </div>
  );
}

/** The money panel on a job card: quotes and invoices for this job, and the next financial step. */
export async function JobFinancePanel({ ctx, jobId, jobStatus }: { ctx: BusinessContext; jobId: string; jobStatus: string }) {
  const can = (p: Parameters<BusinessContext['permissions']['has']>[0]) => ctx.permissions.has(p);
  if (!can('quote.view') && !can('invoice.view') && !can('quote.create') && !can('invoice.create')) return null;
  const f = fmtOf(ctx);
  const { listJobQuotes } = await import('@/server/finance/quotes');
  const { listJobInvoices } = await import('@/server/finance/invoices');
  const quotes = can('quote.view') ? await listJobQuotes(ctx, jobId) : [];
  const invoices = can('invoice.view') ? await listJobInvoices(ctx, jobId) : [];
  const billable = ['READY_FOR_COLLECTION', 'COMPLETED'].includes(jobStatus);
  const liveInvoice = invoices.some((i) => i.status !== 'CANCELLED');
  return (
    <Card>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Quotes and invoices</h2>
        <div className="flex flex-wrap gap-2">
          {can('quote.create') && <LinkButton href={`/quotes/new?jobId=${jobId}`} variant="secondary">Quote from job</LinkButton>}
          {can('invoice.create') && billable && !liveInvoice && <LinkButton href={`/invoices/new?jobId=${jobId}`}>Invoice this job</LinkButton>}
        </div>
      </div>
      {quotes.length === 0 && invoices.length === 0 ? (
        <p className="text-sm text-muted">{billable ? 'Nothing has been quoted or invoiced for this job yet.' : 'Prepare a quote from the recommended work. Invoicing is available once the job is ready for collection.'}</p>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {quotes.map((q) => <li key={q.id} className="flex items-center justify-between gap-2 py-2"><Link className="font-medium text-brand-700 hover:underline" href={`/quotes/${q.id}`}>{q.number}{q.currentVersion > 1 ? ` · v${q.currentVersion}` : ''}</Link><span className="flex items-center gap-2"><QuoteStatusBadge status={q.status} /><span className="tabular-nums">{money(q.totalCents, f)}</span></span></li>)}
          {invoices.map((i) => <li key={i.id} className="flex items-center justify-between gap-2 py-2"><Link className="font-medium text-brand-700 hover:underline" href={`/invoices/${i.id}`}>{i.number ?? 'Draft invoice'}</Link><span className="flex items-center gap-2"><InvoiceStatusBadge status={i.status} /><span className="tabular-nums">{money(i.totalCents, f)}</span></span></li>)}
        </ul>
      )}
    </Card>
  );
}

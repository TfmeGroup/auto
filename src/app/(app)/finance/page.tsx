import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Card, EmptyState, LinkButton, PageHeader } from '@/components/ui';
import { AGE_LABEL, Kpi, METHOD_LABEL, money } from '@/components/finance/shared';
import { Tabs, qs } from '@/components/workshop/layout';
import { canUseFeature } from '@/server/billing/features';
import { getAgeingDetail, getFinanceDashboard, getPaymentAnalytics, getProfitability, getQuoteAnalytics, getVatReport } from '@/server/finance/reports';
import { searchFinance } from '@/server/finance/search';
import { assertCan, requireBusiness } from '@/server/web/session';
import { todayIso } from '@/lib/tz';
import { formatDate } from '@/lib/format';
import { StatementForm } from '@/components/finance/StatementForm';

export const metadata: Metadata = { title: 'Finance' };
export const dynamic = 'force-dynamic';

type Search = { tab?: string; from?: string; to?: string; bucket?: string; q?: string };
const TABS = [
  { key: 'overview', label: 'Overview' }, { key: 'receivables', label: 'Who owes' }, { key: 'reports', label: 'Reports' }, { key: 'search', label: 'Find' }, { key: 'statements', label: 'Statements' }, { key: 'export', label: 'Exports' },
];
const field = 'block min-h-11 w-full rounded-lg border border-line bg-surface px-3 md:min-h-10';

export default async function FinancePage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'finance.view_reports');
  const sp = await searchParams;
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : 'overview';
  const range = { from: sp.from || undefined, to: sp.to || undefined };
  const fmt = { currency: ctx.business.currency, locale: ctx.business.locale };
  const hrefTab = (key: string) => `/finance${qs({ tab: key === 'overview' ? undefined : key, ...range })}`;
  const entitled = canUseFeature(ctx.subscription, 'financial_reports');
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);

  let body;
  let error: string | null = null;
  try {
    if (tab === 'overview') body = await Overview({ ctx, range, fmt });
    else if (tab === 'receivables') body = await Receivables({ ctx, bucket: sp.bucket, fmt });
    else if (tab === 'reports') body = await Reports({ ctx, range, fmt, entitled, can });
    else if (tab === 'search') body = await Find({ ctx, q: sp.q });
    else if (tab === 'statements') body = <Statements ctx={ctx} />;
    else body = <Exports ctx={ctx} range={range} />;
  } catch (e) {
    error = e instanceof Error && 'code' in e && (e as { code?: string }).code === 'VALIDATION_ERROR' ? 'Check the dates: the end date cannot be before the start date, and the period cannot be longer than about three years.' : null;
    if (!error) throw e;
  }

  return (
    <>
      <PageHeader title="Finance" description="Revenue, what customers owe, and payments, calculated from your invoices and payment records." />
      <Tabs tabs={TABS} active={tab} hrefFor={hrefTab} />
      {['overview', 'reports', 'export'].includes(tab) && (
        <form action="/finance" className="mb-4 flex flex-wrap items-end gap-2" role="search">
          <input type="hidden" name="tab" value={tab} />
          <label className="grid gap-1 text-xs text-muted">From<input name="from" type="date" defaultValue={sp.from} className={field} /></label>
          <label className="grid gap-1 text-xs text-muted">To<input name="to" type="date" defaultValue={sp.to} className={field} /></label>
          <button className="min-h-11 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white md:min-h-10">Apply</button>
          {(sp.from || sp.to) && <Link href={`/finance${qs({ tab: tab === 'overview' ? undefined : tab })}`} className="min-h-11 px-2 py-2.5 text-sm text-brand-700">This month</Link>}
        </form>
      )}
      {error && <Alert>{error}</Alert>}
      {body}
    </>
  );
}

type Ctx = Awaited<ReturnType<typeof requireBusiness>>;
type Fmt = { currency: string; locale: string };

async function Overview({ ctx, range, fmt }: { ctx: Ctx; range: { from?: string; to?: string }; fmt: Fmt }) {
  const d = await getFinanceDashboard(ctx, range);
  const r = d.receivables;
  return (
    <div className="space-y-5">
      <section aria-label="Revenue" className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Revenue (invoiced, excluding VAT)</h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi label="Today" value={money(d.revenue.todayCents, fmt)} />
          <Kpi label="This week" value={money(d.revenue.weekCents, fmt)} />
          <Kpi label="This month" value={money(d.revenue.monthCents, fmt)} />
          <Kpi label={`${d.range.from} to ${d.range.to}`} value={money(d.revenue.rangeCents, fmt)} hint={`${d.invoiced.countInRange} invoice${d.invoiced.countInRange === 1 ? '' : 's'} issued`} />
        </div>
        <p className="text-xs text-muted">Revenue is what you invoiced, less credit notes. It is not the same as cash received.</p>
      </section>

      <section aria-label="Cash received" className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Payments received</h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi label="Received today" value={money(d.received.todayCents, fmt)} />
          <Kpi label="In the period" value={money(d.received.rangeCents, fmt)} hint={`${d.received.rangeCount} payment${d.received.rangeCount === 1 ? '' : 's'}`} />
          <Kpi label="Refunded" value={money(d.received.refundedInRangeCents, fmt)} />
          <Kpi label="Net cash" value={money(d.received.netInRangeCents, fmt)} tone="ok" />
        </div>
      </section>

      <section aria-label="Receivables" className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">What customers owe you</h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi label="Outstanding" value={money(r.outstandingCents, fmt)} hint={`${r.openInvoices} open invoice${r.openInvoices === 1 ? '' : 's'}`} />
          <Kpi label="Overdue" value={money(r.overdueCents, fmt)} tone={r.overdueCents > 0 ? 'danger' : undefined} />
          <Kpi label="Average invoice" value={money(d.invoiced.averageInvoiceCents, fmt)} hint="excluding VAT" />
          <Kpi label="Average job value" value={d.averageJobValueCents === null ? '—' : money(d.averageJobValueCents, fmt)} hint="invoices linked to jobs" />
        </div>
        <Card>
          <h3 className="mb-2 text-sm font-semibold">Ageing</h3>
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {(Object.keys(r.ageing) as (keyof typeof r.ageing)[]).map((b) => (
              <li key={b} className="rounded-lg border border-line bg-canvas px-3 py-2">
                <Link href={`/finance?tab=receivables&bucket=${b}`} className="block">
                  <p className="text-xs text-muted">{AGE_LABEL[b]}</p>
                  <p className="text-base font-bold tabular-nums">{money(r.ageing[b].amountCents, fmt)}</p>
                  <p className="text-xs text-muted">{r.ageing[b].count} invoice{r.ageing[b].count === 1 ? '' : 's'}</p>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </section>

      <section aria-label="Quotes" className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Quotes</h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi label="Awaiting approval" value={d.quotes.pendingCount} />
          <Kpi label="Value awaiting approval" value={money(d.quotes.pendingValueCents, fmt)} />
          <Kpi label="Invoices issued" value={d.invoiced.countInRange} />
          <Kpi label="Invoices paid" value={d.invoiced.paidInRange} />
        </div>
      </section>
    </div>
  );
}

async function Receivables({ ctx, bucket, fmt }: { ctx: Ctx; bucket?: string; fmt: Fmt }) {
  const b = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'].includes(bucket ?? '') ? bucket : undefined;
  const d = await getAgeingDetail(ctx, { bucket: b });
  const day = (x: string) => formatDate(`${x}T12:00:00Z`, 'UTC', ctx.business.locale);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Age">
        {[['', 'All'], ...Object.entries(AGE_LABEL)].map(([k, label]) => (
          <Link key={k} href={`/finance?tab=receivables${k ? `&bucket=${k}` : ''}`} aria-current={(b ?? '') === k ? 'true' : undefined} className={`inline-flex min-h-9 items-center rounded-full border px-3 text-xs font-medium ${(b ?? '') === k ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-line bg-surface text-muted'}`}>{label}</Link>
        ))}
      </div>
      {d.items.length === 0 ? <EmptyState title="Nothing outstanding">No unpaid invoices{b ? ' in this age group' : ''}.</EmptyState> : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
          {d.items.map((i) => (
            <li key={i.id}>
              <Link href={`/invoices/${i.id}`} className="flex items-center justify-between gap-3 px-3 py-3 hover:bg-canvas">
                <div className="min-w-0"><p className="text-sm font-semibold">{i.number}</p><p className="truncate text-xs text-muted">{i.customer.name} · due {day(i.dueDate)} · {AGE_LABEL[i.bucket]}</p></div>
                <span className={`shrink-0 font-semibold tabular-nums ${i.bucket === 'current' ? '' : 'text-danger'}`}>{money(i.outstandingCents, fmt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

async function Reports({ ctx, range, fmt, entitled, can }: { ctx: Ctx; range: { from?: string; to?: string }; fmt: Fmt; entitled: boolean; can: (p: Parameters<Ctx['permissions']['has']>[0]) => boolean }) {
  if (!entitled) {
    return (
      <EmptyState title="Reports are part of a higher plan" action={can('settings.manage_billing') ? <LinkButton href="/settings/billing">See plans</LinkButton> : undefined}>
        Quote analytics, payment analytics, gross profit and VAT reports are included on the Team plan and above. The overview and “who owes” screens are on every plan.
      </EmptyState>
    );
  }
  const quotes = can('quote.view') ? await getQuoteAnalytics(ctx, range) : null;
  const pays = can('payment.view') ? await getPaymentAnalytics(ctx, range) : null;
  const profit = can('finance.view_costs') ? await getProfitability(ctx, range) : null;
  const vat = await getVatReport(ctx, range);
  return (
    <div className="space-y-6">
      {quotes && (
        <section className="space-y-2">
          <h2 className="text-base font-semibold">Quotes</h2>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Quotes" value={quotes.counts.total} hint={`${quotes.counts.draft} draft · ${quotes.counts.sent + quotes.counts.viewed} awaiting`} />
            <Kpi label="Approved" value={quotes.counts.approved + quotes.counts.converted} hint={quotes.approvalRatePct === null ? undefined : `${quotes.approvalRatePct}% of sent`} tone="ok" />
            <Kpi label="Declined / expired" value={`${quotes.counts.declined} / ${quotes.counts.expired}`} hint={quotes.declineRatePct === null ? undefined : `${quotes.declineRatePct}% declined`} />
            <Kpi label="Average quote" value={money(quotes.averageQuoteValueCents, fmt)} />
            <Kpi label="Approved value" value={money(quotes.approvedValueCents, fmt)} tone="ok" />
            <Kpi label="Value awaiting" value={money(quotes.outstandingValueCents, fmt)} />
            <Kpi label="Converted to invoice" value={quotes.counts.converted} />
            <Kpi label="Cancelled" value={quotes.counts.cancelled} />
          </div>
          <p className="text-xs text-muted">{quotes.note}</p>
        </section>
      )}
      {pays && (
        <section className="space-y-2">
          <h2 className="text-base font-semibold">Payments</h2>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Received" value={money(pays.totalReceivedCents, fmt)} hint={`${pays.paymentCount} payments`} tone="ok" />
            <Kpi label="Refunded" value={money(pays.refundedCents, fmt)} hint={`${pays.refundCount} refunds`} />
            <Kpi label="Credit issued" value={money(pays.creditIssuedCents, fmt)} hint={`${money(pays.creditAppliedCents, fmt)} applied`} />
            <Kpi label="Outstanding" value={money(pays.outstandingCents, fmt)} />
          </div>
          <Card>
            <h3 className="mb-2 text-sm font-semibold">By method</h3>
            <ul className="divide-y divide-line text-sm">
              {pays.byMethod.map((m) => <li key={m.method} className="flex justify-between py-1.5"><span>{METHOD_LABEL[m.method]} <span className="text-muted">({m.count})</span></span><span className="tabular-nums">{money(m.amountCents, fmt)}</span></li>)}
            </ul>
          </Card>
        </section>
      )}
      {profit && (
        <section className="space-y-2">
          <h2 className="text-base font-semibold">Gross profit (operational)</h2>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Revenue (ex VAT)" value={money(profit.revenueCents, fmt)} />
            <Kpi label="Parts cost" value={money(profit.partsCostCents, fmt)} />
            <Kpi label="Labour cost" value={money(profit.labourCostCents, fmt)} />
            <Kpi label="Gross profit" value={money(profit.grossProfitCents, fmt)} hint={profit.grossMarginPct === null ? undefined : `${profit.grossMarginPct}% margin`} tone="ok" />
          </div>
          {profit.uncostedLines > 0 && <Alert tone="warn">{profit.uncostedLines} invoice line{profit.uncostedLines === 1 ? ' has' : 's have'} no recorded cost ({money(profit.uncostedRevenueCents, fmt)} of revenue); {profit.uncostedLines === 1 ? 'it is' : 'they are'} counted as zero cost.</Alert>}
          <p className="text-xs text-muted">{profit.note}</p>
        </section>
      )}
      <section className="space-y-2">
        <h2 className="text-base font-semibold">VAT (operational data for your accountant)</h2>
        {!vat.vatRegistered && <Alert tone="warn">This business is not marked as VAT registered, so no VAT is charged on documents.</Alert>}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi label="Output VAT" value={money(vat.outputVatCents, fmt)} />
          <Kpi label="Taxable sales" value={money(vat.taxableSalesCents, fmt)} />
        </div>
        <p className="text-xs text-muted">{vat.note}</p>
      </section>
    </div>
  );
}

async function Find({ ctx, q }: { ctx: Ctx; q?: string }) {
  const groups = q && q.trim().length >= 2 ? await searchFinance(ctx, { q, limit: 10 }) : [];
  return (
    <div className="space-y-4">
      <form action="/finance" role="search"><input type="hidden" name="tab" value="search" /><input name="q" defaultValue={q} type="search" autoFocus placeholder="Invoice, quote, receipt or payment number, reference, customer, phone, registration, VIN" aria-label="Search finance records" className={field} /></form>
      {q && groups.length === 0 && <EmptyState title="Nothing found">Try a document number, a payment reference, a customer name or a registration.</EmptyState>}
      {groups.map((g) => (
        <Card key={g.key}>
          <h2 className="mb-2 text-sm font-semibold">{g.label}</h2>
          <ul className="divide-y divide-line">{g.items.map((i) => <li key={i.id}><Link href={i.href} className="block py-2.5 hover:bg-canvas"><p className="text-sm font-medium">{i.title}</p>{i.subtitle && <p className="text-xs text-muted">{i.subtitle}</p>}</Link></li>)}</ul>
        </Card>
      ))}
    </div>
  );
}

function Statements({ ctx }: { ctx: Ctx }) {
  const today = todayIso(ctx.business.timezone);
  return (
    <Card className="max-w-xl space-y-3">
      <h2 className="text-base font-semibold">Customer statement</h2>
      <p className="text-sm text-muted">A customer’s account for a period: invoices, payments, credit notes and refunds, with opening and closing balances. Download it as a PDF to send.</p>
      <StatementForm defaultFrom={`${today.slice(0, 4)}-01-01`} defaultTo={today} />
    </Card>
  );
}

function Exports({ ctx, range }: { ctx: Ctx; range: { from?: string; to?: string } }) {
  const today = todayIso(ctx.business.timezone);
  const from = range.from ?? `${today.slice(0, 4)}-01-01`;
  const to = range.to ?? today;
  const can = (p: Parameters<Ctx['permissions']['has']>[0]) => ctx.permissions.has(p);
  if (!can('finance.export')) return <Alert tone="warn">You do not have permission to export financial data.</Alert>;
  const sets: [string, string, boolean][] = [
    ['invoices', 'Invoices', can('invoice.view')], ['invoice_lines', 'Invoice lines', can('invoice.view')], ['payments', 'Payments', can('payment.view')], ['receipts', 'Receipts', can('payment.view')],
    ['quotes', 'Quotes', can('quote.view')], ['credit_notes', 'Credit notes', can('credit_note.view')], ['vat', 'VAT lines', can('invoice.view')], ['ageing', 'Ageing (open invoices)', can('invoice.view')],
  ];
  return (
    <Card className="space-y-3">
      <h2 className="text-base font-semibold">Export for your accountant</h2>
      <p className="text-sm text-muted">Download <strong>{from}</strong> to <strong>{to}</strong> as CSV or Excel. Change the dates above. Exports are recorded in the audit log.</p>
      <ul className="divide-y divide-line">
        {sets.filter(([, , ok]) => ok).map(([key, label]) => (
          <li key={key} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
            <span className="text-sm font-medium">{label}</span>
            <span className="flex gap-2">
              <a className="inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-3 text-sm font-semibold hover:bg-canvas md:min-h-10" href={`/api/v1/finance/export?dataset=${key}&format=csv&from=${from}&to=${to}`}>CSV</a>
              <a className="inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-3 text-sm font-semibold hover:bg-canvas md:min-h-10" href={`/api/v1/finance/export?dataset=${key}&format=xlsx&from=${from}&to=${to}`}>Excel</a>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}


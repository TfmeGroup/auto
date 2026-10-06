import type { Metadata } from 'next';
import { DocumentsPanel } from '@/components/documents/DocumentsPanel';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, Card, LinkButton, PageHeader } from '@/components/ui';
import { ApproveOnBehalfForm, GoButton, ReasonButton, SendPanel } from '@/components/finance/FinanceActions';
import { InvoiceStatusBadge, LineItems, QuoteStatusBadge, TotalsBox, money } from '@/components/finance/shared';
import { Row } from '@/components/workshop/layout';
import { isAppError } from '@/lib/errors';
import { formatDate, formatDateTime } from '@/lib/format';
import { getQuote } from '@/server/finance/quotes';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Quote' };
export const dynamic = 'force-dynamic';

const EVENT: Record<string, string> = {
  'quote.created': 'Created', 'quote.edited': 'Edited', 'quote.version_created': 'New version created', 'quote.sent': 'Sent to the customer', 'quote.resent': 'Link re-sent',
  'quote.viewed': 'Opened by the customer', 'quote.approved': 'Approved', 'quote.declined': 'Declined', 'quote.changes_requested': 'Customer asked for changes', 'quote.expired': 'Expired',
  'quote.cancelled': 'Cancelled', 'quote.job_created': 'Job created', 'quote.converted_to_invoice': 'Invoice created',
};

export default async function QuotePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ version?: string; notice?: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'quote.view');
  const { id } = await params;
  const sp = await searchParams;
  let q;
  try {
    q = await getQuote(ctx, id, { version: sp.version });
  } catch (e) {
    if (isAppError(e) && (e.code === 'NOT_FOUND' || e.code === 'VALIDATION_ERROR')) notFound();
    throw e;
  }
  const fmt = { currency: ctx.business.currency, locale: ctx.business.locale };
  const tz = ctx.business.timezone;
  const dt = (d: Date | string) => formatDateTime(d, tz, ctx.business.locale);
  const day = (d: string | null) => (d ? formatDate(`${d}T12:00:00Z`, 'UTC', ctx.business.locale) : '—');
  const { quote, version: v, actions } = q;
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  const hasEmail = !!q.customer?.email;
  const liveInvoice = q.invoices.find((i) => i.status !== 'CANCELLED');

  return (
    <>
      <PageHeader
        title={`${quote.number}${v.isCurrent ? '' : ` · version ${v.version}`}`}
        description={v.title ?? undefined}
        actions={<>
          <LinkButton href={`/api/v1/quotes/${quote.id}/pdf${v.isCurrent ? '' : `?version=${v.version}`}`} variant="secondary">View PDF</LinkButton>
          {actions.edit && <LinkButton href={`/quotes/${quote.id}/edit`} variant="secondary">{v.frozen ? 'Revise (new version)' : 'Edit'}</LinkButton>}
        </>}
      />
      {sp.notice && <div className="mb-3"><Alert tone="warn">{sp.notice}</Alert></div>}
      {!v.isCurrent && <div className="mb-3"><Alert tone="warn">You are looking at an older version (v{v.version}). <Link href={`/quotes/${quote.id}`} className="font-semibold underline">Go to the current version (v{quote.currentVersion})</Link>.</Alert></div>}
      {quote.changesRequestedAt && quote.status !== 'DRAFT' && <div className="mb-3"><Alert tone="warn">The customer asked for changes. Revise the quote to create a new version for them to approve.</Alert></div>}
      {quote.status === 'EXPIRED' && <div className="mb-3"><Alert tone="warn">This quote expired on {day(v.validUntil)}. Revise it with a new “valid until” date to send it again.</Alert></div>}
      {quote.status === 'DECLINED' && <div className="mb-3"><Alert tone="warn">The customer declined this quote.</Alert></div>}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <QuoteStatusBadge status={quote.status} />
              <span className="text-sm text-muted">Version {v.version}{v.frozen ? ` · sent ${v.sentAt ? dt(v.sentAt) : ''}` : ' · not yet sent'}</span>
            </div>
            <LineItems lines={q.lines} fmt={fmt} showVat={v.vatRegistered} showCost={can('finance.view_costs')} />
            <div className="mt-4 border-t border-line pt-3">
              <TotalsBox fmt={fmt} t={{ subtotalCents: v.subtotalCents, discountCents: v.discountCents, taxableCents: v.taxableCents, vatCents: v.vatCents, totalCents: v.totalCents, vatRegistered: v.vatRegistered, vatRateBps: v.vatRateBps }} />
              <p className="mt-1 text-right text-xs text-muted">{v.pricesIncludeVat ? 'Prices include VAT.' : v.vatRegistered ? 'Prices exclude VAT.' : 'Not VAT registered.'}</p>
            </div>
          </Card>

          {(v.customerNotes || v.terms || v.description) && (
            <Card>
              <dl className="divide-y divide-line">
                {v.description && <Row label="Description"><span className="whitespace-pre-wrap">{v.description}</span></Row>}
                {v.customerNotes && <Row label="Customer notes"><span className="whitespace-pre-wrap">{v.customerNotes}</span></Row>}
                {v.terms && <Row label="Terms"><span className="whitespace-pre-wrap">{v.terms}</span></Row>}
              </dl>
            </Card>
          )}
          {quote.internalNotes && <Card><h2 className="mb-1 text-base font-semibold">Internal notes</h2><p className="whitespace-pre-wrap text-sm">{quote.internalNotes}</p><p className="mt-1 text-xs text-muted">Never shown to the customer.</p></Card>}

          <Card>
            <h2 className="mb-3 text-base font-semibold">History</h2>
            {q.events.length === 0 ? <p className="text-sm text-muted">Nothing yet.</p> : (
              <ol className="relative space-y-3 border-l border-line pl-4">
                {q.events.map((e) => (
                  <li key={e.id} className="relative">
                    <span aria-hidden className="absolute -left-[1.3rem] top-1.5 size-2.5 rounded-full border-2 border-surface bg-brand-500" />
                    <p className="text-sm">{EVENT[e.type] ?? e.type}{e.version ? ` (v${e.version})` : ''}{e.type === 'quote.approved' && e.detail && typeof e.detail === 'object' && 'method' in e.detail ? ` · ${String((e.detail as { method: string }).method).toLowerCase().replace('_', ' ')}` : ''}</p>
                    {e.detail && typeof e.detail === 'object' && 'comment' in e.detail && (e.detail as { comment?: string }).comment && <p className="text-sm text-muted">“{(e.detail as { comment: string }).comment}”</p>}
                    {e.detail && typeof e.detail === 'object' && 'changeNote' in e.detail && <p className="text-sm text-muted">{(e.detail as { changeNote: string }).changeNote}</p>}
                    <p className="text-xs text-muted">{dt(e.at)} · {e.actorName ?? (e.actorKind === 'SYSTEM' ? 'System' : e.actorKind === 'CUSTOMER' ? 'Customer' : 'Staff')}{e.actorKind === 'CUSTOMER' ? ' (customer)' : ''}</p>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <h2 className="mb-1 text-base font-semibold">Details</h2>
            <dl className="divide-y divide-line">
              <Row label="Customer">{q.customer && <Link className="text-brand-700 hover:underline" href={`/customers/${q.customer.id}`}>{q.customer.name}</Link>}</Row>
              <Row label="Vehicle">{q.vehicle && <Link className="text-brand-700 hover:underline" href={`/vehicles/${q.vehicle.id}`}>{q.vehicle.label}</Link>}</Row>
              <Row label="Job">{q.job && <Link className="text-brand-700 hover:underline" href={`/jobs/${q.job.id}`}>{q.job.jobNumber}</Link>}</Row>
              <Row label="Quote date">{day(v.quoteDate)}</Row>
              <Row label="Valid until">{day(v.validUntil)}</Row>
              <Row label="Created by">{quote.createdBy}</Row>
            </dl>
          </Card>

          {(actions.send || actions.approve || actions.cancel || actions.createJob || actions.createInvoice || liveInvoice) && (
            <Card className="space-y-4">
              <h2 className="text-base font-semibold">Actions</h2>
              {quote.status === 'APPROVED' && <Alert tone="ok">Approved{quote.approvedAt ? ` on ${dt(quote.approvedAt)}` : ''} (version {quote.approvedVersion}).</Alert>}
              {actions.send && <SendPanel path={`/api/v1/quotes/${quote.id}/send`} label={quote.status === 'DRAFT' ? 'Send to customer' : 'Send the link again'} hasEmail={hasEmail} noun="quote" />}
              {actions.approve && <ApproveOnBehalfForm quoteId={quote.id} version={quote.currentVersion} />}
              {actions.createInvoice && <GoButton label="Create invoice" variant="primary" path={`/api/v1/quotes/${quote.id}/invoice`} redirect={{ base: '/invoices/', key: 'id' }} confirm="Create a draft invoice from this approved quote?" />}
              {actions.createJob && <GoButton label="Create job" path={`/api/v1/quotes/${quote.id}/create-job`} redirect={{ base: '/jobs/', key: 'jobId' }} confirm="Open a job card for this vehicle with the approved work?" />}
              {liveInvoice && <p className="text-sm">Invoice: <Link className="text-brand-700 hover:underline" href={`/invoices/${liveInvoice.id}`}>{liveInvoice.number ?? 'Draft invoice'}</Link> <InvoiceStatusBadge status={liveInvoice.status} /></p>}
              {actions.cancel && <ReasonButton label="Cancel quote" variant="danger" path={`/api/v1/quotes/${quote.id}/cancel`} prompt="Why is it being cancelled?" />}
            </Card>
          )}

          <Card>
            <h2 className="mb-2 text-base font-semibold">Versions</h2>
            <ul className="space-y-2 text-sm">
              {q.versions.map((x) => (
                <li key={x.version} className="flex items-start justify-between gap-2">
                  <div>
                    <Link href={x.version === quote.currentVersion ? `/quotes/${quote.id}` : `/quotes/${quote.id}?version=${x.version}`} className={x.version === v.version ? 'font-semibold' : 'text-brand-700 hover:underline'}>
                      Version {x.version}{x.version === quote.currentVersion ? ' (current)' : ''}
                    </Link>
                    <p className="text-xs text-muted">{x.sentAt ? `Sent ${dt(x.sentAt)}` : 'Not sent'}{x.changeNote ? ` · ${x.changeNote}` : ''}</p>
                  </div>
                  <span className="shrink-0 tabular-nums">{money(x.totalCents, fmt)}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
      <div className="mt-4"><DocumentsPanel ctx={ctx} resourceType="quote" resourceId={quote.id} kind="documents" title="Stored documents (each PDF version is kept)" /></div>
    </>
  );
}

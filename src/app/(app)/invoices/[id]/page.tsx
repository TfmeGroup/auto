import { randomUUID } from 'node:crypto';
import { DocumentsPanel } from '@/components/documents/DocumentsPanel';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, Card, LinkButton, PageHeader } from '@/components/ui';
import { ApplyCreditForm, GoButton, ReasonButton, RecordPaymentForm, SendPanel } from '@/components/finance/FinanceActions';
import { CreditNoteStatusBadge, InvoiceStatusBadge, LineItems, METHOD_LABEL, PaymentStatusBadge, TotalsBox, money } from '@/components/finance/shared';
import { Row } from '@/components/workshop/layout';
import { isAppError } from '@/lib/errors';
import { formatDate, formatDateTime } from '@/lib/format';
import { centsToDecimal } from '@/lib/money';
import { getInvoice } from '@/server/finance/invoices';
import { getDocumentDefaults } from '@/server/finance/settings';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Invoice' };
export const dynamic = 'force-dynamic';

const EVENT: Record<string, string> = {
  'invoice.created': 'Draft created', 'invoice.edited': 'Draft edited', 'invoice.finalised': 'Issued', 'invoice.sent': 'Sent to the customer', 'invoice.resent': 'Link re-sent', 'invoice.viewed': 'Opened by the customer',
  'invoice.cancelled': 'Cancelled', 'invoice.written_off': 'Written off', 'invoice.overdue': 'Became overdue', 'invoice.credit_applied': 'Customer credit applied', 'invoice.credit_note_issued': 'Credit note issued',
  'invoice.reminder_sent': 'Payment reminder sent',
};

export default async function InvoicePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'invoice.view');
  const { id } = await params;
  const sp = await searchParams;
  let d;
  try {
    d = await getInvoice(ctx, id);
  } catch (e) {
    if (isAppError(e) && e.code === 'NOT_FOUND') notFound();
    throw e;
  }
  const defaults = ctx.permissions.has('payment.create') ? await getDocumentDefaults(ctx) : null;
  const fmt = { currency: ctx.business.currency, locale: ctx.business.locale };
  const dt = (x: Date | string) => formatDateTime(x, ctx.business.timezone, ctx.business.locale);
  const day = (x: string | null) => (x ? formatDate(`${x}T12:00:00Z`, 'UTC', ctx.business.locale) : '—');
  const i = d.invoice;
  const a = d.actions;
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  const issued = !!i.finalisedAt;
  const hasEmail = !!d.customer?.email;

  return (
    <>
      <PageHeader
        title={i.number ?? 'Draft invoice'}
        description={i.title ?? undefined}
        actions={<>
          <LinkButton href={`/api/v1/invoices/${i.id}/pdf`} variant="secondary">View PDF</LinkButton>
          {a.edit && <LinkButton href={`/invoices/${i.id}/edit`} variant="secondary">Edit draft</LinkButton>}
        </>}
      />
      {sp.notice && <div className="mb-3"><Alert tone="warn">{sp.notice}</Alert></div>}
      {i.status === 'OVERDUE' && <div className="mb-3"><Alert tone="danger">This invoice was due on {day(i.dueDate)} and {money(i.outstandingCents, fmt)} is still outstanding.</Alert></div>}
      {i.status === 'PAID' && i.paidCents === 0 && i.creditNotedCents > 0 && <div className="mb-3"><Alert tone="ok">Settled by credit note.</Alert></div>}
      {i.status === 'WRITTEN_OFF' && <div className="mb-3"><Alert tone="warn">Written off ({money(i.writtenOffCents, fmt)}){i.writeOffReason ? `: ${i.writeOffReason}` : ''}.</Alert></div>}
      {i.status === 'CANCELLED' && <div className="mb-3"><Alert tone="warn">Cancelled{i.cancelReason ? `: ${i.cancelReason}` : ''}.</Alert></div>}
      {!issued && i.status === 'DRAFT' && <div className="mb-3"><Alert tone="warn">This is a draft. It has no invoice number yet and the customer cannot see it. Issue it when it is ready: after that it is locked.</Alert></div>}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <InvoiceStatusBadge status={i.status} />
              {issued && <span className="text-sm text-muted">Issued {day(i.invoiceDate)} · due {day(i.dueDate)}</span>}
            </div>
            <LineItems lines={d.lines} fmt={fmt} showVat={i.vatRegistered} showCost={can('finance.view_costs')} />
            <div className="mt-4 border-t border-line pt-3">
              <TotalsBox fmt={fmt} t={{
                subtotalCents: i.subtotalCents, discountCents: i.discountCents, taxableCents: i.taxableCents, vatCents: i.vatCents, totalCents: i.totalCents, vatRegistered: i.vatRegistered, vatRateBps: i.vatRateBps,
                ...(issued ? { paidCents: i.paidCents, creditCents: i.creditAppliedCents + i.creditNotedCents, writtenOffCents: i.writtenOffCents, outstandingCents: i.outstandingCents } : {}),
              }} />
            </div>
          </Card>

          {d.profit && (
            <Card>
              <h2 className="mb-2 text-base font-semibold">Profit on this invoice</h2>
              <dl className="grid grid-cols-3 gap-3 text-sm">
                <div><dt className="text-muted">Revenue (ex VAT)</dt><dd className="font-semibold tabular-nums">{money(d.profit.revenueCents, fmt)}</dd></div>
                <div><dt className="text-muted">Recorded cost</dt><dd className="font-semibold tabular-nums">{money(d.profit.costCents, fmt)}</dd></div>
                <div><dt className="text-muted">Gross profit</dt><dd className="font-semibold tabular-nums">{money(d.profit.grossProfitCents, fmt)}</dd></div>
              </dl>
              <p className="mt-2 text-xs text-muted">Operational gross profit from the costs recorded on the lines. Lines without a cost count as zero cost. Never shown to the customer.</p>
            </Card>
          )}

          {(i.customerNotes || i.terms) && (
            <Card><dl className="divide-y divide-line">{i.customerNotes && <Row label="Customer notes"><span className="whitespace-pre-wrap">{i.customerNotes}</span></Row>}{i.terms && <Row label="Terms"><span className="whitespace-pre-wrap">{i.terms}</span></Row>}</dl></Card>
          )}
          {i.internalNotes && <Card><h2 className="mb-1 text-base font-semibold">Internal notes</h2><p className="whitespace-pre-wrap text-sm">{i.internalNotes}</p><p className="mt-1 text-xs text-muted">Never shown to the customer.</p></Card>}

          {can('payment.view') && issued && (
            <Card>
              <h2 className="mb-3 text-base font-semibold">Payments</h2>
              {d.payments.length === 0 && d.creditApplications.length === 0 ? <p className="text-sm text-muted">No payments yet.</p> : (
                <ul className="divide-y divide-line">
                  {d.payments.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                      <div>
                        <Link href={`/payments/${p.id}`} className="font-medium text-brand-700 hover:underline">{p.number}</Link> <PaymentStatusBadge status={p.status} />
                        <p className="text-xs text-muted">{METHOD_LABEL[p.method] ?? p.method}{p.reference ? ` · ${p.reference}` : ''}{p.paidAt ? ` · ${dt(p.paidAt)}` : ''}{p.receipt ? ` · receipt ${p.receipt.number}` : ''}</p>
                        {p.creditedCents > 0 && <p className="text-xs text-muted">{money(p.creditedCents, fmt)} of this was kept as customer credit.</p>}
                        {p.refunds.map((r) => <p key={r.id} className="text-xs text-danger">Refunded {money(r.amountCents, fmt)} ({r.number}): {r.reason}</p>)}
                      </div>
                      <span className="font-semibold tabular-nums">{money(p.amountCents, fmt)}</span>
                    </li>
                  ))}
                  {d.creditApplications.map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-2 py-2.5 text-sm"><div><p className="font-medium">Customer credit applied</p><p className="text-xs text-muted">{dt(c.at)}</p></div><span className="font-semibold tabular-nums">{money(c.amountCents, fmt)}</span></li>
                  ))}
                </ul>
              )}
            </Card>
          )}

          {d.creditNotes.length > 0 && (
            <Card>
              <h2 className="mb-3 text-base font-semibold">Credit notes</h2>
              <ul className="divide-y divide-line">
                {d.creditNotes.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-2 py-2.5 text-sm">
                    <div><Link href={`/credit-notes/${c.id}`} className="font-medium text-brand-700 hover:underline">{c.number ?? 'Draft credit note'}</Link> <CreditNoteStatusBadge status={c.status} /></div>
                    <span className="font-semibold tabular-nums">{money(c.totalCents, fmt)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card>
            <h2 className="mb-3 text-base font-semibold">History</h2>
            <ol className="relative space-y-3 border-l border-line pl-4">
              {d.events.map((e) => (
                <li key={e.id} className="relative">
                  <span aria-hidden className="absolute -left-[1.3rem] top-1.5 size-2.5 rounded-full border-2 border-surface bg-brand-500" />
                  <p className="text-sm">{EVENT[e.type] ?? e.type}</p>
                  <p className="text-xs text-muted">{dt(e.at)} · {e.actorName ?? (e.actorKind === 'SYSTEM' ? 'System' : e.actorKind === 'CUSTOMER' ? 'Customer' : 'Staff')}{e.actorKind === 'CUSTOMER' ? ' (customer)' : ''}</p>
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <h2 className="mb-1 text-base font-semibold">Details</h2>
            <dl className="divide-y divide-line">
              <Row label="Customer">{d.customer && <Link className="text-brand-700 hover:underline" href={`/customers/${d.customer.id}`}>{d.customer.name}</Link>}</Row>
              <Row label="Vehicle">{d.vehicle && <Link className="text-brand-700 hover:underline" href={`/vehicles/${d.vehicle.id}`}>{d.vehicle.label}</Link>}</Row>
              <Row label="Job">{d.job && <Link className="text-brand-700 hover:underline" href={`/jobs/${d.job.id}`}>{d.job.jobNumber}</Link>}</Row>
              <Row label="Quote">{d.quote && <Link className="text-brand-700 hover:underline" href={`/quotes/${d.quote.id}`}>{d.quote.number}{i.quoteVersion ? ` (v${i.quoteVersion})` : ''}</Link>}</Row>
              <Row label="Terms">{i.paymentTermsDays ? `${i.paymentTermsDays} days` : undefined}</Row>
              <Row label="Created by">{i.createdBy}</Row>
              {issued && <Row label="Issued by">{i.finalisedBy}</Row>}
            </dl>
          </Card>

          <Card className="space-y-4">
            <h2 className="text-base font-semibold">Actions</h2>
            {a.finalise && <GoButton label="Issue invoice" variant="primary" path={`/api/v1/invoices/${i.id}/finalise`} confirm="Issue this invoice? It gets its number and is locked: later corrections need a credit note." />}
            {a.send && <SendPanel path={`/api/v1/invoices/${i.id}/send`} label={i.sentAt ? 'Send the link again' : 'Send to customer'} hasEmail={hasEmail} noun="invoice" />}
            {a.recordPayment && defaults && (
              <div>
                <h3 className="mb-2 text-sm font-semibold">Record a payment</h3>
                <RecordPaymentForm invoiceId={i.id} defaultAmount={centsToDecimal(i.outstandingCents)} methods={defaults.enabledMethods} idempotencyKey={randomUUID()} />
              </div>
            )}
            {a.applyCredit && (
              <div>
                <h3 className="mb-2 text-sm font-semibold">Use customer credit</h3>
                <ApplyCreditForm invoiceId={i.id} maxCents={Math.min(d.customerCreditCents, i.outstandingCents)} availableLabel={money(d.customerCreditCents, fmt)} idempotencyKey={randomUUID()} />
              </div>
            )}
            {a.creditNote && <LinkButton href={`/credit-notes/new?invoiceId=${i.id}`} variant="secondary">Issue a credit note</LinkButton>}
            {a.writeOff && <ReasonButton label="Write off balance" variant="danger" path={`/api/v1/invoices/${i.id}/write-off`} prompt="Why is the balance being written off?" />}
            {a.cancel && <ReasonButton label="Cancel invoice" variant="danger" path={`/api/v1/invoices/${i.id}/cancel`} prompt="Why is it being cancelled?" />}
            {!a.finalise && !a.send && !a.recordPayment && !a.creditNote && !a.cancel && <p className="text-sm text-muted">No actions available.</p>}
          </Card>
        </div>
      </div>
      <div className="mt-4"><DocumentsPanel ctx={ctx} resourceType="invoice" resourceId={i.id} kind="documents" title="Stored documents (a copy is kept at each stage)" /></div>
    </>
  );
}

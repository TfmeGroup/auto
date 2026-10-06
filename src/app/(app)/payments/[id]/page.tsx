import { randomUUID } from 'node:crypto';
import { DocumentsPanel } from '@/components/documents/DocumentsPanel';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, LinkButton, PageHeader } from '@/components/ui';
import { ReconcileButton, RefundForm } from '@/components/finance/FinanceActions';
import { METHOD_LABEL, PaymentStatusBadge, money } from '@/components/finance/shared';
import { Row } from '@/components/workshop/layout';
import { isAppError } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { getPayment } from '@/server/finance/payments';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Payment' };
export const dynamic = 'force-dynamic';

const EVENT: Record<string, string> = {
  'payment.recorded': 'Recorded', 'payment.completed': 'Completed', 'payment.refunded': 'Refunded', 'payment.online_started': 'Online payment started', 'payment.failed': 'Failed', 'payment.cancelled': 'Cancelled',
};

export default async function PaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'payment.view');
  const { id } = await params;
  let d;
  try {
    d = await getPayment(ctx, id);
  } catch (e) {
    if (isAppError(e) && e.code === 'NOT_FOUND') notFound();
    throw e;
  }
  const fmt = { currency: ctx.business.currency, locale: ctx.business.locale };
  const dt = (x: Date | string) => formatDateTime(x, ctx.business.timezone, ctx.business.locale);
  const p = d.payment;

  return (
    <>
      <PageHeader title={p.number} description={p.purpose === 'DEPOSIT' ? 'Deposit' : 'Payment'} actions={d.receipt && <LinkButton href={`/api/v1/receipts/${d.receipt.id}/pdf`} variant="secondary">Receipt {d.receipt.number}</LinkButton>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <PaymentStatusBadge status={p.status} />
              <p className="text-2xl font-bold tabular-nums">{money(p.amountCents, fmt)}</p>
            </div>
            <dl className="divide-y divide-line">
              <Row label="Customer">{d.customer && <Link className="text-brand-700 hover:underline" href={`/customers/${d.customer.id}`}>{d.customer.name}</Link>}</Row>
              <Row label="Invoice">{d.invoice && <Link className="text-brand-700 hover:underline" href={`/invoices/${d.invoice.id}`}>{d.invoice.number}</Link>}</Row>
              <Row label="Method">{METHOD_LABEL[p.method]}{p.provider ? ` (${p.provider})` : ''}</Row>
              <Row label="Reference">{p.reference}</Row>
              <Row label="Provider reference">{p.providerReference}</Row>
              <Row label="Date">{p.paidAt ? dt(p.paidAt) : undefined}</Row>
              <Row label="Applied to invoice">{money(p.appliedCents, fmt)}</Row>
              <Row label="Kept as customer credit">{p.creditedCents > 0 ? money(p.creditedCents, fmt) : undefined}</Row>
              <Row label="Refunded">{p.refundedAppliedCents + p.refundedCreditCents > 0 ? money(p.refundedAppliedCents + p.refundedCreditCents, fmt) : undefined}</Row>
              <Row label="Recorded by">{p.recordedBy ?? (p.provider ? 'Payment provider' : undefined)}</Row>
              <Row label="Notes">{p.notes}</Row>
              <Row label="Failure">{p.failureReason}</Row>
            </dl>
          </Card>

          {d.refunds.length > 0 && (
            <Card>
              <h2 className="mb-2 text-base font-semibold">Refunds</h2>
              <ul className="divide-y divide-line">
                {d.refunds.map((r) => (
                  <li key={r.id} className="flex items-start justify-between gap-3 py-2.5 text-sm">
                    <div><p className="font-medium">{r.number}</p><p className="text-xs text-muted">{dt(r.refundedAt)} · {r.reason}</p></div>
                    <span className="font-semibold tabular-nums">{money(r.amountCents, fmt)}</span>
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
                  <p className="text-xs text-muted">{dt(e.at)} · {e.actorName ?? 'System'}</p>
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="space-y-4">
            <h2 className="text-base font-semibold">Reconciliation</h2>
            <p className="text-sm">{p.reconciled ? <>Reconciled{p.reconciledBy ? ` by ${p.reconciledBy}` : ''}{p.reconciledAt ? ` on ${dt(p.reconciledAt)}` : ''}.</> : 'Not yet matched to a bank or card statement.'}</p>
            {p.reconciliationNote && <p className="text-sm text-muted">{p.reconciliationNote}</p>}
            {d.actions.reconcile && <ReconcileButton paymentId={p.id} reconciled={p.reconciled} />}
          </Card>
          {d.actions.refund && p.refundableCents > 0 && (
            <Card className="space-y-3">
              <h2 className="text-base font-semibold">Refund</h2>
              <p className="text-sm text-muted">Up to {money(p.refundableCents, fmt)} can still be refunded.</p>
              <RefundForm paymentId={p.id} maxCents={p.refundableCents} idempotencyKey={randomUUID()} />
            </Card>
          )}
        </div>
      </div>
      {d.receipt && <div className="mt-4"><DocumentsPanel ctx={ctx} resourceType="receipt" resourceId={d.receipt.id} kind="documents" title="Receipt documents" /></div>}
    </>
  );
}

import type { Metadata } from 'next';
import { Alert, Card, LinkButton } from '@/components/ui';
import { BusinessHeader, InvalidLink, Meta, MetaItem } from '@/components/finance/CustomerDocShell';
import { PayOnline } from '@/components/finance/CustomerActions';
import { InvoiceStatusBadge, LineItems, METHOD_LABEL, TotalsBox, money } from '@/components/finance/shared';
import { isAppError } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import { getPublicInvoice } from '@/server/finance/online';
import { publicMeta } from '@/server/web/public-meta';

export const metadata: Metadata = { title: 'Your invoice' };

export default async function CustomerInvoicePage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ paid?: string }> }) {
  const { token } = await params;
  await searchParams;
  let d;
  try {
    d = await getPublicInvoice(token, await publicMeta());
  } catch (e) {
    if (isAppError(e) && e.code === 'NOT_FOUND') return <InvalidLink />;
    throw e;
  }
  const fmt = { currency: d.business.currency, locale: d.business.locale };
  const day = (x: string | null) => (x ? formatDate(`${x}T12:00:00Z`, 'UTC', d.business.locale) : '');
  const t = d.totals;
  const owing = t.outstandingCents > 0 && !['CANCELLED', 'WRITTEN_OFF'].includes(d.invoice.status);

  return (
    <div className="space-y-4">
      <BusinessHeader business={d.business} logoSrc={`/api/public/invoices/${token}/logo`} />

      <Card className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted">{d.invoice.taxInvoice ? 'Tax invoice' : 'Invoice'}</p>
            <h2 className="text-xl font-bold">{d.invoice.number}</h2>
            {d.invoice.title && <p className="text-sm text-muted">{d.invoice.title}</p>}
          </div>
          <InvoiceStatusBadge status={d.invoice.status} />
        </div>
        <Meta>
          <MetaItem label="Billed to">{d.customer.name}</MetaItem>
          <MetaItem label="Invoice date">{day(d.invoice.invoiceDate)}</MetaItem>
          <MetaItem label="Due date">{day(d.invoice.dueDate)}</MetaItem>
          <MetaItem label="Payment terms">{d.invoice.paymentTermsDays ? `${d.invoice.paymentTermsDays} days` : null}</MetaItem>
          <MetaItem label="Vehicle">{d.vehicle?.label}</MetaItem>
          <MetaItem label="Job">{d.jobNumber}</MetaItem>
          <MetaItem label="Quote">{d.quoteNumber}</MetaItem>
        </Meta>
      </Card>

      <Card>
        <LineItems lines={d.lines} fmt={fmt} showVat={t.vatRegistered} />
        <div className="mt-4 border-t border-line pt-3"><TotalsBox fmt={fmt} t={{ ...t, creditCents: t.creditCents }} /></div>
      </Card>

      {d.payments.length > 0 && (
        <Card>
          <h2 className="mb-2 text-sm font-semibold">Payments received</h2>
          <ul className="divide-y divide-line text-sm">
            {d.payments.map((p, i) => <li key={i} className="flex justify-between py-2"><span>{p.at ? day(new Date(p.at).toISOString().slice(0, 10)) : ''} · {METHOD_LABEL[p.method]}</span><span className="tabular-nums">{money(p.amountCents, fmt)}</span></li>)}
          </ul>
        </Card>
      )}

      {d.invoice.status === 'PAID' && <Alert tone="ok">This invoice has been paid in full. Thank you.</Alert>}
      {d.invoice.status === 'CANCELLED' && <Alert tone="warn">This invoice has been cancelled.</Alert>}
      {d.invoice.status === 'WRITTEN_OFF' && <Alert tone="warn">This invoice is closed.</Alert>}

      {owing && (
        <Card className="space-y-4">
          <div className="flex items-baseline justify-between"><h2 className="text-base font-semibold">Amount to pay</h2><p className="text-2xl font-bold tabular-nums">{money(t.outstandingCents, fmt)}</p></div>
          {d.invoice.status === 'OVERDUE' && <Alert tone="danger">This invoice was due on {day(d.invoice.dueDate)}.</Alert>}
          {d.payment.online && <PayOnline token={token} outstandingCents={t.outstandingCents} currency={d.business.currency} locale={d.business.locale} provider={d.payment.online.provider} />}
          {d.payment.instructions && (
            <div>
              <h3 className="text-sm font-semibold">{d.payment.online ? 'Or pay by EFT' : 'How to pay'}</h3>
              <p className="mt-1 whitespace-pre-wrap rounded-lg bg-canvas p-3 text-sm">{d.payment.instructions}</p>
              <p className="mt-1 text-xs text-muted">Please use {d.invoice.number} as your payment reference.</p>
            </div>
          )}
          {!d.payment.online && !d.payment.instructions && <p className="text-sm text-muted">Please contact {d.business.name} to arrange payment.</p>}
        </Card>
      )}

      {(d.invoice.customerNotes || d.invoice.terms) && (
        <Card className="space-y-3">
          {d.invoice.customerNotes && <div><h2 className="text-sm font-semibold">Notes</h2><p className="whitespace-pre-wrap text-sm">{d.invoice.customerNotes}</p></div>}
          {d.invoice.terms && <div><h2 className="text-sm font-semibold">Terms and conditions</h2><p className="whitespace-pre-wrap text-sm text-muted">{d.invoice.terms}</p></div>}
        </Card>
      )}

      <LinkButton href={`/api/public/invoices/${token}/pdf?download=1`} variant="secondary" className="w-full">Download as PDF</LinkButton>
    </div>
  );
}

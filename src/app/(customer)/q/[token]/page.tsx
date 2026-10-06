import type { Metadata } from 'next';
import { Alert, Card, LinkButton } from '@/components/ui';
import { BusinessHeader, InvalidLink, Meta, MetaItem } from '@/components/finance/CustomerDocShell';
import { QuoteDecision } from '@/components/finance/CustomerActions';
import { LineItems, QuoteStatusBadge, TotalsBox } from '@/components/finance/shared';
import { isAppError } from '@/lib/errors';
import { formatDate, formatDateTime } from '@/lib/format';
import { getPublicQuote } from '@/server/finance/quote-public';
import { publicMeta } from '@/server/web/public-meta';

export const metadata: Metadata = { title: 'Your quote' };

export default async function CustomerQuotePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let q;
  try {
    q = await getPublicQuote(token, await publicMeta());
  } catch (e) {
    if (isAppError(e) && e.code === 'NOT_FOUND') return <InvalidLink />;
    throw e;
  }
  const fmt = { currency: q.business.currency, locale: q.business.locale };
  const day = (d: string | null) => (d ? formatDate(`${d}T12:00:00Z`, 'UTC', q.business.locale) : '');

  return (
    <div className="space-y-4">
      <BusinessHeader business={q.business} logoSrc={`/api/public/quotes/${token}/logo`} />

      <Card className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted">Quote</p>
            <h2 className="text-xl font-bold">{q.quote.number}{q.quote.version > 1 ? ` · version ${q.quote.version}` : ''}</h2>
            {q.quote.title && <p className="text-sm text-muted">{q.quote.title}</p>}
          </div>
          <QuoteStatusBadge status={q.quote.status} />
        </div>
        <Meta>
          <MetaItem label="For">{q.customer.name}</MetaItem>
          <MetaItem label="Vehicle">{q.vehicle ? q.vehicle.label : null}</MetaItem>
          <MetaItem label="Job">{q.jobNumber}</MetaItem>
          <MetaItem label="Valid until">{day(q.quote.validUntil)}</MetaItem>
        </Meta>
        {q.quote.description && <p className="whitespace-pre-wrap text-sm">{q.quote.description}</p>}
        {q.quote.changeNote && <Alert tone="warn">This is a revised quote: {q.quote.changeNote}</Alert>}
      </Card>

      <Card>
        <LineItems lines={q.lines} fmt={fmt} showVat={q.totals.vatRegistered} />
        <div className="mt-4 border-t border-line pt-3">
          <TotalsBox fmt={fmt} t={q.totals} />
          <p className="mt-1 text-right text-xs text-muted">{q.totals.pricesIncludeVat ? 'Prices include VAT.' : q.totals.vatRegistered ? 'Prices exclude VAT.' : ''}</p>
        </div>
      </Card>

      {(q.quote.customerNotes || q.quote.terms) && (
        <Card className="space-y-3">
          {q.quote.customerNotes && <div><h2 className="text-sm font-semibold">Notes</h2><p className="whitespace-pre-wrap text-sm">{q.quote.customerNotes}</p></div>}
          {q.quote.terms && <div><h2 className="text-sm font-semibold">Terms and conditions</h2><p className="whitespace-pre-wrap text-sm text-muted">{q.quote.terms}</p></div>}
        </Card>
      )}

      <Card className="space-y-3">
        {q.decision ? (
          <Alert tone={q.decision.type === 'APPROVED' ? 'ok' : 'warn'}>
            {q.decision.type === 'APPROVED' ? 'Approved' : 'Declined'} by {q.decision.by} on {formatDateTime(q.decision.at, q.business.timezone, q.business.locale)}.
            {q.decision.type === 'APPROVED' ? ' The workshop will be in touch about the next steps.' : ''}
          </Alert>
        ) : q.canDecide ? (
          <>
            <p className="text-sm">Please review the quote above, then approve it, ask for changes, or decline.</p>
            <QuoteDecision token={token} version={q.quote.version} customerName={q.customer.name} />
          </>
        ) : q.quote.status === 'EXPIRED' ? (
          <Alert tone="warn">This quote has expired and can no longer be approved. Please contact {q.business.name} for an updated quote.</Alert>
        ) : q.quote.status === 'DRAFT' ? (
          <Alert tone="warn">This quote is being revised. You will receive a new link when it is ready.</Alert>
        ) : (
          <Alert tone="warn">This quote can no longer be answered.</Alert>
        )}
        <LinkButton href={`/api/public/quotes/${token}/pdf?download=1`} variant="secondary" className="w-full">Download as PDF</LinkButton>
      </Card>
    </div>
  );
}

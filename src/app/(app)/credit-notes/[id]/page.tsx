import type { Metadata } from 'next';
import { DocumentsPanel } from '@/components/documents/DocumentsPanel';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, Card, LinkButton, PageHeader } from '@/components/ui';
import { GoButton, ReasonButton } from '@/components/finance/FinanceActions';
import { CreditNoteStatusBadge, LineItems, TotalsBox, money } from '@/components/finance/shared';
import { Row } from '@/components/workshop/layout';
import { isAppError } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { getCreditNote } from '@/server/finance/creditnotes';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Credit note' };
export const dynamic = 'force-dynamic';

export default async function CreditNotePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'credit_note.view');
  const { id } = await params;
  let d;
  try {
    d = await getCreditNote(ctx, id);
  } catch (e) {
    if (isAppError(e) && e.code === 'NOT_FOUND') notFound();
    throw e;
  }
  const fmt = { currency: ctx.business.currency, locale: ctx.business.locale };
  const dt = (x: Date | string) => formatDateTime(x, ctx.business.timezone, ctx.business.locale);
  const c = d.creditNote;

  return (
    <>
      <PageHeader title={c.number ?? 'Draft credit note'} description={`Against invoice ${d.invoice?.number ?? ''}`} actions={<LinkButton href={`/api/v1/credit-notes/${c.id}/pdf`} variant="secondary">View PDF</LinkButton>} />
      {c.status === 'DRAFT' && <div className="mb-3"><Alert tone="warn">This is a draft. Nothing has changed on the invoice yet. Someone with authority must issue it.</Alert></div>}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <div className="mb-3"><CreditNoteStatusBadge status={c.status} /></div>
            <LineItems lines={d.lines} fmt={fmt} showVat={c.vatRegistered} />
            <div className="mt-4 border-t border-line pt-3"><TotalsBox fmt={fmt} t={{ subtotalCents: c.subtotalCents, discountCents: c.discountCents, taxableCents: c.taxableCents, vatCents: c.vatCents, totalCents: c.totalCents, vatRegistered: c.vatRegistered, vatRateBps: c.vatRateBps }} /></div>
            {c.status === 'ISSUED' && (
              <p className="mt-3 text-sm text-muted">{money(c.appliedCents, fmt)} reduced the invoice{c.creditedCents > 0 ? ` and ${money(c.creditedCents, fmt)} was added to the customer’s credit` : ''}.</p>
            )}
          </Card>
          <Card><h2 className="mb-1 text-base font-semibold">Reason</h2><p className="whitespace-pre-wrap text-sm">{c.reason}</p>{c.notes && <p className="mt-2 whitespace-pre-wrap text-sm text-muted">{c.notes}</p>}</Card>
          <Card>
            <h2 className="mb-3 text-base font-semibold">History</h2>
            <ol className="relative space-y-3 border-l border-line pl-4">
              {d.events.map((e) => (
                <li key={e.id} className="relative"><span aria-hidden className="absolute -left-[1.3rem] top-1.5 size-2.5 rounded-full border-2 border-surface bg-brand-500" /><p className="text-sm">{e.type.replace('credit_note.', '').replace('_', ' ')}</p><p className="text-xs text-muted">{dt(e.at)} · {e.actorName ?? 'System'}</p></li>
              ))}
            </ol>
          </Card>
        </div>
        <div className="space-y-4">
          <Card>
            <dl className="divide-y divide-line">
              <Row label="Customer">{d.customer && <Link className="text-brand-700 hover:underline" href={`/customers/${d.customer.id}`}>{d.customer.name}</Link>}</Row>
              <Row label="Invoice">{d.invoice && <Link className="text-brand-700 hover:underline" href={`/invoices/${d.invoice.id}`}>{d.invoice.number}</Link>}</Row>
              <Row label="Vehicle">{d.vehicle?.label}</Row>
              <Row label="Issued">{c.issuedAt ? dt(c.issuedAt) : undefined}</Row>
              <Row label="Created by">{c.createdBy}</Row>
              <Row label="Authorised by">{c.authorisedBy}</Row>
            </dl>
          </Card>
          {(d.actions.issue || d.actions.cancel) && (
            <Card className="space-y-4">
              <h2 className="text-base font-semibold">Actions</h2>
              {d.actions.issue && <GoButton label="Authorise and issue" variant="primary" path={`/api/v1/credit-notes/${c.id}/issue`} confirm="Issue this credit note? It reduces what the customer owes (or becomes their credit) and cannot be undone." />}
              {d.actions.cancel && <ReasonButton label="Cancel draft" variant="danger" path={`/api/v1/credit-notes/${c.id}/cancel`} prompt="Why is it being cancelled? (optional)" minLength={0} />}
            </Card>
          )}
        </div>
      </div>
      <div className="mt-4"><DocumentsPanel ctx={ctx} resourceType="credit_note" resourceId={c.id} kind="documents" title="Stored documents" /></div>
    </>
  );
}

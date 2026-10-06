import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { Alert, Card, PageHeader } from '@/components/ui';
import { CreditNoteForm } from '@/components/finance/CreditNoteForm';
import { isAppError } from '@/lib/errors';
import { getInvoice } from '@/server/finance/invoices';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'New credit note' };
export const dynamic = 'force-dynamic';

export default async function NewCreditNotePage({ searchParams }: { searchParams: Promise<{ invoiceId?: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'credit_note.create');
  const { invoiceId } = await searchParams;
  if (!invoiceId) redirect('/invoices');
  let d;
  try {
    d = await getInvoice(ctx, invoiceId);
  } catch (e) {
    if (isAppError(e) && e.code === 'NOT_FOUND') notFound();
    throw e;
  }
  if (!d.actions.creditNote) {
    return (<><PageHeader title="New credit note" /><Alert tone="warn">Credit notes can only be raised against an issued invoice that is not cancelled.</Alert></>);
  }
  const credited = d.creditNotes.filter((c) => c.status !== 'CANCELLED').reduce((a, c) => a + c.totalCents, 0);
  return (
    <>
      <PageHeader title="New credit note" description={`Against invoice ${d.invoice.number}`} />
      <Card className="max-w-3xl">
        <CreditNoteForm
          invoiceId={d.invoice.id} invoiceNumber={d.invoice.number ?? ''} maxCents={Math.max(0, d.invoice.totalCents - credited)}
          lines={d.lines.map((l) => ({ lineType: l.lineType, description: l.description, quantityMilli: l.quantityMilli, unitPriceCents: l.unitPriceCents, taxTreatment: l.taxTreatment }))}
          tax={{ vatRegistered: d.invoice.vatRegistered, vatRateBps: d.invoice.vatRateBps, pricesIncludeVat: d.invoice.pricesIncludeVat }} currency={ctx.business.currency} locale={ctx.business.locale}
        />
      </Card>
    </>
  );
}

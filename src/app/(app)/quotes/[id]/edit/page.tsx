import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { PageHeader } from '@/components/ui';
import { DocumentForm } from '@/components/finance/DocumentForm';
import { lineToState } from '@/components/finance/line-state';
import { isAppError } from '@/lib/errors';
import { centsToDecimal } from '@/lib/money';
import { getQuote } from '@/server/finance/quotes';
import { getDocumentDefaults } from '@/server/finance/settings';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Edit quote' };
export const dynamic = 'force-dynamic';

export default async function EditQuotePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'quote.edit');
  const { id } = await params;
  let q;
  try {
    q = await getQuote(ctx, id);
  } catch (e) {
    if (isAppError(e) && e.code === 'NOT_FOUND') notFound();
    throw e;
  }
  if (!q.actions.edit) redirect(`/quotes/${id}`);
  const defaults = await getDocumentDefaults(ctx);
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  const v = q.version;
  // A frozen (already sent) version: saving makes version N+1, with the tax settings in force today.
  const tax = v.frozen ? defaults.tax : { vatRegistered: v.vatRegistered, vatRateBps: v.vatRateBps, pricesIncludeVat: v.pricesIncludeVat };

  return (
    <>
      <PageHeader title={`Edit ${q.quote.number}`} description={v.frozen ? `Version ${v.version} has been sent. Your changes become version ${v.version + 1}.` : `Draft, version ${v.version}.`} />
      <DocumentForm
        canPickParts={ctx.permissions.has('inventory.view')}
        kind="quote" mode="edit" endpoint={`/api/v1/quotes/${id}`} method="PATCH" basePath="/quotes" submitLabel={v.frozen ? `Save as version ${v.version + 1}` : 'Save changes'}
        requireChangeNote={v.frozen}
        initial={{
          customer: q.customer ? { id: q.customer.id, name: q.customer.name, customerNumber: q.customer.customerNumber, mobile: q.customer.mobile, email: q.customer.email } : null,
          vehicleId: q.vehicle?.id, jobId: q.job?.id, jobLabel: q.job?.jobNumber, title: v.title ?? '', description: v.description ?? '', validUntil: v.frozen ? '' : (v.validUntil ?? ''),
          terms: v.terms ?? '', customerNotes: v.customerNotes ?? '', internalNotes: q.quote.internalNotes ?? '', discountType: v.discountType,
          discount: v.discountType === 'NONE' ? '' : centsToDecimal(v.discountValue), lines: q.lines.map(lineToState),
        }}
        tax={tax} currency={ctx.business.currency} locale={ctx.business.locale}
        canSeeCosts={can('finance.view_costs')} canCreateCustomer={false} canCreateVehicle={false}
      />
    </>
  );
}

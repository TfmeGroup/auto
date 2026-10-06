import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { PageHeader } from '@/components/ui';
import { DocumentForm } from '@/components/finance/DocumentForm';
import { lineToState } from '@/components/finance/line-state';
import { isAppError } from '@/lib/errors';
import { centsToDecimal } from '@/lib/money';
import { getInvoice } from '@/server/finance/invoices';
import { getDocumentDefaults } from '@/server/finance/settings';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Edit invoice' };
export const dynamic = 'force-dynamic';

export default async function EditInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'invoice.edit');
  const { id } = await params;
  let inv;
  try {
    inv = await getInvoice(ctx, id);
  } catch (e) {
    if (isAppError(e) && e.code === 'NOT_FOUND') notFound();
    throw e;
  }
  if (!inv.actions.edit) redirect(`/invoices/${id}`);
  const defaults = await getDocumentDefaults(ctx);
  const i = inv.invoice;
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  const tax = i.quoteId ? { vatRegistered: i.vatRegistered, vatRateBps: i.vatRateBps, pricesIncludeVat: i.pricesIncludeVat } : defaults.tax;

  return (
    <>
      <PageHeader title="Edit draft invoice" description="Once issued, an invoice is locked: corrections are made with a credit note." />
      <DocumentForm
        canPickParts={ctx.permissions.has('inventory.view')}
        kind="invoice" mode="edit" endpoint={`/api/v1/invoices/${id}`} method="PATCH" basePath="/invoices" submitLabel="Save draft"
        initial={{
          customer: inv.customer ? { id: inv.customer.id, name: inv.customer.name, customerNumber: inv.customer.customerNumber, mobile: inv.customer.mobile, email: inv.customer.email } : null,
          vehicleId: inv.vehicle?.id, jobId: inv.job?.id, jobLabel: inv.job?.jobNumber, title: i.title ?? '', invoiceDate: i.invoiceDate ?? '', dueDate: i.dueDate ?? '', paymentTermsDays: String(i.paymentTermsDays || ''),
          terms: i.terms ?? '', customerNotes: i.customerNotes ?? '', internalNotes: i.internalNotes ?? '', discountType: i.discountType, discount: i.discountType === 'NONE' ? '' : centsToDecimal(i.discountValue),
          lines: inv.lines.map(lineToState),
        }}
        tax={tax} currency={ctx.business.currency} locale={ctx.business.locale}
        canSeeCosts={can('finance.view_costs')} canCreateCustomer={false} canCreateVehicle={false}
      />
    </>
  );
}

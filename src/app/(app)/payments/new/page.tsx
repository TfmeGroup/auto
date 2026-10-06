import { randomUUID } from 'node:crypto';
import type { Metadata } from 'next';
import { Card, PageHeader } from '@/components/ui';
import { PaymentEntry } from '@/components/finance/PaymentEntry';
import { getInvoice } from '@/server/finance/invoices';
import { getDocumentDefaults } from '@/server/finance/settings';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Record payment' };
export const dynamic = 'force-dynamic';

export default async function NewPaymentPage({ searchParams }: { searchParams: Promise<{ invoiceId?: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'payment.create');
  const sp = await searchParams;
  const defaults = await getDocumentDefaults(ctx);
  let initial = null;
  if (sp.invoiceId && ctx.permissions.has('invoice.view')) {
    const d = await getInvoice(ctx, sp.invoiceId).catch(() => null);
    if (d && d.actions.recordPayment) {
      initial = {
        id: d.invoice.id, number: d.invoice.number, outstandingCents: d.invoice.outstandingCents, totalCents: d.invoice.totalCents, dueDate: d.invoice.dueDate,
        customer: { id: d.customer?.id ?? '', name: d.customer?.name ?? '' }, vehicle: d.vehicle ? { registration: d.vehicle.registration, label: d.vehicle.label } : null,
      };
    }
  }
  return (
    <>
      <PageHeader title="Record payment" description="Record money you have received. A receipt is issued automatically." />
      <Card className="max-w-2xl">
        <PaymentEntry
          methods={defaults.enabledMethods} depositsEnabled={defaults.depositsEnabled} currency={ctx.business.currency} locale={ctx.business.locale}
          idempotencyKey={randomUUID()} initialInvoice={initial} canSearchCustomers={ctx.permissions.has('customer.view')}
        />
      </Card>
    </>
  );
}

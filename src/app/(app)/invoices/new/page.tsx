import type { Metadata } from 'next';
import Link from 'next/link';
import { listPricedServices } from '@/server/settings/catalogue';
import { Alert, PageHeader } from '@/components/ui';
import { DocumentForm } from '@/components/finance/DocumentForm';
import { GoButton } from '@/components/finance/FinanceActions';
import { getCustomer } from '@/server/customers/service';
import { getDocumentDefaults } from '@/server/finance/settings';
import { jobSummary } from '@/server/finance/sources';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'New invoice' };
export const dynamic = 'force-dynamic';

export default async function NewInvoicePage({ searchParams }: { searchParams: Promise<{ customerId?: string; vehicleId?: string; jobId?: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'invoice.create');
  const sp = await searchParams;
  const defaults = await getDocumentDefaults(ctx);
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);

  // An invoice for a finished job is built from what was actually used on it, not typed in.
  const job = sp.jobId && can('job.view') ? await jobSummary(ctx, sp.jobId).catch(() => null) : null;
  if (job) {
    return (
      <>
        <PageHeader title="Invoice from job" description={`Job ${job.jobNumber} for ${job.customer.name}`} />
        <div className="max-w-xl space-y-3">
          <Alert tone="warn">The invoice is built from what was <strong>actually used</strong> on the job: parts that were fitted and the labour recorded. Parts that were only requested, reserved or ordered are not billed. You can edit the draft before issuing it.</Alert>
          <GoButton label="Create the draft invoice" variant="primary" path={`/api/v1/jobs/${job.id}/invoice`} redirect={{ base: '/invoices/', key: 'id' }} />
          <p className="text-sm text-muted">Or <Link className="text-brand-700 underline" href="/invoices/new">create an invoice by hand</Link>.</p>
        </div>
      </>
    );
  }
  const customer = sp.customerId && can('customer.view') ? await getCustomer(ctx, sp.customerId).catch(() => null) : null;

  return (
    <>
      <PageHeader title="New invoice" description="Create a draft invoice. You can edit it until you issue it." />
      <DocumentForm
        canPickParts={ctx.permissions.has('inventory.view')}
        services={await listPricedServices(ctx)}
        kind="invoice" mode="create" endpoint="/api/v1/invoices" method="POST" basePath="/invoices" submitLabel="Create draft invoice"
        initial={{
          customer: customer ? { id: customer.id, name: customer.name, customerNumber: customer.customerNumber, mobile: customer.mobile, email: customer.email } : null,
          vehicleId: sp.vehicleId, terms: defaults.invoiceTerms ?? '', paymentTermsDays: String(defaults.paymentTermsDays), lines: [],
        }}
        tax={defaults.tax} currency={ctx.business.currency} locale={ctx.business.locale}
        canSeeCosts={can('finance.view_costs')} canCreateCustomer={can('customer.create')} canCreateVehicle={can('vehicle.create')}
      />
    </>
  );
}

import type { Metadata } from 'next';
import { listPricedServices } from '@/server/settings/catalogue';
import { PageHeader } from '@/components/ui';
import { DocumentForm } from '@/components/finance/DocumentForm';
import { getCustomer } from '@/server/customers/service';
import { getDocumentDefaults } from '@/server/finance/settings';
import { jobSummary } from '@/server/finance/sources';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'New quote' };
export const dynamic = 'force-dynamic';

export default async function NewQuotePage({ searchParams }: { searchParams: Promise<{ customerId?: string; vehicleId?: string; jobId?: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'quote.create');
  const sp = await searchParams;
  const defaults = await getDocumentDefaults(ctx);
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);

  let customerId = sp.customerId;
  let vehicleId = sp.vehicleId;
  let jobLabel: string | undefined;
  if (sp.jobId && can('job.view')) {
    const job = await jobSummary(ctx, sp.jobId).catch(() => null);
    if (job) { customerId = job.customer.id; vehicleId = job.vehicleId; jobLabel = job.jobNumber; }
  }
  const customer = customerId && can('customer.view') ? await getCustomer(ctx, customerId).catch(() => null) : null;

  return (
    <>
      <PageHeader title="New quote" description="Prepare a quote, then send it to the customer to review and approve online." />
      <DocumentForm
        canPickParts={ctx.permissions.has('inventory.view')}
        services={await listPricedServices(ctx)}
        kind="quote" mode="create" endpoint="/api/v1/quotes" method="POST" basePath="/quotes" submitLabel="Create quote"
        initial={{
          customer: customer ? { id: customer.id, name: customer.name, customerNumber: customer.customerNumber, mobile: customer.mobile, email: customer.email } : null,
          vehicleId, jobId: jobLabel ? sp.jobId : undefined, jobLabel, terms: defaults.quoteTerms ?? '', lines: [],
        }}
        offerFromJob={!!jobLabel}
        tax={defaults.tax} currency={ctx.business.currency} locale={ctx.business.locale}
        canSeeCosts={can('finance.view_costs')} canCreateCustomer={can('customer.create')} canCreateVehicle={can('vehicle.create')}
      />
    </>
  );
}

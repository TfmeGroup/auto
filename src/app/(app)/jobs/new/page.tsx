import type { Metadata } from 'next';
import { Card, PageHeader } from '@/components/ui';
import { JobForm } from '@/components/workshop/JobForm';
import { getCustomer } from '@/server/customers/service';
import { getRules, getWorkshopLookups } from '@/server/workshop/service';
import { listJobTemplates } from '@/server/settings/catalogue';
import { getJobLabels } from '@/server/settings/config-service';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'New job' };
export const dynamic = 'force-dynamic';

export default async function NewJobPage({ searchParams }: { searchParams: Promise<{ customerId?: string; vehicleId?: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'job.create');
  const sp = await searchParams;
  const [lookups, rules, customer] = await Promise.all([getWorkshopLookups(ctx), getRules(ctx), sp.customerId ? getCustomer(ctx, sp.customerId).catch(() => null) : null]);
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  const templates = ctx.subscription.features.has('advanced_settings') ? await listJobTemplates(ctx).catch(() => []) : [];
  const jobCfg = await getJobLabels(ctx).catch(() => null);
  return (
    <>
      <PageHeader title="New job" description="Open a job card for a vehicle that is here now. For a booked vehicle, check the booking in instead." />
      <Card>
        <JobForm
          lookups={lookups}
          customer={customer ? { id: customer.id, name: customer.name, customerNumber: customer.customerNumber, mobile: customer.mobile } : null}
          vehicleId={customer ? sp.vehicleId : undefined}
          requireSignature={rules.requireCheckInSignature}
          templates={templates.map((t) => ({ id: t.id, name: t.name }))} priorityLabels={jobCfg?.priority}
          perms={{ createCustomer: can('customer.create'), createVehicle: can('vehicle.create'), assign: can('job.assign') }}
        />
      </Card>
    </>
  );
}

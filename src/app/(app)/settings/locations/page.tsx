import type { Metadata } from 'next';
import { Alert, Badge, Card, PageHeader } from '@/components/ui';
import { ActionButton } from '@/components/forms/RowActions';
import { InlineForm } from '@/components/forms/InlineForm';
import { AddLocationForm } from '@/components/forms/LocationControls';
import { listLocations } from '@/server/locations/service';
import { getUsage } from '@/server/usage/service';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Locations' };
export const dynamic = 'force-dynamic';

export default async function LocationsPage() {
  const ctx = await requireBusiness();
  assertCan(ctx, 'settings.view');
  const [locations, usage] = await Promise.all([listLocations(ctx), getUsage(ctx)]);
  const canEdit = (ctx.permissions.has('settings.edit') || ctx.permissions.has('location.manage')) && ctx.subscription.canWrite;
  const multi = ctx.subscription.features.has('multi_location');
  const room = usage.locations.used < usage.locations.limit;

  return (
    <>
      <PageHeader title="Locations" description={`${usage.locations.used} of ${usage.locations.limit} locations used on the ${ctx.subscription.planName} plan.`} />
      {canEdit && (
        <Card className="mb-4">
          {!multi ? <Alert tone="warn">Running more than one location is not included in your plan. Upgrade to add branches.</Alert>
            : !room ? <Alert tone="warn">You have reached your plan’s location limit.</Alert>
            : <AddLocationForm />}
        </Card>
      )}
      <ul className="grid gap-2">
        {locations.map((l) => (
          <li key={l.id}>
            <Card>
              <div className="flex items-center justify-between gap-3">
                <p className="font-medium">{l.name} {l.isDefault && <Badge tone="brand">Main</Badge>} {l.status === 'ARCHIVED' && <Badge tone="neutral">archived</Badge>}</p>
                {canEdit && !l.isDefault && l.status === 'ACTIVE' && <ActionButton label="Archive" variant="ghost" path={`/api/v1/locations/${l.id}`} method="DELETE" confirm="Archive this location? History is kept." />}
              </div>
              <p className="mt-1 text-sm text-muted">{[l.phone, l.email, [l.addressLine1, l.city].filter(Boolean).join(', ')].filter(Boolean).join(' · ') || 'No contact details of its own: documents use the business details.'}</p>
              {canEdit && l.status === 'ACTIVE' && (
                <details className="mt-1">
                  <summary className="min-h-11 cursor-pointer text-sm font-medium leading-[2.75rem] text-brand-700">Edit details</summary>
                  <InlineForm endpoint={`/api/v1/locations/${l.id}`} method="PATCH" submitLabel="Save" variant="secondary" resetOnSuccess={false} fields={[
                    { name: 'name', label: 'Name', defaultValue: l.name, required: true },
                    { name: 'phone', label: 'Phone', type: 'tel', defaultValue: l.phone ?? '' },
                    { name: 'email', label: 'Email', type: 'email', defaultValue: l.email ?? '' },
                    { name: 'addressLine1', label: 'Street address', defaultValue: l.addressLine1 ?? '' },
                    { name: 'city', label: 'City', defaultValue: l.city ?? '' },
                    { name: 'province', label: 'Province', defaultValue: l.province ?? '' },
                    { name: 'postalCode', label: 'Postal code', defaultValue: l.postalCode ?? '' },
                  ]} />
                  <p className="mt-1 text-xs text-muted">This location&apos;s contact details go on its own quotes, invoices and orders. Anything left empty falls back to the business&apos;s details.</p>
                </details>
              )}
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}

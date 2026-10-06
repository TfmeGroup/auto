import type { Metadata } from 'next';
import { Card, PageHeader } from '@/components/ui';
import { BusinessSettingsForm, LogoUploader } from '@/components/forms/BusinessSettingsForm';
import { InlineForm } from '@/components/forms/InlineForm';
import { getBusiness } from '@/server/businesses/service';
import { requireBusiness } from '@/server/web/session';
import { redirect } from 'next/navigation';

export const metadata: Metadata = { title: 'Business settings' };
const TIMEZONES = ['Africa/Johannesburg', 'Africa/Windhoek', 'Africa/Gaborone', 'Africa/Maputo', 'Africa/Harare', 'Africa/Lusaka', 'Africa/Nairobi', 'Africa/Lagos', 'Europe/London', 'UTC'];
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const ctx = await requireBusiness();
  if (!ctx.permissions.has('settings.view') && !ctx.permissions.has('business.view')) redirect('/forbidden');
  const b = await getBusiness(ctx);
  const canEdit = ctx.permissions.has('business.edit') && ctx.subscription.canWrite;

  return (
    <>
      <PageHeader title="Business profile" description="How your business appears on documents, and how tax is calculated." />
      <div className="space-y-4">
        <Card>
          <h2 className="mb-3 text-base font-semibold">Logo</h2>
          <LogoUploader hasLogo={b.logoFileId !== null} canEdit={canEdit} />
        </Card>
        <Card>
          <BusinessSettingsForm initial={{ ...b, hasLogo: b.logoFileId !== null }} canEdit={canEdit} />
        </Card>
        <Card>
          <h2 className="mb-1 text-base font-semibold">Region</h2>
          <p className="mb-3 text-sm text-muted">The time zone decides where a day starts and ends in every report. The currency is how amounts are shown on new documents; documents already issued keep the currency they were issued in.</p>
          {canEdit ? (
            <InlineForm endpoint="/api/v1/business" method="PATCH" submitLabel="Save region" variant="secondary" resetOnSuccess={false} fields={[
              { name: 'timezone', label: 'Time zone', type: 'select', defaultValue: b.timezone, options: TIMEZONES.concat(TIMEZONES.includes(b.timezone) ? [] : [b.timezone]).map((z) => ({ value: z, label: z })) },
              { name: 'currency', label: 'Currency (ISO code)', defaultValue: b.currency, hint: 'ZAR for South African rand.' },
              { name: 'locale', label: 'Number and date format', type: 'select', defaultValue: b.locale, options: [{ value: 'en-ZA', label: 'South Africa (en-ZA)' }, { value: 'en-GB', label: 'United Kingdom (en-GB)' }, { value: 'en-US', label: 'United States (en-US)' }].concat(['en-ZA', 'en-GB', 'en-US'].includes(b.locale) ? [] : [{ value: b.locale, label: b.locale }]) },
            ]} />
          ) : <p className="text-sm">{b.timezone} · {b.currency} · {b.locale}</p>}
        </Card>
      </div>
    </>
  );
}

import type { Metadata } from 'next';
import { Alert, Card, PageHeader } from '@/components/ui';
import { FinanceSettingsForm, LabourRates, LocationCodes, type SettingsView } from '@/components/finance/FinanceSettingsForm';
import { getFinanceSettings, listLabourCostRates, listLocationDocCodes } from '@/server/finance/settings';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Quotes & invoices settings' };
export const dynamic = 'force-dynamic';

export default async function FinanceSettingsPage() {
  const ctx = await requireBusiness();
  assertCan(ctx, 'settings.view');
  const canEdit = ctx.permissions.has('finance.manage_settings');
  const s = (await getFinanceSettings(ctx)) as unknown as SettingsView;
  const rates = canEdit ? await listLabourCostRates(ctx) : [];
  const locations = canEdit ? await listLocationDocCodes(ctx) : [];

  if (!canEdit) {
    return (
      <>
        <PageHeader title="Quotes & invoices" description="How your quotes, invoices and payments are numbered and worded." />
        <Alert tone="warn">You can see these settings but changing them needs the “Manage payment and document settings” permission.</Alert>
        <Card className="mt-4"><dl className="grid gap-2 text-sm sm:grid-cols-2"><div><dt className="text-muted">Invoice numbers</dt><dd>{s.invoicePrefix}-{'0'.repeat(Math.max(0, s.numberPadding - 1))}1</dd></div><div><dt className="text-muted">Quotes valid for</dt><dd>{s.quoteValidityDays} days</dd></div><div><dt className="text-muted">Payment terms</dt><dd>{s.paymentTermsDays} days</dd></div></dl></Card>
      </>
    );
  }
  return (
    <>
      <PageHeader title="Quotes & invoices" description="Numbering, terms, payment methods, reminders and online payments." />
      <div className="space-y-5">
        <FinanceSettingsForm s={s} vat={{ registered: ctx.business.vatRegistered, rateBps: ctx.business.vatRateBps }} />
        {locations.length > 1 && (
          <Card>
            <h2 className="mb-1 text-base font-semibold">Location codes</h2>
            <p className="mb-2 text-sm text-muted">Give a location a short code to put it into that location’s document numbers (e.g. INV-CPT-000001). Each coded location counts on its own.</p>
            <LocationCodes rows={locations} />
          </Card>
        )}
        <Card>
          <h2 className="mb-1 text-base font-semibold">Technician cost rates</h2>
          <p className="mb-2 text-sm text-muted">What an hour of each technician’s time costs the business. Used only for gross profit reports and never shown to customers. The rate in force when labour is invoiced is saved on that invoice line.</p>
          <LabourRates rows={rates} />
        </Card>
      </div>
    </>
  );
}

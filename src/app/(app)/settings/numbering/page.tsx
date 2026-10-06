import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui';
import { NumberingForm } from '@/components/settings/ConfigForms';
import { getNumbering } from '@/server/settings/config-service';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Numbering' };
export const dynamic = 'force-dynamic';

export default async function NumberingPage() {
  const ctx = await requireBusiness();
  assertCan(ctx, 'settings.view');
  const n = await getNumbering(ctx);
  const writable = ctx.subscription.canWrite;
  return (
    <>
      <PageHeader title="Numbering" description="How customers, bookings, jobs, quotes, invoices, payments, purchase orders and the rest are numbered. Numbers are issued by the server, one at a time, and are never reused." />
      <NumberingForm kinds={n.kinds} canEdit={{ workshop: n.canEdit.workshop && writable, finance: n.canEdit.finance && writable, inventory: n.canEdit.inventory && writable }} />
    </>
  );
}

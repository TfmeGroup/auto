import type { Metadata } from 'next';
import { Card } from '@/components/ui';
import { InvalidLink } from '@/components/finance/CustomerDocShell';
import { OptOutButton } from '@/components/notifications/OptOutButton';
import { isAppError } from '@/lib/errors';
import { optOutLabel, readOptOut } from '@/server/notifications/preferences';

export const metadata: Metadata = { title: 'Message preferences' };

/** A customer chooses to stop one kind of optional message. Opening the page changes nothing; the button does. */
export default async function OptOutPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let o;
  try {
    o = readOptOut(token);
  } catch (e) {
    if (isAppError(e)) return <InvalidLink />;
    throw e;
  }
  return (
    <Card className="mx-auto mt-10 max-w-md space-y-3">
      <h1 className="text-lg font-bold">Stop {optOutLabel(o.category)}?</h1>
      <p className="text-sm text-muted">You will no longer receive {optOutLabel(o.category)} from this workshop. You will still receive messages about your own quotes, invoices, receipts and bookings, because those are your records.</p>
      <OptOutButton token={token} label={optOutLabel(o.category)} />
    </Card>
  );
}

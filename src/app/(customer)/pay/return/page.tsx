import type { Metadata } from 'next';
import { Alert, Card } from '@/components/ui';
import { InvalidLink } from '@/components/finance/CustomerDocShell';
import { RefreshWhilePending } from '@/components/finance/CustomerActions';
import { money } from '@/components/finance/shared';
import { isAppError } from '@/lib/errors';
import { getPublicPaymentStatus } from '@/server/finance/online';

export const metadata: Metadata = { title: 'Payment' };

/**
 * Where the payment provider sends the customer's browser back to. This page only SHOWS what our records say: a browser
 * arriving here proves nothing, and the payment is marked paid only when the provider's verified notification reaches the server.
 */
export default async function PayReturnPage({ searchParams }: { searchParams: Promise<{ b?: string; ref?: string; cancelled?: string }> }) {
  const sp = await searchParams;
  let s;
  try {
    s = await getPublicPaymentStatus(sp.b ?? '', sp.ref ?? '');
  } catch (e) {
    if (isAppError(e) && e.code === 'NOT_FOUND') return <InvalidLink />;
    throw e;
  }
  const fmt = { currency: s.business.currency, locale: s.business.locale };
  const pending = ['PENDING', 'PROCESSING'].includes(s.status) && !sp.cancelled;

  return (
    <Card className="mx-auto mt-6 max-w-md space-y-3 text-center">
      <h1 className="text-lg font-bold">{s.business.name}</h1>
      {s.status === 'COMPLETED' && (<><Alert tone="ok">Payment received. Thank you!</Alert><p className="text-sm">{money(s.amountCents, fmt)}{s.invoiceNumber ? ` for invoice ${s.invoiceNumber}` : ''}. A receipt has been emailed to you.</p></>)}
      {pending && (<><Alert tone="warn">We are waiting for your bank to confirm the payment. This usually takes less than a minute. You can close this page: we will email your receipt.</Alert><RefreshWhilePending active /></>)}
      {(s.status === 'FAILED' || (s.status === 'CANCELLED' && sp.cancelled) || (!!sp.cancelled && s.status !== 'COMPLETED')) && (<Alert tone="warn">The payment was not completed and no money was taken. Please go back to your invoice link in the email and try again, or contact {s.business.name}.</Alert>)}
      {s.status === 'CANCELLED' && !sp.cancelled && <Alert tone="warn">This payment was cancelled. No money was taken.</Alert>}
      {(s.business.phone || s.business.email) && <p className="text-xs text-muted">Questions? {[s.business.phone, s.business.email].filter(Boolean).join(' · ')}</p>}
    </Card>
  );
}

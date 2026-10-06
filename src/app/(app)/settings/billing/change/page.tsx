import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, Badge, Card, PageHeader } from '@/components/ui';
import { ContinueToPayment, ScheduleDowngrade } from '@/components/billing/BillingControls';
import { evaluatePlanChange } from '@/server/billing/plan-change';
import { assertCan, requireBusiness } from '@/server/web/session';
import { isAppError } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import { formatMoney } from '@/lib/money';

export const metadata: Metadata = { title: 'Change plan' };
export const dynamic = 'force-dynamic';

export default async function ChangePlanPage({ searchParams }: { searchParams: Promise<{ plan?: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'settings.manage_billing');
  const { plan } = await searchParams;
  if (!plan) notFound();
  let ev;
  try {
    ev = await evaluatePlanChange(ctx, plan);
  } catch (e) {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  }
  const money = (c: number | null) => (c === null ? '—' : formatMoney(c));
  const verb = ev.direction === 'downgrade' ? 'Downgrade' : 'Upgrade';

  return (
    <>
      <PageHeader title={`${verb} to ${ev.target.name}`} description={`From ${ev.current.name}. Review exactly what changes before you confirm.`} />
      <div className="space-y-4">
        <Card>
          <h2 className="mb-2 text-base font-semibold">Price</h2>
          {ev.target.priceCents === null ? <p className="text-sm text-muted">Pricing for this plan has not been set yet.</p> : (
            <dl className="grid max-w-sm gap-1 text-sm">
              <div className="flex justify-between"><dt className="text-muted">{ev.target.interval === 'ANNUAL' ? 'Yearly' : 'Monthly'} price (excl. VAT)</dt><dd className="tabular-nums">{money(ev.target.priceCents)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">VAT</dt><dd className="tabular-nums">{money(ev.target.vatCents)}</dd></div>
              <div className="flex justify-between border-t border-line pt-1 font-semibold"><dt>Total per {ev.target.interval === 'ANNUAL' ? 'year' : 'month'}</dt><dd className="tabular-nums">{money(ev.target.totalCents)}</dd></div>
            </dl>
          )}
        </Card>

        <Card>
          <h2 className="mb-2 text-base font-semibold">What changes</h2>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs uppercase tracking-wide text-muted"><th className="py-1 font-medium">Limit</th><th className="py-1 font-medium">Now</th><th className="py-1 font-medium">After</th></tr></thead>
            <tbody className="divide-y divide-line">
              {ev.limitChanges.map((l) => <tr key={l.what}><td className="py-1.5">{l.what}</td><td className="tabular-nums">{l.from}</td><td className="font-medium tabular-nums">{l.to}</td></tr>)}
            </tbody>
          </table>
          {ev.featuresGained.length > 0 && <p className="mt-3 text-sm"><Badge tone="ok">You gain</Badge> {ev.featuresGained.map((f) => f.label).join(', ')}</p>}
          {ev.featuresLost.length > 0 && <p className="mt-2 text-sm"><Badge tone="warn">You lose</Badge> {ev.featuresLost.map((f) => f.label).join(', ')}</p>}
        </Card>

        {ev.violations.length > 0 && (
          <Alert tone="danger">
            <p className="mb-1 font-semibold">You need to make some changes first</p>
            <ul className="list-disc pl-5">{ev.violations.map((v) => <li key={v.kind}>{v.message}</li>)}</ul>
          </Alert>
        )}
        {ev.reason && ev.violations.length === 0 && <Alert tone="warn">{ev.reason}</Alert>}

        <Card>
          {ev.canProceed && ev.mode === 'checkout' && <ContinueToPayment planKey={ev.target.key} label={ev.direction === 'upgrade' && ctx.subscription.status === 'ACTIVE' ? 'Confirm upgrade and pay' : 'Continue to payment'} />}
          {ev.canProceed && ev.mode === 'scheduled_downgrade' && <ScheduleDowngrade planKey={ev.target.key} effectiveOn={ev.effectiveAt ? formatDate(ev.effectiveAt, ctx.business.timezone, ctx.business.locale) : 'the end of this period'} />}
          {!ev.canProceed && <p className="text-sm text-muted">This change is not available right now.</p>}
          <p className="mt-3 text-xs text-muted">Your plan changes only after the payment provider confirms payment — never from this page alone.</p>
          <Link href="/settings/billing" className="mt-3 inline-block text-sm font-medium text-brand-600 hover:underline">← Back to billing</Link>
        </Card>
      </div>
    </>
  );
}

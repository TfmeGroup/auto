import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Badge, Card, LinkButton, PageHeader } from '@/components/ui';
import { CancelSubscription } from '@/components/billing/BillingControls';
import { ActionButton } from '@/components/forms/RowActions';
import { Meter } from '@/components/billing/Meter';
import { getBillingOverview } from '@/server/billing/overview';
import { assertCan, requireBusiness } from '@/server/web/session';
import { formatBytes, formatDate } from '@/lib/format';
import { formatMoney } from '@/lib/money';

export const metadata: Metadata = { title: 'Billing' };
export const dynamic = 'force-dynamic';

const STATUS_TONE = { TRIALING: 'ok', ACTIVE: 'ok', PAST_DUE: 'warn', GRACE_PERIOD: 'warn', CANCELED: 'warn', SUSPENDED: 'danger', EXPIRED: 'danger' } as const;
const STATUS_LABEL = { TRIALING: 'Free trial', ACTIVE: 'Active', PAST_DUE: 'Payment overdue', GRACE_PERIOD: 'Grace period', CANCELED: 'Cancelled', SUSPENDED: 'Suspended', EXPIRED: 'Expired' } as const;
const PAYMENT_TONE = { COMPLETE: 'ok', PENDING: 'neutral', FAILED: 'danger', CANCELLED: 'neutral' } as const;

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ checkout?: string; changed?: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'settings.manage_billing');
  const sp = await searchParams;
  const o = await getBillingOverview(ctx);
  const s = o.subscription;
  const d = (x: Date | string | null) => (x ? formatDate(x, ctx.business.timezone, ctx.business.locale) : '—');
  const mb = (n: number) => formatBytes(n);

  return (
    <>
      <PageHeader title="Billing & subscription" description={`This subscription belongs to ${ctx.business.name}, not to your personal account.`} />

      {sp.checkout === 'return' && <div className="mb-4"><Alert tone="ok">Thanks! Your plan updates as soon as your payment is confirmed by the payment provider — usually within moments. Refresh to check.</Alert></div>}
      {sp.checkout === 'cancelled' && <div className="mb-4"><Alert tone="warn">Checkout was cancelled. Nothing was charged.</Alert></div>}
      {sp.changed === 'scheduled' && <div className="mb-4"><Alert tone="ok">Downgrade scheduled.</Alert></div>}
      {s.status === 'PAST_DUE' && <div className="mb-4"><Alert tone="warn">Your last payment failed. Everything still works; we keep retrying for {o.timing.pastDueRetryDays} days, then you get a {o.timing.graceDays}-day grace period.</Alert></div>}
      {s.status === 'GRACE_PERIOD' && <div className="mb-4"><Alert tone="warn">You are in the grace period. Everything still works, but the business becomes read-only if the payment is not resolved. Your data is safe.</Alert></div>}
      {s.status === 'SUSPENDED' && <div className="mb-4"><Alert>This business is read-only because payment is outstanding. Your data is preserved — choose a plan below to restore full access.</Alert></div>}
      {s.status === 'EXPIRED' && <div className="mb-4"><Alert>{s.trial.phase === 'expired' ? 'Your free trial has ended.' : 'Your subscription has ended.'} The business is read-only and your data is safe. Choose a plan below to continue.</Alert></div>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted">Current plan</p>
              <p className="text-2xl font-bold">{s.planName}</p>
            </div>
            <Badge tone={STATUS_TONE[s.status]}>{STATUS_LABEL[s.status]}</Badge>
          </div>
          <dl className="mt-3 grid gap-1.5 text-sm">
            {s.trial.endsAt && s.status === 'TRIALING' && (
              <>
                <div className="flex justify-between gap-2"><dt className="text-muted">Trial started</dt><dd>{d(s.trial.startedAt)}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-muted">Trial ends</dt><dd>{d(s.trial.endsAt)}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-muted">Days remaining</dt><dd className="font-semibold">{s.trial.daysRemaining} {s.trial.phase === 'expiring' && <Badge tone="warn">expiring</Badge>}</dd></div>
              </>
            )}
            {s.billingInterval && s.status !== 'TRIALING' && !s.isCustom && <div className="flex justify-between gap-2"><dt className="text-muted">Billed</dt><dd>{s.billingInterval === 'ANNUAL' ? 'Annually' : 'Monthly'}</dd></div>}
            {s.nextBillingDate && !s.cancelAtPeriodEnd && <div className="flex justify-between gap-2"><dt className="text-muted">Next billing date</dt><dd>{d(s.nextBillingDate)}</dd></div>}
            {s.cancelAtPeriodEnd && <div className="flex justify-between gap-2"><dt className="text-muted">Access until</dt><dd>{d(s.currentPeriodEnd)}</dd></div>}
            {s.paymentMethod && <div className="flex justify-between gap-2"><dt className="text-muted">Payment method</dt><dd>{s.paymentMethod}</dd></div>}
            {s.pendingPlan && <div className="flex justify-between gap-2"><dt className="text-muted">Scheduled change</dt><dd>to {o.plans.find((p) => p.key === s.pendingPlan!.key)?.name ?? s.pendingPlan.key} on {d(s.pendingPlan.effectiveAt)}</dd></div>}
          </dl>
          {s.pendingPlan && <div className="mt-3"><ActionButton label="Cancel scheduled change" variant="secondary" path="/api/v1/billing/downgrade" method="DELETE" /></div>}
          <p className="mt-3 text-xs text-muted">Billing contact: {o.billingContact ? `${o.billingContact.name} (${o.billingContact.email})` : '—'}. Card details are handled by the payment provider; we never see or store them.</p>
        </Card>

        <Card>
          <h2 className="mb-3 text-base font-semibold">Usage</h2>
          {o.overLimit.length > 0 && <p role="alert" className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">Over your plan: {o.overLimit.map((x) => x.label).join(', ')}. Nothing has been deleted; you cannot add more of these until you upgrade or free some up.</p>}
          <div className="space-y-3">
            <Meter label="Team members" used={o.usage.members.used} limit={o.usage.members.limit} />
            <Meter label="Locations" used={o.usage.locations.used} limit={o.usage.locations.limit} />
            <Meter label="Storage" used={o.usage.storage.usedBytes} limit={o.usage.storage.limitBytes} format={mb} />
          </div>
          <h3 className="mb-1 mt-4 text-sm font-semibold">Included features</h3>
          <ul className="grid gap-x-4 gap-y-0.5 text-sm sm:grid-cols-2">
            {s.features.map((f) => <li key={f.key} className={f.included ? '' : 'text-muted line-through'}>{f.included ? '✓' : '✕'} {f.label}</li>)}
          </ul>
        </Card>
      </div>

      <h2 className="mb-3 mt-6 text-lg font-semibold">Plans</h2>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {o.plans.map((p) => (
          <Card key={p.key} className={p.current ? 'border-brand-500' : ''}>
            <h3 className="text-lg font-bold">{p.name}</h3>
            <p className="mt-1 text-xl font-bold">
              {p.isCustom ? 'Tailored' : p.priceCents === null ? 'Price to be announced' : formatMoney(p.priceCents)}
              {p.priceCents !== null && !p.isCustom && <span className="text-sm font-normal text-muted"> /{p.interval === 'ANNUAL' ? 'year' : 'month'} excl. VAT</span>}
            </p>
            {p.priceInclVatCents !== null && !p.isCustom && <p className="text-xs text-muted">{formatMoney(p.priceInclVatCents)} incl. VAT</p>}
            <ul className="my-3 space-y-1 text-sm">
              <li>{p.isCustom ? '36+ team members' : `Up to ${p.maxMembers} team member${p.maxMembers === 1 ? '' : 's'}`}</li>
              <li>{p.isCustom ? 'Custom locations' : `${p.maxLocations} location${p.maxLocations === 1 ? '' : 's'}`}</li>
              <li>{p.isCustom ? 'Custom storage' : p.maxStorageMb >= 1024 ? `${p.maxStorageMb / 1024} GB storage` : `${p.maxStorageMb} MB storage`}</li>
            </ul>
            {p.current ? <Badge tone="brand">Your plan</Badge> : <LinkButton href={`/settings/billing/change?plan=${p.key}`} variant="secondary" className="w-full">{p.isCustom ? 'Contact us' : 'Review change'}</LinkButton>}
          </Card>
        ))}
      </div>

      <Card className="mt-6">
        <h2 className="mb-3 text-base font-semibold">Subscription invoices</h2>
        {o.invoices.length === 0 ? <p className="text-sm text-muted">No invoices yet. A tax invoice is issued for every payment.</p> : (
          <ul className="divide-y divide-line">
            {o.invoices.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <Link href={`/settings/billing/invoices/${i.id}`} className="font-medium text-brand-700 hover:underline">{i.number}</Link>
                <span className="text-muted">{d(i.issuedAt)} · {i.planName}</span>
                <span className="font-medium tabular-nums">{formatMoney(i.totalCents)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="mt-4">
        <h2 className="mb-3 text-base font-semibold">Payment history</h2>
        {o.payments.length === 0 ? <p className="text-sm text-muted">No payments yet.</p> : (
          <ul className="divide-y divide-line">
            {o.payments.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="text-muted">{d(p.createdAt)}</span>
                <Badge tone={PAYMENT_TONE[p.status]}>{p.status.toLowerCase()}</Badge>
                <span className="font-medium tabular-nums">{formatMoney(p.amountCents)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {(s.status === 'ACTIVE' || s.status === 'PAST_DUE' || s.status === 'GRACE_PERIOD') && (
        <Card className="mt-4">
          <h2 className="mb-3 text-base font-semibold">Cancel subscription</h2>
          <CancelSubscription accessUntil={s.currentPeriodEnd ? d(s.currentPeriodEnd) : null} />
        </Card>
      )}
      {!o.onlineBillingAvailable && <div className="mt-4"><Alert tone="warn">Online payments are not configured on this server yet, so plans cannot be purchased here.</Alert></div>}
    </>
  );
}

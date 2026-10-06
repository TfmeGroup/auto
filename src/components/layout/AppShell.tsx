import Link from 'next/link';
import { Alert } from '@/components/ui';
import { listMyBusinesses } from '@/server/businesses/service';
import type { BusinessContext } from '@/server/context';
import { AccountMenu } from './AccountMenu';
import { Icon } from './icons';
import { getUnreadCount } from '@/server/notifications/inapp';
import { GlobalSearch } from './GlobalSearch';
import { MobileMore } from './MobileMore';
import { BottomLinks, SidebarLinks } from './NavLinks';
import { QuickCreate } from './QuickCreate';
import { ResendVerification } from './ResendVerification';
import { NAV_ITEMS, QUICK_CREATE } from './nav-config';

const DAY = 86_400_000;

function Banner({ ctx }: { ctx: BusinessContext }) {
  const s = ctx.subscription;
  const canBill = ctx.permissions.has('settings.manage_billing');
  const billing = canBill ? (
    <>
      {' '}
      <Link href="/settings/billing" className="font-semibold underline">Manage billing</Link>
    </>
  ) : (
    ' Ask an owner to renew.'
  );
  if (s.status === 'SUSPENDED') {
    return <Alert tone="danger">This business is suspended because payment is outstanding, so it is read-only. Your data is safe and paying restores access straight away.{billing}</Alert>;
  }
  if (s.status === 'GRACE_PERIOD') {
    return <Alert tone="warn">Payment is overdue and this business is in its grace period. Everything works for now, but it becomes read-only if the payment is not resolved.{billing}</Alert>;
  }
  if (s.status === 'CANCELED' && s.currentPeriodEnd) {
    return <Alert tone="warn">The subscription is cancelled. You have full access until {s.currentPeriodEnd.toLocaleDateString('en-ZA', { dateStyle: 'medium' })}, then the business becomes read-only.{billing}</Alert>;
  }
  if (s.status === 'EXPIRED') {
    return <Alert tone="danger">Your subscription has ended, so TFME Auto is read-only. Your data is safe.{billing}</Alert>;
  }
  if (s.status === 'PAST_DUE') {
    return <Alert tone="warn">Your last payment did not go through. Please update billing to avoid interruption.{billing}</Alert>;
  }
  if (s.status === 'TRIALING' && s.trialEndsAt) {
    const days = Math.max(0, Math.ceil((s.trialEndsAt.getTime() - Date.now()) / DAY));
    if (days <= 5) return <Alert tone="warn">Your free trial ends in {days} day{days === 1 ? '' : 's'}.{billing}</Alert>;
  }
  return null;
}

export async function AppShell({ ctx, children }: { ctx: BusinessContext; children: React.ReactNode }) {
  const visible = NAV_ITEMS.filter((i) => !i.permission || i.permission.some((p) => ctx.permissions.has(p)));
  const bottom = visible.filter((i) => i.primary).slice(0, 4);
  const more = visible.filter((i) => !bottom.includes(i));
  const quick = QUICK_CREATE.filter((q) => ctx.permissions.has(q.permission));
  const businesses = await listMyBusinesses(ctx.user.id);
  const unread = await getUnreadCount(ctx).catch(() => 0);

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[15rem_minmax(0,1fr)]">
      {/* Lets keyboard and screen-reader users jump past the navigation; visible only while focused. */}
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:shadow-lg">
        Skip to main content
      </a>
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-line bg-surface p-3 md:flex">
        <Link href="/dashboard" className="mb-4 flex items-center gap-2 px-2 py-2 text-lg font-extrabold tracking-tight text-brand-600">
          TFME <span className="text-ink">Auto</span>
        </Link>
        <SidebarLinks items={visible} />
        <div className="mt-auto border-t border-line px-2 pt-3">
          <p className="truncate text-sm font-semibold">{ctx.business.name}</p>
          <p className="text-xs text-muted">{ctx.membership.roleName}</p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-surface/95 px-3 backdrop-blur sm:px-5">
          <Link href="/dashboard" className="shrink-0 text-base font-extrabold text-brand-600 md:hidden" aria-label="TFME Auto home">
            TFME
          </Link>
          <GlobalSearch />
          <QuickCreate items={quick} />
          <Link href="/notifications" className="relative inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-ink hover:bg-canvas md:size-10" aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}>
            <Icon name="bell" />
            {unread > 0 && <span aria-hidden className="absolute right-1 top-1 inline-flex min-w-5 items-center justify-center rounded-full bg-danger px-1 text-[11px] font-bold leading-5 text-white">{unread > 99 ? '99+' : unread}</span>}
          </Link>
          <AccountMenu
            userName={ctx.user.name}
            userEmail={ctx.user.email}
            businessName={ctx.business.name}
            businesses={businesses}
            currentBusinessId={ctx.business.id}
          />
        </header>

        <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-3 p-3 pb-24 sm:p-5 md:pb-8">
          {!ctx.user.emailVerified && <Alert tone="warn"><ResendVerification /></Alert>}
          <Banner ctx={ctx} />
          <main id="main" tabIndex={-1} className="min-w-0 flex-1 focus:outline-none">{children}</main>
        </div>

        <nav aria-label="Primary" className="safe-bottom fixed inset-x-0 bottom-0 z-20 flex border-t border-line bg-surface md:hidden">
          <BottomLinks items={bottom} />
          <MobileMore items={more} />
        </nav>
      </div>
    </div>
  );
}

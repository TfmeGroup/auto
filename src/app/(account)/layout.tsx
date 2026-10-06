import Link from 'next/link';
import { listMyBusinesses } from '@/server/businesses/service';
import { requireUser } from '@/server/web/session';
import { AccountNav } from './AccountNav';

export const dynamic = 'force-dynamic';

/**
 * Personal-account area. Needs sign-in but NOT a business: a person with no business can still
 * manage their profile and security here, create a business, or accept an invitation.
 */
export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const businesses = await listMyBusinesses(user.user.id);
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between gap-3 px-4">
          <span className="text-lg font-extrabold tracking-tight text-brand-600">TFME <span className="text-ink">Auto</span></span>
          {businesses.length > 0 ? (
            <Link href="/dashboard" className="inline-flex min-h-11 items-center text-sm font-medium text-brand-600 hover:underline">← Back to {businesses.length === 1 ? businesses[0]!.name : 'my business'}</Link>
          ) : (
            <Link href="/onboarding" className="inline-flex min-h-11 items-center text-sm font-medium text-brand-600 hover:underline">Create a business →</Link>
          )}
        </div>
      </header>
      <div className="mx-auto max-w-3xl space-y-4 p-4 pb-16">
        <AccountNav />
        {children}
      </div>
    </div>
  );
}

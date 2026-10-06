import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Alert } from '@/components/ui';
import { listMyBusinesses } from '@/server/businesses/service';
import { requireUser } from '@/server/web/session';
import { CreateBusinessForm } from './CreateBusinessForm';

export const metadata: Metadata = { title: 'Set up your business' };
export const dynamic = 'force-dynamic';

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ new?: string }> }) {
  const user = await requireUser();
  const { new: isNew } = await searchParams;
  const existing = await listMyBusinesses(user.user.id);
  if (existing.length > 0 && !isNew) redirect('/dashboard');

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Set up your business</h1>
        <p className="mt-1 text-sm text-muted">
          Your account is personal. A business is the workshop workspace where customers, jobs and invoices live.
        </p>
      </div>
      {!user.user.emailVerified && (
        <Alert tone="warn">Verify your email address first — we sent you a link. You can create your business as soon as it is confirmed.</Alert>
      )}
      <CreateBusinessForm canCreate={user.user.emailVerified} />
      <p className="border-t border-line pt-4 text-sm text-muted">
        Joining an existing workshop instead? Open the invitation link in your invitation email while signed in with the invited address.
      </p>
    </div>
  );
}

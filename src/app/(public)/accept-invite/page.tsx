import type { Metadata } from 'next';
import Link from 'next/link';
import { LinkButton } from '@/components/ui';
import { getUser } from '@/server/web/session';
import { AcceptInvite } from './AcceptInvite';

export const metadata: Metadata = { title: 'Join a business' };
export const dynamic = 'force-dynamic';

export default async function AcceptInvitePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  if (!token) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-bold">Invitation not valid</h1>
        <p className="text-sm text-muted">This invitation link is incomplete. Ask your administrator to send a new one.</p>
        <Link href="/login" className="text-sm font-medium text-brand-600 hover:underline">Go to sign in</Link>
      </div>
    );
  }
  const user = await getUser();
  if (!user) {
    // Existing account: sign in. New person: create an account with the invited address, verify it, then open this link again.
    const next = encodeURIComponent(`/accept-invite?token=${token}`);
    return (
      <div className="space-y-4">
        <div>
          <h1 className="text-xl font-bold">You have been invited</h1>
          <p className="mt-1 text-sm text-muted">Sign in to accept. If you do not have a TFME Auto account yet, create one using the email address the invitation was sent to, verify it, then open this invitation link again.</p>
        </div>
        <LinkButton href={`/login?next=${next}`} className="w-full">I have an account — sign in</LinkButton>
        <LinkButton href={`/register?next=${next}`} variant="secondary" className="w-full">Create an account</LinkButton>
      </div>
    );
  }
  return <AcceptInvite token={token} email={user.user.email} verified={user.user.emailVerified} />;
}

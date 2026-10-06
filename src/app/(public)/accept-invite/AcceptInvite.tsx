'use client';

import { useRouter } from 'next/navigation';
import { Alert, Button } from '@/components/ui';
import { useSubmit } from '@/components/forms/use-submit';
import { api } from '@/lib/api-client';

export function AcceptInvite({ token, email, verified }: { token: string; email: string; verified: boolean }) {
  const router = useRouter();
  const { pending, error, run } = useSubmit();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Join a business</h1>
        <p className="mt-1 text-sm text-muted">
          You are signed in as <strong className="text-ink">{email}</strong>. The invitation must have been sent to this address.
        </p>
      </div>
      {!verified && <Alert tone="warn">Verify your email address first (check your inbox), then come back to this link.</Alert>}
      {error && <Alert>{error}</Alert>}
      <Button
        className="w-full"
        loading={pending}
        disabled={!verified}
        onClick={() =>
          void run(async () => {
            await api('/api/v1/invitations/accept', { body: { token } });
            router.replace('/dashboard');
            router.refresh();
          })
        }
      >
        Accept invitation
      </Button>
    </div>
  );
}

'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api-client';

/** Lets someone who has not made a business yet leave: sign out and return to the sign-in page (to use another account, or come back later). */
export function SignOutLink({ email }: { email: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await api('/api/v1/auth/logout', { method: 'POST', body: {} });
    } finally {
      router.replace('/login');
      router.refresh();
    }
  }

  return (
    <p className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
      <span>Signed in as <strong className="font-semibold text-ink">{email}</strong></span>
      <button type="button" onClick={signOut} disabled={busy} className="inline-flex min-h-11 items-center font-medium text-brand-700 underline disabled:opacity-60">
        {busy ? 'Signing out…' : 'Sign out and back to sign in'}
      </button>
    </p>
  );
}

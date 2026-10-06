'use client';

import { Alert, Button } from '@/components/ui';

/** A page failed to load. Says so plainly, offers a retry, and quotes the reference support can look up. Never shows internals. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-lg space-y-3 py-10">
      <Alert>We could not load this page. Your data is safe. Try again, and if it keeps happening contact support{error.digest ? ` and quote reference ${error.digest}` : ''}.</Alert>
      <Button type="button" onClick={reset}>Try again</Button>
    </div>
  );
}

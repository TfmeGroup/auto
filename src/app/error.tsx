'use client';

import { useEffect } from 'react';

/** Last-resort boundary: friendly message, never a stack trace. The digest lets support find the server log. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Intentionally no console output of error details in production builds.
  }, [error]);
  return (
    <div className="grid min-h-dvh place-items-center px-4 text-center">
      <div className="max-w-sm">
        <h1 className="text-xl font-bold">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted">We hit a problem loading this page. Please try again.</p>
        {error.digest && <p className="mt-2 text-xs text-muted">Reference: {error.digest}</p>}
        <button onClick={reset} className="mt-5 inline-flex min-h-11 items-center rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white">Try again</button>
      </div>
    </div>
  );
}

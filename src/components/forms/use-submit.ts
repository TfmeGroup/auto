'use client';

import { useEffect, useState } from 'react';
import { ApiError } from '@/lib/api-client';

/** Submit state shared by every form: pending flag, top-level error, per-field errors. */
export function useSubmit() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  // False until hydration finishes. Submitting earlier would be a native browser submit, which
  // would put every field (including passwords) into the URL.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  async function run(fn: () => Promise<void>) {
    setPending(true);
    setError(null);
    setFields({});
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError) {
        setFields(e.fields);
        setError(Object.keys(e.fields).length > 0 ? 'Please fix the highlighted fields.' : e.message);
      } else {
        setError('We could not reach the server. Check your connection and try again.');
      }
    } finally {
      setPending(false);
    }
  }

  return { pending, ready, error, fields, run, clearError: () => setError(null) };
}

/** Read a named field from a submitted <form> as a trimmed string. */
export function formValue(form: HTMLFormElement, name: string): string {
  const v = new FormData(form).get(name);
  return typeof v === 'string' ? v : '';
}

/** Only allow same-site relative redirects after login (prevents open redirects). */
export function safeNext(next: string | null | undefined, fallback = '/dashboard'): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? next : fallback;
}

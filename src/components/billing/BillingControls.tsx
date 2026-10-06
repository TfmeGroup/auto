'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { formValue, useSubmit } from '@/components/forms/use-submit';
import { api, ApiError } from '@/lib/api-client';

/** Hands the browser to the payment provider. Nothing here marks anything paid — only the provider's verified webhook can. */
export function ContinueToPayment({ planKey, label }: { planKey: string; label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const { data } = await api<{ actionUrl: string; fields: Record<string, string> }>('/api/v1/billing/checkout', { body: { planKey } });
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = data.actionUrl;
      for (const [k, v] of Object.entries(data.fields)) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = k;
        input.value = v;
        form.appendChild(input);
      }
      document.body.appendChild(form);
      form.submit();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not start checkout.');
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2">
      <Button loading={busy} onClick={go} className="w-full sm:w-auto">{label}</Button>
      {error && <Alert>{error}</Alert>}
    </div>
  );
}

export function ScheduleDowngrade({ planKey, effectiveOn }: { planKey: string; effectiveOn: string }) {
  const router = useRouter();
  const { pending, ready, error, run } = useSubmit();
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted">You keep your current plan until <strong className="text-ink">{effectiveOn}</strong>. The lower price applies from the next renewal.</p>
      {error && <Alert>{error}</Alert>}
      <Button loading={pending || !ready} onClick={() => void run(async () => { await api('/api/v1/billing/downgrade', { body: { planKey } }); router.push('/settings/billing?changed=scheduled'); router.refresh(); })}>Schedule downgrade</Button>
    </div>
  );
}

export function CancelSubscription({ accessUntil }: { accessUntil: string | null }) {
  const router = useRouter();
  const { pending, ready, error, run } = useSubmit();
  const [open, setOpen] = useState(false);
  if (!open) return <Button variant="secondary" onClick={() => setOpen(true)}>Cancel subscription…</Button>;
  return (
    <form
      method="post"
      noValidate
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = e.currentTarget;
        void run(async () => { await api('/api/v1/billing/cancel', { body: { reason: formValue(f, 'reason'), confirm: true } }); setOpen(false); router.refresh(); });
      }}
    >
      <Alert tone="warn">Billing stops. You keep full access{accessUntil ? ` until ${accessUntil}` : ''}, then the business becomes read-only. Nothing is deleted.</Alert>
      {error && <Alert>{error}</Alert>}
      <Field label="Why are you leaving? (optional)" htmlFor="cancelReason"><Input id="cancelReason" name="reason" /></Field>
      <div className="flex gap-2">
        <Button type="submit" variant="danger" loading={pending || !ready}>Cancel subscription</Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Keep it</Button>
      </div>
    </form>
  );
}

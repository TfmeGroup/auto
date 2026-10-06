'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Field, Input, Textarea } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';
import { formatMoney, parseDecimalToCents } from '@/lib/money';

/** The customer's side of a quote: approve, decline or ask for changes. Works on any phone; no sign-in. */
export function QuoteDecision({ token, version, customerName }: { token: string; version: number; customerName: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<'approve' | 'decline' | 'request_changes' | null>(null);
  const [name, setName] = useState(customerName);
  const [accept, setAccept] = useState(false);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);

  async function submit() {
    if (!mode) return;
    setBusy(true);
    setError(null);
    setFields({});
    try {
      await api(`/api/public/quotes/${token}/decision`, { body: { action: mode, version, name, acceptTerms: mode === 'approve' ? accept : undefined, comment: comment || undefined } });
      setDone(mode === 'approve' ? 'Thank you. You have approved this quote. The workshop has been told.' : mode === 'decline' ? 'You have declined this quote. The workshop has been told.' : 'Your request has been sent. The workshop will send you a revised quote.');
      router.refresh();
    } catch (e) {
      if (e instanceof ApiError) {
        setFields(e.fields);
        setError(Object.keys(e.fields).length ? 'Please check the highlighted fields.' : e.message);
      } else setError('We could not reach the server. Please check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  if (done) return <Alert tone="ok">{done}</Alert>;
  if (!mode) {
    return (
      <div className="space-y-2">
        <Button className="w-full" onClick={() => setMode('approve')}>Approve this quote</Button>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={() => setMode('request_changes')}>Ask for changes</Button>
          <Button variant="secondary" onClick={() => setMode('decline')}>Decline</Button>
        </div>
      </div>
    );
  }
  return (
    <form className="space-y-3 rounded-xl border border-line bg-canvas p-3" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2 className="text-base font-semibold">{mode === 'approve' ? 'Approve this quote' : mode === 'decline' ? 'Decline this quote' : 'Ask for changes'}</h2>
      {error && <Alert>{error}</Alert>}
      {mode !== 'request_changes' && (
        <Field label="Your full name" htmlFor="q-name" error={fields.name} hint={mode === 'approve' ? 'Typing your name is your electronic signature.' : undefined}>
          <Input id="q-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={120} />
        </Field>
      )}
      <Field label={mode === 'request_changes' ? 'What would you like changed?' : 'Comment (optional)'} htmlFor="q-comment" error={fields.comment}>
        <Textarea id="q-comment" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} />
      </Field>
      {mode === 'approve' && (
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" className="mt-0.5 size-5" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
          <span>I accept this quote and its terms. I understand that my name, the date and time, and my device’s address are recorded as proof of this approval.</span>
        </label>
      )}
      {fields.acceptTerms && <p role="alert" className="text-xs font-medium text-danger">{fields.acceptTerms}</p>}
      <div className="flex gap-2">
        <Button type="submit" loading={busy} className="flex-1">{mode === 'approve' ? 'Confirm approval' : mode === 'decline' ? 'Confirm decline' : 'Send request'}</Button>
        <Button type="button" variant="secondary" onClick={() => setMode(null)}>Back</Button>
      </div>
    </form>
  );
}

/** Pay an invoice online: asks our server for a checkout session, then posts the browser to the provider's hosted page. */
export function PayOnline({ token, outstandingCents, currency, locale, provider }: { token: string; outstandingCents: number; currency: string; locale: string; provider: string }) {
  const [part, setPart] = useState(false);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const [session, setSession] = useState<{ actionUrl: string; fields: Record<string, string> } | null>(null);

  useEffect(() => { if (session) form.current?.submit(); }, [session]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      let body: { amountCents?: number } = {};
      if (part) {
        try { body = { amountCents: parseDecimalToCents(amount.replace(/[Rr\s]/g, '').replace(',', '.')) }; } catch { setError('Enter the amount as a number, like 500.00'); setBusy(false); return; }
      }
      const res = await api<{ session: { actionUrl: string; fields: Record<string, string> } }>(`/api/public/invoices/${token}/pay`, { body });
      setSession(res.data.session);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'We could not start the payment. Please try again.');
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {part && (
        <Field label="Amount to pay now" htmlFor="pay-part">
          <Input id="pay-part" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={(outstandingCents / 100).toFixed(2)} />
        </Field>
      )}
      <Button className="w-full" loading={busy} onClick={() => void start()}>Pay {part ? 'this amount' : formatMoney(outstandingCents, currency, locale)} online</Button>
      <button type="button" className="min-h-11 w-full text-sm text-brand-700" onClick={() => setPart(!part)}>{part ? 'Pay the full balance instead' : 'Pay part of the balance'}</button>
      <p className="text-center text-xs text-muted">You will be taken to {provider}’s secure page. Your card details never reach us.</p>
      {error && <Alert>{error}</Alert>}
      {session && (
        <form ref={form} action={session.actionUrl} method="post" className="hidden">
          {Object.entries(session.fields).map(([k, val]) => <input key={k} type="hidden" name={k} value={val} />)}
          <noscript><button type="submit">Continue to payment</button></noscript>
        </form>
      )}
    </div>
  );
}

/** After the provider returns the customer: re-checks the payment's real state a few times (a webhook confirms it, not this page). */
export function RefreshWhilePending({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    let n = 0;
    const t = setInterval(() => { n += 1; router.refresh(); if (n >= 12) clearInterval(t); }, 5000);
    return () => clearInterval(t);
  }, [active, router]);
  return null;
}

'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, Input, Select, Textarea } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';
import { parseDecimalToCents } from '@/lib/money';

/** Rand text ("1 250,50", "R1250.5") to exact cents; anything unreadable becomes NaN so the server reports it. */
const toCents = (raw: string): number => {
  try {
    return parseDecimalToCents(raw.replace(/[Rr\s]/g, '').replace(',', '.'));
  } catch {
    return Number.NaN;
  }
};

/**
 * Buttons that perform a financial action through the API (and so through the server's permission, state and plan checks),
 * then refresh the page. Showing or hiding a button is a convenience; the endpoint is what enforces the rule.
 */

function useCall() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function call<T>(path: string, body: unknown, after?: (data: T) => void, method = 'POST') {
    setBusy(true);
    setError(null);
    try {
      const res = await api<T>(path, { method, body });
      after?.(res.data);
      return res.data;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong.');
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { router, busy, error, setError, call };
}

/** One-click action with an optional "are you sure?", optionally continuing to another page with an id from the result. */
export function GoButton({
  label, path, body = {}, variant = 'secondary', confirm, redirect, className,
}: {
  label: string;
  path: string;
  body?: unknown;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  confirm?: string;
  /** After success go to `${base}${data[key]}`. */
  redirect?: { base: string; key: string };
  className?: string;
}) {
  const { router, busy, error, call } = useCall();
  const [asking, setAsking] = useState(false);
  async function go() {
    const data = await call<Record<string, string>>(path, body);
    if (!data) return;
    setAsking(false);
    if (redirect && data[redirect.key]) router.push(`${redirect.base}${data[redirect.key]}`);
    router.refresh();
  }
  if (asking && confirm) {
    return (
      <div className="space-y-2">
        <p className="text-sm">{confirm}</p>
        <div className="flex gap-2">
          <Button variant={variant === 'secondary' ? 'primary' : variant} loading={busy} onClick={go}>Yes, {label.toLowerCase()}</Button>
          <Button variant="secondary" onClick={() => setAsking(false)}>Not now</Button>
        </div>
        {error && <Alert>{error}</Alert>}
      </div>
    );
  }
  return (
    <div className={className}>
      <Button variant={variant} loading={busy} onClick={() => (confirm ? setAsking(true) : void go())}>{label}</Button>
      {error && <div className="mt-2"><Alert>{error}</Alert></div>}
    </div>
  );
}

/** An action that must be explained: opens a reason box, then posts `{ reason, ...extra }`. */
export function ReasonButton({
  label, path, variant = 'secondary', prompt = 'Reason', extra = {}, minLength = 3, redirect,
}: {
  label: string;
  path: string;
  variant?: 'secondary' | 'danger';
  prompt?: string;
  extra?: Record<string, unknown>;
  minLength?: number;
  redirect?: string;
}) {
  const { router, busy, error, call } = useCall();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (!open) return <Button variant={variant} onClick={() => setOpen(true)}>{label}</Button>;
  return (
    <form
      className="w-full space-y-2 rounded-xl border border-line bg-canvas p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await call(path, { reason, ...extra });
        if (ok) { setOpen(false); setReason(''); if (redirect) router.push(redirect); router.refresh(); }
      }}
    >
      <Field label={prompt} htmlFor={`reason-${path}`}>
        <Textarea id={`reason-${path}`} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoFocus />
      </Field>
      {error && <Alert>{error}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" variant={variant === 'danger' ? 'danger' : 'primary'} loading={busy} disabled={reason.trim().length < minLength}>{label}</Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}

export function CopyButton({ text, label = 'Copy link' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="secondary"
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 2000); } catch { window.prompt('Copy this link', text); }
      }}
    >
      {done ? 'Copied' : label}
    </Button>
  );
}

/** Send (or re-send) a quote or invoice: emails the customer and shows the private link to share another way (WhatsApp, SMS). */
export function SendPanel({ path, label, hasEmail, noun }: { path: string; label: string; hasEmail: boolean; noun: 'quote' | 'invoice' }) {
  const { router, busy, error, call } = useCall();
  const [email, setEmail] = useState(hasEmail);
  const [result, setResult] = useState<{ customerUrl: string; emailed: boolean } | null>(null);
  return (
    <div className="space-y-2">
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" className="size-5" checked={email} disabled={!hasEmail} onChange={(e) => setEmail(e.target.checked)} />
        {hasEmail ? `Email the ${noun} to the customer` : 'The customer has no email address: you can share the link yourself'}
      </label>
      <Button loading={busy} onClick={async () => {
        const d = await call<{ customerUrl: string; emailed: boolean }>(path, { email });
        if (d) { setResult(d); router.refresh(); }
      }}>{label}</Button>
      {error && <Alert>{error}</Alert>}
      {result && (
        <div className="space-y-2 rounded-xl border border-line bg-canvas p-3 text-sm" role="status">
          <p>{result.emailed ? 'Sent by email.' : 'Not emailed.'} The customer’s private link:</p>
          <p className="break-all rounded-lg bg-surface px-2 py-1.5 font-mono text-xs">{result.customerUrl}</p>
          <CopyButton text={result.customerUrl} />
        </div>
      )}
    </div>
  );
}

const METHODS = [['EFT', 'EFT'], ['CARD', 'Card'], ['CASH', 'Cash'], ['ONLINE', 'Online (recorded)'], ['OTHER', 'Other']] as const;

/** The "record a payment" form: amount, method, reference. The request key is made once per form, so a double tap is one payment. */
export function RecordPaymentForm({
  invoiceId, customerId, purpose = 'INVOICE', defaultAmount, methods, idempotencyKey, submitLabel = 'Record payment', redirectBase,
}: {
  invoiceId?: string;
  customerId?: string;
  purpose?: 'INVOICE' | 'DEPOSIT';
  defaultAmount?: string;
  methods: string[];
  idempotencyKey: string;
  submitLabel?: string;
  /** After saving, open the payment (/payments/<id>). */
  redirectBase?: string;
}) {
  const { router, busy, error, call } = useCall();
  const [amount, setAmount] = useState(defaultAmount ?? '');
  const [method, setMethod] = useState(methods[0] ?? 'EFT');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [done, setDone] = useState<{ number: string; receiptNumber: string | null; creditedCents: number } | null>(null);
  return (
    <form
      className="space-y-3"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const cents = toCents(amount);
        const d = await call<{ id: string; number: string; receiptNumber: string | null; creditedCents: number }>('/api/v1/payments', { purpose, invoiceId, customerId, amountCents: cents, method, reference, notes, idempotencyKey });
        if (d) {
          setDone(d);
          if (redirectBase) router.push(`${redirectBase}${d.id}`);
          router.refresh();
        }
      }}
    >
      {error && <Alert>{error}</Alert>}
      {done && <Alert tone="ok">Payment {done.number} recorded{done.receiptNumber ? `, receipt ${done.receiptNumber}` : ''}.{done.creditedCents > 0 ? ' The excess was added to the customer’s credit.' : ''}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Amount" htmlFor="pay-amount" hint="In rand, e.g. 1250.00">
          <Input id="pay-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoComplete="off" required />
        </Field>
        <Field label="Method" htmlFor="pay-method">
          <Select id="pay-method" value={method} onChange={(e) => setMethod(e.target.value)}>
            {METHODS.filter(([v]) => methods.includes(v)).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </Field>
        <Field label="Reference (optional)" htmlFor="pay-ref" hint="Bank reference, card slip number…">
          <Input id="pay-ref" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} />
        </Field>
        <Field label="Notes (optional)" htmlFor="pay-notes">
          <Input id="pay-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
        </Field>
      </div>
      <Button type="submit" loading={busy} disabled={!!done}>{submitLabel}</Button>
    </form>
  );
}

/** Use customer credit against an invoice. */
export function ApplyCreditForm({ invoiceId, maxCents, idempotencyKey, availableLabel }: { invoiceId: string; maxCents: number; idempotencyKey: string; availableLabel: string }) {
  const { router, busy, error, call } = useCall();
  const [amount, setAmount] = useState((maxCents / 100).toFixed(2));
  return (
    <form
      className="space-y-2"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const cents = toCents(amount);
        const d = await call(`/api/v1/invoices/${invoiceId}/apply-credit`, { amountCents: cents, idempotencyKey });
        if (d) router.refresh();
      }}
    >
      <p className="text-sm text-muted">The customer has {availableLabel} credit.</p>
      <Field label="Amount to apply" htmlFor="credit-amount">
        <Input id="credit-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      {error && <Alert>{error}</Alert>}
      <Button type="submit" variant="secondary" loading={busy}>Apply credit</Button>
    </form>
  );
}

/** Refund (part of) a payment. */
export function RefundForm({ paymentId, maxCents, idempotencyKey }: { paymentId: string; maxCents: number; idempotencyKey: string }) {
  const { router, busy, error, call } = useCall();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState((maxCents / 100).toFixed(2));
  const [reason, setReason] = useState('');
  const [ref, setRef] = useState('');
  if (!open) return <Button variant="secondary" onClick={() => setOpen(true)}>Refund…</Button>;
  return (
    <form
      className="space-y-3 rounded-xl border border-line bg-canvas p-3"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const cents = toCents(amount);
        const d = await call(`/api/v1/payments/${paymentId}/refund`, { amountCents: cents, reason, providerReference: ref, idempotencyKey });
        if (d) { setOpen(false); router.refresh(); }
      }}
    >
      <p className="text-sm text-muted">This records that you have paid money back. It does not move money by itself.</p>
      <Field label="Amount to refund" htmlFor="refund-amount"><Input id="refund-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
      <Field label="Reason" htmlFor="refund-reason"><Textarea id="refund-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>
      <Field label="Bank / provider reference (optional)" htmlFor="refund-ref"><Input id="refund-ref" value={ref} onChange={(e) => setRef(e.target.value)} maxLength={100} /></Field>
      {error && <Alert>{error}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" variant="danger" loading={busy} disabled={reason.trim().length < 3}>Record refund</Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}

/** Approval recorded on the customer's behalf (they said yes on the phone, in person, or in writing). */
export function ApproveOnBehalfForm({ quoteId, version }: { quoteId: string; version: number }) {
  const { router, busy, error, call } = useCall();
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState('PHONE');
  const [note, setNote] = useState('');
  if (!open) return <Button variant="secondary" onClick={() => setOpen(true)}>Record approval…</Button>;
  return (
    <form
      className="space-y-3 rounded-xl border border-line bg-canvas p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const d = await call(`/api/v1/quotes/${quoteId}/approve`, { method, note, version });
        if (d) { setOpen(false); router.refresh(); }
      }}
    >
      <p className="text-sm text-muted">Use this when the customer told you they approve. It locks version {version} and is recorded with your name.</p>
      <Field label="How did they approve?" htmlFor="appr-method">
        <Select id="appr-method" value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="PHONE">By phone</option><option value="IN_PERSON">In person</option><option value="WRITTEN">In writing (message or email)</option><option value="OTHER">Other</option>
        </Select>
      </Field>
      <Field label="Note (optional)" htmlFor="appr-note"><Input id="appr-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
      {error && <Alert>{error}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" loading={busy}>Record approval</Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}

/** Reconcile / un-reconcile a payment. */
export function ReconcileButton({ paymentId, reconciled }: { paymentId: string; reconciled: boolean }) {
  const { router, busy, error, call } = useCall();
  return (
    <div>
      <Button variant="secondary" loading={busy} onClick={async () => { if (await call(`/api/v1/payments/${paymentId}/reconcile`, { reconciled: !reconciled })) router.refresh(); }}>
        {reconciled ? 'Mark as not reconciled' : 'Mark as reconciled'}
      </Button>
      {error && <div className="mt-2"><Alert>{error}</Alert></div>}
    </div>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Input } from '@/components/ui';
import { RecordPaymentForm } from '@/components/finance/FinanceActions';
import { CustomerPicker, type CustomerOption } from '@/components/workshop/Pickers';
import { api } from '@/lib/api-client';
import { centsToDecimal, formatMoney } from '@/lib/money';

interface OpenInvoice {
  id: string;
  number: string | null;
  outstandingCents: number;
  totalCents: number;
  dueDate: string | null;
  customer: { id: string; name: string };
  vehicle: { registration: string | null; label: string } | null;
}

/**
 * "Record payment" for phones and desktops: pick the invoice (searching open invoices on the server as you type) or take a
 * deposit for a customer, then enter amount, method and reference. The request key is created once per screen, so tapping
 * twice records one payment.
 */
export function PaymentEntry({
  methods, depositsEnabled, currency, locale, idempotencyKey, initialInvoice, canSearchCustomers,
}: {
  methods: string[];
  depositsEnabled: boolean;
  currency: string;
  locale: string;
  idempotencyKey: string;
  initialInvoice?: OpenInvoice | null;
  canSearchCustomers: boolean;
}) {
  const [mode, setMode] = useState<'invoice' | 'deposit'>('invoice');
  const [invoice, setInvoice] = useState<OpenInvoice | null>(initialInvoice ?? null);
  const [customer, setCustomer] = useState<CustomerOption | null>(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<OpenInvoice[]>([]);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const money = (c: number) => formatMoney(c, currency, locale);

  useEffect(() => {
    if (mode !== 'invoice' || invoice) return;
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await api<OpenInvoice[]>(`/api/v1/invoices?payment=unpaid&pageSize=8&sort=due_date&dir=asc${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`);
        if (mine === seq.current) setResults(r.data);
      } catch {
        if (mine === seq.current) setResults([]);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [q, mode, invoice]);

  return (
    <div className="space-y-4">
      {depositsEnabled && (
        <div role="tablist" aria-label="What is the payment for?" className="grid grid-cols-2 gap-1 rounded-xl bg-canvas p-1">
          {([['invoice', 'Pay an invoice'], ['deposit', 'Deposit / advance']] as const).map(([k, label]) => (
            <button key={k} role="tab" type="button" aria-selected={mode === k} onClick={() => setMode(k)} className={clsx('min-h-11 rounded-lg text-sm font-medium', mode === k ? 'bg-surface shadow-sm' : 'text-muted')}>{label}</button>
          ))}
        </div>
      )}

      {mode === 'invoice' && !invoice && (
        <div className="space-y-2">
          <Input type="search" placeholder="Search invoice number, customer, phone, registration" aria-label="Search unpaid invoices" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
          <ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-lg border border-line bg-surface" aria-busy={loading}>
            {results.map((i) => (
              <li key={i.id}>
                <button type="button" onClick={() => setInvoice(i)} className="flex min-h-14 w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-canvas">
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{i.number}</span>
                    <span className="block truncate text-xs text-muted">{i.customer.name}{i.vehicle ? ` · ${i.vehicle.registration ?? i.vehicle.label}` : ''}</span>
                  </span>
                  <span className="shrink-0 text-right text-sm font-semibold tabular-nums text-danger">{money(i.outstandingCents)}</span>
                </button>
              </li>
            ))}
            {!loading && results.length === 0 && <li className="px-3 py-3 text-sm text-muted">No unpaid invoices match.</li>}
          </ul>
        </div>
      )}

      {mode === 'invoice' && invoice && (
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-3 rounded-lg border border-line bg-canvas px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-semibold">{invoice.number} · {invoice.customer.name}</p>
              <p className="text-xs text-muted">Total {money(invoice.totalCents)} · outstanding <strong className="text-ink">{money(invoice.outstandingCents)}</strong></p>
            </div>
            <button type="button" className="min-h-11 shrink-0 px-2 text-sm font-medium text-brand-700" onClick={() => setInvoice(null)}>Change</button>
          </div>
          <RecordPaymentForm invoiceId={invoice.id} defaultAmount={centsToDecimal(invoice.outstandingCents)} methods={methods} idempotencyKey={idempotencyKey} redirectBase="/payments/" />
        </div>
      )}

      {mode === 'deposit' && (
        <div className="space-y-4">
          <p className="text-sm text-muted">A deposit is money received before an invoice exists. It is kept as the customer’s credit and can be applied to their invoice later.</p>
          {canSearchCustomers ? <CustomerPicker value={customer} onChange={setCustomer} canCreate={false} /> : <p className="text-sm text-muted">You need permission to view customers to take a deposit.</p>}
          {customer && <RecordPaymentForm purpose="DEPOSIT" customerId={customer.id} methods={methods} idempotencyKey={idempotencyKey} submitLabel="Record deposit" redirectBase="/payments/" />}
        </div>
      )}
    </div>
  );
}

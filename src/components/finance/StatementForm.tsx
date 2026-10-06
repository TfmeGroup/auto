'use client';

import { useState } from 'react';
import { CustomerPicker, type CustomerOption } from '@/components/workshop/Pickers';
import { Field, Input } from '@/components/ui';

/** Pick a customer and a period, then view the statement or download its PDF. Both are normal links to authorised endpoints. */
export function StatementForm({ defaultFrom, defaultTo }: { defaultFrom: string; defaultTo: string }) {
  const [customer, setCustomer] = useState<CustomerOption | null>(null);
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const q = `from=${from}&to=${to}`;
  return (
    <div className="space-y-3">
      <Field label="Customer" htmlFor="stmt-customer"><CustomerPicker value={customer} onChange={setCustomer} canCreate={false} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="From" htmlFor="stmt-from"><Input id="stmt-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To" htmlFor="stmt-to"><Input id="stmt-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      {customer && (
        <div className="flex flex-wrap gap-2">
          <a className="inline-flex min-h-11 items-center rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 md:min-h-10" href={`/customers/${customer.id}?tab=financial&${q}`}>View statement</a>
          <a className="inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-4 text-sm font-semibold hover:bg-canvas md:min-h-10" href={`/api/v1/customers/${customer.id}/statement/pdf?${q}&download=1`}>Download PDF</a>
        </div>
      )}
    </div>
  );
}

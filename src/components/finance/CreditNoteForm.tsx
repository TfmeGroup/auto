'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Alert, Button, Field, Input, Select, Textarea } from '@/components/ui';
import { useSubmit } from '@/components/forms/use-submit';
import { api } from '@/lib/api-client';
import { centsToDecimal, formatMoney, parseDecimalToCents, parseQuantityToMilli } from '@/lib/money';
import { calculateDocument, type LineCalcInput } from '@/server/finance/calc';

interface InvLine {
  lineType: string;
  description: string;
  quantityMilli: number;
  unitPriceCents: number;
  taxTreatment: string;
}
interface Row {
  key: number;
  lineType: string;
  description: string;
  qty: string;
  price: string;
  taxTreatment: 'STANDARD' | 'ZERO_RATED' | 'EXEMPT';
}

let n = 0;
const blank = (over: Partial<Row> = {}): Row => ({ key: ++n, lineType: 'OTHER', description: '', qty: '1', price: '', taxTreatment: 'STANDARD', ...over });
const num = (s: string) => s.replace(/[Rr\s]/g, '').replace(',', '.');

/** Raise a credit note against an issued invoice: reverse all of it, or credit specific lines. Authorising it is a separate step. */
export function CreditNoteForm({
  invoiceId, invoiceNumber, lines, tax, currency, locale, maxCents,
}: {
  invoiceId: string;
  invoiceNumber: string;
  lines: InvLine[];
  tax: { vatRegistered: boolean; vatRateBps: number; pricesIncludeVat: boolean };
  currency: string;
  locale: string;
  /** What can still be credited (invoice total less other credit notes). */
  maxCents: number;
}) {
  const router = useRouter();
  const { pending, ready, error, fields, run } = useSubmit();
  const [mode, setMode] = useState<'full' | 'lines'>('full');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<Row[]>([blank()]);
  const money = (c: number) => formatMoney(c, currency, locale);

  const calc = useMemo(() => {
    if (mode !== 'lines') return null;
    try {
      const parsed: LineCalcInput[] = rows.map((r) => ({ quantityMilli: parseQuantityToMilli(num(r.qty) || '0'), unitPriceCents: parseDecimalToCents(num(r.price) || '0'), discountType: 'NONE', discountValue: 0, taxTreatment: r.taxTreatment }));
      return calculateDocument(parsed, tax);
    } catch {
      return null;
    }
  }, [rows, mode, tax]);

  const patch = (key: number, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));

  return (
    <form
      noValidate
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const body: Record<string, unknown> = { invoiceId, reason, notes };
          if (mode === 'full') body.copy = 'full';
          else {
            body.lines = rows.map((r) => ({
              lineType: r.lineType, description: r.description, taxTreatment: r.taxTreatment,
              quantityMilli: (() => { try { return parseQuantityToMilli(num(r.qty) || '0'); } catch { return 0; } })(),
              unitPriceCents: (() => { try { return parseDecimalToCents(num(r.price) || '0'); } catch { return -1; } })(),
            }));
          }
          const res = await api<{ id: string }>('/api/v1/credit-notes', { body });
          router.push(`/credit-notes/${res.data.id}`);
          router.refresh();
        });
      }}
    >
      {error && <Alert>{error}</Alert>}
      <p className="text-sm text-muted">Credit notes correct an issued invoice without changing it. You can credit up to <strong>{money(maxCents)}</strong> more against {invoiceNumber}.</p>

      <div role="radiogroup" aria-label="What to credit" className="grid gap-2 sm:grid-cols-2">
        {([['full', 'The whole invoice', 'Reverses every line, including VAT.'], ['lines', 'Specific lines', 'Credit some items or an amount.']] as const).map(([k, title, hint]) => (
          <label key={k} className={`flex min-h-14 cursor-pointer items-start gap-3 rounded-xl border p-3 ${mode === k ? 'border-brand-600 bg-brand-50' : 'border-line bg-surface'}`}>
            <input type="radio" name="mode" className="mt-1 size-5" checked={mode === k} onChange={() => setMode(k)} />
            <span><span className="block text-sm font-semibold">{title}</span><span className="block text-xs text-muted">{hint}</span></span>
          </label>
        ))}
      </div>

      {mode === 'lines' && (
        <section className="space-y-3">
          {fields.lines && <Alert>{fields.lines}</Alert>}
          <Button type="button" variant="secondary" onClick={() => setRows(lines.map((l) => blank({ lineType: l.lineType, description: l.description, qty: String(l.quantityMilli / 1000), price: centsToDecimal(l.unitPriceCents), taxTreatment: l.taxTreatment as Row['taxTreatment'] })))}>Start from the invoice’s lines</Button>
          <ul className="space-y-3">
            {rows.map((r, i) => (
              <li key={r.key} className="rounded-xl border border-line bg-canvas p-3">
                <div className="grid gap-2 sm:grid-cols-6">
                  <div className="sm:col-span-3"><Field label={`Line ${i + 1}: description`} htmlFor={`cn-d-${r.key}`} error={fields[`lines.${i}.description`]}><Input id={`cn-d-${r.key}`} value={r.description} onChange={(e) => patch(r.key, { description: e.target.value })} maxLength={300} /></Field></div>
                  <Field label="Quantity" htmlFor={`cn-q-${r.key}`} error={fields[`lines.${i}.quantityMilli`] ?? fields[`lines.${i}.quantity`]}><Input id={`cn-q-${r.key}`} inputMode="decimal" value={r.qty} onChange={(e) => patch(r.key, { qty: e.target.value })} /></Field>
                  <Field label="Unit price" htmlFor={`cn-p-${r.key}`} error={fields[`lines.${i}.unitPriceCents`] ?? fields[`lines.${i}.unitPrice`]}><Input id={`cn-p-${r.key}`} inputMode="decimal" value={r.price} onChange={(e) => patch(r.key, { price: e.target.value })} /></Field>
                  {tax.vatRegistered && (
                    <Field label="VAT" htmlFor={`cn-v-${r.key}`}>
                      <Select id={`cn-v-${r.key}`} value={r.taxTreatment} onChange={(e) => patch(r.key, { taxTreatment: e.target.value as Row['taxTreatment'] })}><option value="STANDARD">Standard</option><option value="ZERO_RATED">Zero-rated</option><option value="EXEMPT">Exempt</option></Select>
                    </Field>
                  )}
                </div>
                <div className="mt-2 text-right"><Button type="button" variant="ghost" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>Remove</Button></div>
              </li>
            ))}
          </ul>
          <Button type="button" variant="secondary" onClick={() => setRows((rs) => [...rs, blank()])}>Add a line</Button>
          <p className="text-sm tabular-nums" aria-live="polite">{calc ? <>Credit total: <strong>{money(calc.totalCents)}</strong>{tax.vatRegistered ? ` (VAT ${money(calc.vatCents)})` : ''}</> : 'Enter quantities and prices to see the total.'}</p>
        </section>
      )}

      <Field label="Reason (shown on the credit note)" htmlFor="cn-reason" error={fields.reason}><Textarea id="cn-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>
      <Field label="Notes (optional)" htmlFor="cn-notes" error={fields.notes}><Textarea id="cn-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} /></Field>
      <Button type="submit" loading={pending || !ready} disabled={reason.trim().length < 3}>Create draft credit note</Button>
    </form>
  );
}

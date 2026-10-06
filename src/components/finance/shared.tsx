import clsx from 'clsx';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui';
import { formatMoney } from '@/lib/money';

/** Display pieces shared by every money screen (staff pages and the customer's quote/invoice pages). Server-renderable. */

type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'brand';

export interface MoneyFmt {
  currency: string;
  locale: string;
}
export const money = (cents: number | null | undefined, f: MoneyFmt) => (cents === null || cents === undefined ? '—' : formatMoney(cents, f.currency, f.locale));

const QUOTE: Record<string, [string, Tone]> = {
  DRAFT: ['Draft', 'neutral'], SENT: ['Sent', 'brand'], VIEWED: ['Viewed', 'brand'], APPROVED: ['Approved', 'ok'], DECLINED: ['Declined', 'danger'], EXPIRED: ['Expired', 'warn'],
  CONVERTED: ['Converted to invoice', 'ok'], CANCELLED: ['Cancelled', 'neutral'],
};
export const QuoteStatusBadge = ({ status }: { status: string }) => <Badge tone={QUOTE[status]?.[1] ?? 'neutral'}>{QUOTE[status]?.[0] ?? status}</Badge>;
export const quoteStatusLabel = (s: string) => QUOTE[s]?.[0] ?? s;

const INVOICE: Record<string, [string, Tone]> = {
  DRAFT: ['Draft', 'neutral'], ISSUED: ['Issued', 'brand'], SENT: ['Sent', 'brand'], VIEWED: ['Viewed', 'brand'], PARTIALLY_PAID: ['Partially paid', 'warn'], PAID: ['Paid', 'ok'],
  OVERDUE: ['Overdue', 'danger'], CANCELLED: ['Cancelled', 'neutral'], WRITTEN_OFF: ['Written off', 'neutral'],
};
export const InvoiceStatusBadge = ({ status }: { status: string }) => <Badge tone={INVOICE[status]?.[1] ?? 'neutral'}>{INVOICE[status]?.[0] ?? status}</Badge>;
export const invoiceStatusLabel = (s: string) => INVOICE[s]?.[0] ?? s;

const PAYMENT: Record<string, [string, Tone]> = {
  PENDING: ['Pending', 'warn'], PROCESSING: ['Processing', 'warn'], COMPLETED: ['Completed', 'ok'], FAILED: ['Failed', 'danger'], CANCELLED: ['Cancelled', 'neutral'],
  REFUNDED: ['Refunded', 'neutral'], PARTIALLY_REFUNDED: ['Partially refunded', 'warn'],
};
export const PaymentStatusBadge = ({ status }: { status: string }) => <Badge tone={PAYMENT[status]?.[1] ?? 'neutral'}>{PAYMENT[status]?.[0] ?? status}</Badge>;

const CN: Record<string, [string, Tone]> = { DRAFT: ['Draft', 'neutral'], ISSUED: ['Issued', 'ok'], CANCELLED: ['Cancelled', 'neutral'] };
export const CreditNoteStatusBadge = ({ status }: { status: string }) => <Badge tone={CN[status]?.[1] ?? 'neutral'}>{CN[status]?.[0] ?? status}</Badge>;

export const METHOD_LABEL: Record<string, string> = { CARD: 'Card', EFT: 'EFT', CASH: 'Cash', ONLINE: 'Online', OTHER: 'Other' };
export const LINE_TYPE_LABEL: Record<string, string> = { PART: 'Part', LABOUR: 'Labour', SERVICE: 'Service', CHARGE: 'Additional charge', OTHER: 'Other' };

export interface DisplayLine {
  id?: string;
  lineType: string;
  description: string;
  sku?: string | null;
  unit?: string | null;
  quantityMilli: number;
  unitPriceCents: number;
  discountCents: number;
  vatCents: number;
  totalCents: number;
  unitCostCents?: number | null;
}

const qty = (milli: number) => (milli % 1000 === 0 ? String(milli / 1000) : (milli / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, ''));

/** Line items: a table on wide screens, stacked cards on phones (no tiny desktop tables on a 375px screen). */
export function LineItems({ lines, fmt, showVat, showCost }: { lines: DisplayLine[]; fmt: MoneyFmt; showVat: boolean; showCost?: boolean }) {
  if (lines.length === 0) return <p className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-sm text-muted">No lines yet.</p>;
  return (
    <>
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full min-w-[34rem] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
              <th className="py-2 pr-2 font-medium">Description</th>
              <th className="px-2 py-2 text-right font-medium">Qty</th>
              <th className="px-2 py-2 text-right font-medium">Unit price</th>
              <th className="px-2 py-2 text-right font-medium">Discount</th>
              {showVat && <th className="px-2 py-2 text-right font-medium">VAT</th>}
              <th className="py-2 pl-2 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {lines.map((l, i) => (
              <tr key={l.id ?? i} className="align-top">
                <td className="py-2 pr-2">
                  <p className="font-medium">{l.description}</p>
                  <p className="text-xs text-muted">{LINE_TYPE_LABEL[l.lineType] ?? l.lineType}{l.sku ? ` · ${l.sku}` : ''}{showCost && l.unitCostCents != null ? ` · cost ${money(l.unitCostCents, fmt)} each` : ''}</p>
                </td>
                <td className="px-2 py-2 text-right tabular-nums">{qty(l.quantityMilli)}{l.unit ? ` ${l.unit}` : ''}</td>
                <td className="px-2 py-2 text-right tabular-nums">{money(l.unitPriceCents, fmt)}</td>
                <td className="px-2 py-2 text-right tabular-nums">{l.discountCents ? money(l.discountCents, fmt) : '—'}</td>
                {showVat && <td className="px-2 py-2 text-right tabular-nums">{l.vatCents ? money(l.vatCents, fmt) : '—'}</td>}
                <td className="py-2 pl-2 text-right font-medium tabular-nums">{money(l.totalCents, fmt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="divide-y divide-line sm:hidden">
        {lines.map((l, i) => (
          <li key={l.id ?? i} className="py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{l.description}</p>
                <p className="text-xs text-muted">{LINE_TYPE_LABEL[l.lineType] ?? l.lineType}{l.sku ? ` · ${l.sku}` : ''}</p>
              </div>
              <p className="shrink-0 text-sm font-semibold tabular-nums">{money(l.totalCents, fmt)}</p>
            </div>
            <p className="mt-1 text-xs text-muted tabular-nums">
              {qty(l.quantityMilli)}{l.unit ? ` ${l.unit}` : ''} × {money(l.unitPriceCents, fmt)}
              {l.discountCents ? ` · discount ${money(l.discountCents, fmt)}` : ''}{showVat && l.vatCents ? ` · VAT ${money(l.vatCents, fmt)}` : ''}
              {showCost && l.unitCostCents != null ? ` · cost ${money(l.unitCostCents, fmt)}` : ''}
            </p>
          </li>
        ))}
      </ul>
    </>
  );
}

export interface TotalsData {
  subtotalCents: number;
  discountCents: number;
  taxableCents?: number;
  vatCents: number;
  totalCents: number;
  vatRegistered: boolean;
  vatRateBps?: number;
  paidCents?: number;
  creditCents?: number;
  writtenOffCents?: number;
  outstandingCents?: number;
}

export function TotalsBox({ t, fmt, className }: { t: TotalsData; fmt: MoneyFmt; className?: string }) {
  const Row = ({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: 'danger' | 'ok' }) => (
    <div className={clsx('flex items-baseline justify-between gap-6 py-1 text-sm', strong && 'border-t border-line pt-2 text-base font-bold')}>
      <dt className={clsx(!strong && 'text-muted')}>{label}</dt>
      <dd className={clsx('tabular-nums', tone === 'danger' && 'text-danger', tone === 'ok' && 'text-ok')}>{value}</dd>
    </div>
  );
  return (
    <dl className={clsx('ml-auto w-full max-w-xs', className)}>
      <Row label="Subtotal" value={money(t.subtotalCents, fmt)} />
      {t.discountCents > 0 && <Row label="Discount" value={`−${money(t.discountCents, fmt)}`} />}
      {t.discountCents > 0 && t.taxableCents !== undefined && <Row label="After discount" value={money(t.taxableCents, fmt)} />}
      {t.vatRegistered && <Row label={`VAT${t.vatRateBps !== undefined ? ` (${t.vatRateBps / 100}%)` : ''}`} value={money(t.vatCents, fmt)} />}
      <Row label="Total" value={money(t.totalCents, fmt)} strong />
      {t.paidCents !== undefined && t.paidCents > 0 && <Row label="Paid" value={`−${money(t.paidCents, fmt)}`} tone="ok" />}
      {t.creditCents !== undefined && t.creditCents > 0 && <Row label="Credit applied" value={`−${money(t.creditCents, fmt)}`} tone="ok" />}
      {t.writtenOffCents !== undefined && t.writtenOffCents > 0 && <Row label="Written off" value={`−${money(t.writtenOffCents, fmt)}`} />}
      {t.outstandingCents !== undefined && <Row label="Outstanding" value={money(t.outstandingCents, fmt)} strong tone={t.outstandingCents > 0 ? 'danger' : 'ok'} />}
    </dl>
  );
}

/** A KPI tile. */
export function Kpi({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'danger' | 'ok' | 'warn' }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-3.5 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className={clsx('mt-1 text-xl font-bold tabular-nums sm:text-2xl', tone === 'danger' && 'text-danger', tone === 'ok' && 'text-ok', tone === 'warn' && 'text-warn')}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export const AGE_LABEL: Record<string, string> = { current: 'Current', d1_30: '1–30 days', d31_60: '31–60 days', d61_90: '61–90 days', d90_plus: '90+ days' };

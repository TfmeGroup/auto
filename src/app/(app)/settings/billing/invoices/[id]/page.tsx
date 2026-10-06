import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSubscriptionInvoice } from '@/server/billing/overview';
import { assertCan, requireBusiness } from '@/server/web/session';
import { isAppError } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import { formatMoney } from '@/lib/money';

export const metadata: Metadata = { title: 'Tax invoice' };
export const dynamic = 'force-dynamic';

/** A printable tax invoice from TFME to the business. Shown only to the business it was issued to. */
export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'settings.manage_billing');
  const { id } = await params;
  let data;
  try {
    data = await getSubscriptionInvoice(ctx, id);
  } catch (e) {
    if (isAppError(e) && (e.status === 404 || e.status === 422)) notFound();
    throw e;
  }
  const { invoice: i, business: b } = data;
  const m = (c: number) => formatMoney(c, i.currency, b.locale);
  const address = [b.billingAddressLine1 ?? b.addressLine1, b.billingAddressLine2 ?? b.addressLine2, b.billingCity ?? b.city, b.billingProvince ?? b.province, b.billingPostalCode ?? b.postalCode].filter(Boolean);

  return (
    <div className="mx-auto max-w-2xl">
      <p className="mb-3 print:hidden"><Link href="/settings/billing" className="text-sm font-medium text-brand-600 hover:underline">← Back to billing</Link></p>
      <article className="rounded-xl border border-line bg-surface p-6 print:border-0 print:p-0">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">Tax invoice</h1>
            <p className="text-sm text-muted">{i.number}</p>
          </div>
          <div className="text-right text-sm">
            <p className="font-semibold">TFME Auto</p>
            <p className="text-muted">Issued {formatDate(i.issuedAt, b.timezone, b.locale)}</p>
          </div>
        </header>
        <section className="mt-6 text-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Billed to</p>
          <p className="font-medium">{b.legalName ?? b.name}</p>
          {address.map((a) => <p key={a}>{a}</p>)}
          {b.vatNumber && <p>VAT no. {b.vatNumber}</p>}
        </section>
        <table className="mt-6 w-full text-sm">
          <thead><tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted"><th className="py-2 font-medium">Description</th><th className="py-2 text-right font-medium">Amount</th></tr></thead>
          <tbody><tr className="border-b border-line"><td className="py-3">{i.description}</td><td className="py-3 text-right tabular-nums">{m(i.subtotalCents)}</td></tr></tbody>
          <tfoot className="text-sm">
            <tr><td className="pt-3 text-right text-muted">VAT ({(i.vatRateBps / 100).toFixed(0)}%)</td><td className="pt-3 text-right tabular-nums">{m(i.vatCents)}</td></tr>
            <tr><td className="pt-1 text-right font-semibold">Total</td><td className="pt-1 text-right text-base font-bold tabular-nums">{m(i.totalCents)}</td></tr>
          </tfoot>
        </table>
        <p className="mt-6 text-xs text-muted print:hidden">Use your browser’s Print option to save as PDF.</p>
      </article>
    </div>
  );
}

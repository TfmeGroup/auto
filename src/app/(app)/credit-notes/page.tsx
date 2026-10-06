import type { Metadata } from 'next';
import Link from 'next/link';
import { EmptyState, PageHeader, Pagination } from '@/components/ui';
import { CreditNoteStatusBadge, money } from '@/components/finance/shared';
import { Chips, qs } from '@/components/workshop/layout';
import { formatDate } from '@/lib/format';
import { listCreditNotes } from '@/server/finance/creditnotes';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Credit notes' };
export const dynamic = 'force-dynamic';

export default async function CreditNotesPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string; status?: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'credit_note.view');
  const sp = await searchParams;
  const status = sp.status === 'DRAFT' || sp.status === 'ISSUED' || sp.status === 'CANCELLED' ? sp.status : undefined;
  const { items, meta } = await listCreditNotes(ctx, { q: sp.q, page: sp.page, status, pageSize: 25 });
  const fmt = { currency: ctx.business.currency, locale: ctx.business.locale };
  const href = (over: Record<string, string | undefined>) => `/credit-notes${qs({ q: sp.q, status }, { page: undefined, ...over })}`;

  return (
    <>
      <PageHeader title="Credit notes" description="Corrections to issued invoices. Raise one from the invoice." />
      <form action="/credit-notes" className="mb-3" role="search">
        <input name="q" defaultValue={sp.q} type="search" placeholder="Credit note or invoice number, customer" aria-label="Search credit notes" className="block min-h-11 w-full rounded-lg border border-line bg-surface px-3 md:min-h-10" />
        {status && <input type="hidden" name="status" value={status} />}
      </form>
      <div className="mb-4"><Chips items={[{ label: 'All', href: href({ status: undefined }), active: !status }, { label: 'Draft', href: href({ status: 'DRAFT' }), active: status === 'DRAFT' }, { label: 'Issued', href: href({ status: 'ISSUED' }), active: status === 'ISSUED' }, { label: 'Cancelled', href: href({ status: 'CANCELLED' }), active: status === 'CANCELLED' }]} /></div>
      {items.length === 0 ? (
        <EmptyState title="No credit notes">Open an issued invoice and choose “Issue a credit note” to correct it.</EmptyState>
      ) : (
        <>
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {items.map((c) => (
              <li key={c.id}>
                <Link href={`/credit-notes/${c.id}`} className="flex flex-wrap items-center justify-between gap-2 px-3 py-3 hover:bg-canvas">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{c.number ?? 'Draft credit note'} <CreditNoteStatusBadge status={c.status} /></p>
                    <p className="truncate text-xs text-muted">{c.customer.name} · against {c.invoice.number} · {c.issuedAt ? formatDate(c.issuedAt, ctx.business.timezone, ctx.business.locale) : 'not issued'}</p>
                  </div>
                  <span className="font-semibold tabular-nums">{money(c.totalCents, fmt)}</span>
                </Link>
              </li>
            ))}
          </ul>
          <Pagination page={meta.page} totalPages={meta.totalPages} total={meta.total} hrefFor={(p) => href({ page: String(p) })} />
        </>
      )}
    </>
  );
}

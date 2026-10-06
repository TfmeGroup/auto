import { z } from 'zod';
import { withTenant } from '@/server/db/client';
import { escapeLike, parseOrThrow } from '@/lib/validation';
import { formatMoney } from '@/lib/money';
import { can } from '@/server/permissions/authorize';
import type { SearchProvider, SearchHit } from '@/server/search/registry';
import type { BusinessContext } from '@/server/context';

/**
 * Search over the financial records by every handle a person would use: document numbers (quote, invoice, receipt, credit note,
 * payment), payment and provider references, customer name / phone / email, vehicle registration / VIN, job number.
 * Every word must match somewhere (so "smith INV-0012" narrows), matching is case-insensitive, and it is plain database search
 * on indexed columns: no scoring, no model.
 */

const words = (q: string) => q.split(/\s+/).filter(Boolean).slice(0, 4);
const norm = (w: string) => w.toUpperCase().replace(/[^A-Z0-9]/g, '') || escapeLike(w);
const ci = (v: string) => ({ contains: escapeLike(v), mode: 'insensitive' as const });

const customerMatch = (w: string) => ({ OR: [{ name: ci(w) }, { mobile: { contains: escapeLike(w) } }, { email: ci(w) }] });
const vehicleMatch = (w: string) => ({ OR: [{ registrationNorm: { contains: norm(w) } }, { vin: { contains: norm(w), mode: 'insensitive' as const } }] });

const money = (c: number) => formatMoney(c);

export const quoteSearchProvider: SearchProvider = {
  key: 'quotes', label: 'Quotes', permission: 'quote.view',
  async search(tx, businessId, query, limit) {
    const rows = await tx.quote.findMany({
      where: { businessId, AND: words(query).map((w) => ({ OR: [{ number: ci(w) }, { customer: customerMatch(w) }, { vehicle: vehicleMatch(w) }, { job: { jobNumber: ci(w) } }] })) },
      orderBy: { createdAt: 'desc' }, take: limit, include: { customer: { select: { name: true } } },
    });
    return rows.map((q) => ({ id: q.id, title: `${q.number} · ${q.customer.name}`, subtitle: `${q.status.toLowerCase()} · ${money(q.totalCents)}`, href: `/quotes/${q.id}` }));
  },
};

export const invoiceSearchProvider: SearchProvider = {
  key: 'invoices', label: 'Invoices', permission: 'invoice.view',
  async search(tx, businessId, query, limit) {
    const rows = await tx.invoice.findMany({
      where: { businessId, AND: words(query).map((w) => ({ OR: [{ number: ci(w) }, { customer: customerMatch(w) }, { vehicle: vehicleMatch(w) }, { job: { jobNumber: ci(w) } }, { quote: { number: ci(w) } }] })) },
      orderBy: { createdAt: 'desc' }, take: limit, include: { customer: { select: { name: true } } },
    });
    return rows.map((i) => ({ id: i.id, title: `${i.number ?? 'Draft invoice'} · ${i.customer.name}`, subtitle: `${i.status.toLowerCase().replace('_', ' ')} · ${money(i.totalCents)}${i.outstandingCents > 0 && i.finalisedAt ? ` · ${money(i.outstandingCents)} due` : ''}`, href: `/invoices/${i.id}` }));
  },
};

export const paymentSearchProvider: SearchProvider = {
  key: 'payments', label: 'Payments & receipts', permission: 'payment.view',
  async search(tx, businessId, query, limit) {
    const rows = await tx.payment.findMany({
      where: {
        businessId,
        AND: words(query).map((w) => ({ OR: [{ number: ci(w) }, { reference: ci(w) }, { providerReference: ci(w) }, { receipt: { number: ci(w) } }, { customer: customerMatch(w) }, { invoice: { number: ci(w) } }] })),
      },
      orderBy: { createdAt: 'desc' }, take: limit, include: { customer: { select: { name: true } }, receipt: { select: { number: true } } },
    });
    return rows.map((p) => ({ id: p.id, title: `${p.number} · ${p.customer.name}`, subtitle: `${money(p.amountCents)} · ${p.method.toLowerCase()}${p.receipt ? ` · ${p.receipt.number}` : ''}`, href: `/payments/${p.id}` }));
  },
};

export const creditNoteSearchProvider: SearchProvider = {
  key: 'credit_notes', label: 'Credit notes', permission: 'credit_note.view',
  async search(tx, businessId, query, limit) {
    const rows = await tx.creditNote.findMany({
      where: { businessId, AND: words(query).map((w) => ({ OR: [{ number: ci(w) }, { customer: customerMatch(w) }, { invoice: { number: ci(w) } }] })) },
      orderBy: { createdAt: 'desc' }, take: limit, include: { customer: { select: { name: true } } },
    });
    return rows.map((c) => ({ id: c.id, title: `${c.number ?? 'Draft credit note'} · ${c.customer.name}`, subtitle: `${c.status.toLowerCase()} · ${money(c.totalCents)}`, href: `/credit-notes/${c.id}` }));
  },
};

export const FINANCE_SEARCH_PROVIDERS = [quoteSearchProvider, invoiceSearchProvider, paymentSearchProvider, creditNoteSearchProvider];

const financeSearchSchema = z.object({ q: z.string().trim().min(2, 'Type at least 2 characters').max(100), limit: z.coerce.number().int().min(1).max(25).default(8) });

/** The finance search box: the same providers as global search, restricted to money records the caller may see. */
export async function searchFinance(ctx: BusinessContext, query: unknown) {
  const { q, limit } = parseOrThrow(financeSearchSchema, query);
  const allowed = FINANCE_SEARCH_PROVIDERS.filter((p) => can(ctx, p.permission));
  return withTenant(ctx.business.id, async (tx) => {
    const groups: { key: string; label: string; items: SearchHit[] }[] = [];
    for (const p of allowed) {
      const items = await p.search(tx, ctx.business.id, q, limit);
      if (items.length) groups.push({ key: p.key, label: p.label, items });
    }
    return groups;
  });
}

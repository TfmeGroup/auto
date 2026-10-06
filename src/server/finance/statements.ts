import { z } from 'zod';
import { withTenant, type Tx } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { formatMoney } from '@/lib/money';
import { todayIso } from '@/lib/tz';
import { parseOrThrow, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { requirePermission } from '@/server/permissions/authorize';
import type { BusinessContext } from '@/server/context';
import { customerSnapshot, isoOf, loadFinanceSettings, businessSnapshot } from './common';
import { loadLogo } from './documents';
import { storeStatementPdf } from '@/server/documents/generator';
import { creditBalance } from './ledger';
import { renderStatementPdf } from './pdf';

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-03-31');
export const statementQuerySchema = z.object({ from: isoDay, to: isoDay });

export interface StatementRow {
  date: string;
  type: 'invoice' | 'payment' | 'credit_note' | 'refund' | 'write_off';
  document: string;
  description: string;
  chargeCents: number;
  creditCents: number;
  balanceCents: number;
}

/**
 * A customer's account for a period. Balance = invoices issued + refunds paid out - payments received - credit notes - write-offs;
 * positive means the customer owes, negative means they are in credit. Applying credit to an invoice moves nothing between
 * "owes" and "paid" so it does not appear. Shows only what the customer is allowed to see (no notes, costs or internal data).
 */
export async function buildStatement(tx: Tx, businessId: string, tz: string, customerId: string, from: string, to: string) {
  const local = (d: Date) => todayIso(tz, d);
  type Ev = { date: string; order: number; type: StatementRow['type']; document: string; description: string; charge: number; credit: number };
  const events: Ev[] = [];

  const invoices = await tx.invoice.findMany({ where: { businessId, customerId, finalisedAt: { not: null }, cancelledAt: null }, select: { number: true, invoiceDate: true, totalCents: true, title: true, writtenOffAt: true, writtenOffCents: true } });
  for (const i of invoices) {
    events.push({ date: isoOf(i.invoiceDate)!, order: 1, type: 'invoice', document: i.number!, description: i.title ?? 'Invoice', charge: i.totalCents, credit: 0 });
    if (i.writtenOffAt && i.writtenOffCents > 0) events.push({ date: local(i.writtenOffAt), order: 5, type: 'write_off', document: i.number!, description: 'Balance written off', charge: 0, credit: i.writtenOffCents });
  }
  const payments = await tx.payment.findMany({ where: { businessId, customerId, status: { in: ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'] } }, include: { invoice: { select: { number: true } }, receipt: { select: { number: true } } } });
  const method = { CARD: 'card', EFT: 'EFT', CASH: 'cash', ONLINE: 'online', OTHER: 'other' } as const;
  for (const p of payments) {
    events.push({ date: local(p.paidAt ?? p.createdAt), order: 2, type: 'payment', document: p.receipt?.number ?? p.number, description: p.purpose === 'DEPOSIT' ? `Deposit (${method[p.method]})` : `Payment (${method[p.method]})${p.invoice?.number ? ` for ${p.invoice.number}` : ''}`, charge: 0, credit: p.amountCents });
  }
  const notes = await tx.creditNote.findMany({ where: { businessId, customerId, status: 'ISSUED' }, include: { invoice: { select: { number: true } } } });
  for (const c of notes) events.push({ date: local(c.issuedAt!), order: 3, type: 'credit_note', document: c.number!, description: `Credit note against ${c.invoice.number ?? 'invoice'}`, charge: 0, credit: c.totalCents });
  const refunds = await tx.refund.findMany({ where: { businessId, customerId } });
  for (const r of refunds) events.push({ date: local(r.refundedAt), order: 4, type: 'refund', document: r.number, description: 'Refund paid to customer', charge: r.amountCents, credit: 0 });

  events.sort((a, b) => (a.date === b.date ? a.order - b.order : a.date < b.date ? -1 : 1));
  const opening = events.filter((e) => e.date < from).reduce((a, e) => a + e.charge - e.credit, 0);
  let bal = opening;
  const rows: StatementRow[] = [];
  for (const e of events.filter((x) => x.date >= from && x.date <= to)) {
    bal += e.charge - e.credit;
    rows.push({ date: e.date, type: e.type, document: e.document, description: e.description, chargeCents: e.charge, creditCents: e.credit, balanceCents: bal });
  }
  return { openingCents: opening, closingCents: bal, rows, chargesCents: rows.reduce((a, r) => a + r.chargeCents, 0), creditsCents: rows.reduce((a, r) => a + r.creditCents, 0) };
}

export async function getStatement(ctx: BusinessContext, customerId: string, query: unknown) {
  requirePermission(ctx, 'invoice.view');
  const id = parseOrThrow(uuidSchema, customerId);
  const q = parseOrThrow(statementQuerySchema, query);
  if (q.to < q.from) throw Errors.validation({ to: 'The end date cannot be before the start date.' });
  return withTenant(ctx.business.id, async (tx) => {
    const customer = await tx.customer.findFirst({ where: { id, businessId: ctx.business.id }, select: { id: true, name: true, customerNumber: true } });
    if (!customer) throw Errors.notFound('Customer');
    const s = await buildStatement(tx, ctx.business.id, ctx.business.timezone, id, q.from, q.to);
    return { customer, from: q.from, to: q.to, ...s, creditAvailableCents: await creditBalance(tx, ctx.business.id, id) };
  });
}

/** The statement as a PDF, filed in the document store against the customer (visible only to people who may see invoices). */
export async function getStatementPdf(ctx: BusinessContext, customerId: string, query: unknown) {
  requirePermission(ctx, 'invoice.view');
  const id = parseOrThrow(uuidSchema, customerId);
  const q = parseOrThrow(statementQuerySchema, query);
  if (q.to < q.from) throw Errors.validation({ to: 'The end date cannot be before the start date.' });
  const model = await withTenant(ctx.business.id, async (tx) => {
    const businessId = ctx.business.id;
    const customer = await tx.customer.findFirst({ where: { id, businessId } });
    if (!customer) throw Errors.notFound('Customer');
    const s = await buildStatement(tx, businessId, ctx.business.timezone, id, q.from, q.to);
    const settings = await loadFinanceSettings(tx, businessId);
    const b = await businessSnapshot(tx, businessId, settings);
    const c = await customerSnapshot(tx, businessId, id);
    await recordAudit(tx, ctx.meta, { action: AuditActions.statementGenerated, businessId, userId: ctx.user.id, resourceType: 'customer', resourceId: id, metadata: { from: q.from, to: q.to, closingCents: s.closingCents } });
    return {
      business: { name: b.name, tradingName: b.tradingName, vatNumber: b.vatNumber, phone: b.phone, email: b.email, address: b.address, currency: b.currency, locale: b.locale, logo: await loadLogo(tx, businessId, b.logoFileId) },
      customer: { name: c.name, lines: [c.address, c.mobile, c.email, `Customer no: ${c.customerNumber}`].filter((v): v is string => !!v) },
      from: q.from, to: q.to, openingCents: s.openingCents, closingCents: s.closingCents, rows: s.rows.map((r) => ({ date: r.date, document: r.document, description: r.description, chargeCents: r.chargeCents, creditCents: r.creditCents, balanceCents: r.balanceCents })),
      creditCents: await creditBalance(tx, businessId, id), footer: b.footer, customerName: customer.name,
    };
  });
  const { customerName, ...pdfModel } = model;
  const pdf = await renderStatementPdf(pdfModel);
  const filename = `statement-${customerName.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40)}-${q.from}-to-${q.to}.pdf`;
  await storeStatementPdf(ctx.business.id, ctx.user.id, id, `${q.from}_${q.to}_${model.closingCents}`, filename, pdf, ctx.meta).catch(() => null);
  return { pdf, filename, closingDisplay: formatMoney(model.closingCents, ctx.business.currency, ctx.business.locale) };
}

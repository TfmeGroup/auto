import { randomUUID } from 'node:crypto';
import { addDays, todayIso } from '@/lib/tz';
import { createInvoice, finaliseInvoice, sendInvoice } from '@/server/finance/invoices';
import { recordPayment } from '@/server/finance/payments';
import { approveQuoteOnBehalf, createQuote, sendQuote } from '@/server/finance/quotes';
import { businessContext, createWorkspace, ownerQuery, type TestWorkspace } from './factory';
import { seedCustomerVehicle } from './workshop';

/** A VAT-registered (or not) workshop with a refreshed context. */
export async function financeWorkspace(name = 'Finance Workshop', opts: { vat?: boolean; vatRateBps?: number } = {}): Promise<TestWorkspace> {
  const ws = await createWorkspace(name);
  if (opts.vat) await setVat(ws, true, opts.vatRateBps ?? 1500);
  return ws;
}

export async function setVat(ws: TestWorkspace, registered: boolean, rateBps = 1500, vatNumber = '4123456789') {
  await ownerQuery('UPDATE businesses SET vat_registered = $2, vat_rate_bps = $3, vat_number = $4 WHERE id = $1', [ws.businessId, registered, rateBps, registered ? vatNumber : null]);
  ws.ctx = await businessContext(ws.owner);
}

export const L = (description: string, qty: number, priceCents: number, over: Record<string, unknown> = {}) => ({
  lineType: 'PART', description, quantityMilli: Math.round(qty * 1000), unitPriceCents: priceCents, ...over,
});

export const key = () => `k-${randomUUID()}`;

export async function party(ws: TestWorkspace, label = 'Fin') {
  return seedCustomerVehicle(ws, label);
}

/** An issued invoice for a new customer (or the given one). Returns ids and the number. */
export async function issuedInvoice(
  ws: TestWorkspace,
  opts: { customerId?: string; vehicleId?: string; lines?: Record<string, unknown>[]; send?: boolean; dueInDays?: number; internalNotes?: string; terms?: string } = {},
) {
  let customerId = opts.customerId;
  let vehicleId = opts.vehicleId;
  if (!customerId) {
    const p = await party(ws);
    customerId = p.customer.id;
    vehicleId = p.vehicle.id;
  }
  const draft = await createInvoice(ws.ctx, {
    customerId, vehicleId, lines: opts.lines ?? [L('Brake pads', 2, 50_000), L('Labour', 1, 45_000, { lineType: 'LABOUR' })],
    ...(opts.internalNotes ? { internalNotes: opts.internalNotes } : {}), ...(opts.terms ? { terms: opts.terms } : {}),
  });
  const fin = await finaliseInvoice(ws.ctx, draft.id);
  // Simulate time passing: move the issue/due dates (the invoice is locked by a trigger, so lift it for this one statement).
  if (opts.dueInDays !== undefined) await backdateInvoice(draft.id, opts.dueInDays);
  const sent = opts.send ? await sendInvoice(ws.ctx, draft.id) : null;
  return { id: draft.id, number: fin.number, customerId: customerId!, vehicleId: vehicleId ?? null, customerUrl: sent?.customerUrl ?? null };
}

export async function pay(ws: TestWorkspace, invoiceId: string, amountCents: number, method: 'CARD' | 'EFT' | 'CASH' | 'ONLINE' | 'OTHER' = 'EFT', extra: Record<string, unknown> = {}) {
  return recordPayment(ws.ctx, { invoiceId, amountCents, method, idempotencyKey: key(), ...extra });
}

/** A sent quote for a new customer; returns the customer link token. */
export async function sentQuote(ws: TestWorkspace, opts: { customerId?: string; vehicleId?: string; jobId?: string; lines?: Record<string, unknown>[] } = {}) {
  let customerId = opts.customerId;
  let vehicleId = opts.vehicleId;
  if (!customerId) {
    const p = await party(ws, 'Quo');
    customerId = p.customer.id;
    vehicleId = p.vehicle.id;
  }
  const q = await createQuote(ws.ctx, { customerId, vehicleId, jobId: opts.jobId, lines: opts.lines ?? [L('Timing belt kit', 1, 120_000), L('Labour', 3, 45_000, { lineType: 'LABOUR' })] });
  const s = await sendQuote(ws.ctx, q.id);
  return { id: q.id, number: q.number, token: s.customerUrl.split('/q/')[1]!, customerId: customerId!, vehicleId: vehicleId ?? null };
}

export async function approvedQuote(ws: TestWorkspace, opts: Parameters<typeof sentQuote>[1] = {}) {
  const q = await sentQuote(ws, opts);
  await approveQuoteOnBehalf(ws.ctx, q.id, { method: 'PHONE', version: 1 });
  return q;
}

export const tokenOf = (url: string) => url.split('/').pop()!;

/** The text drawn in a PDF made by pdf-lib (streams are deflated and text is hex-encoded): enough to assert on content. */
export function pdfText(pdf: Buffer): string {
  const { inflateSync } = require('node:zlib') as typeof import('node:zlib');
  const raw = pdf.toString('latin1');
  const out: string[] = [];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    let body: string;
    try { body = inflateSync(Buffer.from(m[1]!, 'latin1')).toString('latin1'); } catch { continue; }
    for (const h of body.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) out.push(Buffer.from(h[1]!, 'hex').toString('latin1'));
  }
  return out.join('\n');
}

/** Make an issued invoice due `dueInDays` from today (negative = already late), as if time had passed. Test-only: lifts the lock trigger briefly. */
export async function backdateInvoice(invoiceId: string, dueInDays: number) {
  // Business-calendar dates (not UTC): between midnight UTC and midnight Johannesburg the two differ by a day.
  const today = todayIso('Africa/Johannesburg');
  const due = addDays(today, dueInDays);
  const issued = addDays(today, Math.min(dueInDays, 0) - 14);
  await ownerQuery('ALTER TABLE invoices DISABLE TRIGGER invoices_frozen');
  try {
    await ownerQuery('UPDATE invoices SET due_date = $2, invoice_date = $3 WHERE id = $1', [invoiceId, due, issued]);
  } finally {
    await ownerQuery('ALTER TABLE invoices ENABLE TRIGGER invoices_frozen');
  }
}

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import { formatMoney } from '@/lib/money';

/**
 * PDF rendering for quotes, invoices, credit notes, receipts and statements. A pure function of the stored data it is
 * given (it reads nothing else), drawn as real text and tables: not a screenshot. Standard Helvetica is used, so text is
 * limited to Latin-1 characters; anything else prints as "?" rather than breaking the document.
 */

export interface PdfBusiness {
  name: string;
  tradingName?: string | null;
  legalName?: string | null;
  registrationNumber?: string | null;
  vatNumber?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  address?: string | null;
  currency: string;
  locale: string;
  logo?: { bytes: Uint8Array; kind: 'png' | 'jpg' } | null;
}

export interface PdfLine {
  description: string;
  sku?: string | null;
  quantityMilli: number;
  unit?: string | null;
  unitPriceCents: number;
  discountCents: number;
  vatCents: number;
  totalCents: number;
}

export interface PdfTotal {
  label: string;
  cents: number;
  bold?: boolean;
  /** Draw in the accent colour (e.g. amount outstanding). */
  accent?: boolean;
}

export interface PdfDocumentModel {
  /** "TAX INVOICE", "QUOTE", "CREDIT NOTE" */
  title: string;
  number: string;
  /** Right-hand facts: Date, Due date, Valid until, Status ... */
  facts: [string, string][];
  /** A short stamp such as PAID or DRAFT. */
  stamp?: string | null;
  business: PdfBusiness;
  billTo: { name: string; lines: string[] };
  /** Heading above the party block ("BILL TO" by default; a purchase order says "SUPPLIER"). */
  billToLabel?: string;
  /** Vehicle, job, quote references etc. */
  references: [string, string][];
  lines: PdfLine[];
  totals: PdfTotal[];
  vatLabel?: string;
  sections: { heading: string; text: string }[];
  footer?: string | null;
  /** 'simple' shows only description and amount (receipts). */
  variant?: 'items' | 'simple';
}

export const W = 595.28;
export const H = 841.89;
export const M = 42;
export const INK = rgb(0.1, 0.1, 0.12);
export const MUTED = rgb(0.4, 0.42, 0.46);
export const LINE = rgb(0.85, 0.86, 0.88);
export const ACCENT = rgb(0.06, 0.3, 0.5);

/** Latin-1 only: map common typographic characters, replace the rest. */
export function safe(text: string | null | undefined): string {
  return (text ?? '')
    .replace(/[–—−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/[   ]/g, ' ')
    .replace(/€/g, 'EUR ')
    .replace(/[\r\t]/g, ' ')
    .replace(/[^\n\x20-\x7E\xA0-\xFF]/g, '?');
}

const qty = (milli: number) => (milli % 1000 === 0 ? String(milli / 1000) : (milli / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, ''));

export class Canvas {
  page!: PDFPage;
  y = 0;
  pages: PDFPage[] = [];
  constructor(readonly doc: PDFDocument, readonly font: PDFFont, readonly bold: PDFFont) {
    this.newPage();
  }
  newPage() {
    this.page = this.doc.addPage([W, H]);
    this.pages.push(this.page);
    this.y = H - M;
  }
  ensure(h: number) {
    if (this.y - h < M + 28) this.newPage();
  }
  text(s: string, x: number, size = 9, opts: { bold?: boolean; color?: ReturnType<typeof rgb>; align?: 'left' | 'right'; maxWidth?: number } = {}) {
    const f = opts.bold ? this.bold : this.font;
    const t = safe(s);
    const w = f.widthOfTextAtSize(t, size);
    const px = opts.align === 'right' ? x - w : x;
    this.page.drawText(t, { x: px, y: this.y, size, font: f, color: opts.color ?? INK });
  }
  wrap(s: string, width: number, size: number, bold = false): string[] {
    const f = bold ? this.bold : this.font;
    const out: string[] = [];
    for (const para of safe(s).split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const test = line ? `${line} ${word}` : word;
        if (f.widthOfTextAtSize(test, size) <= width) line = test;
        else {
          if (line) out.push(line);
          // A single word wider than the column is broken up.
          let rest = word;
          while (f.widthOfTextAtSize(rest, size) > width) {
            let n = rest.length;
            while (n > 1 && f.widthOfTextAtSize(rest.slice(0, n), size) > width) n--;
            out.push(rest.slice(0, n));
            rest = rest.slice(n);
          }
          line = rest;
        }
      }
      out.push(line);
    }
    return out;
  }
  rule(x1 = M, x2 = W - M, color = LINE) {
    this.page.drawLine({ start: { x: x1, y: this.y }, end: { x: x2, y: this.y }, thickness: 0.6, color });
  }
}

export async function embedLogo(doc: PDFDocument, logo: PdfBusiness['logo']): Promise<PDFImage | null> {
  if (!logo) return null;
  try {
    return logo.kind === 'png' ? await doc.embedPng(logo.bytes) : await doc.embedJpg(logo.bytes);
  } catch {
    return null; // a logo that cannot be embedded never blocks a financial document
  }
}

export async function renderDocumentPdf(m: PdfDocumentModel): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${m.title} ${m.number}`);
  doc.setProducer('TFME Auto');
  doc.setCreator('TFME Auto');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const c = new Canvas(doc, font, bold);
  const money = (cents: number) => formatMoney(cents, m.business.currency, m.business.locale);
  const b = m.business;

  // ── header: logo + business, title + facts ──
  const top = c.y;
  let leftBottom = top;
  const logo = await embedLogo(doc, b.logo);
  const x = M;
  if (logo) {
    const s = Math.min(130 / logo.width, 56 / logo.height, 1);
    c.page.drawImage(logo, { x: M, y: top - logo.height * s, width: logo.width * s, height: logo.height * s });
    leftBottom = top - logo.height * s - 8;
  }
  c.y = leftBottom;
  c.text(b.tradingName ?? b.name, x, 12, { bold: true });
  c.y -= 13;
  const bizLines = [b.legalName && b.legalName !== (b.tradingName ?? b.name) ? b.legalName : null, b.registrationNumber ? `Reg: ${b.registrationNumber}` : null, b.vatNumber ? `VAT no: ${b.vatNumber}` : null, b.address, b.phone, b.email, b.website].filter((v): v is string => !!v);
  for (const l of bizLines) for (const w of c.wrap(l, 250, 8.5)) { c.text(w, x, 8.5, { color: MUTED }); c.y -= 11; }
  const leftEnd = c.y;

  c.y = top;
  c.text(m.title, W - M, 20, { bold: true, color: ACCENT, align: 'right' });
  c.y -= 18;
  c.text(m.number, W - M, 11, { bold: true, align: 'right' });
  c.y -= 15;
  for (const [k, v] of m.facts) { c.text(`${k}:  ${v}`, W - M, 9, { align: 'right' }); c.y -= 12; }
  if (m.stamp) {
    c.y -= 4;
    c.text(m.stamp, W - M, 14, { bold: true, color: m.stamp === 'PAID' ? rgb(0.1, 0.5, 0.25) : rgb(0.7, 0.2, 0.15), align: 'right' });
    c.y -= 14;
  }
  c.y = Math.min(leftEnd, c.y) - 10;
  c.rule();
  c.y -= 16;

  // ── parties ──
  const colTop = c.y;
  c.text(m.billToLabel ?? 'BILL TO', M, 8, { bold: true, color: MUTED });
  c.y -= 12;
  c.text(m.billTo.name, M, 10.5, { bold: true });
  c.y -= 12;
  for (const l of m.billTo.lines) for (const w of c.wrap(l, 240, 9)) { c.text(w, M, 9); c.y -= 11.5; }
  const leftY = c.y;
  c.y = colTop;
  if (m.references.length) {
    c.text('DETAILS', 320, 8, { bold: true, color: MUTED });
    c.y -= 12;
    for (const [k, v] of m.references) {
      const wrapped = c.wrap(v, 170, 9);
      c.text(k, 320, 9, { color: MUTED });
      wrapped.forEach((w, i) => { c.text(w, 390, 9); if (i < wrapped.length - 1) c.y -= 11; });
      c.y -= 12;
    }
  }
  c.y = Math.min(leftY, c.y) - 10;

  // ── lines table ──
  const simple = m.variant === 'simple';
  const cols = { desc: M, qty: 330, price: 392, disc: 448, vat: 498, total: W - M };
  const descWidth = simple ? W - 2 * M - 110 : cols.qty - cols.desc - 40;
  const header = () => {
    c.ensure(30);
    c.page.drawRectangle({ x: M, y: c.y - 5, width: W - 2 * M, height: 17, color: rgb(0.94, 0.95, 0.97) });
    c.text('Description', cols.desc + 4, 8.5, { bold: true });
    if (!simple) {
      c.text('Qty', cols.qty, 8.5, { bold: true, align: 'right' });
      c.text('Unit price', cols.price + 40, 8.5, { bold: true, align: 'right' });
      c.text('Discount', cols.disc + 40, 8.5, { bold: true, align: 'right' });
      c.text('VAT', cols.vat + 30, 8.5, { bold: true, align: 'right' });
    }
    c.text(simple ? 'Amount' : 'Total', cols.total, 8.5, { bold: true, align: 'right' });
    c.y -= 20;
  };
  header();
  for (const l of m.lines) {
    const desc = c.wrap(l.description, descWidth, 9);
    const sku = l.sku ? c.wrap(`Ref: ${l.sku}`, descWidth, 8) : [];
    const rows = desc.length + sku.length;
    c.ensure(rows * 11.5 + 8);
    if (c.y > H - M - 5) header();
    const y0 = c.y;
    desc.forEach((d, i) => { c.y = y0 - i * 11.5; c.text(d, cols.desc + 4, 9); });
    sku.forEach((d, i) => { c.y = y0 - (desc.length + i) * 11.5; c.text(d, cols.desc + 4, 8, { color: MUTED }); });
    c.y = y0;
    if (!simple) {
      c.text(`${qty(l.quantityMilli)}${l.unit ? ` ${l.unit}` : ''}`, cols.qty, 9, { align: 'right' });
      c.text(money(l.unitPriceCents), cols.price + 40, 9, { align: 'right' });
      c.text(l.discountCents ? money(l.discountCents) : '-', cols.disc + 40, 9, { align: 'right' });
      c.text(l.vatCents ? money(l.vatCents) : '-', cols.vat + 30, 9, { align: 'right' });
    }
    c.text(money(l.totalCents), cols.total, 9, { align: 'right' });
    c.y = y0 - rows * 11.5 - 3;
    c.rule();
    c.y -= 7;
  }
  if (m.lines.length === 0) { c.text('No lines', cols.desc + 4, 9, { color: MUTED }); c.y -= 16; }

  // ── totals ──
  c.ensure(m.totals.length * 15 + 20);
  c.y -= 4;
  for (const t of m.totals) {
    c.text(t.label, 440, t.bold ? 10 : 9, { bold: t.bold, align: 'right' });
    c.text(money(t.cents), W - M, t.bold ? 10 : 9, { bold: t.bold, align: 'right', color: t.accent ? ACCENT : INK });
    c.y -= t.bold ? 16 : 13;
  }
  c.y -= 8;

  // ── notes, terms, payment instructions ──
  for (const s of m.sections) {
    const body = c.wrap(s.text, W - 2 * M, 8.5);
    c.ensure(18 + Math.min(body.length, 3) * 11);
    c.text(s.heading.toUpperCase(), M, 8, { bold: true, color: MUTED });
    c.y -= 12;
    for (const line of body) { c.ensure(12); c.text(line, M, 8.5); c.y -= 11; }
    c.y -= 8;
  }

  // ── footer + page numbers ──
  const total = c.pages.length;
  c.pages.forEach((p, i) => {
    const f = safe(m.footer ?? '');
    if (f) p.drawText(f.slice(0, 120), { x: M, y: 30, size: 8, font, color: MUTED });
    const label = `${m.number}  -  Page ${i + 1} of ${total}`;
    p.drawText(label, { x: W - M - font.widthOfTextAtSize(label, 8), y: 30, size: 8, font, color: MUTED });
  });

  return Buffer.from(await doc.save());
}

// ───────── Statement ─────────

export interface PdfStatementModel {
  business: PdfBusiness;
  customer: { name: string; lines: string[] };
  from: string;
  to: string;
  openingCents: number;
  closingCents: number;
  rows: { date: string; document: string; description: string; chargeCents: number; creditCents: number; balanceCents: number }[];
  /** Credit the customer holds at the end of the period, if any. */
  creditCents: number;
  footer?: string | null;
}

export async function renderStatementPdf(m: PdfStatementModel): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Statement ${m.customer.name} ${m.from} to ${m.to}`);
  doc.setProducer('TFME Auto');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const c = new Canvas(doc, font, bold);
  const money = (cents: number) => formatMoney(cents, m.business.currency, m.business.locale);
  const b = m.business;
  const logo = await embedLogo(doc, b.logo);
  const top = c.y;
  if (logo) {
    const s = Math.min(130 / logo.width, 56 / logo.height, 1);
    c.page.drawImage(logo, { x: M, y: top - logo.height * s, width: logo.width * s, height: logo.height * s });
    c.y = top - logo.height * s - 8;
  }
  c.text(b.tradingName ?? b.name, M, 12, { bold: true });
  c.y -= 13;
  for (const l of [b.vatNumber ? `VAT no: ${b.vatNumber}` : null, b.address, b.phone, b.email].filter((v): v is string => !!v)) for (const w of c.wrap(l, 250, 8.5)) { c.text(w, M, 8.5, { color: MUTED }); c.y -= 11; }
  const leftEnd = c.y;
  c.y = top;
  c.text('STATEMENT', W - M, 20, { bold: true, color: ACCENT, align: 'right' });
  c.y -= 18;
  c.text(`${m.from} to ${m.to}`, W - M, 10, { align: 'right' });
  c.y = Math.min(leftEnd, c.y - 10) - 8;
  c.rule();
  c.y -= 16;
  c.text('CUSTOMER', M, 8, { bold: true, color: MUTED });
  c.y -= 12;
  c.text(m.customer.name, M, 10.5, { bold: true });
  c.y -= 12;
  for (const l of m.customer.lines) for (const w of c.wrap(l, 300, 9)) { c.text(w, M, 9); c.y -= 11.5; }
  c.y -= 8;

  const x = { date: M + 4, doc: 112, desc: 190, charge: 420, credit: 478, bal: W - M };
  const header = () => {
    c.ensure(30);
    c.page.drawRectangle({ x: M, y: c.y - 5, width: W - 2 * M, height: 17, color: rgb(0.94, 0.95, 0.97) });
    c.text('Date', x.date, 8.5, { bold: true });
    c.text('Document', x.doc, 8.5, { bold: true });
    c.text('Description', x.desc, 8.5, { bold: true });
    c.text('Charges', x.charge + 46, 8.5, { bold: true, align: 'right' });
    c.text('Credits', x.credit + 46, 8.5, { bold: true, align: 'right' });
    c.text('Balance', x.bal, 8.5, { bold: true, align: 'right' });
    c.y -= 20;
  };
  header();
  c.text('Opening balance', x.desc, 9, { bold: true });
  c.text(money(m.openingCents), x.bal, 9, { bold: true, align: 'right' });
  c.y -= 15;
  for (const r of m.rows) {
    const desc = c.wrap(r.description, 220, 8.5);
    c.ensure(desc.length * 11 + 8);
    const y0 = c.y;
    c.text(r.date, x.date, 8.5);
    c.text(r.document, x.doc, 8.5);
    desc.forEach((d, i) => { c.y = y0 - i * 11; c.text(d, x.desc, 8.5); });
    c.y = y0;
    if (r.chargeCents) c.text(money(r.chargeCents), x.charge + 46, 8.5, { align: 'right' });
    if (r.creditCents) c.text(money(r.creditCents), x.credit + 46, 8.5, { align: 'right' });
    c.text(money(r.balanceCents), x.bal, 8.5, { align: 'right' });
    c.y = y0 - desc.length * 11 - 2;
    c.rule();
    c.y -= 7;
  }
  if (m.rows.length === 0) { c.text('No activity in this period', x.desc, 9, { color: MUTED }); c.y -= 16; }
  c.ensure(50);
  c.y -= 6;
  c.text(m.closingCents > 0 ? 'Balance due' : m.closingCents < 0 ? 'Account in credit' : 'Balance', 440, 11, { bold: true, align: 'right' });
  c.text(money(Math.abs(m.closingCents)), W - M, 11, { bold: true, align: 'right', color: ACCENT });
  c.y -= 16;
  if (m.creditCents > 0) { c.text('Credit available to use on future invoices', 440, 9, { align: 'right' }); c.text(money(m.creditCents), W - M, 9, { align: 'right' }); c.y -= 14; }
  const total = c.pages.length;
  c.pages.forEach((p, i) => {
    if (m.footer) p.drawText(safe(m.footer).slice(0, 120), { x: M, y: 30, size: 8, font, color: MUTED });
    const label = `Statement  -  Page ${i + 1} of ${total}`;
    p.drawText(label, { x: W - M - font.widthOfTextAtSize(label, 8), y: 30, size: 8, font, color: MUTED });
  });
  return Buffer.from(await doc.save());
}

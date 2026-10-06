import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import sharp from 'sharp';
import { Canvas, M, W, ACCENT, INK, LINE, MUTED, embedLogo, safe, type PdfBusiness } from '@/server/finance/pdf';

/**
 * PDF layout for narrative documents: the vehicle inspection report and the job summary. Like the financial PDFs it is a pure
 * function of the stored data it is handed, drawn as real text: every sentence in it was written by a person at the workshop or is
 * a fixed label. Nothing is generated from the data by guesswork.
 */
export type ReportStatus = 'GOOD' | 'ATTENTION' | 'CRITICAL' | 'NOT_CHECKED' | 'INFO';

export type ReportSection =
  | { heading: string; kind: 'text'; text: string }
  | { heading: string; kind: 'facts'; rows: [string, string][] }
  | { heading: string; kind: 'table'; columns: { label: string; width: number; align?: 'left' | 'right' }[]; rows: string[][] }
  | { heading: string; kind: 'items'; items: { label: string; status: ReportStatus; detail?: string | null }[] }
  | { heading: string; kind: 'photos'; photos: { bytes: Buffer; caption: string }[] };

export interface ReportModel {
  title: string;
  number: string;
  facts: [string, string][];
  business: PdfBusiness;
  sections: ReportSection[];
  footer?: string | null;
}

// Status is always written as a word as well as coloured, so the report reads correctly in black and white.
const STATUS_LABEL: Record<ReportStatus, string> = { GOOD: 'GOOD', ATTENTION: 'NEEDS ATTENTION', CRITICAL: 'CRITICAL', NOT_CHECKED: 'NOT CHECKED', INFO: '' };
const STATUS_COLOR = { GOOD: rgb(0.1, 0.5, 0.25), ATTENTION: rgb(0.75, 0.45, 0.05), CRITICAL: rgb(0.75, 0.15, 0.12), NOT_CHECKED: MUTED, INFO: INK };

/** Photos are re-encoded as modest JPEGs so a report with a dozen pictures stays a reasonable size and every format embeds. */
export async function photoForPdf(data: Buffer): Promise<Buffer | null> {
  try {
    return await sharp(data, { limitInputPixels: 60_000_000, failOn: 'error' }).rotate().resize({ width: 900, height: 900, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 78 }).toBuffer();
  } catch {
    return null;
  }
}

export async function renderReportPdf(m: ReportModel): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${m.title} ${m.number}`);
  doc.setProducer('TFME Auto');
  doc.setCreator('TFME Auto');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const c = new Canvas(doc, font, bold);
  const b = m.business;

  // header
  const top = c.y;
  let leftBottom = top;
  const logo = await embedLogo(doc, b.logo);
  if (logo) {
    const s = Math.min(130 / logo.width, 56 / logo.height, 1);
    c.page.drawImage(logo, { x: M, y: top - logo.height * s, width: logo.width * s, height: logo.height * s });
    leftBottom = top - logo.height * s - 8;
  }
  c.y = leftBottom;
  c.text(b.tradingName ?? b.name, M, 12, { bold: true });
  c.y -= 13;
  for (const l of [b.address, b.phone, b.email, b.website].filter((v): v is string => !!v)) for (const w of c.wrap(l, 250, 8.5)) { c.text(w, M, 8.5, { color: MUTED }); c.y -= 11; }
  const leftEnd = c.y;
  c.y = top;
  c.text(m.title, W - M, 18, { bold: true, color: ACCENT, align: 'right' });
  c.y -= 17;
  c.text(m.number, W - M, 11, { bold: true, align: 'right' });
  c.y -= 15;
  for (const [k, v] of m.facts) { c.text(`${k}:  ${v}`, W - M, 9, { align: 'right' }); c.y -= 12; }
  c.y = Math.min(leftEnd, c.y) - 8;
  c.rule();
  c.y -= 16;

  const heading = (t: string) => {
    c.ensure(40);
    c.text(t.toUpperCase(), M, 8.5, { bold: true, color: ACCENT });
    c.y -= 5;
    c.rule();
    c.y -= 13;
  };

  for (const s of m.sections) {
    heading(s.heading);
    if (s.kind === 'text') {
      for (const line of c.wrap(s.text, W - 2 * M, 9.5)) { c.ensure(14); c.text(line, M, 9.5); c.y -= 12.5; }
    } else if (s.kind === 'facts') {
      for (const [k, v] of s.rows) {
        const lines = c.wrap(v, W - 2 * M - 130, 9.5);
        c.ensure(lines.length * 12.5 + 2);
        c.text(k, M, 9.5, { color: MUTED });
        lines.forEach((l, i) => { c.text(l, M + 130, 9.5); if (i < lines.length - 1) c.y -= 12.5; });
        c.y -= 12.5;
      }
    } else if (s.kind === 'table') {
      const total = s.columns.reduce((n, col) => n + col.width, 0);
      const widths = s.columns.map((col) => ((W - 2 * M) * col.width) / total);
      const xs = widths.map((_, i) => M + widths.slice(0, i).reduce((n, w) => n + w, 0));
      c.ensure(24);
      c.page.drawRectangle({ x: M, y: c.y - 5, width: W - 2 * M, height: 16, color: rgb(0.94, 0.95, 0.97) });
      s.columns.forEach((col, i) => c.text(col.label, col.align === 'right' ? xs[i]! + widths[i]! - 4 : xs[i]! + 4, 8.5, { bold: true, align: col.align }));
      c.y -= 19;
      for (const row of s.rows) {
        const wrapped = row.map((cell, i) => c.wrap(cell, widths[i]! - 8, 9));
        const n = Math.max(...wrapped.map((w) => w.length));
        c.ensure(n * 11.5 + 8);
        const y0 = c.y;
        wrapped.forEach((lines, i) => lines.forEach((l, j) => { c.y = y0 - j * 11.5; c.text(l, s.columns[i]!.align === 'right' ? xs[i]! + widths[i]! - 4 : xs[i]! + 4, 9, { align: s.columns[i]!.align }); }));
        c.y = y0 - n * 11.5 - 3;
        c.rule(M, W - M, LINE);
        c.y -= 7;
      }
      if (s.rows.length === 0) { c.text('None recorded', M + 4, 9, { color: MUTED }); c.y -= 14; }
    } else if (s.kind === 'items') {
      for (const it of s.items) {
        const detail = it.detail ? c.wrap(it.detail, W - 2 * M - 150, 9) : [];
        c.ensure(Math.max(1, detail.length) * 12 + 6);
        c.text(it.label, M, 9.5);
        if (STATUS_LABEL[it.status]) c.text(STATUS_LABEL[it.status], M + 190, 9, { bold: true, color: STATUS_COLOR[it.status] });
        const y0 = c.y;
        detail.forEach((l, i) => { c.y = y0 - i * 11.5; c.text(l, M + 300, 9, { color: MUTED }); });
        c.y = y0 - Math.max(1, detail.length) * 12 - 2;
      }
      if (s.items.length === 0) { c.text('Nothing recorded', M, 9, { color: MUTED }); c.y -= 14; }
    } else if (s.kind === 'photos') {
      const cell = (W - 2 * M - 16) / 2;
      let col = 0;
      let rowTop = c.y;
      let rowHeight = 0;
      for (const p of s.photos) {
        let img;
        try { img = await doc.embedJpg(p.bytes); } catch { continue; }
        const scale = Math.min(cell / img.width, 170 / img.height, 1);
        const w = img.width * scale;
        const h = img.height * scale;
        if (col === 0) { c.ensure(h + 30); rowTop = c.y; rowHeight = 0; }
        const x = M + col * (cell + 16);
        c.page.drawImage(img, { x, y: rowTop - h, width: w, height: h });
        const cap = c.wrap(p.caption, cell, 8);
        const savedY = c.y;
        c.y = rowTop - h - 10;
        cap.slice(0, 2).forEach((l, i) => { c.y = rowTop - h - 10 - i * 10; c.text(l, x, 8, { color: MUTED }); });
        c.y = savedY;
        rowHeight = Math.max(rowHeight, h + 10 + Math.min(cap.length, 2) * 10 + 8);
        col++;
        if (col === 2) { c.y = rowTop - rowHeight; col = 0; }
      }
      if (col === 1) c.y = rowTop - rowHeight;
      if (s.photos.length === 0) { c.text('No photos', M, 9, { color: MUTED }); c.y -= 14; }
    }
    c.y -= 12;
  }

  const total = c.pages.length;
  c.pages.forEach((p, i) => {
    const f = safe(m.footer ?? '');
    if (f) p.drawText(f.slice(0, 120), { x: M, y: 30, size: 8, font, color: MUTED });
    const label = `${m.number}  -  Page ${i + 1} of ${total}`;
    p.drawText(label, { x: W - M - font.widthOfTextAtSize(label, 8), y: 30, size: 8, font, color: MUTED });
  });
  return Buffer.from(await doc.save());
}

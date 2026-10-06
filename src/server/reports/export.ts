import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { z } from 'zod';
import { Errors } from '@/lib/errors';
import { toCsv, toXlsx, type Cell, type Column as TabularColumn } from '@/lib/tabular';
import { parseOrThrow } from '@/lib/validation';
import { withTenant } from '@/server/db/client';
import { AuditActions, recordAudit } from '@/server/audit/audit';
import { requirePermission } from '@/server/permissions/authorize';
import { consume } from '@/server/security/rate-limit';
import { safe } from '@/server/finance/pdf';
import type { BusinessContext } from '@/server/context';
import { REPORTS, reportDef } from './registry';
import { assertCanRun, execute } from './run';
import type { ColType, Column, Metric, ReportCategory, ReportDef, ReportResult } from './types';

export type ExportFormat = 'CSV' | 'XLSX' | 'PDF';

/** Financial reports are exported only by people who may export financial data; stock and purchasing ones by people who may export inventory. */
export function exportPermission(category: ReportCategory) {
  return category === 'financial' || category === 'profitability' || category === 'vat' ? ('finance.export' as const) : category === 'inventory' || category === 'suppliers' ? ('inventory.export' as const) : null;
}

export const exportSchema = z.object({ format: z.enum(['CSV', 'XLSX', 'PDF']).default('CSV'), columns: z.string().max(400).optional() });

const MIME: Record<ExportFormat, string> = { CSV: 'text/csv; charset=utf-8', XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', PDF: 'application/pdf' };

/** Plain, unlocalised value for a machine reader: numbers stay numbers (money in cents is written as a two-decimal amount by the writer). */
function cellOf(v: unknown, type: ColType, tz: string): Cell {
  if (v === null || v === undefined || v === '') return null;
  if (type === 'datetime') return new Intl.DateTimeFormat('sv-SE', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }).format(new Date(String(v)));
  if (typeof v === 'number') return v;
  return String(v);
}

const kindOf = (t: ColType): TabularColumn['kind'] => (t === 'money' ? 'money' : t === 'int' || t === 'pct' || t === 'hours' ? 'int' : 'text');

export function selectColumns(result: ReportResult, requested?: string): Column[] {
  if (!requested) return result.columns;
  const want = requested.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = want.find((k) => !result.columns.some((c) => c.key === k));
  if (bad) throw Errors.validation({ columns: `"${bad}" is not a column of this report.` });
  return want.map((k) => result.columns.find((c) => c.key === k)!);
}

export function resultToCsv(result: ReportResult, columns: Column[], tz: string): Buffer {
  return toCsv(columns.map((c) => ({ header: c.label, kind: kindOf(c.type) })), result.rows.map((r) => columns.map((c) => cellOf(r[c.key], c.type, tz))));
}

export function resultToXlsx(result: ReportResult, columns: Column[], tz: string): Buffer {
  return toXlsx(result.title, columns.map((c) => ({ header: c.label, kind: kindOf(c.type) })), result.rows.map((r) => columns.map((c) => cellOf(r[c.key], c.type, tz))));
}

// ───────── display formatting (PDF) ─────────

const ascii = (s: string) => s.replace(/[  ]/g, ' ');
function shown(v: unknown, type: ColType, r: ReportResult): string {
  if (v === null || v === undefined || v === '') return '';
  if (type === 'money') return ascii(new Intl.NumberFormat(r.locale, { style: 'currency', currency: r.currency }).format(Number(v) / 100));
  if (type === 'pct') return `${v}%`;
  if (type === 'hours') return `${v} h`;
  if (type === 'datetime') return new Intl.DateTimeFormat('sv-SE', { timeZone: r.range?.timezone ?? 'UTC', dateStyle: 'short', timeStyle: 'short' }).format(new Date(String(v)));
  return String(v);
}

const metricText = (m: Metric, r: ReportResult) => (m.value === null ? 'n/a' : shown(m.value, m.type, r));

export async function resultToPdf(result: ReportResult, columns: Column[], businessName: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${result.title} - ${businessName}`);
  doc.setProducer('TFME Auto');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const PW = 841.89, PH = 595.28, M = 36;
  const ink = rgb(0.1, 0.1, 0.12), muted = rgb(0.4, 0.42, 0.46), line = rgb(0.85, 0.86, 0.88), accent = rgb(0.06, 0.3, 0.5);
  const pages: ReturnType<typeof doc.addPage>[] = [];
  let page = doc.addPage([PW, PH]);
  pages.push(page);
  let y = PH - M;
  const fit = (t: string, size: number, width: number, f = font) => { let s = safe(t); if (f.widthOfTextAtSize(s, size) <= width) return s; while (s.length > 1 && f.widthOfTextAtSize(`${s}...`, size) > width) s = s.slice(0, -1); return `${s}...`; };
  const draw = (t: string, x: number, size: number, o: { bold?: boolean; color?: ReturnType<typeof rgb>; right?: number } = {}) => {
    const f = o.bold ? bold : font;
    const s = safe(t);
    page.drawText(s, { x: o.right !== undefined ? o.right - f.widthOfTextAtSize(s, size) : x, y, size, font: f, color: o.color ?? ink });
  };
  const newPage = () => { page = doc.addPage([PW, PH]); pages.push(page); y = PH - M; };

  draw(businessName, M, 9, { color: muted });
  y -= 22;
  draw(result.title, M, 18, { bold: true, color: accent });
  y -= 15;
  if (result.range) { draw(`${result.range.from} to ${result.range.to}  (${result.range.timezone})`, M, 9, { color: muted }); y -= 12; }
  const filters = Object.entries(result.appliedFilters).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('   ');
  if (filters) { draw(fit(`Filters: ${filters}`, 8, PW - 2 * M), M, 8, { color: muted }); y -= 11; }
  draw(`Generated ${result.generatedAt.slice(0, 16).replace('T', ' ')} UTC`, M, 8, { color: muted });
  y -= 18;

  // summary as a two-column block of "label  value"
  const colW = (PW - 2 * M) / 3;
  let i = 0;
  for (const m of result.summary) {
    const cx = M + (i % 3) * colW;
    if (i % 3 === 0 && i > 0) y -= 24;
    const top = y;
    page.drawText(fit(m.label, 7.5, colW - 10), { x: cx, y: top, size: 7.5, font, color: muted });
    page.drawText(fit(metricText(m, result), 11, colW - 10, bold), { x: cx, y: top - 12, size: 11, font: bold, color: ink });
    i++;
  }
  if (result.summary.length) y -= 34;

  // table
  const widths = columns.map((c) => (c.type === 'money' || c.type === 'int' || c.type === 'pct' || c.type === 'hours' ? 1 : c.type === 'date' ? 1.1 : 2));
  const total = widths.reduce((a, b) => a + b, 0);
  const px = widths.map((w) => ((PW - 2 * M) * w) / total);
  const right = (c: Column) => c.type === 'money' || c.type === 'int' || c.type === 'pct' || c.type === 'hours';
  const head = () => {
    let x = M;
    columns.forEach((c, k) => { const s = fit(c.label, 7.5, px[k]! - 6, bold); page.drawText(s, { x: right(c) ? x + px[k]! - 4 - bold.widthOfTextAtSize(s, 7.5) : x + 2, y, size: 7.5, font: bold, color: muted }); x += px[k]!; });
    y -= 4;
    page.drawLine({ start: { x: M, y }, end: { x: PW - M, y }, thickness: 0.6, color: line });
    y -= 11;
  };
  head();
  for (const r of result.rows) {
    if (y < M + 20) { newPage(); head(); }
    let x = M;
    columns.forEach((c, k) => {
      const s = fit(shown(r[c.key], c.type, result), 8, px[k]! - 6);
      page.drawText(s, { x: right(c) ? x + px[k]! - 4 - font.widthOfTextAtSize(s, 8) : x + 2, y, size: 8, font, color: ink });
      x += px[k]!;
    });
    y -= 12;
  }
  if (result.rows.length === 0) { draw('No rows for these filters.', M, 9, { color: muted }); y -= 14; }
  const note = result.notes[0];
  if (note) { y -= 6; if (y < M + 20) newPage(); for (const n of result.notes) { page.drawText(fit(n, 7.5, PW - 2 * M), { x: M, y, size: 7.5, font, color: muted }); y -= 10; if (y < M) newPage(); } }
  pages.forEach((p, n) => p.drawText(`Page ${n + 1} of ${pages.length}`, { x: PW - M - 50, y: 18, size: 7.5, font, color: muted }));
  return Buffer.from(await doc.save());
}

// ───────── the export itself ─────────

export interface ExportedReport { data: Buffer; filename: string; mime: string; rows: number; format: ExportFormat }

/** Build the file bytes for an already-run result (shared by the HTTP export and scheduled delivery). */
export async function renderExport(ctx: Pick<BusinessContext, 'business'>, result: ReportResult, format: ExportFormat, columns: Column[]): Promise<ExportedReport> {
  const tz = ctx.business.timezone;
  const data = format === 'CSV' ? resultToCsv(result, columns, tz) : format === 'XLSX' ? resultToXlsx(result, columns, tz) : await resultToPdf(result, columns, ctx.business.name);
  const stamp = (result.range ? `${result.range.from}_${result.range.to}` : result.generatedAt.slice(0, 10)).replace(/[^0-9_-]/g, '');
  return { data, filename: `${result.key}-${stamp}.${format.toLowerCase()}`, mime: MIME[format], rows: result.rows.length, format };
}

/** An export of a standard report, honouring filters, columns, location access and permissions; always audited. */
export async function exportReport(ctx: BusinessContext, key: string, query: Record<string, unknown>): Promise<ExportedReport> {
  const def = reportDef(key);
  if (!def) throw Errors.notFound('Report');
  const { format, columns: wanted, ...rest } = query as { format?: string; columns?: string } & Record<string, unknown>;
  const opts = parseOrThrow(exportSchema, { format, columns: wanted });
  return exportDef(ctx, def, rest, opts.format, opts.columns);
}

export async function exportDef(ctx: BusinessContext, def: ReportDef, query: unknown, format: ExportFormat, wantedColumns?: string): Promise<ExportedReport> {
  assertCanRun(ctx, def);
  requirePermission(ctx, 'report.export');
  const extra = def.exportNeeds !== undefined ? def.exportNeeds : exportPermission(def.category);
  if (extra) requirePermission(ctx, extra);
  if (def.noExport) throw Errors.forbidden('This report cannot be exported.');
  await consume({ key: `report-export:${ctx.business.id}`, limit: 60, windowSec: 3600 });
  const result = await execute(ctx, def, query, { all: true });
  const columns = selectColumns(result, wantedColumns);
  const out = await renderExport(ctx, result, format, columns);
  await withTenant(ctx.business.id, (tx) =>
    recordAudit(tx, ctx.meta, {
      action: AuditActions.reportExported, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'report', resourceId: def.key,
      metadata: { report: def.key, format, rows: out.rows, columns: columns.map((c) => c.key), range: result.range, filters: result.appliedFilters, sensitive: !!def.sensitive || !!extra },
    }),
  );
  return out;
}

void REPORTS;

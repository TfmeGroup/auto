import clsx from 'clsx';
import Link from 'next/link';
import { Alert, Badge, Card, EmptyState, Pagination } from '@/components/ui';
import { Kpi } from '@/components/finance/shared';
import { formatDate, formatDateTime } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import type { ChartSpec, ColType, Column, Metric, ReportResult } from '@/server/reports/types';

/**
 * How a report is drawn. Everything here is a server component: the numbers arrive already calculated and permission-filtered, and this only
 * lays them out. Charts always come with their data as a real table (the text alternative), every bar carries its value as text, and
 * status is always a word, so nothing depends on colour alone.
 */

export interface Fmt { currency: string; locale: string; timezone: string }

export function cell(v: unknown, type: ColType, f: Fmt): string {
  if (v === null || v === undefined || v === '') return '—';
  switch (type) {
    case 'money': return formatMoney(Number(v), f.currency, f.locale);
    case 'pct': return `${Number(v).toLocaleString(f.locale, { maximumFractionDigits: 1 })}%`;
    case 'hours': return `${Number(v).toLocaleString(f.locale, { maximumFractionDigits: 1 })} h`;
    case 'int': return Number(v).toLocaleString(f.locale);
    case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? formatDate(`${v}T12:00:00Z`, 'UTC', f.locale) : String(v);
    case 'datetime': return formatDateTime(String(v), f.timezone, f.locale);
    default: return String(v);
  }
}

const num = (t: ColType) => t === 'money' || t === 'int' || t === 'pct' || t === 'hours';

// ───────────── summary tiles ─────────────

export function Summary({ metrics, f }: { metrics: Metric[]; f: Fmt }) {
  if (!metrics.length) return null;
  return (
    <section aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {metrics.map((m) => <Kpi key={m.key} label={m.label} value={m.value === null ? 'Not enough data' : cell(m.value, m.type, f)} hint={m.hint} tone={m.tone} />)}
    </section>
  );
}

// ───────────── charts ─────────────

const fmtUnit = (v: number | null, unit: ChartSpec['unit'], f: Fmt) => (v === null ? '—' : unit === 'money' ? formatMoney(v, f.currency, f.locale) : unit === 'pct' ? `${v}%` : unit === 'hours' ? `${v} h` : v.toLocaleString(f.locale));
const compact = (v: number, unit: ChartSpec['unit'], f: Fmt) => (unit === 'money' ? new Intl.NumberFormat(f.locale, { notation: 'compact', maximumFractionDigits: 1 }).format(v / 100) : new Intl.NumberFormat(f.locale, { notation: 'compact', maximumFractionDigits: 1 }).format(v));

/** Distinct fills (solid, hatched, dotted) so series differ by pattern as well as by colour. */
const SERIES_FILL = ['var(--color-brand-600)', 'url(#hatch)', 'url(#dots)'];
const SERIES_STROKE = ['var(--color-brand-600)', 'var(--color-ok)', 'var(--color-warn)'];
const DASH = ['', '6 3', '2 3'];

export function ReportChart({ chart, f }: { chart: ChartSpec; f: Fmt }) {
  const n = chart.x.length;
  if (n === 0) return null;
  const all = chart.series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const max = Math.max(1, ...all);
  const min = Math.min(0, ...all);
  const W = Math.max(320, Math.min(900, n * 46 + 70));
  const H = 220;
  const pad = { l: 46, r: 8, t: 12, b: 56 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const y = (v: number) => pad.t + ih - ((v - min) / (max - min || 1)) * ih;
  const slot = iw / n;
  const bw = Math.max(4, Math.min(34, (slot * 0.8) / chart.series.length));
  const labelEvery = Math.max(1, Math.ceil(n / 12));
  const summary = `${chart.title}. ${chart.series.map((s) => `${s.name}: ${s.values.map((v, i) => `${chart.x[i]} ${fmtUnit(v, chart.unit, f)}`).slice(0, 6).join('; ')}${n > 6 ? '; and more, see the table' : ''}`).join('. ')}`;
  const ticks = [0, 0.5, 1].map((t) => min + (max - min) * t);
  return (
    <figure className="rounded-xl border border-line bg-surface p-3">
      <figcaption className="mb-2 text-sm font-semibold">{chart.title}</figcaption>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={summary} className="max-w-none">
          <defs>
            <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="var(--color-ok-bg)" /><line x1="0" y1="0" x2="0" y2="6" stroke="var(--color-ok)" strokeWidth="3" /></pattern>
            <pattern id="dots" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="var(--color-warn-bg)" /><circle cx="3" cy="3" r="1.5" fill="var(--color-warn)" /></pattern>
          </defs>
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeWidth="1" />
              <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" fontSize="10" fill="var(--color-muted)">{compact(t, chart.unit, f)}</text>
            </g>
          ))}
          {chart.kind === 'bar' && chart.series.map((s, si) => s.values.map((v, i) => v === null ? null : (
            <g key={`${si}-${i}`}>
              <rect x={pad.l + i * slot + (slot - bw * chart.series.length) / 2 + si * bw} y={Math.min(y(v), y(0))} width={bw - 1} height={Math.max(1, Math.abs(y(v) - y(0)))} fill={SERIES_FILL[si % 3]} stroke={SERIES_STROKE[si % 3]} strokeWidth="1">
                <title>{`${chart.x[i]} — ${s.name}: ${fmtUnit(v, chart.unit, f)}`}</title>
              </rect>
              {n <= 8 && chart.series.length === 1 && <text x={pad.l + i * slot + slot / 2} y={Math.min(y(v), y(0)) - 3} textAnchor="middle" fontSize="10" fill="var(--color-ink)">{compact(v, chart.unit, f)}</text>}
            </g>
          )))}
          {chart.kind === 'line' && chart.series.map((s, si) => {
            const pts = s.values.map((v, i) => (v === null ? null : [pad.l + i * slot + slot / 2, y(v)] as const));
            const path = pts.filter((p): p is readonly [number, number] => !!p).map((p) => p.join(',')).join(' ');
            return (
              <g key={si}>
                <polyline points={path} fill="none" stroke={SERIES_STROKE[si % 3]} strokeWidth="2" strokeDasharray={DASH[si % 3]} />
                {pts.map((p, i) => p && (si % 2 === 0
                  ? <circle key={i} cx={p[0]} cy={p[1]} r="3" fill={SERIES_STROKE[si % 3]}><title>{`${chart.x[i]} — ${s.name}: ${fmtUnit(s.values[i]!, chart.unit, f)}`}</title></circle>
                  : <rect key={i} x={p[0] - 3} y={p[1] - 3} width="6" height="6" fill={SERIES_STROKE[si % 3]}><title>{`${chart.x[i]} — ${s.name}: ${fmtUnit(s.values[i]!, chart.unit, f)}`}</title></rect>))}
              </g>
            );
          })}
          {chart.x.map((x, i) => (i % labelEvery === 0 ? (
            <text key={i} x={pad.l + i * slot + slot / 2} y={H - pad.b + 14} textAnchor="end" fontSize="10" fill="var(--color-muted)" transform={`rotate(-35 ${pad.l + i * slot + slot / 2} ${H - pad.b + 14})`}>{x.length > 16 ? `${x.slice(0, 15)}…` : x}</text>
          ) : null))}
        </svg>
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Chart key">
        {chart.series.map((s, si) => (
          <li key={s.name} className="inline-flex items-center gap-1.5">
            <svg width="16" height="10" aria-hidden><rect width="16" height="10" fill={chart.kind === 'bar' ? SERIES_FILL[si % 3] : 'none'} stroke={SERIES_STROKE[si % 3]} strokeDasharray={chart.kind === 'line' ? DASH[si % 3] : ''} /></svg>
            {s.name}
          </li>
        ))}
      </ul>
      <details className="mt-2">
        <summary className="min-h-11 cursor-pointer text-sm font-medium leading-[2.75rem] text-brand-700">View this chart as a table</summary>
        <div className="max-w-full overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{chart.title}</caption>
            <thead><tr><th scope="col" className="py-1.5 pr-3 font-medium">{' '}</th>{chart.series.map((s) => <th key={s.name} scope="col" className="px-2 py-1.5 text-right font-medium">{s.name}</th>)}</tr></thead>
            <tbody className="divide-y divide-line">
              {chart.x.map((x, i) => <tr key={i}><th scope="row" className="py-1.5 pr-3 font-normal">{x}</th>{chart.series.map((s) => <td key={s.name} className="px-2 py-1.5 text-right tabular-nums">{fmtUnit(s.values[i] ?? null, chart.unit, f)}</td>)}</tr>)}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

// ───────────── table / cards ─────────────

function Cell({ c, row, f }: { c: Column; row: Record<string, unknown>; f: Fmt }) {
  const text = cell(row[c.key], c.type, f);
  if (c.link && row[c.link.idKey]) return <Link className="font-medium text-brand-700 hover:underline" href={`${c.link.path}/${String(row[c.link.idKey])}`}>{text}</Link>;
  if (c.type === 'status' && text !== '—') return <Badge>{text}</Badge>;
  return <>{text}</>;
}

export function ReportTable({ result, f }: { result: ReportResult; f: Fmt }) {
  const { columns, rows } = result;
  if (rows.length === 0) return <EmptyState title="Nothing to show for these filters">Change the date range or filters. A report only ever shows records that exist.</EmptyState>;
  const [first, ...rest] = columns;
  return (
    <>
      {/* Phones: one card per row (a wide table would force sideways scrolling). */}
      <ul className="grid gap-2 md:hidden" aria-label={`${result.title} rows`}>
        {rows.map((r, i) => (
          <li key={i}>
            <Card>
              <p className="text-sm font-semibold"><Cell c={first!} row={r} f={f} /></p>
              <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                {rest.map((c) => (
                  <div key={c.key} className={clsx('min-w-0', c.type === 'text' && 'col-span-2')}>
                    <dt className="text-xs text-muted">{c.label}</dt>
                    <dd className={clsx('break-words', num(c.type) && 'tabular-nums')}><Cell c={c} row={r} f={f} /></dd>
                  </div>
                ))}
              </dl>
            </Card>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto rounded-xl border border-line bg-surface md:block">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{result.title}</caption>
          <thead className="border-b border-line bg-canvas text-xs uppercase tracking-wide text-muted">
            <tr>{columns.map((c) => <th key={c.key} scope="col" className={clsx('px-3 py-2.5 font-medium', num(c.type) && 'text-right')}>{c.label}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r, i) => (
              <tr key={i}>{columns.map((c) => <td key={c.key} className={clsx('px-3 py-2.5', num(c.type) ? 'text-right tabular-nums' : 'whitespace-nowrap')}><Cell c={c} row={r} f={f} /></td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function ReportBody({ result, f, hrefFor }: { result: ReportResult; f: Fmt; hrefFor: (page: number) => string }) {
  const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));
  return (
    <div className="space-y-4">
      <Summary metrics={result.summary} f={f} />
      {result.charts.length > 0 && <div className="grid gap-4 lg:grid-cols-2">{result.charts.map((c) => <ReportChart key={c.title} chart={c} f={f} />)}</div>}
      <ReportTable result={result} f={f} />
      {result.paged && <Pagination page={result.page} totalPages={totalPages} total={result.total} hrefFor={hrefFor} />}
      {result.notes.length > 0 && (
        <Card><h2 className="mb-1 text-sm font-semibold">How to read this report</h2><ul className="list-disc space-y-1 pl-5 text-sm text-muted">{result.notes.map((n) => <li key={n}>{n}</li>)}</ul></Card>
      )}
      <p className="text-xs text-muted">Generated {formatDateTime(result.generatedAt, f.timezone, f.locale)}{result.range ? ` · ${result.range.from} to ${result.range.to} (${result.range.timezone})` : ''}. Figures come straight from your records.</p>
    </div>
  );
}

export { Alert };

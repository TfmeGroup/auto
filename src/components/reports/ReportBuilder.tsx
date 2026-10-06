'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { Alert, Badge, Button, Card, Field, Input, Select, Textarea } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';
import { formatMoney } from '@/lib/money';
import { randToCents } from '@/components/workshop/money-input';

interface FieldInfo { key: string; label: string; type: string; values: { value: string; label: string }[] | null; numeric: boolean; groupable: boolean }
interface SourceInfo { key: string; label: string; description: string; dateField: string; locked: boolean; hasLocation: boolean; fields: FieldInfo[] }
interface Filter { field: string; op: string; value: string; value2: string }
interface Metric { fn: string; field: string }
interface Config {
  source: string; fields: string[]; filters: { field: string; op: string; value?: string | number | boolean; values?: (string | number)[] }[]; groupBy: { field: string; grain?: string }[];
  metrics: { fn: string; field?: string }[]; sort: { column: string; dir: string }[]; dateRange: { preset?: string; from?: string; to?: string } | null; locationIds: string[];
}
interface Result { columns: { key: string; label: string; type: string }[]; rows: Record<string, unknown>[]; total: number; page: number; pageSize: number; notes: string[] }

const OPS: Record<string, [string, string][]> = {
  text: [['contains', 'contains'], ['eq', 'is'], ['neq', 'is not'], ['isEmpty', 'is empty'], ['notEmpty', 'is not empty']],
  status: [['eq', 'is'], ['neq', 'is not']],
  num: [['eq', '='], ['neq', '≠'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['between', 'between'], ['isEmpty', 'is empty'], ['notEmpty', 'is not empty']],
  date: [['eq', 'on'], ['gte', 'on or after'], ['lte', 'on or before'], ['between', 'between'], ['isEmpty', 'is empty'], ['notEmpty', 'is not empty']],
  bool: [['eq', 'is']],
};
const opsFor = (t: string) => OPS[t === 'int' || t === 'money' || t === 'pct' || t === 'hours' ? 'num' : t === 'date' || t === 'datetime' ? 'date' : t === 'status' ? 'status' : t === 'bool' ? 'bool' : 'text']!;
const FNS: [string, string][] = [['count', 'Count of rows'], ['sum', 'Total of'], ['avg', 'Average of'], ['min', 'Lowest'], ['max', 'Highest'], ['count_distinct', 'Number of different']];
const PRESETS: [string, string][] = [['', 'All dates'], ['TODAY', 'Today'], ['YESTERDAY', 'Yesterday'], ['THIS_WEEK', 'This week'], ['LAST_WEEK', 'Last week'], ['THIS_MONTH', 'This month'], ['LAST_MONTH', 'Last month'], ['THIS_QUARTER', 'This quarter'], ['LAST_QUARTER', 'Last quarter'], ['THIS_YEAR', 'This year'], ['LAST_YEAR', 'Last year'], ['CUSTOM', 'Custom range']];

/**
 * The custom report builder. It only ever offers the approved sources and fields it is given (already limited to what this person may see),
 * sends a configuration (never SQL) to the server, and the server re-validates every part of it. Nothing typed here is trusted.
 */
export function ReportBuilder({ sources, roles, members, locations, canShare, canBusinessWide, currency, locale, initial }: {
  sources: SourceInfo[];
  roles: { value: string; label: string }[];
  members: { value: string; label: string }[];
  locations: { value: string; label: string }[];
  canShare: boolean;
  canBusinessWide: boolean;
  currency: string;
  locale: string;
  initial?: { id: string; name: string; description: string | null; visibility: string; sharedRoleIds: string[]; sharedMembershipIds: string[]; config: Config };
}) {
  const router = useRouter();
  const first = sources.find((s) => !s.locked) ?? sources[0];
  const c0 = initial?.config;
  const [source, setSource] = useState(c0?.source ?? first?.key ?? '');
  const [mode, setMode] = useState<'list' | 'summary'>(c0 && (c0.groupBy.length || c0.metrics.length) ? 'summary' : 'list');
  const [fields, setFields] = useState<string[]>(c0?.fields ?? []);
  const [groupBy, setGroupBy] = useState<{ field: string; grain: string }[]>((c0?.groupBy ?? []).map((g) => ({ field: g.field, grain: g.grain ?? '' })));
  const [metrics, setMetrics] = useState<Metric[]>((c0?.metrics ?? []).map((m) => ({ fn: m.fn, field: m.field ?? '' })));
  const [filters, setFilters] = useState<Filter[]>((c0?.filters ?? []).map((f) => ({ field: f.field, op: f.op, value: f.value === undefined ? (f.values?.[0] !== undefined ? String(f.values[0]) : '') : String(f.value), value2: f.values?.[1] !== undefined ? String(f.values[1]) : '' })));
  const [sortCol, setSortCol] = useState(c0?.sort?.[0]?.column ?? '');
  const [sortDir, setSortDir] = useState(c0?.sort?.[0]?.dir ?? 'asc');
  const [preset, setPreset] = useState(c0?.dateRange?.preset ?? '');
  const [from, setFrom] = useState(c0?.dateRange?.from ?? '');
  const [to, setTo] = useState(c0?.dateRange?.to ?? '');
  const [loc, setLoc] = useState(c0?.locationIds?.[0] ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [visibility, setVisibility] = useState(initial?.visibility ?? 'PRIVATE');
  const [sharedRoles, setSharedRoles] = useState<string[]>(initial?.sharedRoleIds ?? []);
  const [sharedMembers, setSharedMembers] = useState<string[]>(initial?.sharedMembershipIds ?? []);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'run' | 'save' | null>(null);
  const [saved, setSaved] = useState(false);

  const src = sources.find((s) => s.key === source);
  const fieldOf = (k: string) => src?.fields.find((f) => f.key === k);
  const toggle = (list: string[], v: string, set: (x: string[]) => void) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const config = useMemo((): Config => {
    const cfg: Config = { source, fields: mode === 'list' ? fields : [], filters: [], groupBy: [], metrics: [], sort: [], dateRange: null, locationIds: loc ? [loc] : [] };
    for (const f of filters) {
      const info = fieldOf(f.field);
      if (!info || !f.op) continue;
      const conv = (v: string): string | number | boolean => (info.type === 'money' ? Number(randToCents(v)) : info.type === 'int' || info.type === 'pct' || info.type === 'hours' ? Number(v) : info.type === 'bool' ? v === 'true' : v);
      if (f.op === 'isEmpty' || f.op === 'notEmpty') cfg.filters.push({ field: f.field, op: f.op });
      else if (f.op === 'between') cfg.filters.push({ field: f.field, op: f.op, values: [conv(f.value), conv(f.value2)] as (string | number)[] });
      else cfg.filters.push({ field: f.field, op: f.op, value: conv(f.value) });
    }
    if (mode === 'summary') {
      cfg.groupBy = groupBy.filter((g) => g.field).map((g) => ({ field: g.field, ...(g.grain ? { grain: g.grain } : {}) }));
      cfg.metrics = metrics.filter((m) => m.fn === 'count' || m.field).map((m) => ({ fn: m.fn, ...(m.fn === 'count' ? {} : { field: m.field }) }));
      if (cfg.groupBy.length === 0 && cfg.metrics.length === 0) cfg.metrics = [{ fn: 'count' }];
    }
    if (sortCol) cfg.sort = [{ column: sortCol, dir: sortDir }];
    if (preset) cfg.dateRange = preset === 'CUSTOM' ? { preset, from, to } : { preset };
    return cfg;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, mode, fields, filters, groupBy, metrics, sortCol, sortDir, preset, from, to, loc]);

  const sortOptions = mode === 'list' ? fields.map((k) => ({ value: k, label: fieldOf(k)?.label ?? k })) : [
    ...groupBy.filter((g) => g.field).map((g) => ({ value: g.grain ? `${g.field}:${g.grain}` : g.field, label: `${fieldOf(g.field)?.label ?? g.field}${g.grain ? ` (${g.grain})` : ''}` })),
    ...(metrics.length ? metrics : [{ fn: 'count', field: '' }]).map((m, i) => ({ value: `metric:${i}`, label: `${FNS.find((x) => x[0] === m.fn)?.[1] ?? m.fn} ${m.field ? fieldOf(m.field)?.label ?? '' : ''}`.trim() })),
  ];

  async function call<T>(kind: 'run' | 'save', fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(kind); setError(null);
    try { return await fn(); } catch (e) { setError(e instanceof ApiError ? (Object.keys(e.fields).length ? Object.values(e.fields).join(' ') : e.message) : 'We could not reach the server.'); } finally { setBusy(null); }
  }
  const run = () => call('run', async () => { const r = await api<Result>('/api/v1/reports/custom/run', { body: { name: name || 'Preview', config, page: 1, pageSize: 25 } }); setResult(r.data); });
  const save = () => call('save', async () => {
    const body = { kind: 'CUSTOM', name, description: description || null, config, visibility, sharedRoleIds: visibility === 'SHARED' ? sharedRoles : [], sharedMembershipIds: visibility === 'SHARED' ? sharedMembers : [] };
    if (initial) await api(`/api/v1/reports/saved/${initial.id}`, { method: 'PATCH', body: { name, description: description || null, config, visibility, sharedRoleIds: body.sharedRoleIds, sharedMembershipIds: body.sharedMembershipIds } });
    else await api('/api/v1/reports/saved', { body });
    setSaved(true);
    router.push('/reports/saved');
    router.refresh();
  });

  const cellText = (v: unknown, type: string) => (v === null || v === undefined || v === '' ? '—' : type === 'money' ? formatMoney(Number(v), currency, locale) : type === 'pct' ? `${v}%` : type === 'hours' ? `${v} h` : typeof v === 'number' ? v.toLocaleString(locale) : String(v));
  const filterValueInput = (f: Filter, i: number, key: 'value' | 'value2') => {
    const info = fieldOf(f.field);
    const set = (v: string) => setFilters(filters.map((x, j) => (j === i ? { ...x, [key]: v } : x)));
    const label = `${info?.label ?? 'Value'}${key === 'value2' ? ' (to)' : ''}`;
    if (info?.values) return <Select aria-label={label} value={f[key]} onChange={(e) => set(e.target.value)}><option value="">Choose…</option>{info.values.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>;
    if (info?.type === 'bool') return <Select aria-label={label} value={f[key]} onChange={(e) => set(e.target.value)}><option value="">Choose…</option><option value="true">Yes</option><option value="false">No</option></Select>;
    if (info?.type === 'date') return <Input aria-label={label} type="date" value={f[key]} onChange={(e) => set(e.target.value)} />;
    return <Input aria-label={label} inputMode={info?.type === 'money' ? 'decimal' : info?.type === 'text' ? 'text' : 'numeric'} value={f[key]} onChange={(e) => set(e.target.value)} placeholder={info?.type === 'money' ? 'e.g. 450.00' : ''} />;
  };

  if (sources.length === 0) return <Alert tone="warn">Your role does not give you access to any data a custom report can use.</Alert>;

  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <Card>
        <h2 className="mb-3 text-base font-semibold">1. What is the report about?</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Data source" htmlFor="rb-source">
            <Select id="rb-source" value={source} onChange={(e) => { setSource(e.target.value); setFields([]); setFilters([]); setGroupBy([]); setMetrics([]); setSortCol(''); setResult(null); }}>
              {sources.map((s) => <option key={s.key} value={s.key} disabled={s.locked}>{s.label}{s.locked ? ' (higher plan)' : ''}</option>)}
            </Select>
          </Field>
          <div className="self-end text-sm text-muted">{src?.description}</div>
        </div>
        <fieldset className="mt-3"><legend className="mb-1 text-sm font-medium">Shape</legend>
          <div className="flex flex-wrap gap-4">
            {(['list', 'summary'] as const).map((m) => (
              <label key={m} className="inline-flex min-h-11 items-center gap-2 text-sm"><input type="radio" name="rb-mode" className="size-5" checked={mode === m} onChange={() => { setMode(m); setSortCol(''); }} />{m === 'list' ? 'A list of records' : 'A summary (group and total)'}</label>
            ))}
          </div>
        </fieldset>
      </Card>

      {mode === 'list' ? (
        <Card>
          <h2 className="mb-1 text-base font-semibold">2. Which fields?</h2>
          <p className="mb-2 text-xs text-muted">Only fields you are allowed to see are listed.</p>
          <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
            {src?.fields.map((f) => (
              <label key={f.key} className="flex min-h-11 items-center gap-2 rounded-lg border border-line px-3 text-sm"><input type="checkbox" className="size-5" checked={fields.includes(f.key)} onChange={() => toggle(fields, f.key, setFields)} />{f.label}</label>
            ))}
          </div>
        </Card>
      ) : (
        <Card>
          <h2 className="mb-2 text-base font-semibold">2. Group and total</h2>
          <p className="mb-1 text-sm font-medium">Group by (up to two)</p>
          <div className="space-y-2">
            {groupBy.map((g, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[1fr_9rem_auto]">
                <Select aria-label={`Group by ${i + 1}`} value={g.field} onChange={(e) => setGroupBy(groupBy.map((x, j) => (j === i ? { field: e.target.value, grain: '' } : x)))}><option value="">Choose a field…</option>{src?.fields.filter((f) => f.groupable).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</Select>
                <Select aria-label={`Date grouping ${i + 1}`} value={g.grain} disabled={fieldOf(g.field)?.type !== 'date'} onChange={(e) => setGroupBy(groupBy.map((x, j) => (j === i ? { ...x, grain: e.target.value } : x)))}><option value="">Exact date</option><option value="day">By day</option><option value="week">By week</option><option value="month">By month</option></Select>
                <Button type="button" variant="ghost" onClick={() => setGroupBy(groupBy.filter((_, j) => j !== i))}>Remove</Button>
              </div>
            ))}
            {groupBy.length < 2 && <Button type="button" variant="secondary" onClick={() => setGroupBy([...groupBy, { field: '', grain: '' }])}>Add a grouping</Button>}
          </div>
          <p className="mb-1 mt-4 text-sm font-medium">Totals</p>
          <div className="space-y-2">
            {metrics.map((m, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[11rem_1fr_auto]">
                <Select aria-label={`Calculation ${i + 1}`} value={m.fn} onChange={(e) => setMetrics(metrics.map((x, j) => (j === i ? { ...x, fn: e.target.value } : x)))}>{FNS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
                <Select aria-label={`Field ${i + 1}`} value={m.field} disabled={m.fn === 'count'} onChange={(e) => setMetrics(metrics.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))}><option value="">{m.fn === 'count' ? 'Rows' : 'Choose a field…'}</option>{src?.fields.filter((f) => (m.fn === 'count_distinct' ? true : m.fn === 'min' || m.fn === 'max' ? f.numeric || f.type === 'date' : f.numeric)).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</Select>
                <Button type="button" variant="ghost" onClick={() => setMetrics(metrics.filter((_, j) => j !== i))}>Remove</Button>
              </div>
            ))}
            {metrics.length < 6 && <Button type="button" variant="secondary" onClick={() => setMetrics([...metrics, { fn: 'count', field: '' }])}>Add a total</Button>}
          </div>
        </Card>
      )}

      <Card>
        <h2 className="mb-2 text-base font-semibold">3. Filters, dates and order</h2>
        <div className="space-y-2">
          {filters.map((f, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[1fr_9rem_1fr_auto]">
              <Select aria-label={`Filter field ${i + 1}`} value={f.field} onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { field: e.target.value, op: opsFor(fieldOf(e.target.value)?.type ?? 'text')[0]![0], value: '', value2: '' } : x)))}><option value="">Choose a field…</option>{src?.fields.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</Select>
              <Select aria-label={`Filter condition ${i + 1}`} value={f.op} onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)))}>{opsFor(fieldOf(f.field)?.type ?? 'text').map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
              <div className={clsx('grid gap-2', f.op === 'between' && 'grid-cols-2')}>
                {f.op !== 'isEmpty' && f.op !== 'notEmpty' && filterValueInput(f, i, 'value')}
                {f.op === 'between' && filterValueInput(f, i, 'value2')}
              </div>
              <Button type="button" variant="ghost" onClick={() => setFilters(filters.filter((_, j) => j !== i))}>Remove</Button>
            </div>
          ))}
          {filters.length < 10 && <Button type="button" variant="secondary" onClick={() => setFilters([...filters, { field: '', op: 'eq', value: '', value2: '' }])}>Add a filter</Button>}
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={`Date range (by ${fieldOf(src?.dateField ?? '')?.label.toLowerCase() ?? 'date'})`} htmlFor="rb-preset"><Select id="rb-preset" value={preset} onChange={(e) => setPreset(e.target.value)}>{PRESETS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
          {preset === 'CUSTOM' && (<><Field label="From" htmlFor="rb-from"><Input id="rb-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field><Field label="To" htmlFor="rb-to"><Input id="rb-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field></>)}
          {src?.hasLocation && locations.length > 1 && <Field label="Location" htmlFor="rb-loc"><Select id="rb-loc" value={loc} onChange={(e) => setLoc(e.target.value)}><option value="">All my locations</option>{locations.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}</Select></Field>}
          <Field label="Sort by" htmlFor="rb-sort"><Select id="rb-sort" value={sortCol} onChange={(e) => setSortCol(e.target.value)}><option value="">Default</option>{sortOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></Field>
          {sortCol && <Field label="Direction" htmlFor="rb-dir"><Select id="rb-dir" value={sortDir} onChange={(e) => setSortDir(e.target.value)}><option value="asc">Lowest first</option><option value="desc">Highest first</option></Select></Field>}
        </div>
        <div className="mt-4"><Button type="button" onClick={() => void run()} loading={busy === 'run'}>Run report</Button></div>
      </Card>

      {result && (
        <Card>
          <h2 className="mb-2 text-base font-semibold">Result <span className="text-sm font-normal text-muted">({result.total.toLocaleString(locale)} row{result.total === 1 ? '' : 's'}{result.total > result.rows.length ? `, first ${result.rows.length} shown` : ''})</span></h2>
          {result.rows.length === 0 ? <p className="text-sm text-muted">No rows match.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Report result</caption>
                <thead className="border-b border-line text-xs uppercase tracking-wide text-muted"><tr>{result.columns.map((c) => <th key={c.key} scope="col" className={clsx('px-2 py-2 font-medium', ['money', 'int', 'pct', 'hours'].includes(c.type) && 'text-right')}>{c.label}</th>)}</tr></thead>
                <tbody className="divide-y divide-line">{result.rows.map((r, i) => <tr key={i}>{result.columns.map((c) => <td key={c.key} className={clsx('px-2 py-2', ['money', 'int', 'pct', 'hours'].includes(c.type) ? 'text-right tabular-nums' : 'whitespace-nowrap')}>{cellText(r[c.key], c.type)}</td>)}</tr>)}</tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      <Card>
        <h2 className="mb-2 text-base font-semibold">4. Save it</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Report name" htmlFor="rb-name"><Input id="rb-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Who can use it" htmlFor="rb-vis">
            <Select id="rb-vis" value={visibility} onChange={(e) => setVisibility(e.target.value)}>
              <option value="PRIVATE">Only me</option>
              {canShare && <option value="SHARED">Selected people and roles</option>}
              {canBusinessWide && <option value="BUSINESS">Everyone in the business</option>}
            </Select>
          </Field>
        </div>
        <div className="mt-3"><Field label="Description (optional)" htmlFor="rb-desc"><Textarea id="rb-desc" rows={2} maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} /></Field></div>
        {visibility === 'SHARED' && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <fieldset><legend className="mb-1 text-sm font-medium">Roles</legend>{roles.map((r) => <label key={r.value} className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="size-5" checked={sharedRoles.includes(r.value)} onChange={() => toggle(sharedRoles, r.value, setSharedRoles)} />{r.label}</label>)}</fieldset>
            <fieldset><legend className="mb-1 text-sm font-medium">People</legend>{members.map((m) => <label key={m.value} className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="size-5" checked={sharedMembers.includes(m.value)} onChange={() => toggle(sharedMembers, m.value, setSharedMembers)} />{m.label}</label>)}</fieldset>
          </div>
        )}
        {visibility !== 'PRIVATE' && <p className="mt-2 text-xs text-muted"><Badge tone="brand">Note</Badge> Sharing a report shares the recipe, not the data. Each person runs it with their own permissions, and it will not run for someone who cannot see every field in it.</p>}
        <div className="mt-4 flex gap-2"><Button type="button" onClick={() => void save()} loading={busy === 'save'} disabled={!name.trim() || saved}>{initial ? 'Save changes' : 'Save report'}</Button></div>
      </Card>
    </div>
  );
}

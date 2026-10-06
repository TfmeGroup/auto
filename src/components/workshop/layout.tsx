import clsx from 'clsx';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Card, EmptyState, Pagination } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { listTimeline } from '@/server/activity/service';
import type { BusinessContext } from '@/server/context';

/** Link-based tabs: the active tab is a URL, so each tab loads only its own data and can be bookmarked or shared. */
export function Tabs({ tabs, active, hrefFor }: { tabs: { key: string; label: string }[]; active: string; hrefFor: (key: string) => string }) {
  return (
    <nav aria-label="Sections" className="-mx-3 mb-4 flex gap-1 overflow-x-auto border-b border-line px-3 sm:mx-0 sm:px-0">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={hrefFor(t.key)}
          aria-current={t.key === active ? 'page' : undefined}
          className={clsx('-mb-px inline-flex min-h-11 shrink-0 items-center border-b-2 px-3 text-sm font-medium', t.key === active ? 'border-brand-600 text-brand-700' : 'border-transparent text-muted hover:text-ink')}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

export function Row({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-2 text-sm sm:grid-cols-4">
      <dt className="text-muted">{label}</dt>
      <dd className="col-span-2 break-words sm:col-span-3">{children || <span className="text-muted">—</span>}</dd>
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border border-line bg-canvas px-3 py-2.5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-0.5 text-lg font-bold tabular-nums">{value ?? '—'}</p>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

/** For parts of the product built by a later module: says so plainly instead of showing a fake or empty widget. */
export function NotYet({ title, children }: { title: string; children: ReactNode }) {
  return (
    <EmptyState title={title}>
      {children}
    </EmptyState>
  );
}

export const kmFmt = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n.toLocaleString('en-ZA')} km`);

/** The customer / vehicle / job activity feed (real events written when things happened). Paged on the server. */
export async function ActivityTimeline({
  ctx, scope, page, hrefFor,
}: {
  ctx: BusinessContext;
  scope: { customerId: string } | { vehicleId: string } | { jobId: string };
  page: number;
  hrefFor: (page: number) => string;
}) {
  const { items, meta } = await listTimeline(ctx, scope, { page, pageSize: 25 });
  if (items.length === 0) return <EmptyState title="No activity yet">Things that happen to this record will appear here.</EmptyState>;
  return (
    <Card>
      <ol className="relative space-y-4 border-l border-line pl-4">
        {items.map((e) => (
          <li key={e.id} className="relative">
            <span aria-hidden className="absolute -left-[1.3rem] top-1.5 size-2.5 rounded-full border-2 border-surface bg-brand-500" />
            <p className="text-sm">{e.summary}</p>
            <p className="text-xs text-muted">
              <time dateTime={e.createdAt.toISOString()}>{formatDateTime(e.createdAt, ctx.business.timezone, ctx.business.locale)}</time>
              {e.actor ? ` · ${e.actor}` : ''}
              {e.visibility === 'CUSTOMER' ? ' · customer-visible' : ''}
            </p>
          </li>
        ))}
      </ol>
      <Pagination page={meta.page} totalPages={meta.totalPages} total={meta.total} hrefFor={hrefFor} />
    </Card>
  );
}

/** Filter chips: plain links, so filtering works without JavaScript and keeps the page's other filters. */
export function Chips({ items }: { items: { label: string; href: string; active: boolean }[] }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter">
      {items.map((i) => (
        <Link key={i.label} href={i.href} aria-current={i.active ? 'true' : undefined} className={clsx('inline-flex min-h-9 items-center rounded-full border px-3 text-xs font-medium', i.active ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-line bg-surface text-muted hover:text-ink')}>
          {i.label}
        </Link>
      ))}
    </div>
  );
}

/** Build a query string from the current filters plus overrides; empty values are dropped. */
export function qs(base: Record<string, string | undefined>, over: Record<string, string | undefined> = {}): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...base, ...over })) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

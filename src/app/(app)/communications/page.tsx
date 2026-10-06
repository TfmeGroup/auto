import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Card, EmptyState, PageHeader, Pagination } from '@/components/ui';
import { CommRows } from '@/components/notifications/comm-shared';
import { canUseFeature } from '@/server/billing/features';
import { isAppError } from '@/lib/errors';
import { listCommunications, communicationSummary, STATUS_LABEL } from '@/server/notifications/history';
import { EVENTS, EVENT_KEYS } from '@/server/notifications/events';
import { requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Messages' };
export const dynamic = 'force-dynamic';

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const control = 'min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm md:min-h-10';

export default async function CommunicationsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const ctx = await requireBusiness();
  if (!ctx.permissions.has('notification.view_history')) return <EmptyState title="You do not have access to message history">Ask an owner or manager if you need it.</EmptyState>;
  if (!canUseFeature(ctx.subscription, 'communication_history')) return <EmptyState title="Message history is not in your plan">Customer communication history is included from the Team plan. The messages themselves are still sent.</EmptyState>;
  const query = Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, one(v)]).filter(([, v]) => v !== ''));
  let result;
  let problem: string | null = null;
  try { result = await listCommunications(ctx, { pageSize: 25, ...query }); } catch (e) { if (isAppError(e) && e.code === 'VALIDATION_ERROR') problem = e.message; else throw e; }
  const summary = await communicationSummary(ctx);
  const base = new URLSearchParams(Object.entries(query).filter(([k]) => k !== 'page') as [string, string][]);
  const hrefFor = (p: number) => { const q = new URLSearchParams(base); q.set('page', String(p)); return `/communications?${q.toString()}`; };
  const failed = summary.FAILED ?? 0;

  return (
    <>
      <PageHeader title="Messages" description="Every operational message sent to customers and suppliers, and what happened to it." />
      {failed > 0 && <div className="mb-3"><Alert tone="warn">{failed} message{failed === 1 ? '' : 's'} failed in the last 30 days. <Link href="/communications?status=FAILED" className="font-semibold underline">Review them</Link>.</Alert></div>}
      <div className="mb-3 flex flex-wrap gap-2 text-xs text-muted" aria-label="Last 30 days">
        {Object.entries(summary).map(([k, n]) => <span key={k} className="rounded-full border border-line bg-surface px-2.5 py-1">{STATUS_LABEL[k] ?? k}: <strong className="text-ink">{n}</strong></span>)}
      </div>
      <form method="get" className="mb-4 grid gap-2 rounded-xl border border-line bg-surface p-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="sm:col-span-2"><label htmlFor="q" className="mb-1 block text-xs font-medium">Search</label><input id="q" name="q" defaultValue={one(sp.q)} maxLength={100} className={control} placeholder="Customer, address, number, registration or subject…" /></div>
        <div><label htmlFor="channel" className="mb-1 block text-xs font-medium">Channel</label><select id="channel" name="channel" defaultValue={one(sp.channel)} className={control}><option value="">All</option><option value="EMAIL">Email</option><option value="SMS">SMS</option><option value="WHATSAPP">WhatsApp</option></select></div>
        <div><label htmlFor="status" className="mb-1 block text-xs font-medium">Status</label><select id="status" name="status" defaultValue={one(sp.status)} className={control}><option value="">All</option>{Object.entries(STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div><label htmlFor="event" className="mb-1 block text-xs font-medium">Message type</label><select id="event" name="event" defaultValue={one(sp.event)} className={control}><option value="">All</option>{EVENT_KEYS.map((k) => <option key={k} value={k}>{EVENTS[k].label}</option>)}</select></div>
        <div><label htmlFor="from" className="mb-1 block text-xs font-medium">From</label><input id="from" name="from" type="date" defaultValue={one(sp.from)} className={control} /></div>
        <div><label htmlFor="to" className="mb-1 block text-xs font-medium">To</label><input id="to" name="to" type="date" defaultValue={one(sp.to)} className={control} /></div>
        {sp.customerId && <input type="hidden" name="customerId" value={one(sp.customerId)} />}
        <div className="flex items-end gap-2"><button className="inline-flex min-h-11 items-center rounded-lg bg-brand-600 px-5 text-sm font-semibold text-white hover:bg-brand-700 md:min-h-10">Search</button><Link href="/communications" className="inline-flex min-h-11 items-center px-3 text-sm text-brand-600 hover:underline md:min-h-10">Clear</Link></div>
      </form>
      {problem && <p className="mb-3 text-sm font-medium text-danger" role="alert">{problem}</p>}
      {result && result.items.length === 0 ? (
        <EmptyState title={Object.keys(query).length ? 'No messages match' : 'No messages yet'}>{Object.keys(query).length ? 'Try a different search.' : 'Communication activity will appear here once the workshop sends a quote, invoice, booking message or reminder.'}</EmptyState>
      ) : result ? (
        <Card><CommRows items={result.items} tz={ctx.business.timezone} locale={ctx.business.locale} /></Card>
      ) : null}
      {result && <Pagination page={result.meta.page} totalPages={result.meta.totalPages} total={result.meta.total} hrefFor={hrefFor} />}
    </>
  );
}

import type { Metadata } from 'next';
import Link from 'next/link';
import { EmptyState, PageHeader, Pagination } from '@/components/ui';
import { NotificationList } from '@/components/notifications/NotificationList';
import { formatDateTime } from '@/lib/format';
import { listNotifications } from '@/server/notifications/inapp';
import { requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Notifications' };
export const dynamic = 'force-dynamic';

export default async function NotificationsPage({ searchParams }: { searchParams: Promise<{ filter?: string; page?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireBusiness();
  const filter = sp.filter === 'unread' ? 'unread' : 'all';
  const r = await listNotifications(ctx, { filter, page: sp.page ?? '1', pageSize: '25' });
  const when = Object.fromEntries(r.items.map((n) => [n.id, formatDateTime(n.createdAt, ctx.business.timezone, ctx.business.locale)]));
  const tab = (k: string, label: string) => (
    <Link href={`/notifications?filter=${k}`} aria-current={filter === k ? 'page' : undefined} className={`-mb-px inline-flex min-h-11 items-center border-b-2 px-3 text-sm font-medium ${filter === k ? 'border-brand-600 text-brand-700' : 'border-transparent text-muted hover:text-ink'}`}>{label}</Link>
  );
  return (
    <>
      <PageHeader title="Notifications" description="What needs your attention in this business." />
      <nav aria-label="Filter notifications" className="mb-3 flex gap-1 border-b border-line">{tab('all', 'All')}{tab('unread', `Unread${r.unread ? ` (${r.unread})` : ''}`)}</nav>
      {r.items.length === 0 ? (
        <EmptyState title={filter === 'unread' ? "You're all caught up" : 'Nothing here yet'}>{filter === 'unread' ? 'There is nothing unread.' : 'Notifications about jobs, bookings, quotes, payments, stock and your account will appear here.'}</EmptyState>
      ) : (
        <NotificationList items={r.items.map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, linkUrl: n.linkUrl, priority: n.priority, count: n.count, read: n.read, createdAt: n.createdAt.toISOString() }))} unread={r.unread} when={when} />
      )}
      <Pagination page={r.meta.page} totalPages={r.meta.totalPages} total={r.meta.total} hrefFor={(p) => `/notifications?filter=${filter}&page=${p}`} />
    </>
  );
}

'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Badge, Button } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  linkUrl: string | null;
  priority: string;
  count: number;
  read: boolean;
  createdAt: string;
}

/**
 * The notification centre. Each notification shows its importance in words (not only colour), can be opened (which marks it read),
 * and can be marked read or unread. Repetitive low-priority events arrive already folded into one ("× 5").
 */
export function NotificationList({ items, unread, when }: { items: NotificationItem[]; unread: number; when: Record<string, string> }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function call(key: string, path: string, method: string) {
    setBusy(key);
    setError(null);
    try {
      await api(path, { method });
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not work. Try again.');
    } finally {
      setBusy(null);
    }
  }

  async function open(n: NotificationItem) {
    if (!n.read) await api(`/api/v1/notifications/${n.id}/read`, { method: 'POST' }).catch(() => {});
    if (n.linkUrl) router.push(n.linkUrl);
    else router.refresh();
  }

  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted" aria-live="polite">{unread === 0 ? 'You are all caught up.' : `${unread} unread`}</p>
        {unread > 0 && <Button type="button" variant="secondary" loading={busy === 'all'} onClick={() => void call('all', '/api/v1/notifications/read-all', 'POST')}>Mark all read</Button>}
      </div>
      <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
        {items.map((n) => (
          <li key={n.id} className={`flex items-start gap-3 px-3 py-3 sm:px-4 ${n.read ? '' : 'bg-brand-50/60'}`}>
            <span aria-hidden className={`mt-2 size-2.5 shrink-0 rounded-full ${n.read ? 'bg-transparent' : 'bg-brand-600'}`} />
            <div className="min-w-0 flex-1">
              <button type="button" onClick={() => void open(n)} className="block min-h-11 w-full text-left md:min-h-0">
                <span className="flex flex-wrap items-center gap-2">
                  <span className={`text-sm ${n.read ? 'font-medium' : 'font-bold'}`}>{n.title}{n.count > 1 ? ` (× ${n.count})` : ''}</span>
                  {n.priority === 'HIGH' && <Badge tone="danger">Important</Badge>}
                  {!n.read && <span className="sr-only">Unread</span>}
                </span>
                {n.body && <span className="mt-0.5 block text-sm text-muted">{n.body}</span>}
              </button>
              <p className="mt-1 text-xs text-muted">{when[n.id]}{n.linkUrl ? <> · <Link href={n.linkUrl} className="text-brand-700 hover:underline">Open</Link></> : null}</p>
            </div>
            <button
              type="button" disabled={busy === n.id} onClick={() => void call(n.id, `/api/v1/notifications/${n.id}/read`, n.read ? 'DELETE' : 'POST')}
              className="inline-flex min-h-11 shrink-0 items-center px-2 text-xs font-medium text-brand-600 hover:underline md:min-h-9" aria-label={n.read ? `Mark "${n.title}" unread` : `Mark "${n.title}" read`}
            >
              {n.read ? 'Mark unread' : 'Mark read'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

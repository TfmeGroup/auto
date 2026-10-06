import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, Card, PageHeader } from '@/components/ui';
import { ActionButton } from '@/components/forms/RowActions';
import { CHANNEL_LABEL, StatusPill } from '@/components/notifications/comm-shared';
import { recordHref } from '@/components/documents/record-links';
import { formatDateTime } from '@/lib/format';
import { isAppError } from '@/lib/errors';
import { getCommunication } from '@/server/notifications/history';
import { requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Message' };
export const dynamic = 'force-dynamic';

export default async function CommunicationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireBusiness();
  let m;
  try { m = await getCommunication(ctx, id); } catch (e) { if (isAppError(e) && ['NOT_FOUND', 'FORBIDDEN', 'FEATURE_NOT_IN_PLAN'].includes(e.code)) notFound(); throw e; }
  const when = (d: Date | null) => (d ? formatDateTime(d, ctx.business.timezone, ctx.business.locale) : null);
  const can = ctx.permissions.has('notification.send') && ctx.subscription.canWrite;
  const href = m.entityType && m.entityId ? recordHref(m.entityType, m.entityId) : null;
  const steps: [string, string | null][] = [['Queued', when(m.queuedAt)], ['Handed to the provider', when(m.sentAt)], ['Reported delivered by the provider', when(m.deliveredAt)], ['Opened', when(m.viewedAt)], ['Failed', when(m.failedAt)]];

  return (
    <>
      <PageHeader title={m.subject || m.eventLabel} description={`${m.eventLabel} · ${CHANNEL_LABEL[m.channel] ?? m.channel}`} actions={<Link href="/communications" className="inline-flex min-h-11 items-center text-sm text-brand-600 hover:underline md:min-h-10">All messages</Link>} />
      <div className="mb-3 flex flex-wrap items-center gap-2"><StatusPill status={m.status} label={m.statusLabel} />{m.manual && <span className="text-xs text-muted">Written by staff</span>}</div>
      {m.status === 'FAILED' && <div className="mb-3"><Alert>{m.statusDetail ?? 'The message could not be sent.'}</Alert></div>}
      {m.status === 'SKIPPED' && <div className="mb-3"><Alert tone="warn">Not sent: {m.statusDetail}</Alert></div>}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card>
          <h2 className="mb-2 text-base font-semibold">Message</h2>
          <pre className="whitespace-pre-wrap break-words font-sans text-sm">{m.body}</pre>
          <p className="mt-3 text-xs text-muted">This is the message as it was recorded. A customer&apos;s private links are not kept in the text.</p>
        </Card>
        <div className="space-y-4">
          <Card>
            <h2 className="mb-2 text-base font-semibold">Details</h2>
            <dl className="space-y-2 text-sm">
              <div><dt className="text-xs uppercase tracking-wide text-muted">To</dt><dd className="font-medium">{m.recipient ?? '—'}{m.customerName ? ` (${m.customerName})` : ''}</dd></div>
              {href && <div><dt className="text-xs uppercase tracking-wide text-muted">About</dt><dd><Link href={href} className="font-medium text-brand-700 hover:underline">{m.entityType?.replace('_', ' ')}</Link></dd></div>}
              <div><dt className="text-xs uppercase tracking-wide text-muted">Attempts</dt><dd className="font-medium">{m.attempts}</dd></div>
            </dl>
            <ol className="mt-3 space-y-1 border-t border-line pt-3 text-sm">
              {steps.filter(([, t]) => t).map(([label, t]) => <li key={label} className="flex justify-between gap-3"><span>{label}</span><span className="text-muted">{t}</span></li>)}
            </ol>
            <p className="mt-3 text-xs text-muted">&ldquo;Handed to the provider&rdquo; means the provider accepted the message. It is only shown as delivered or opened if the provider says so.</p>
          </Card>
          {can && (m.status === 'FAILED' || m.status === 'QUEUED') && (
            <Card className="space-y-2">
              {m.status === 'FAILED' && <ActionButton label="Send again" path={`/api/v1/communications/${m.id}/retry`} />}
              {m.status === 'QUEUED' && <ActionButton label="Cancel this message" variant="danger" path={`/api/v1/communications/${m.id}/cancel`} confirm="Cancel this message so it is not sent?" />}
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

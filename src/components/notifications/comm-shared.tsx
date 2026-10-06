import Link from 'next/link';
import { Badge } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { recordHref } from '@/components/documents/record-links';

export interface CommItem {
  id: string;
  channel: string;
  eventLabel: string;
  recipient: string | null;
  subject: string | null;
  status: string;
  statusLabel: string;
  statusDetail: string | null;
  customerId: string | null;
  customerName: string | null;
  entityType: string | null;
  entityId: string | null;
  manual: boolean;
  createdAt: Date;
  sentAt: Date | null;
  deliveredAt: Date | null;
  viewedAt: Date | null;
}

const TONE: Record<string, 'ok' | 'danger' | 'warn' | 'brand' | 'neutral'> = { SENT: 'brand', DELIVERED: 'ok', VIEWED: 'ok', FAILED: 'danger', SKIPPED: 'warn', CANCELLED: 'neutral', QUEUED: 'neutral', PROCESSING: 'neutral' };
export const CHANNEL_LABEL: Record<string, string> = { EMAIL: 'Email', SMS: 'SMS', WHATSAPP: 'WhatsApp' };

/** The state in words ("Sent" means handed to the provider, never "delivered": delivery is only ever shown when the provider reported it). */
export function StatusPill({ status, label }: { status: string; label: string }) {
  return <Badge tone={TONE[status] ?? 'neutral'}>{label}</Badge>;
}

export function CommRows({ items, tz, locale, showCustomer = true }: { items: CommItem[]; tz: string; locale: string; showCustomer?: boolean }) {
  return (
    <ul className="divide-y divide-line">
      {items.map((m) => (
        <li key={m.id} className="py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/communications/${m.id}`} className="text-sm font-semibold text-brand-700 hover:underline">{m.subject || m.eventLabel}</Link>
            <StatusPill status={m.status} label={m.statusLabel} />
            <Badge>{CHANNEL_LABEL[m.channel] ?? m.channel}</Badge>
            {m.manual && <Badge>Written by staff</Badge>}
          </div>
          <p className="mt-0.5 text-xs text-muted">
            {m.eventLabel} · {showCustomer && m.customerName ? <>{m.customerName} · </> : null}{m.recipient ?? 'no recipient'} · {formatDateTime(m.createdAt, tz, locale)}
            {m.entityType && m.entityId && recordHref(m.entityType, m.entityId) ? <> · <Link href={recordHref(m.entityType, m.entityId)!} className="text-brand-700 hover:underline">{m.entityType.replace('_', ' ')}</Link></> : null}
          </p>
          {m.statusDetail && m.status !== 'SENT' && <p className="mt-0.5 text-xs font-medium">{m.statusDetail}</p>}
        </li>
      ))}
    </ul>
  );
}

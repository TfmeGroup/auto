import Link from 'next/link';
import { Card, EmptyState, Pagination } from '@/components/ui';
import { CommRows } from '@/components/notifications/comm-shared';
import { ManualMessageForm } from '@/components/notifications/ManualMessageForm';
import { PrefsForm } from '@/components/notifications/PrefsForm';
import { canUseFeature } from '@/server/billing/features';
import { listCommunications } from '@/server/notifications/history';
import { getCustomerPreferences } from '@/server/notifications/preferences';
import { isChannelConfigured } from '@/server/notifications/providers/text';
import type { BusinessContext } from '@/server/context';

/** A customer's communication: what was sent to them and what happened, their preferences, and a way to write to them. */
export async function CustomerCommPanel({ ctx, customerId, page, hrefFor, archived }: { ctx: BusinessContext; customerId: string; page: number; hrefFor: (p: number) => string; archived: boolean }) {
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  const hasHistory = can('notification.view_history') && canUseFeature(ctx.subscription, 'communication_history');
  const [history, prefs] = await Promise.all([
    hasHistory ? listCommunications(ctx, { customerId, page, pageSize: 20 }) : null,
    getCustomerPreferences(ctx, customerId),
  ]);
  const canEdit = can('notification.manage_preferences') && ctx.subscription.canWrite && !archived;
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        {can('notification.send') && ctx.subscription.canWrite && !archived && <Card><ManualMessageForm customerId={customerId} /></Card>}
        <Card>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold">Communication history</h2>
            {hasHistory && <Link href={`/communications?customerId=${customerId}`} className="inline-flex min-h-11 items-center text-sm text-brand-600 hover:underline md:min-h-9">Open in messages</Link>}
          </div>
          {!can('notification.view_history') ? (
            <p className="text-sm text-muted">You do not have permission to see message history.</p>
          ) : !hasHistory ? (
            <p className="text-sm text-muted">Customer communication history is not included in your plan.</p>
          ) : history && history.items.length === 0 ? (
            <EmptyState title="No messages yet">Communication activity will appear here: bookings, quotes, invoices, payments, reminders and anything you send.</EmptyState>
          ) : history ? (
            <>
              <CommRows items={history.items} tz={ctx.business.timezone} locale={ctx.business.locale} showCustomer={false} />
              <Pagination page={history.meta.page} totalPages={history.meta.totalPages} total={history.meta.total} hrefFor={hrefFor} />
            </>
          ) : null}
        </Card>
      </div>
      <Card>
        <h2 className="mb-3 text-base font-semibold">Preferences and consent</h2>
        <PrefsForm customerId={customerId} initial={prefs.preferences} canEdit={canEdit} smsAvailable={isChannelConfigured('sms')} whatsappAvailable={isChannelConfigured('whatsapp')} />
        {prefs.consents.length > 0 && (
          <div className="mt-4">
            <h3 className="text-sm font-semibold">Consent history</h3>
            <ul className="mt-1 space-y-1 text-xs text-muted">
              {prefs.consents.slice(0, 6).map((c) => <li key={c.id}>{c.consentType === 'SMS' ? 'SMS' : 'WhatsApp'}: {c.status === 'GRANTED' ? 'agreed' : 'withdrawn'} ({c.source.replace(/_/g, ' ')}) · {c.createdAt.toLocaleDateString('en-ZA')}</li>)}
            </ul>
          </div>
        )}
      </Card>
    </div>
  );
}

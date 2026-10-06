import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { CommSettingsForm } from '@/components/notifications/CommSettingsForm';
import { canUseFeature } from '@/server/billing/features';
import { EVENTS, INTERNAL_EVENTS, JOB_UPDATE_EVENTS } from '@/server/notifications/events';
import { isChannelConfigured } from '@/server/notifications/providers/text';
import { getCommSettings } from '@/server/notifications/settings';
import { requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Communication settings' };
export const dynamic = 'force-dynamic';

export default async function CommunicationSettingsPage() {
  const ctx = await requireBusiness();
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  if (!can('notification.manage_settings')) {
    return (
      <>
        <PageHeader title="Communication" description="How your messages to customers and your team behave." />
        {can('notification.manage_templates') ? <Card><Link href="/settings/communication/templates" className="text-brand-700 underline">Edit message templates</Link></Card> : <EmptyState title="You do not have access to communication settings">Ask an owner or manager.</EmptyState>}
      </>
    );
  }
  const data = await getCommSettings(ctx);
  const sub = ctx.subscription;
  return (
    <>
      <PageHeader title="Communication" description="How your messages to customers and your team behave." actions={can('notification.manage_templates') ? <Link href="/settings/communication/templates" className="inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-4 text-sm font-semibold hover:bg-canvas md:min-h-10">Message templates</Link> : undefined} />
      <Card>
        <CommSettingsForm
          initial={data.settings as never}
          jobUpdates={JOB_UPDATE_EVENTS.map((k) => ({ key: k, label: EVENTS[k].label }))}
          internalEvents={Object.values(INTERNAL_EVENTS).map((e) => ({ type: e!.type, label: e!.label, permission: e!.permission }))}
          canEdit={ctx.subscription.canWrite}
          can={{ sms: canUseFeature(sub, 'sms_notifications'), whatsapp: canUseFeature(sub, 'whatsapp_notifications'), smsProvider: isChannelConfigured('sms'), whatsappProvider: isChannelConfigured('whatsapp'), advanced: canUseFeature(sub, 'advanced_communication'), serviceReminders: canUseFeature(sub, 'service_reminders') }}
        />
      </Card>
    </>
  );
}

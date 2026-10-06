import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Card, EmptyState, PageHeader } from '@/components/ui';
import { TemplateEditor } from '@/components/notifications/TemplateEditor';
import { listTemplates } from '@/server/notifications/templates-admin';
import { requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Message templates' };
export const dynamic = 'force-dynamic';

export default async function TemplatesPage() {
  const ctx = await requireBusiness();
  if (!ctx.permissions.has('notification.manage_templates')) return <EmptyState title="You do not have access to message templates">Ask an owner or manager.</EmptyState>;
  const data = await listTemplates(ctx);
  const groups = new Map<string, typeof data.items>();
  for (const t of data.items) groups.set(t.category, [...(groups.get(t.category) ?? []), t]);
  const editable = ctx.permissions.has('notification.manage_templates') && ctx.subscription.canWrite;

  return (
    <>
      <PageHeader title="Message templates" description="The wording of the messages TFME Auto sends for you. Every message has standard wording ready to go." actions={<Link href="/settings/communication" className="inline-flex min-h-11 items-center text-sm text-brand-600 hover:underline md:min-h-10">Communication settings</Link>} />
      {!data.canCustomise && <div className="mb-3"><Alert tone="warn">Your plan uses the standard wording. Custom templates are included from the Team plan. You can still preview every message.</Alert></div>}
      <div className="space-y-5">
        {[...groups.entries()].map(([category, items]) => (
          <Card key={category} className="space-y-2">
            <h2 className="text-base font-semibold">{category}</h2>
            {items.map((t) => (
              <TemplateEditor
                key={`${t.event}-${t.channel}`} event={t.event} label={t.label} channel={t.channel as 'EMAIL' | 'SMS' | 'WHATSAPP'} mandatory={t.mandatory} system={t.system}
                custom={t.custom ? { subject: t.custom.subject, body: t.custom.body, active: t.custom.active, version: t.custom.version } : null} variables={t.variables} descriptions={data.variables}
                canEdit={editable} canCustomise={data.canCustomise}
              />
            ))}
          </Card>
        ))}
      </div>
    </>
  );
}

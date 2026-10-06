import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Card, PageHeader } from '@/components/ui';
import { getSetupCheck, type SetupStatus } from '@/server/admin/setup';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Setup check' };
export const dynamic = 'force-dynamic';

const WORD: Record<SetupStatus, string> = { COMPLETE: 'Complete', WARNING: 'Could be better', ACTION_REQUIRED: 'Action required' };
const TONE = { COMPLETE: 'ok', WARNING: 'warn', ACTION_REQUIRED: 'danger' } as const;

export default async function SetupPage() {
  const ctx = await requireBusiness();
  assertCan(ctx, 'settings.view');
  const s = await getSetupCheck(ctx);
  return (
    <>
      <PageHeader title="System setup check" description="A fixed checklist worked out from your saved settings and records. Fix an item and it turns complete the next time you open this page." />
      <p className="mb-3 text-sm"><strong>{s.complete}</strong> complete · <strong>{s.warnings}</strong> could be better · <strong>{s.actionRequired}</strong> need action</p>
      <ul className="grid gap-2">
        {s.items.map((i) => (
          <li key={i.key}>
            <Card className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-medium">{i.label} <Badge tone={TONE[i.status]}>{WORD[i.status]}</Badge></p>
                <p className="mt-0.5 text-sm text-muted">{i.detail}</p>
              </div>
              {i.status !== 'COMPLETE' && <Link href={i.href} className="inline-flex min-h-11 items-center rounded-lg border border-line px-4 text-sm font-semibold hover:bg-canvas md:min-h-10">Fix this</Link>}
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}

import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, EmptyState, LinkButton, PageHeader, Pagination } from '@/components/ui';
import { InventoryNav, TransferStatusBadge } from '@/components/inventory/shared';
import { inventoryTabs } from '@/components/inventory/nav';
import { Chips, qs } from '@/components/workshop/layout';
import { formatDate } from '@/lib/format';
import { listTransfers } from '@/server/inventory/transfers';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Stock transfers' };
export const dynamic = 'force-dynamic';

const CHIPS = [['All', undefined], ['Open', 'DRAFT,REQUESTED,APPROVED'], ['In transit', 'IN_TRANSIT'], ['Received', 'RECEIVED'], ['Cancelled', 'CANCELLED']] as const;

export default async function TransfersPage({ searchParams }: { searchParams: Promise<{ page?: string; status?: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'inventory.view');
  const sp = await searchParams;
  if (!ctx.subscription.features.has('multi_location')) {
    return <><PageHeader title="Stock transfers" /><InventoryNav tabs={inventoryTabs(ctx)} active="transfers" /><Alert tone="warn">Moving stock between locations needs a plan with more than one location.</Alert></>;
  }
  const { items, meta } = await listTransfers(ctx, { page: sp.page, status: sp.status, pageSize: 25 });
  const href = (over: Record<string, string | undefined>) => `/inventory/transfers${qs({ status: sp.status }, { page: undefined, ...over })}`;
  return (
    <>
      <PageHeader title="Stock transfers" description="Stock moves out of one location when it ships and onto the other's shelf only when it is received there." actions={ctx.permissions.has('inventory.transfer') && <LinkButton href="/inventory/transfers/new">New transfer</LinkButton>} />
      <InventoryNav tabs={inventoryTabs(ctx)} active="transfers" />
      <div className="mb-4"><Chips items={CHIPS.map(([label, status]) => ({ label, href: href({ status }), active: (status ?? '') === (sp.status ?? '') }))} /></div>
      {items.length === 0 ? <EmptyState title="No transfers" action={ctx.permissions.has('inventory.transfer') ? <LinkButton href="/inventory/transfers/new">Create a transfer</LinkButton> : undefined}>Move parts between your locations here.</EmptyState> : (
        <>
          <ul className="space-y-2">
            {items.map((t) => (
              <li key={t.id}>
                <Link href={`/inventory/transfers/${t.id}`} className="block rounded-xl border border-line bg-surface p-3 shadow-sm hover:bg-canvas">
                  <div className="flex items-start justify-between gap-2"><p className="font-semibold">{t.number}</p><TransferStatusBadge status={t.status} /></div>
                  <p className="text-sm">{t.from} → {t.to}</p>
                  <p className="text-xs text-muted">{t.units} unit{t.units === 1 ? '' : 's'} · created {formatDate(t.createdAt, ctx.business.timezone, ctx.business.locale)}</p>
                </Link>
              </li>
            ))}
          </ul>
          <Pagination page={meta.page} totalPages={meta.totalPages} total={meta.total} hrefFor={(p) => href({ page: String(p) })} />
        </>
      )}
    </>
  );
}

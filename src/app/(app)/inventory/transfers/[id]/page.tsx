import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, Card, PageHeader } from '@/components/ui';
import { ActionButton } from '@/components/forms/RowActions';
import { TransferStatusBadge, money } from '@/components/inventory/shared';
import { PartFilesPanel } from '@/components/inventory/PartFilesPanel';
import { Row } from '@/components/workshop/layout';
import { formatDateTime } from '@/lib/format';
import { isAppError } from '@/lib/errors';
import { getTransfer } from '@/server/inventory/transfers';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Stock transfer' };
export const dynamic = 'force-dynamic';

export default async function TransferPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'inventory.view');
  const { id } = await params;
  let d;
  try {
    d = await getTransfer(ctx, id);
  } catch (e) {
    if (isAppError(e) && (e.status === 404 || e.status === 422)) notFound();
    throw e;
  }
  const t = d.transfer;
  const fmt = { currency: ctx.business.currency, locale: ctx.business.locale };
  const at = (x: Date | null) => (x ? formatDateTime(x, ctx.business.timezone, ctx.business.locale) : null);
  const base = `/api/v1/transfers/${t.id}`;
  const writable = ctx.subscription.canWrite && ctx.permissions.has('inventory.transfer');
  return (
    <>
      <PageHeader title={t.number} description={`${t.from} → ${t.to}`} />
      <div className="mb-3 flex flex-wrap items-center gap-2"><TransferStatusBadge status={t.status} /></div>
      {t.status === 'IN_TRANSIT' && <div className="mb-3"><Alert tone="warn">This stock has left {t.from} and is not on any shelf until it is received at {t.to}.</Alert></div>}
      {writable && (
        <div className="mb-4 flex flex-wrap gap-2">
          {d.can.request && <ActionButton label="Request" variant="primary" path={`${base}/request`} />}
          {d.can.approve && ctx.permissions.has('inventory.approve_purchase') && <ActionButton label="Approve" variant="primary" path={`${base}/approve`} />}
          {d.can.ship && <ActionButton label="Ship" variant="primary" path={`${base}/ship`} confirm="Take this stock off the sending location now? It will not be on any shelf until it is received." />}
          {d.can.receive && <ActionButton label="Receive" variant="primary" path={`${base}/receive`} confirm="Put this stock on the shelf at the receiving location?" />}
          {d.can.cancel && <ActionButton label="Cancel transfer" variant="ghost" path={`${base}/cancel`} confirm="Cancel this transfer?" />}
        </div>
      )}
      <div className="space-y-4">
        <Card>
          <h2 className="mb-2 text-base font-semibold">Parts</h2>
          <ul className="divide-y divide-line">{d.lines.map((l) => <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"><Link href={`/inventory/parts/${l.partId}`} className="min-w-0 truncate font-medium text-brand-700 hover:underline">{l.sku} — {l.name}</Link><span className="tabular-nums"><strong>{l.quantity}</strong>{l.unitCostCents !== null ? <span className="ml-2 text-xs text-muted">{money(l.unitCostCents, fmt)} each</span> : null}</span></li>)}</ul>
        </Card>
        <Card>
          <dl className="divide-y divide-line">
            <Row label="Requested">{at(t.requestedAt)}{t.requestedBy ? ` by ${t.requestedBy}` : ''}</Row>
            <Row label="Approved">{at(t.approvedAt)}{t.approvedBy ? ` by ${t.approvedBy}` : ''}</Row>
            <Row label="Shipped">{at(t.shippedAt)}{t.shippedBy ? ` by ${t.shippedBy}` : ''}</Row>
            <Row label="Received">{at(t.receivedAt)}{t.receivedBy ? ` by ${t.receivedBy}` : ''}</Row>
            {t.cancelledAt && <Row label="Cancelled">{at(t.cancelledAt)}{t.cancelReason ? ` — ${t.cancelReason}` : ''}</Row>}
            <Row label="Notes">{t.notes}</Row>
          </dl>
        </Card>
        <PartFilesPanel ctx={ctx} resourceType="stock_transfer" resourceId={t.id} kind="all" title="Documents and photos" />
      </div>
    </>
  );
}

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Alert, Card, PageHeader } from '@/components/ui';
import { ReceiveForm } from '@/components/inventory/ReceiveForm';
import { isAppError } from '@/lib/errors';
import { accessibleLocationsFor } from '@/server/inventory/queries';
import { getPurchaseOrder } from '@/server/inventory/purchasing';
import { assertCan, requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Receive goods' };
export const dynamic = 'force-dynamic';

export default async function ReceivePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'inventory.receive');
  const { id } = await params;
  let d;
  try {
    d = await getPurchaseOrder(ctx, id);
  } catch (e) {
    if (isAppError(e) && (e.status === 404 || e.status === 422)) notFound();
    throw e;
  }
  const o = d.order;
  const open = d.lines.filter((l) => l.remaining > 0);
  const locations = await accessibleLocationsFor(ctx);
  return (
    <>
      <PageHeader title={`Receive ${o.number}`} description={`${d.supplier.name} · deliver to ${o.locationName}`} />
      {!['ORDERED', 'PARTIALLY_RECEIVED'].includes(o.status) ? <Alert tone="warn">{o.status === 'RECEIVED' ? 'This order has been received in full.' : 'Only an order that has been placed can be received.'}</Alert> : open.length === 0 ? <Alert tone="ok">Nothing is outstanding.</Alert> : (
        <Card className="max-w-3xl">
          <ReceiveForm poId={o.id} number={o.number} canSeeCosts={d.canSeeCosts} locations={locations} defaultLocationId={o.locationId} lines={open.map((l) => ({ id: l.id, description: l.description, sku: l.sku, remaining: l.remaining, unitCostCents: l.unitCostCents, hasPart: !!l.partId }))} />
        </Card>
      )}
    </>
  );
}

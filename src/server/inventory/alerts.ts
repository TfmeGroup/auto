import { prisma, withTenant } from '@/server/db/client';
import { logger } from '@/lib/logger';
import { todayIso } from '@/lib/tz';
import { recordAudit } from '@/server/audit/audit';
import { loadEffectiveSubscription } from '@/server/billing/subscriptions';
import { notifyInApp } from '@/server/notifications/service';
import { notifyInternal } from '@/server/notifications/internal';
import { systemMeta } from '@/server/context';
import { dateOnly, isoOf } from '@/server/finance/common';
import { stockState } from './calc';

/**
 * Scheduled inventory work, run by the worker's scheduler (never by someone happening to open a page):
 *  - low-stock and out-of-stock alerts: a part is announced when its level CHANGES to low or out (and when it recovers), not on every run, and the people
 *    who look after stock get ONE grouped notice per run rather than one per part;
 *  - late purchase orders: an order past its expected delivery date is flagged once for that date.
 * Every step is safe to run twice or from many workers at once: it only acts on a state change it records, in the same transaction as the notice.
 */

export interface InventoryTickResult {
  partsAlerted: number;
  lateOrders: number;
  invitationsExpired?: number;
}

export async function runInventoryTasks(now = new Date()): Promise<InventoryTickResult> {
  const out: InventoryTickResult = { partsAlerted: 0, lateOrders: 0 };
  const businesses = await prisma().business.findMany({ where: { status: 'ACTIVE' }, select: { id: true, name: true, timezone: true } });
  for (const b of businesses) {
    try {
      const gate = await withTenant(b.id, async (tx) => {
        if (!(await tx.part.findFirst({ where: { businessId: b.id }, select: { id: true } }))) return false;
        const sub = await loadEffectiveSubscription(tx, b.id, now);
        return sub.canWrite;
      });
      if (!gate) continue;
      out.partsAlerted += await stockAlerts(b);
      out.lateOrders += await lateOrders(b, now);
    } catch (err) {
      logger.error({ businessId: b.id, err: String(err) }, 'inventory scheduled tasks failed for a business');
    }
  }
  return out;
}

type Biz = { id: string; name: string; timezone: string };

async function stockAlerts(b: Biz): Promise<number> {
  return withTenant(b.id, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; sku: string; name: string; min_stock: number; reorder_level: number | null; last_alert_level: string; on_hand: number; reserved: number }[]>`
      SELECT p.id, p.sku, p.name, p.min_stock, p.reorder_level, p.last_alert_level,
             COALESCE(sum(sl.on_hand), 0)::int AS on_hand, COALESCE(sum(sl.reserved), 0)::int AS reserved
        FROM parts p LEFT JOIN stock_levels sl ON sl.part_id = p.id
       WHERE p.business_id = ${b.id}::uuid AND p.status = 'ACTIVE' GROUP BY p.id`;
    const worse: { id: string; sku: string; name: string; level: 'LOW' | 'OUT' }[] = [];
    const recovered: string[] = [];
    const changed: { id: string; level: string }[] = [];
    for (const r of rows) {
      const level = stockState(r.on_hand - r.reserved, r.min_stock, r.reorder_level);
      // A part with no threshold that has never held any stock is not "out of stock" news.
      const meaningful = r.min_stock > 0 || (r.reorder_level ?? 0) > 0 || r.on_hand > 0 || r.last_alert_level !== 'NORMAL';
      const effective = meaningful ? level : 'NORMAL';
      if (effective === r.last_alert_level) continue;
      changed.push({ id: r.id, level: effective });
      if (effective === 'LOW' || effective === 'OUT') {
        if (!(r.last_alert_level === 'OUT' && effective === 'LOW')) worse.push({ id: r.id, sku: r.sku, name: r.name, level: effective });
      } else recovered.push(r.id);
    }
    if (changed.length === 0) return 0;
    for (const c of changed) await tx.part.update({ where: { id: c.id }, data: { lastAlertLevel: c.level } });
    if (worse.length > 0) {
      const out = worse.filter((w) => w.level === 'OUT');
      const low = worse.filter((w) => w.level === 'LOW');
      const parts = [...out.map((w) => `${w.sku} (out)`), ...low.map((w) => `${w.sku} (low)`)];
      const title = `${worse.length} part${worse.length === 1 ? '' : 's'} need${worse.length === 1 ? 's' : ''} restocking`;
      const body = `${out.length ? `${out.length} out of stock` : ''}${out.length && low.length ? ', ' : ''}${low.length ? `${low.length} low` : ''}: ${parts.slice(0, 8).join(', ')}${parts.length > 8 ? ` and ${parts.length - 8} more` : ''}.`;
      await notifyInternal(tx, b.id, 'LOW_STOCK', { title, body, linkUrl: '/inventory/reports?report=low' });
      await recordAudit(tx, systemMeta('scheduler'), { action: 'inventory.low_stock_alert', businessId: b.id, userId: null, resourceType: 'inventory', resourceId: b.id, metadata: { parts: worse.map((w) => ({ id: w.id, level: w.level })) } });
    }
    return worse.length;
  });
}

/** Orders past their expected date are flagged once per expected date (changing the date earns a fresh flag). */
async function lateOrders(b: Biz, now: Date): Promise<number> {
  const today = todayIso(b.timezone, now);
  return withTenant(b.id, async (tx) => {
    const settings = await tx.inventorySettings.findUnique({ where: { businessId: b.id } });
    const grace = settings?.poReminderDays ?? 1;
    const due = await tx.purchaseOrder.findMany({
      where: { businessId: b.id, status: { in: ['ORDERED', 'PARTIALLY_RECEIVED'] }, expectedDate: { lt: dateOnly(today) } },
      select: { id: true, number: true, expectedDate: true, lastLateNoticeFor: true, createdById: true, orderedById: true, supplier: { select: { name: true } } }, take: 500,
    });
    let n = 0;
    for (const po of due) {
      const expected = isoOf(po.expectedDate)!;
      if (po.lastLateNoticeFor && isoOf(po.lastLateNoticeFor) === expected) continue;
      const daysLate = Math.round((dateOnly(today).getTime() - dateOnly(expected).getTime()) / 86_400_000);
      if (daysLate < grace) continue;
      const claimed = await tx.purchaseOrder.updateMany({ where: { id: po.id, businessId: b.id, OR: [{ lastLateNoticeFor: null }, { lastLateNoticeFor: { not: dateOnly(expected) } }] }, data: { lastLateNoticeFor: dateOnly(expected) } });
      if (claimed.count !== 1) continue;
      const buyers = [...new Set([po.createdById, po.orderedById].filter((v): v is string => !!v))];
      for (const userId of buyers) await notifyInApp(tx, { businessId: b.id, userId, type: 'PO_LATE', title: `Purchase order ${po.number} is late`, body: `${po.supplier.name} was due to deliver by ${expected}. Follow up with them.`, linkUrl: `/purchase-orders/${po.id}` });
      n++;
    }
    return n;
  });
}


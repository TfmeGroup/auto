import { addDays, todayIso } from '@/lib/tz';
import { withTenant } from '@/server/db/client';
import { can } from '@/server/permissions/authorize';
import { getInventorySnapshot } from '@/server/inventory/reports';
import { receivables } from '@/server/finance/reports';
import { getSetupCheck } from './setup';
import { measureUsage } from '@/server/usage/service';
import type { BusinessContext } from '@/server/context';

/**
 * Business alerts: conditions that need attention, worked out from the real records every time (nothing is stored, so an alert disappears the
 * moment its cause is fixed). Each one links to where it is dealt with, and a person only sees alerts about things they are allowed to act on.
 */
export interface Alert {
  key: string;
  severity: 'danger' | 'warn' | 'info';
  title: string;
  detail: string;
  href: string;
  count: number;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function getAlerts(ctx: BusinessContext): Promise<Alert[]> {
  const out: Alert[] = [];
  const bid = ctx.business.id;
  const sub = ctx.subscription;

  // Subscription and trial (people who handle billing)
  if (can(ctx, 'settings.manage_billing')) {
    if (sub.status === 'TRIALING' && sub.trialDaysRemaining !== null && sub.trialDaysRemaining <= 7) {
      out.push({ key: 'trial', severity: sub.trialDaysRemaining <= 2 ? 'danger' : 'warn', title: 'Your free trial is ending', detail: `${plural(sub.trialDaysRemaining, 'day')} left. Choose a plan to keep working without interruption.`, href: '/settings/billing', count: 1 });
    }
    if (['PAST_DUE', 'GRACE_PERIOD', 'SUSPENDED', 'EXPIRED'].includes(sub.status)) {
      out.push({ key: 'subscription', severity: 'danger', title: 'Subscription needs attention', detail: sub.status === 'PAST_DUE' ? 'A payment did not go through.' : sub.status === 'GRACE_PERIOD' ? 'Payment is overdue and the business is in its grace period.' : 'The subscription is not active, so changes are blocked until it is.', href: '/settings/billing', count: 1 });
    }
  }

  if (can(ctx, 'inventory.view')) {
    const s = await getInventorySnapshot(ctx).catch(() => null);
    if (s && s.outOfStock > 0) out.push({ key: 'out_of_stock', severity: 'danger', title: 'Parts out of stock', detail: `${plural(s.outOfStock, 'part')} with nothing available.`, href: '/inventory/reports', count: s.outOfStock });
    if (s && s.lowStock > 0) out.push({ key: 'low_stock', severity: 'warn', title: 'Low stock', detail: `${plural(s.lowStock, 'part')} at or below their reorder point.`, href: '/inventory/reports', count: s.lowStock });
    if (s && s.lateOrders) out.push({ key: 'late_orders', severity: 'warn', title: 'Late deliveries', detail: `${plural(s.lateOrders, 'purchase order')} past the expected date.`, href: '/purchase-orders', count: s.lateOrders });
  }

  if (can(ctx, 'invoice.view') && can(ctx, 'finance.view_reports')) {
    const r = await withTenant(bid, (tx) => receivables(tx, ctx)).catch(() => null);
    if (r && r.overdueCents > 0) {
      const n = (Object.entries(r.ageing) as [string, { count: number }][]).filter(([k]) => k !== 'current').reduce((a, [, v]) => a + v.count, 0);
      out.push({ key: 'overdue_invoices', severity: 'warn', title: 'Overdue invoices', detail: `${plural(n, 'invoice')} past their due date.`, href: '/reports/receivables', count: n });
    }
  }

  await withTenant(bid, async (tx) => {
    const week = new Date(Date.now() - 7 * 86_400_000);
    if (can(ctx, 'payment.view')) {
      const n = await tx.payment.count({ where: { businessId: bid, status: 'FAILED', createdAt: { gte: week } } });
      if (n > 0) out.push({ key: 'failed_payments', severity: 'danger', title: 'Failed payments', detail: `${plural(n, 'customer payment')} did not go through in the last 7 days.`, href: '/payments', count: n });
    }
    if (can(ctx, 'notification.view_history')) {
      const n = await tx.communication.count({ where: { businessId: bid, status: 'FAILED', createdAt: { gte: week } } });
      if (n > 0) out.push({ key: 'failed_messages', severity: 'warn', title: 'Messages that failed to send', detail: `${plural(n, 'message')} could not be delivered in the last 7 days.`, href: '/communications?status=FAILED', count: n });
    }
    if (can(ctx, 'document.manage')) {
      const n = await tx.documentGeneration.count({ where: { businessId: bid, status: 'FAILED' } });
      if (n > 0) out.push({ key: 'failed_documents', severity: 'warn', title: 'Documents that could not be generated', detail: `${plural(n, 'document')} failed. Retry them from Settings, Documents.`, href: '/settings/documents', count: n });
      const usage = await measureUsage(tx, bid);
      const limit = sub.limits.storageMb * 1024 * 1024;
      if (limit > 0 && usage.storageBytes / limit >= 0.85) {
        const pct = Math.round((usage.storageBytes / limit) * 100);
        out.push({ key: 'storage', severity: pct >= 100 ? 'danger' : 'warn', title: pct >= 100 ? 'Storage is full' : 'Storage is nearly full', detail: `${pct}% of your plan's storage is used.${pct >= 100 ? ' New uploads are refused until space is freed or the plan is upgraded.' : ''}`, href: '/settings/documents', count: 1 });
      }
    }
    if (can(ctx, 'report.manage_scheduled')) {
      const n = await tx.reportRun.count({ where: { businessId: bid, status: 'FAILED', createdAt: { gte: week } } });
      if (n > 0) out.push({ key: 'failed_reports', severity: 'warn', title: 'Scheduled reports that did not go out', detail: `${plural(n, 'run')} failed in the last 7 days.`, href: '/reports/schedules', count: n });
    }
    if (can(ctx, 'data.import')) {
      const n = await tx.importBatch.count({ where: { businessId: bid, status: 'FAILED', createdAt: { gte: week } } });
      if (n > 0) out.push({ key: 'failed_imports', severity: 'warn', title: 'Imports that failed', detail: `${plural(n, 'import')} could not be saved.`, href: '/admin/import', count: n });
    }
  });

  if (can(ctx, 'settings.view')) {
    const setup = await getSetupCheck(ctx).catch(() => null);
    const open = setup?.items.filter((i) => i.status === 'ACTION_REQUIRED').length ?? 0;
    if (open > 0) out.push({ key: 'setup', severity: 'info', title: 'Setup is not finished', detail: `${plural(open, 'item')} still need your attention.`, href: '/admin/setup', count: open });
  }
  void addDays; void todayIso;
  const order = { danger: 0, warn: 1, info: 2 } as const;
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

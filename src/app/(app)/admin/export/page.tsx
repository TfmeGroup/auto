import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, PageHeader } from '@/components/ui';
import { requireBusiness, assertCan } from '@/server/web/session';

export const metadata: Metadata = { title: 'Export' };
export const dynamic = 'force-dynamic';

export default async function ExportCentrePage() {
  const ctx = await requireBusiness();
  assertCan(ctx, 'business.export');
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  const rows: { href: string; label: string; text: string; show: boolean }[] = [
    { href: '/settings/export', label: 'Full business data export', text: 'A structured copy of your customers, vehicles, jobs, bookings, quotes, invoices, payments, stock, suppliers, team and more. Prepared in the background and kept private. Includes only what your role may see; passwords and secrets are never included.', show: ctx.subscription.features.has('data_export') },
    { href: '/reports', label: 'Report exports', text: 'Every report can be exported to CSV, Excel or PDF with its filters and chosen columns. Each export is recorded in the audit log.', show: can('report.view') && can('report.export') },
    { href: '/finance?tab=export', label: 'Accounting files', text: 'Invoices, payments, credit notes, refunds and VAT as clean rows for your accountant. This is data for accounting software, not an accounting integration.', show: can('finance.export') },
    { href: '/reports/accounting', label: 'Accounting export report', text: 'One combined file of invoices, credit notes, payments and refunds for any period.', show: can('finance.export') && can('report.view') },
    { href: '/inventory/reports', label: 'Stock exports', text: 'Parts, stock levels and movements.', show: can('inventory.export') },
    { href: '/audit', label: 'Audit log export', text: 'The audit log as a file (open the audit log and choose Export).', show: can('audit.view') },
  ];
  return (
    <>
      <PageHeader title="Export centre" description="Take data out of TFME Auto. Exports respect your role, your locations and your plan, and are recorded in the audit log." />
      <ul className="grid gap-2 sm:grid-cols-2">
        {rows.filter((r) => r.show).map((r) => <li key={r.href}><Link href={r.href}><Card className="h-full transition-colors hover:border-brand-500"><p className="font-medium">{r.label}</p><p className="mt-1 text-sm text-muted">{r.text}</p></Card></Link></li>)}
      </ul>
    </>
  );
}

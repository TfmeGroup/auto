import Link from 'next/link';
import { Alert } from '@/components/ui';
import { formatBytes } from '@/lib/format';
import type { StorageReport } from '@/server/files/usage';

/** How much of the plan's storage is used. The state is written in words, not only coloured. */
export function StorageMeter({ report, canBill }: { report: StorageReport; canBill: boolean }) {
  const pct = Math.min(100, report.percentUsed);
  const tone = report.state === 'ok' ? 'bg-brand-600' : report.state === 'near' ? 'bg-warn' : 'bg-danger';
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold">{formatBytes(report.usedBytes)} of {formatBytes(report.limitBytes)} used <span className="font-normal text-muted">({report.percentUsed}%)</span></p>
        <p className="text-xs text-muted">{report.fileCount.toLocaleString('en-ZA')} file{report.fileCount === 1 ? '' : 's'}{report.trashBytes > 0 ? ` · ${formatBytes(report.trashBytes)} in the trash` : ''}</p>
      </div>
      <div className="h-2.5 overflow-hidden rounded bg-line" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Storage used">
        <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      {report.state === 'near' && <Alert tone="warn">You are close to your storage limit. Nothing is deleted automatically.{canBill ? <> <Link href="/settings/billing" className="font-semibold underline">See plans</Link>.</> : ' Ask an owner about a larger plan.'}</Alert>}
      {(report.state === 'full' || report.state === 'over') && (
        <Alert tone="danger">
          {report.state === 'over' ? 'You are over your storage limit, so new uploads are blocked until space is freed or the plan is changed.' : 'Your storage is full, so new uploads are blocked.'} Existing files stay safe and available; nothing is deleted automatically.
          {canBill ? <> <Link href="/settings/billing" className="font-semibold underline">Upgrade your plan</Link>.</> : ' Ask an owner to upgrade the plan.'}
        </Alert>
      )}
    </div>
  );
}

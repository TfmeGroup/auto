import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, PageHeader } from '@/components/ui';
import { ReportBody } from '@/components/reports/ReportView';
import { qs } from '@/components/workshop/layout';
import { AppError } from '@/lib/errors';
import { exportPermission } from '@/server/reports/export';
import { runSavedReport } from '@/server/reports/saved';
import { requireBusiness } from '@/server/web/session';

export const metadata: Metadata = { title: 'Saved report' };
export const dynamic = 'force-dynamic';

export default async function SavedReportPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ page?: string }> }) {
  const ctx = await requireBusiness();
  const { id } = await params;
  const sp = await searchParams;
  const f = { currency: ctx.business.currency, locale: ctx.business.locale, timezone: ctx.business.timezone };
  let result = null;
  let problem: string | null = null;
  try {
    result = await runSavedReport(ctx, id, { page: Number(sp.page) || 1 });
  } catch (e) {
    if (e instanceof AppError && e.status === 404) problem = 'This report was not found, or it is not shared with you.';
    else problem = e instanceof AppError ? e.message : 'The report could not be produced.';
  }
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  const need = result ? exportPermission(result.category) : null;
  const mayExport = !!result && can('report.export') && (!need || can(need));
  return (
    <>
      <PageHeader
        title={result?.saved.name ?? 'Saved report'}
        actions={mayExport ? (['CSV', 'XLSX', 'PDF'] as const).map((fmt) => <a key={fmt} className="inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-4 text-sm font-semibold hover:bg-canvas md:min-h-10" href={`/api/v1/reports/saved/${id}/export${qs({ format: fmt })}`}>{fmt === 'XLSX' ? 'Excel' : fmt}</a>) : undefined}
      />
      <p className="-mt-3 mb-3 flex gap-4 text-sm"><Link href="/reports/saved" className="font-medium text-brand-700 hover:underline">← Saved reports</Link>{can('report.manage_scheduled') && <Link href="/reports/schedules" className="font-medium text-brand-700 hover:underline">Schedule this report</Link>}</p>
      {problem && <Alert tone="warn">{problem}</Alert>}
      {result && <ReportBody result={result} f={f} hrefFor={(p) => `/reports/saved/${id}${qs({ page: p > 1 ? String(p) : undefined })}`} />}
    </>
  );
}

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, EmptyState, LinkButton, PageHeader } from '@/components/ui';
import { ReportFilters } from '@/components/reports/ReportFilters';
import { ReportBody } from '@/components/reports/ReportView';
import { SaveViewForm } from '@/components/reports/SaveViewForm';
import { qs } from '@/components/workshop/layout';
import { AppError } from '@/lib/errors';
import { exportPermission } from '@/server/reports/export';
import { filterOptions } from '@/server/reports/options';
import { reportDef } from '@/server/reports/registry';
import { availableReports, runReport } from '@/server/reports/run';
import { requireBusiness } from '@/server/web/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ key: string }> }): Promise<Metadata> {
  const { key } = await params;
  return { title: reportDef(key)?.title ?? 'Report' };
}

const flat = (sp: Record<string, string | string[] | undefined>) => Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])) as Record<string, string | undefined>;

export default async function ReportPage({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireBusiness();
  const { key } = await params;
  const query = flat(await searchParams);
  const entry = availableReports(ctx).find((r) => r.key === key);
  const def = reportDef(key);
  if (!def || !entry) notFound();
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  const f = { currency: ctx.business.currency, locale: ctx.business.locale, timezone: ctx.business.timezone };

  if (entry.locked) {
    return (
      <>
        <PageHeader title={def.title} description={def.description} />
        <EmptyState title="Not included in your plan" action={can('settings.manage_billing') ? <LinkButton href="/settings/billing">See plans</LinkButton> : undefined}>This report is part of a higher plan. Your other reports are unaffected.</EmptyState>
      </>
    );
  }

  const options = await filterOptions(ctx, def.filters);
  let result = null;
  let problem: string | null = null;
  try {
    result = await runReport(ctx, key, query);
  } catch (e) {
    problem = e instanceof AppError ? e.message : 'The report could not be produced. Please try again.';
  }
  const base = { ...query };
  delete base.page;
  const hrefFor = (page: number) => `/reports/${key}${qs(base, { page: page > 1 ? String(page) : undefined })}`;
  const exportNeeds = exportPermission(def.category);
  const mayExport = can('report.export') && (!exportNeeds || can(exportNeeds)) && !def.noExport;
  const exportHref = (format: string) => `/api/v1/reports/${key}/export${qs(base, { format })}`;
  const { page: _p, ...config } = base;
  void _p;

  return (
    <>
      <PageHeader
        title={def.title}
        description={def.description}
        actions={mayExport && result ? (
          <>
            <a className="inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-4 text-sm font-semibold hover:bg-canvas md:min-h-10" href={exportHref('CSV')}>CSV</a>
            <a className="inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-4 text-sm font-semibold hover:bg-canvas md:min-h-10" href={exportHref('XLSX')}>Excel</a>
            <a className="inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-4 text-sm font-semibold hover:bg-canvas md:min-h-10" href={exportHref('PDF')}>PDF</a>
          </>
        ) : undefined}
      />
      <p className="-mt-3 mb-3 text-sm"><Link href="/reports" className="font-medium text-brand-700 hover:underline">← All reports</Link></p>
      <div className="space-y-4">
        <ReportFilters reportKey={key} filters={entry.filters} groupBys={entry.groupBys} options={options} query={query} />
        {problem && <Alert tone="warn">{problem}</Alert>}
        {result && <ReportBody result={result} f={f} hrefFor={hrefFor} />}
        {result && <SaveViewForm reportKey={key} config={config} canShare={can('report.manage')} defaultName={def.title} />}
      </div>
    </>
  );
}

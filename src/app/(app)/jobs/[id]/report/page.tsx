import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, Badge, PageHeader } from '@/components/ui';
import { InspectionStatusBadge, WorkPriorityBadge } from '@/components/workshop/badges';
import { PrintButton } from '@/components/workshop/PrintButton';
import { getInspectionReport } from '@/server/jobcards/reports';
import { assertCan, requireBusiness } from '@/server/web/session';
import { formatDate, formatDateTime } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { isAppError } from '@/lib/errors';

export const metadata: Metadata = { title: 'Inspection report' };
export const dynamic = 'force-dynamic';

export default async function ReportPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ audience?: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'job.view');
  const { id } = await params;
  const sp = await searchParams;
  const audience = sp.audience === 'customer' ? 'customer' : 'internal';
  let r;
  try {
    r = await getInspectionReport(ctx, id, { audience });
  } catch (e) {
    if (isAppError(e) && (e.status === 404 || e.status === 422)) notFound();
    throw e;
  }
  const tz = ctx.business.timezone;
  const loc = ctx.business.locale;
  const customerView = r.audience === 'customer';

  return (
    <div className="mx-auto max-w-3xl print:max-w-none">
      <div className="print:hidden">
        <PageHeader
          title="Inspection report"
          description={customerView ? 'Customer version: only what is marked for the customer.' : 'Internal version: includes notes and photos that are not for the customer.'}
          actions={<><PrintButton /><Link href={`/jobs/${id}`} className="inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-4 text-sm font-semibold md:min-h-10">Back to the job</Link></>}
        />
        {!customerView && <div className="mb-3"><Alert tone="warn">Internal version — do not give this to the customer. <Link className="font-semibold underline" href={`/jobs/${id}/report?audience=customer`}>Open the customer version</Link>.</Alert></div>}
        {customerView && <div className="mb-3 text-sm"><Link className="font-medium text-brand-700 hover:underline" href={`/jobs/${id}/report?audience=internal`}>Open the internal version</Link></div>}
      </div>

      <article className="space-y-5 rounded-xl border border-line bg-surface p-5 print:border-0 print:p-0">
        <header className="border-b border-line pb-3">
          <h1 className="text-xl font-bold">{r.business.name}</h1>
          <p className="text-sm text-muted">{[r.business.phone, r.business.email].filter(Boolean).join(' · ')}</p>
          <h2 className="mt-2 text-lg font-semibold">Vehicle inspection report{customerView ? '' : ' (internal)'}</h2>
        </header>

        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div><dt className="inline text-muted">Customer: </dt><dd className="inline font-medium">{r.customer.name}</dd></div>
          <div><dt className="inline text-muted">Job: </dt><dd className="inline font-medium">{r.job.jobNumber}</dd></div>
          <div><dt className="inline text-muted">Vehicle: </dt><dd className="inline font-medium">{[r.vehicle.registration, r.vehicle.year, r.vehicle.make, r.vehicle.model, r.vehicle.colour].filter(Boolean).join(' ')}</dd></div>
          <div><dt className="inline text-muted">Inspected: </dt><dd className="inline font-medium">{formatDateTime(r.inspection.date, tz, loc)}</dd></div>
          <div><dt className="inline text-muted">Technician: </dt><dd className="inline font-medium">{r.inspection.technician ?? '—'}</dd></div>
          <div><dt className="inline text-muted">Mileage: </dt><dd className="inline font-medium">{r.job.mileageInKm !== null ? `${r.job.mileageInKm.toLocaleString('en-ZA')} km` : '—'}</dd></div>
        </dl>

        <p className="text-sm">
          <Badge tone="ok">{r.inspection.totals.good} good</Badge>{' '}<Badge tone="warn">{r.inspection.totals.attention} need attention</Badge>{' '}<Badge tone="danger">{r.inspection.totals.critical} critical</Badge>
        </p>
        {r.inspection.summary && <p className="whitespace-pre-wrap text-sm">{r.inspection.summary}</p>}
        {'internalNotes' in r.inspection && r.inspection.internalNotes && <p className="rounded-lg bg-warn-bg p-2 text-sm"><strong>Internal notes:</strong> {r.inspection.internalNotes}</p>}

        {r.inspection.sections.map((s) => (
          <section key={s.category} className="break-inside-avoid">
            <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted">{s.label}</h3>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {s.items.map((i) => (
                <li key={i.label} className="px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{i.label}{i.measurement ? ` — ${i.measurement.value} ${i.measurement.unit ?? ''}` : ''}</span>
                    <InspectionStatusBadge status={i.status} />
                  </div>
                  {i.customerNotes && <p className="mt-0.5 text-muted">{i.customerNotes}</p>}
                  {'internalNotes' in i && i.internalNotes && <p className="mt-0.5 text-warn">Internal: {i.internalNotes}</p>}
                  {i.photos.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-2">
                      {i.photos.map((p) => (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img key={p.fileId} src={`/api/v1/files/${p.fileId}`} alt={p.description ?? i.label} className="size-24 rounded-md border border-line object-cover" />
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}

        {r.diagnoses.length > 0 && (
          <section className="break-inside-avoid">
            <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted">Diagnosis</h3>
            <ul className="space-y-2 text-sm">
              {r.diagnoses.map((d, idx) => (
                <li key={idx} className="rounded-lg border border-line p-3">
                  <p className="text-xs text-muted">{formatDate(d.date, tz, loc)}</p>
                  {d.summary && <p>{d.summary}</p>}
                  {!customerView && (
                    <>
                      {d.symptoms && <p><strong>Symptoms:</strong> {d.symptoms}</p>}
                      {(d.faultCodes?.length ?? 0) > 0 && <p><strong>Fault codes:</strong> {d.faultCodes?.join(', ')}</p>}
                      {d.testsPerformed && <p><strong>Tests:</strong> {d.testsPerformed}</p>}
                      {d.findings && <p><strong>Findings:</strong> {d.findings}</p>}
                      {d.diagnosis && <p><strong>Technician’s diagnosis:</strong> {d.diagnosis} {d.confirmed ? '(confirmed)' : '(not confirmed)'}</p>}
                      {d.internalNotes && <p className="text-warn">Internal: {d.internalNotes}</p>}
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {r.recommendedWork.length > 0 && (
          <section className="break-inside-avoid">
            <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted">Recommended work</h3>
            <p className="mb-1 text-xs text-muted">These are recommendations. Nothing is done until you approve it.</p>
            <ul className="divide-y divide-line rounded-lg border border-line text-sm">
              {r.recommendedWork.map((w, idx) => (
                <li key={idx} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <span><span className="font-medium">{w.description}</span>{w.quantity > 1 ? ` × ${w.quantity}` : ''}{w.estimatedMinutes ? ` · about ${w.estimatedMinutes} min` : ''}{'notes' in w && w.notes ? <span className="block text-warn">Internal: {w.notes}</span> : null}</span>
                  <span className="flex items-center gap-2">
                    {'estimatedPriceCents' in w && w.estimatedPriceCents ? <span className="font-medium">{formatMoney(w.estimatedPriceCents, ctx.business.currency, loc)}</span> : null}
                    <WorkPriorityBadge priority={w.priority} />
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {r.photos.length > 0 && (
          <section className="break-inside-avoid">
            <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted">Photos</h3>
            <div className="flex flex-wrap gap-2">
              {r.photos.map((p) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={p.fileId} src={`/api/v1/files/${p.fileId}`} alt={p.description ?? p.category} className="size-28 rounded-md border border-line object-cover" />
              ))}
            </div>
          </section>
        )}

        {r.updates.length > 0 && (
          <section className="break-inside-avoid">
            <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted">Updates</h3>
            <ul className="space-y-1 text-sm">{r.updates.map((u, idx) => <li key={idx}><span className="text-xs text-muted">{formatDateTime(u.at, tz, loc)}</span><br />{u.body}</li>)}</ul>
          </section>
        )}
        <p className="text-xs text-muted">Generated {formatDateTime(r.generatedAt, tz, loc)}.</p>
      </article>
    </div>
  );
}


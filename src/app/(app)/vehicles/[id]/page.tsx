import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, Card, EmptyState, LinkButton, PageHeader, Pagination } from '@/components/ui';
import { ActionButton } from '@/components/forms/RowActions';
import { InlineForm } from '@/components/forms/InlineForm';
import { ActivityTimeline, Row, Stat, Tabs, kmFmt, qs } from '@/components/workshop/layout';
import { JobList } from '@/components/workshop/Lists';
import { FilesPanel } from '@/components/workshop/FilesPanel';
import { HealthBadge, VehicleStatusBadge, WorkPriorityBadge, ApprovalBadge, vehicleStatusLabel } from '@/components/workshop/badges';
import { listJobs } from '@/server/jobcards/service';
import { listVehicleDiagnostics } from '@/server/jobcards/work';
import { getVehicle, listMileage, vehicleLabel, VEHICLE_STATUSES } from '@/server/vehicles/service';
import { getVehicleOverview, listIntervals, listServiceHistory, listVehicleParts, listVehiclePhotos } from '@/server/vehicles/insights';
import { listServiceTypes } from '@/server/workshop/service';
import { assertCan, requireBusiness } from '@/server/web/session';
import { formatDate, formatDateTime } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { isAppError } from '@/lib/errors';
import { InvoicesTab, QuotesTab, VehicleFinancialTab } from '@/components/finance/FinanceTabs';
import { getVehicleFinancials } from '@/server/finance/insights';

export const metadata: Metadata = { title: 'Vehicle' };
export const dynamic = 'force-dynamic';

type Ctx = Awaited<ReturnType<typeof requireBusiness>>;
interface TabProps { ctx: Ctx; id: string; page: number; hrefTab: (k: string) => string; fmt: { tz: string; locale: string } }

const FUEL: Record<string, string> = { PETROL: 'Petrol', DIESEL: 'Diesel', HYBRID: 'Hybrid', ELECTRIC: 'Electric', LPG: 'LPG', OTHER: 'Other' };
const TRANS: Record<string, string> = { MANUAL: 'Manual', AUTOMATIC: 'Automatic', CVT: 'CVT', DCT: 'DCT', OTHER: 'Other' };
const DRIVE: Record<string, string> = { FWD: 'Front-wheel drive', RWD: 'Rear-wheel drive', AWD: 'All-wheel drive', FOUR_BY_FOUR: '4x4', OTHER: 'Other' };
const SOURCE: Record<string, string> = { CREATED: 'Vehicle added', MANUAL: 'Recorded by hand', BOOKING: 'At booking', CHECK_IN: 'At check-in', JOB_CREATED: 'Job opened', SERVICE: 'Service', JOB_COMPLETION: 'Job completed', CORRECTION: 'Correction' };

async function OverviewTab({ ctx, id, fmt }: TabProps) {
  const can = (p: Parameters<Ctx['permissions']['has']>[0]) => ctx.permissions.has(p);
  const [o, intervals, types] = await Promise.all([getVehicleOverview(ctx, id), listIntervals(ctx, id), can('vehicle.edit') ? listServiceTypes(ctx) : Promise.resolve([])]);
  const v = o.vehicle;
  const archived = !!v.archivedAt;
  const h = o.health;
  // Spend comes from this vehicle's own invoices (not from the customer's account).
  const money = (can('invoice.view') ? ((await getVehicleFinancials(ctx, id).catch(() => null)) as { totals?: { spendExVatCents: number; outstandingCents: number } } | null) : null)?.totals;
  const canWrite = ctx.subscription.canWrite && !archived;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Mileage" value={kmFmt(v.mileageKm)} />
        <Stat label="Total jobs" value={o.totalJobs} />
        <Stat label="Last service" value={o.lastService?.completedAt ? formatDate(o.lastService.completedAt, fmt.tz, fmt.locale) : '—'} hint={o.lastService?.jobNumber} />
        <Stat label="Next service" value={o.nextService ? (o.nextService.nextDueAt ? formatDate(o.nextService.nextDueAt, fmt.tz, fmt.locale) : kmFmt(o.nextService.nextDueKm)) : '—'} hint={o.nextService?.name} />
        <Stat label="Outstanding work" value={o.outstandingWork} />
        <Stat label="Spend" value={money ? formatMoney(money.spendExVatCents, ctx.business.currency, ctx.business.locale) : '—'} hint={money ? (money.outstandingCents > 0 ? `${formatMoney(money.outstandingCents, ctx.business.currency, ctx.business.locale)} outstanding` : 'excluding VAT') : 'No access to invoices'} />
      </div>

      {h && (
        <Card>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">Health indicator</h2>
            <HealthBadge level={h.level} />
          </div>
          <p className="mb-2 text-xs text-muted">Worked out from recorded inspections, outstanding recommended work and overdue servicing — not a diagnosis.{h.inspectedAt ? ` Last inspection ${formatDate(h.inspectedAt, fmt.tz, fmt.locale)}.` : ' No completed inspection on record.'}</p>
          {h.facts.length === 0 ? <p className="text-sm text-muted">Nothing outstanding is recorded.</p> : (
            <ul className="space-y-1 text-sm">
              {h.facts.map((f, i) => <li key={i} className="flex gap-2"><span aria-hidden>•</span><span>{f.jobId ? <Link className="hover:underline" href={`/jobs/${f.jobId}`}>{f.text}</Link> : f.text}</span></li>)}
            </ul>
          )}
          {h.outstandingWork.length > 0 && (
            <div className="mt-3 border-t border-line pt-3">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Recommended work not yet done (recommendations)</p>
              <ul className="space-y-1.5 text-sm">
                {h.outstandingWork.map((w) => <li key={w.id} className="flex flex-wrap items-center gap-2"><WorkPriorityBadge priority={w.priority} /><ApprovalBadge status={w.approvalStatus} /><Link href={`/jobs/${w.jobId}`} className="hover:underline">{w.description}</Link></li>)}
              </ul>
            </div>
          )}
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mb-1 text-base font-semibold">Details</h2>
          <dl className="divide-y divide-line">
            <Row label="Owner"><Link href={`/customers/${v.customer.id}`} className="text-brand-700 hover:underline">{v.customer.name}</Link> <span className="text-muted">{v.customer.customerNumber}</span></Row>
            <Row label="Registration">{v.registration}</Row>
            <Row label="VIN">{v.vin}</Row>
            <Row label="Vehicle">{[v.year, v.make, v.model, v.variant].filter(Boolean).join(' ')}</Row>
            <Row label="Colour">{v.colour}</Row>
            <Row label="Engine">{[v.engine, v.engineSizeCc ? `${v.engineSizeCc} cc` : null].filter(Boolean).join(' · ')}</Row>
            <Row label="Fuel">{v.fuelType && FUEL[v.fuelType]}</Row>
            <Row label="Transmission">{v.transmission && TRANS[v.transmission]}</Row>
            <Row label="Drive">{v.driveType && DRIVE[v.driveType]}</Row>
            <Row label="Current job">{o.activeJob ? <Link className="text-brand-700 hover:underline" href={`/jobs/${o.activeJob.id}`}>{o.activeJob.jobNumber}</Link> : null}</Row>
            <Row label="Notes"><span className="whitespace-pre-wrap">{v.notes}</span></Row>
          </dl>
          <h3 className="mb-1 mt-4 text-sm font-semibold">Additional authorised contacts</h3>
          {v.contacts.length === 0 ? <p className="text-sm text-muted">None.</p> : (
            <ul className="divide-y divide-line text-sm">
              {v.contacts.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2 py-2">
                  <span>{c.name}{c.relationship ? ` (${c.relationship})` : ''}{c.mobile ? ` · ${c.mobile}` : ''}</span>
                  {can('vehicle.edit') && canWrite && <ActionButton label="Remove" variant="ghost" method="DELETE" path={`/api/v1/vehicles/${v.id}/contacts/${c.id}`} confirm="Remove this contact?" />}
                </li>
              ))}
            </ul>
          )}
          {can('vehicle.edit') && canWrite && (
            <details className="mt-2"><summary className="min-h-11 cursor-pointer text-sm font-medium text-brand-700 leading-[2.75rem]">Add a contact</summary>
              <InlineForm endpoint={`/api/v1/vehicles/${v.id}/contacts`} submitLabel="Add contact" variant="secondary" fields={[
                { name: 'name', label: 'Name', required: true }, { name: 'relationship', label: 'Relationship' }, { name: 'mobile', label: 'Mobile', type: 'tel' },
              ]} />
            </details>
          )}
        </Card>

        <div className="space-y-4">
          {can('vehicle.edit') && canWrite && (
            <Card>
              <h2 className="mb-2 text-base font-semibold">Status</h2>
              <p className="mb-2 text-xs text-muted">Jobs move this automatically as they progress (and record why). Set it here to override.</p>
              <InlineForm endpoint={`/api/v1/vehicles/${v.id}/status`} submitLabel="Set status" variant="secondary" resetOnSuccess={false} fields={[
                { name: 'status', label: 'Status', type: 'select', defaultValue: v.status, options: VEHICLE_STATUSES.map((s) => ({ value: s, label: vehicleStatusLabel(s) })) },
                { name: 'reason', label: 'Reason (optional)' },
              ]} />
            </Card>
          )}
          {can('vehicle.edit') && canWrite && (
            <Card>
              <h2 className="mb-2 text-base font-semibold">Record mileage</h2>
              <InlineForm endpoint={`/api/v1/vehicles/${v.id}/mileage`} submitLabel="Record" variant="secondary" fields={[
                { name: 'mileageKm', label: 'Odometer (km)', type: 'number', required: true, hint: `Last recorded: ${kmFmt(v.mileageKm)}. It cannot go down.` }, { name: 'note', label: 'Note (optional)' },
              ]} />
              {can('vehicle.correct_mileage') && (
                <details className="mt-3"><summary className="min-h-11 cursor-pointer text-sm font-medium text-brand-700 leading-[2.75rem]">Correct a wrong reading</summary>
                  <InlineForm endpoint={`/api/v1/vehicles/${v.id}/mileage/correct`} submitLabel="Correct mileage" variant="secondary" fields={[
                    { name: 'mileageKm', label: 'Correct odometer (km)', type: 'number', required: true }, { name: 'reason', label: 'Reason', required: true, hint: 'Kept in the history; the earlier reading is not erased.' },
                  ]} />
                </details>
              )}
            </Card>
          )}
          <Card>
            <h2 className="mb-2 text-base font-semibold">Service intervals</h2>
            {intervals.filter((i) => i.active).length === 0 ? <p className="text-sm text-muted">No maintenance schedule set.</p> : (
              <ul className="divide-y divide-line text-sm">
                {intervals.filter((i) => i.active).map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div>
                      <p className="font-medium">{i.name} {i.status.overdue && <Badge tone="danger">Overdue</Badge>}</p>
                      <p className="text-xs text-muted">
                        {[i.everyKm ? `every ${i.everyKm.toLocaleString('en-ZA')} km` : null, i.everyMonths ? `every ${i.everyMonths} months` : null].filter(Boolean).join(' or ')}
                        {i.status.needsBaseline ? ' · no previous service recorded' : ` · next ${[i.status.nextDueKm !== null ? kmFmt(i.status.nextDueKm) : null, i.status.nextDueAt ? formatDate(i.status.nextDueAt, fmt.tz, fmt.locale) : null].filter(Boolean).join(' / ')}`}
                      </p>
                    </div>
                    {can('vehicle.edit') && canWrite && (
                      <div className="flex gap-1">
                        <ActionButton label="Mark serviced" variant="secondary" path={`/api/v1/vehicles/${v.id}/intervals/${i.id}/serviced`} body={{}} />
                        <ActionButton label="Remove" variant="ghost" method="DELETE" path={`/api/v1/vehicles/${v.id}/intervals/${i.id}`} confirm="Stop tracking this service?" />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {can('vehicle.edit') && canWrite && (
              <details className="mt-2"><summary className="min-h-11 cursor-pointer text-sm font-medium text-brand-700 leading-[2.75rem]">Add a service interval</summary>
                <InlineForm endpoint={`/api/v1/vehicles/${v.id}/intervals`} submitLabel="Add interval" variant="secondary" fields={[
                  { name: 'name', label: 'Name', required: true, placeholder: 'Oil service', span: 'full' },
                  { name: 'serviceTypeId', label: 'Resets when this service is completed', type: 'select', span: 'full', options: [{ value: '', label: 'Not linked to a service' }, ...types.map((t) => ({ value: t.id, label: t.name }))] },
                  { name: 'everyKm', label: 'Every (km)', type: 'number' }, { name: 'everyMonths', label: 'Every (months)', type: 'number' },
                  { name: 'lastServiceKm', label: 'Last serviced at (km)', type: 'number' }, { name: 'lastServiceAt', label: 'Last serviced on', type: 'date' },
                ]} />
              </details>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

async function HistoryTab({ ctx, id, page, hrefTab, fmt }: TabProps) {
  const { items, meta } = await listServiceHistory(ctx, id, { page, pageSize: 10 });
  if (items.length === 0) return <EmptyState title="No completed jobs yet">The service history is built from this vehicle’s completed job cards.</EmptyState>;
  const pricing = ctx.permissions.has('job.view_pricing');
  return (
    <>
      <ol className="space-y-3">
        {items.map((h) => (
          <li key={h.jobId}>
            <Card>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-semibold"><Link href={`/jobs/${h.jobId}`} className="text-brand-700 hover:underline">{h.jobNumber}</Link>{h.serviceType ? ` · ${h.serviceType}` : ''}</p>
                <p className="text-sm text-muted">{h.date ? formatDate(h.date, fmt.tz, fmt.locale) : ''} · {kmFmt(h.mileageKm)}</p>
              </div>
              {h.technician && <p className="text-sm text-muted">Technician: {h.technician}</p>}
              {h.summary && <p className="mt-1 text-sm">{h.summary}</p>}
              {h.workPerformed.length > 0 && <ul className="mt-2 list-disc pl-5 text-sm">{h.workPerformed.map((w, i) => <li key={i}>{w}</li>)}</ul>}
              {h.parts.length > 0 && <p className="mt-2 text-sm"><span className="font-medium">Parts:</span> {h.parts.map((p) => `${p.quantity} × ${p.description}${p.partNumber ? ` (${p.partNumber})` : ''}`).join(', ')}</p>}
              {h.labour.length > 0 && <p className="mt-1 text-sm"><span className="font-medium">Labour:</span> {h.labour.map((l) => `${l.description} (${l.minutes} min${pricing && 'totalCents' in l && l.totalCents != null ? `, ${formatMoney(l.totalCents, ctx.business.currency, ctx.business.locale)}` : ''})`).join('; ')}</p>}
              {h.photoCount > 0 && <p className="mt-1 text-xs text-muted">{h.photoCount} photo{h.photoCount === 1 ? '' : 's'} on the job</p>}
            </Card>
          </li>
        ))}
      </ol>
      <Pagination page={meta.page} totalPages={meta.totalPages} total={meta.total} hrefFor={(p) => `${hrefTab('history')}&page=${p}`} />
    </>
  );
}

async function JobsTab({ ctx, id, page, hrefTab, fmt }: TabProps) {
  const { items, meta } = await listJobs(ctx, { vehicleId: id, page, pageSize: 20 });
  if (items.length === 0) return <EmptyState title="No jobs yet">Jobs for this vehicle will appear here.</EmptyState>;
  return <><JobList items={items as never} fmt={fmt} /><Pagination page={meta.page} totalPages={meta.totalPages} total={meta.total} hrefFor={(p) => `${hrefTab('jobs')}&page=${p}`} /></>;
}

async function PartsTab({ ctx, id, fmt }: TabProps) {
  const parts = await listVehicleParts(ctx, id);
  if (parts.length === 0) return <EmptyState title="No parts recorded">Parts added to this vehicle’s jobs will be listed here.</EmptyState>;
  return (
    <Card>
      <ul className="divide-y divide-line text-sm">
        {parts.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
            <span>{p.quantity} × {p.description}{p.partNumber ? ` (${p.partNumber})` : ''}</span>
            <span className="text-xs text-muted"><Badge>{p.status.toLowerCase()}</Badge> <Link href={`/jobs/${p.jobId}`} className="hover:underline">{p.jobNumber}</Link> · {formatDate(p.date, fmt.tz, fmt.locale)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

async function DiagnosticsTab({ ctx, id, fmt }: TabProps) {
  const rows = await listVehicleDiagnostics(ctx, id);
  if (rows.length === 0) return <EmptyState title="No diagnostic records">Diagnoses recorded on this vehicle’s jobs will appear here.</EmptyState>;
  return (
    <ol className="space-y-3">
      {rows.map((d) => (
        <li key={d.id}>
          <Card>
            <p className="text-sm font-semibold"><Link href={`/jobs/${d.jobId}`} className="text-brand-700 hover:underline">{d.jobNumber}</Link> · {formatDateTime(d.recordedAt, fmt.tz, fmt.locale)}{d.technicianName ? ` · ${d.technicianName}` : ''}</p>
            {d.symptoms && <p className="mt-1 text-sm"><span className="font-medium">Symptoms:</span> {d.symptoms}</p>}
            {d.faultCodes.length > 0 && <p className="text-sm"><span className="font-medium">Fault codes:</span> {d.faultCodes.join(', ')}</p>}
            {d.testsPerformed && <p className="text-sm"><span className="font-medium">Tests:</span> {d.testsPerformed}</p>}
            {d.findings && <p className="text-sm"><span className="font-medium">Findings (observations):</span> {d.findings}</p>}
            {d.diagnosis && <p className="text-sm"><span className="font-medium">Technician’s diagnosis:</span> {d.diagnosis} {d.confirmedAt ? <Badge tone="ok">Confirmed</Badge> : <Badge tone="warn">Not confirmed</Badge>}</p>}
          </Card>
        </li>
      ))}
    </ol>
  );
}

async function PhotosTab({ ctx, id }: TabProps) {
  const photos = await listVehiclePhotos(ctx, id);
  if (photos.length === 0) return <EmptyState title="No photos yet">Photos taken on this vehicle’s jobs will appear here.</EmptyState>;
  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {photos.map((p) => (
        <li key={p.id} className="overflow-hidden rounded-lg border border-line bg-surface">
          <a href={`/api/v1/files/${p.fileId}`} target="_blank" rel="noopener noreferrer">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/v1/files/${p.fileId}`} alt={p.description ?? p.category.toLowerCase().replace(/_/g, ' ')} loading="lazy" className="aspect-square w-full object-cover" />
          </a>
          <p className="truncate px-2 py-1 text-xs text-muted">{p.jobNumber} · {p.category.toLowerCase().replace(/_/g, ' ')}</p>
        </li>
      ))}
    </ul>
  );
}

async function MileageTab({ ctx, id, page, hrefTab, fmt }: TabProps) {
  const { items, meta } = await listMileage(ctx, id, { page, pageSize: 25 });
  return (
    <>
      <Card>
        <ul className="divide-y divide-line text-sm">
          {items.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <span className="font-medium">{m.mileageKm.toLocaleString('en-ZA')} km {m.isCorrection && <Badge tone="warn">Correction</Badge>}</span>
              <span className="text-xs text-muted">{SOURCE[m.source]}{m.note ? ` — ${m.note}` : ''} · {m.recordedBy ?? 'System'} · {formatDateTime(m.recordedAt, fmt.tz, fmt.locale)}</span>
            </li>
          ))}
        </ul>
      </Card>
      <Pagination page={meta.page} totalPages={meta.totalPages} total={meta.total} hrefFor={(p) => `${hrefTab('mileage')}&page=${p}`} />
    </>
  );
}

export default async function VehiclePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; page?: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'vehicle.view');
  const { id } = await params;
  const sp = await searchParams;
  const can = (p: Parameters<Ctx['permissions']['has']>[0]) => ctx.permissions.has(p);
  const fmt = { tz: ctx.business.timezone, locale: ctx.business.locale };

  let v;
  try {
    v = await getVehicle(ctx, id);
  } catch (e) {
    if (isAppError(e) && (e.status === 404 || e.status === 422)) notFound();
    throw e;
  }
  const archived = !!v.archivedAt;
  // "Record inspection" goes to the vehicle's open job if it has one (an inspection always belongs to a job).
  const activeJobId = can('job.view') ? (await listJobs(ctx, { vehicleId: v.id, status: 'open', pageSize: 1 })).items[0]?.id : undefined;
  const tabs = [
    { key: 'overview', label: 'Overview', show: true },
    { key: 'history', label: 'Service history', show: can('job.view') },
    { key: 'jobs', label: 'Jobs', show: can('job.view') },
    { key: 'parts', label: 'Parts', show: can('job.view') },
    { key: 'diagnostics', label: 'Diagnostics', show: can('job.view') },
    { key: 'mileage', label: 'Mileage', show: true },
    { key: 'quotes', label: 'Quotes', show: can('quote.view') },
    { key: 'invoices', label: 'Invoices', show: can('invoice.view') },
    { key: 'financial', label: 'Financial', show: can('invoice.view') },
    { key: 'documents', label: 'Documents', show: can('document.view') },
    { key: 'photos', label: 'Photos', show: can('job.view') },
    { key: 'activity', label: 'Timeline', show: true },
  ].filter((t) => t.show);
  const tab = tabs.find((t) => t.key === sp.tab)?.key ?? 'overview';
  const page = Math.max(1, Number(sp.page) || 1);
  const hrefTab = (key: string) => `/vehicles/${v.id}${qs({ tab: key === 'overview' ? undefined : key })}`;
  const tp: TabProps = { ctx, id: v.id, page, hrefTab, fmt };

  return (
    <>
      <PageHeader
        title={v.registration ?? vehicleLabel(v)}
        description={[v.year, v.make, v.model].filter(Boolean).join(' ') || undefined}
        actions={
          <>
            {can('job.inspect') && !archived && <LinkButton href={activeJobId ? `/jobs/${activeJobId}?tab=inspection` : `/jobs/new?customerId=${v.customer.id}&vehicleId=${v.id}`} variant="secondary">Record inspection</LinkButton>}
            {can('booking.create') && !archived && <LinkButton href={`/bookings/new?customerId=${v.customer.id}&vehicleId=${v.id}`} variant="secondary">New booking</LinkButton>}
            {can('job.create') && !archived && <LinkButton href={`/jobs/new?customerId=${v.customer.id}&vehicleId=${v.id}`}>New job</LinkButton>}
          </>
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <VehicleStatusBadge status={v.status} />
        {archived && <Badge tone="warn">Archived</Badge>}
        <span className="text-sm text-muted">Owner: <Link href={`/customers/${v.customer.id}`} className="font-medium text-brand-700 hover:underline">{v.customer.name}</Link></span>
        {can('vehicle.edit') && !archived && <Link href={`/vehicles/${v.id}/edit`} className="text-sm font-medium text-brand-700 hover:underline">Edit</Link>}
        {can('vehicle.archive') && (
          <ActionButton label={archived ? 'Restore' : 'Archive'} variant="ghost" path={`/api/v1/vehicles/${v.id}/archive`} body={{ archived: !archived }} confirm={archived ? undefined : 'Archive this vehicle? It is hidden from lists but its history is kept, and you can restore it.'} />
        )}
      </div>
      <Tabs tabs={tabs} active={tab} hrefFor={hrefTab} />

      {tab === 'overview' && <OverviewTab {...tp} />}
      {tab === 'history' && <HistoryTab {...tp} />}
      {tab === 'jobs' && <JobsTab {...tp} />}
      {tab === 'parts' && <PartsTab {...tp} />}
      {tab === 'diagnostics' && <DiagnosticsTab {...tp} />}
      {tab === 'mileage' && <MileageTab {...tp} />}
      {tab === 'quotes' && <QuotesTab ctx={ctx} scope={{ vehicleId: v.id, customerId: v.customerId }} page={page} hrefFor={(p) => `${hrefTab('quotes')}&page=${p}`} canCreate={can('quote.create') && !archived} />}
      {tab === 'invoices' && <InvoicesTab ctx={ctx} scope={{ vehicleId: v.id, customerId: v.customerId }} page={page} hrefFor={(p) => `${hrefTab('invoices')}&page=${p}`} canCreate={can('invoice.create') && !archived} />}
      {tab === 'financial' && <VehicleFinancialTab ctx={ctx} vehicleId={v.id} />}
      {tab === 'documents' && <FilesPanel ctx={ctx} resourceType="vehicle" resourceId={v.id} archived={archived} />}
      {tab === 'photos' && <PhotosTab {...tp} />}
      {tab === 'activity' && <ActivityTimeline ctx={ctx} scope={{ vehicleId: v.id }} page={page} hrefFor={(p) => `${hrefTab('activity')}&page=${p}`} />}
    </>
  );
}

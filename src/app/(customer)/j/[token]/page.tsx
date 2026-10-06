import type { Metadata } from 'next';
import { Badge, Card } from '@/components/ui';
import { BusinessHeader, InvalidLink, Meta, MetaItem } from '@/components/finance/CustomerDocShell';
import { isAppError } from '@/lib/errors';
import { formatBytes, formatDate, formatDateTime } from '@/lib/format';
import { getPublicJob } from '@/server/documents/customer';
import { publicMeta } from '@/server/web/public-meta';

export const metadata: Metadata = { title: 'Your vehicle' };

/** The customer's view of their job, behind their private link: progress, the updates meant for them, and the photos and documents the workshop chose to share. */
export default async function CustomerJobPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let j;
  try {
    j = await getPublicJob(token, await publicMeta());
  } catch (e) {
    if (isAppError(e) && e.code === 'NOT_FOUND') return <InvalidLink />;
    throw e;
  }
  const day = (d: Date | null) => (d ? formatDate(d, j.business.timezone, j.business.locale) : '');

  return (
    <div className="space-y-4">
      <BusinessHeader business={{ ...j.business, vatNumber: null, registrationNumber: null }} logoSrc={`/api/public/jobs/${token}/logo`} />
      <Card className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted">Job</p>
            <h2 className="text-xl font-bold">{j.job.number}</h2>
            <p className="text-sm text-muted">{j.vehicle.label}</p>
          </div>
          <Badge tone={j.job.status === 'COMPLETED' ? 'ok' : j.job.status === 'CANCELLED' ? 'danger' : 'brand'}>{j.job.statusLabel}</Badge>
        </div>
        <Meta>
          <MetaItem label="For">{j.customer.name}</MetaItem>
          <MetaItem label="Opened">{day(j.job.openedAt)}</MetaItem>
          <MetaItem label="Expected">{day(j.job.estimatedCompletionAt)}</MetaItem>
          <MetaItem label="Completed">{day(j.job.completedAt)}</MetaItem>
        </Meta>
      </Card>

      {j.updates.length > 0 && (
        <Card>
          <h2 className="mb-2 text-base font-semibold">Updates from the workshop</h2>
          <ul className="space-y-3">{j.updates.map((u, i) => <li key={i}><p className="text-xs text-muted">{formatDateTime(u.at, j.business.timezone, j.business.locale)}</p><p className="whitespace-pre-wrap text-sm">{u.body}</p></li>)}</ul>
        </Card>
      )}

      {j.photos.length > 0 && (
        <Card>
          <h2 className="mb-2 text-base font-semibold">Photos</h2>
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {j.photos.map((p) => (
              <li key={p.id} className="space-y-1">
                <a href={`/api/public/jobs/${token}/files/${p.id}`} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-lg border border-line" aria-label={`Open photo${p.caption ? `: ${p.caption}` : ''}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/public/jobs/${token}/files/${p.id}${p.thumbnail ? '?thumb=1' : ''}`} alt={p.caption ?? 'Photo of your vehicle'} loading="lazy" className="aspect-square w-full object-cover" />
                </a>
                {p.caption && <p className="text-xs text-muted">{p.caption}</p>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {j.documents.length > 0 && (
        <Card>
          <h2 className="mb-2 text-base font-semibold">Documents</h2>
          <ul className="divide-y divide-line">
            {j.documents.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0"><p className="truncate text-sm font-medium">{d.name}</p><p className="text-xs text-muted">{formatBytes(d.sizeBytes)} · {day(d.createdAt)}</p></div>
                <a href={`/api/public/jobs/${token}/files/${d.id}?download=1`} className="inline-flex min-h-11 shrink-0 items-center rounded-lg border border-line px-4 text-sm font-semibold text-brand-700 hover:bg-canvas">Download</a>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {j.updates.length === 0 && j.photos.length === 0 && j.documents.length === 0 && (
        <Card><p className="text-sm text-muted">There is nothing to show yet. {j.business.name} will share updates, photos and documents here as the job progresses. Questions? {j.business.phone ?? j.business.email ?? 'Please contact the workshop'}.</p></Card>
      )}
    </div>
  );
}

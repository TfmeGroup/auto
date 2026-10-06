import Link from 'next/link';
import { Card } from '@/components/ui';
import { DocumentUploader } from '@/components/documents/DocumentUploader';
import { GenerateButton } from '@/components/documents/GenerateButton';
import { DocRow, Thumb, VisibilityBadge } from '@/components/documents/shared';
import { listCategories } from '@/server/files/categories';
import { RESOURCES } from '@/server/files/registry';
import { searchDocuments } from '@/server/files/search';
import { getDocumentSettings } from '@/server/files/settings';
import type { DocKind } from '@/server/documents/generator';
import type { BusinessContext } from '@/server/context';

/**
 * The documents and photos on one record, through the one shared document system. Shows only what the viewer may see; uploading needs
 * permission and a writable subscription. Photos show as thumbnails (the small copy), documents as a list. Buttons for documents the
 * system can make from this record (a job summary, an inspection report, ...) appear when asked for.
 */
export async function DocumentsPanel({
  ctx, resourceType, resourceId, kind = 'all', title, archived = false, generate = [], defaultCategory,
}: {
  ctx: BusinessContext;
  resourceType: string;
  resourceId: string;
  kind?: 'photos' | 'documents' | 'all';
  title?: string;
  archived?: boolean;
  generate?: { kind: DocKind; label: string }[];
  defaultCategory?: string;
}) {
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  if (!can('document.view')) return <Card><p className="text-sm text-muted">You do not have access to documents.</p></Card>;
  const rule = RESOURCES[resourceType];
  const [found, cats, settings] = await Promise.all([
    searchDocuments(ctx, { resourceType, resourceId, pageSize: 60, state: 'active' }),
    listCategories(ctx),
    getDocumentSettings(ctx),
  ]);
  const all = found.items;
  const isImage = (m: string) => m.startsWith('image/');
  const files = kind === 'photos' ? all.filter((f) => isImage(f.mimeType)) : kind === 'documents' ? all.filter((f) => !isImage(f.mimeType)) : all;
  const photos = kind === 'all' ? all.filter((f) => isImage(f.mimeType)) : [];
  const docs = kind === 'all' ? all.filter((f) => !isImage(f.mimeType)) : files;
  const canUpload = can('document.upload') && ctx.subscription.canWrite && !archived && (!rule?.write || can(rule.write));
  const choices = cats.filter((c) => c.active).map((c) => ({ key: c.key, label: c.label }));
  const heading = title ?? (kind === 'photos' ? 'Photos' : kind === 'documents' ? 'Documents' : 'Documents & photos');

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{heading}</h2>
        <Link href={`/documents?resourceType=${resourceType}&resourceId=${resourceId}`} className="inline-flex min-h-11 items-center text-sm text-brand-600 hover:underline md:min-h-9">Open in the library</Link>
      </div>
      {generate.length > 0 && ctx.subscription.canWrite && !archived && (
        <div className="flex flex-wrap gap-2">{generate.map((g) => <GenerateButton key={g.kind} kind={g.kind} id={resourceId} label={g.label} />)}</div>
      )}
      {canUpload && (
        <DocumentUploader resourceType={resourceType} resourceId={resourceId} categories={choices} defaultCategory={defaultCategory ?? rule?.defaultCategory ?? 'OTHER'} canShare={can('document.share') && !!rule?.customerShareable} canRestrict={can('document.view_restricted')} photosOnly={kind === 'photos'} maxMb={settings.effectiveMaxUploadMb} />
      )}
      {files.length === 0 ? (
        <p className="text-sm text-muted">{kind === 'photos' ? 'No photos yet. Use "Take photo" to add one.' : 'No documents yet. Use "Choose files" to upload one.'}</p>
      ) : (
        <>
          {(kind === 'photos' ? files : photos).length > 0 && (
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
              {(kind === 'photos' ? files : photos).map((f) => (
                <li key={f.id} className="space-y-1">
                  <Link href={`/documents/${f.id}`} className="block overflow-hidden rounded-lg border border-line" aria-label={`Open photo ${f.name}`}>
                    {f.hasThumbnail ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={`/api/v1/files/${f.id}?thumb=1`} alt={f.description ?? f.name} loading="lazy" className="aspect-square w-full object-cover" />
                    ) : (
                      <div className="flex aspect-square items-center justify-center bg-canvas"><Thumb f={f} size="size-16" /></div>
                    )}
                  </Link>
                  <VisibilityBadge v={f.visibility} />
                </li>
              ))}
            </ul>
          )}
          {kind !== 'photos' && docs.length > 0 && (
            <ul className="divide-y divide-line">
              {docs.map((f) => <DocRow key={f.id} f={f} locale={ctx.business.locale} tz={ctx.business.timezone} />)}
            </ul>
          )}
        </>
      )}
      {found.meta.total > 60 && <p className="text-xs text-muted">Showing the 60 most recent. <Link href={`/documents?resourceType=${resourceType}&resourceId=${resourceId}`} className="text-brand-600 underline">See all {found.meta.total}</Link>.</p>}
    </Card>
  );
}

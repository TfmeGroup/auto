import Link from 'next/link';
import { Badge } from '@/components/ui';
import { formatBytes, formatDate } from '@/lib/format';
import type { FileView } from '@/server/files/service';

/** Document status shown in words as well as colour, so it never relies on colour alone. */
export function VisibilityBadge({ v }: { v: FileView['visibility'] }) {
  if (v === 'CUSTOMER') return <Badge tone="brand">Customer can see</Badge>;
  if (v === 'RESTRICTED') return <Badge tone="warn">Restricted</Badge>;
  return <Badge>Staff only</Badge>;
}

export function StatusBadge({ status }: { status: string }) {
  if (status === 'ARCHIVED') return <Badge tone="warn">Archived</Badge>;
  if (status === 'TRASHED') return <Badge tone="danger">In trash</Badge>;
  if (status === 'DELETED') return <Badge tone="danger">Deleted</Badge>;
  return null;
}

export const kindIcon = (mime: string) => (mime.startsWith('image/') ? 'Photo' : mime === 'application/pdf' ? 'PDF' : mime.includes('spreadsheet') || mime === 'text/csv' ? 'Sheet' : mime.includes('word') ? 'Doc' : 'File');

/** A small square: the photo's thumbnail when there is one, otherwise a label for the kind of file. */
export function Thumb({ f, size = 'size-12' }: { f: Pick<FileView, 'id' | 'mimeType' | 'hasThumbnail' | 'name'>; size?: string }) {
  if (f.hasThumbnail) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={`/api/v1/files/${f.id}?thumb=1`} alt="" loading="lazy" className={`${size} shrink-0 rounded-md border border-line bg-canvas object-cover`} />
    );
  }
  return <span aria-hidden className={`${size} flex shrink-0 items-center justify-center rounded-md border border-line bg-canvas text-[10px] font-semibold uppercase text-muted`}>{kindIcon(f.mimeType)}</span>;
}

export function DocRow({ f, locale, tz, children }: { f: FileView; locale: string; tz: string; children?: React.ReactNode }) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      <Thumb f={f} />
      <div className="min-w-0 flex-1">
        <Link href={`/documents/${f.id}`} className="block min-h-6 truncate text-sm font-medium text-brand-700 hover:underline">{f.name}</Link>
        <p className="text-xs text-muted">
          {formatBytes(f.sizeBytes)} · {formatDate(f.createdAt, tz, locale)}{f.uploadedByName ? ` · ${f.uploadedByName}` : f.source === 'GENERATED' ? ' · Generated' : ''}{f.version > 1 ? ` · version ${f.version}` : ''}
        </p>
        <div className="mt-1 flex flex-wrap gap-1"><VisibilityBadge v={f.visibility} /><StatusBadge status={f.status} />{f.source === 'GENERATED' && <Badge>Generated</Badge>}</div>
        {children}
      </div>
    </li>
  );
}

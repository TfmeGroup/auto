import { Readable } from 'node:stream';
import { INLINE_SAFE } from './sniff';

/**
 * How a stored file is handed to a browser. Whatever the file is, the browser is told what it is (from our own detection, never from
 * the uploader), forbidden from guessing, and kept from running anything in it. Only types that are safe to show inline are ever
 * shown inline; everything else downloads. Private files are never cached by a shared cache.
 */
const HEADERS = { 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' } as const;
// A built-in PDF viewer does not work inside a `sandbox` policy; everything else gets the strictest policy.
const CSP = (mime: string) => (mime === 'application/pdf' ? "default-src 'none'; object-src 'self'; style-src 'unsafe-inline'" : "default-src 'none'; sandbox");

const asciiName = (n: string) => n.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');

export function fileResponse(r: { file: { originalName: string; displayName?: string | null; sizeBytes: number }; stream: Readable; size?: number; mimeType: string; isThumbnail?: boolean }, opts: { download?: boolean }): Response {
  const name = r.file.displayName || r.file.originalName;
  const inline = !opts.download && (r.isThumbnail || INLINE_SAFE.has(r.mimeType));
  const headers: Record<string, string> = {
    ...HEADERS,
    'content-type': r.mimeType,
    'content-security-policy': CSP(r.mimeType),
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${asciiName(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'cache-control': r.isThumbnail ? 'private, max-age=300' : 'private, no-store',
  };
  if (r.size !== undefined) headers['content-length'] = String(r.size);
  return new Response(Readable.toWeb(r.stream) as ReadableStream, { headers });
}

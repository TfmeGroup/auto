import { Readable } from 'node:stream';

/** Response helpers for finance downloads: always private, never sniffed, never cached by a shared cache. */

const SAFE = { 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store', 'content-security-policy': "default-src 'none'; sandbox" } as const;
// A PDF we rendered ourselves holds no active content, and a `sandbox` policy would stop browsers' built-in PDF viewer from opening it.
const PDF_SAFE = { 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store' } as const;
const quote = (name: string) => `filename*=UTF-8''${encodeURIComponent(name)}`;

export function pdfResponse(pdf: Buffer, filename: string, opts: { download?: boolean } = {}): Response {
  return new Response(new Uint8Array(pdf), {
    headers: { 'content-type': 'application/pdf', 'content-length': String(pdf.length), 'content-disposition': `${opts.download ? 'attachment' : 'inline'}; ${quote(filename)}`, ...PDF_SAFE },
  });
}

export function fileResponse(data: Buffer, mime: string, filename: string): Response {
  return new Response(new Uint8Array(data), { headers: { 'content-type': mime, 'content-length': String(data.length), 'content-disposition': `attachment; ${quote(filename)}`, ...SAFE } });
}

export function streamResponse(stream: Readable, size: number, mime: string): Response {
  return new Response(Readable.toWeb(stream) as ReadableStream, { headers: { 'content-type': mime, 'content-length': String(size), ...SAFE, 'cache-control': 'private, max-age=300' } });
}

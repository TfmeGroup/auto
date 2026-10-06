/**
 * Upload content validation. The declared MIME type and filename come from the
 * client and are untrusted; the real type is decided from the file's bytes.
 * SVG and HTML are deliberately NOT allowed (script-capable).
 */

export interface DetectedType {
  mime: string;
  ext: string;
}

const startsWith = (b: Buffer, sig: number[], offset = 0) => sig.every((v, i) => b[offset + i] === v);
const ascii = (b: Buffer, from: number, to: number) => b.subarray(from, to).toString('latin1');

const OOXML = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

function isLikelyText(b: Buffer): boolean {
  const sample = b.subarray(0, 8192);
  if (sample.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return true;
  } catch {
    // A multi-byte character may be cut at the sample boundary; tolerate that only.
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, sample.length - 3));
      return true;
    } catch {
      return false;
    }
  }
}

/** Returns the detected type, or null when the content is not an allowed file type. */
export function detectFileType(buf: Buffer, filename: string): DetectedType | null {
  if (buf.length < 4) return null;
  const lowerName = filename.toLowerCase();

  if (startsWith(buf, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', ext: 'jpg' };
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: 'image/png', ext: 'png' };
  if (ascii(buf, 0, 6) === 'GIF87a' || ascii(buf, 0, 6) === 'GIF89a') return { mime: 'image/gif', ext: 'gif' };
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (ascii(buf, 0, 5) === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  if (ascii(buf, 4, 8) === 'ftyp' && ['heic', 'heix', 'mif1', 'msf1'].includes(ascii(buf, 8, 12)))
    return { mime: 'image/heic', ext: 'heic' };

  // docx / xlsx are zip containers: require the zip signature AND a matching extension.
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) {
    if (lowerName.endsWith('.docx')) return { mime: OOXML.docx, ext: 'docx' };
    if (lowerName.endsWith('.xlsx')) return { mime: OOXML.xlsx, ext: 'xlsx' };
    return null;
  }

  if ((lowerName.endsWith('.txt') || lowerName.endsWith('.csv')) && isLikelyText(buf)) {
    return lowerName.endsWith('.csv') ? { mime: 'text/csv', ext: 'csv' } : { mime: 'text/plain', ext: 'txt' };
  }
  return null;
}

/** Strip path components and control characters; the stored name is display-only. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|?*:]/g, '_').trim().slice(0, 150);
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'file';
}

/** Types that are safe to render inline in the browser. Everything else downloads. */
export const INLINE_SAFE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']);

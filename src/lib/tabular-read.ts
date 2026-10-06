import { inflateRawSync } from 'node:zlib';

/**
 * Dependency-free readers for the two import formats: CSV and Excel (.xlsx). They return the first sheet as rows of text. They are deliberately
 * strict about size (an upload cannot expand into something huge) and read only plain values: formulas are never evaluated.
 */

export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5_000;
const MAX_UNCOMPRESSED = 40 * 1024 * 1024;

export class TabularError extends Error {}

// ───────── CSV ─────────

export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delimiter) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
      if (rows.length > MAX_IMPORT_ROWS + 1) throw new TabularError(`Too many rows (the limit is ${MAX_IMPORT_ROWS.toLocaleString('en-ZA')}). Split the file.`);
    } else cell += c;
  }
  if (quoted) throw new TabularError('The file has an unclosed quote.');
  row.push(cell);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return rows;
}

// ───────── XLSX ─────────

interface ZipEntry { name: string; method: number; compSize: number; size: number; offset: number }

function readZipEntries(buf: Buffer): Map<string, ZipEntry> {
  const min = Math.max(0, buf.length - 65_557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new TabularError('That does not look like an Excel (.xlsx) file.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, ZipEntry>();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new TabularError('The Excel file is damaged.');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    total += size;
    if (total > MAX_UNCOMPRESSED) throw new TabularError('The Excel file is too large once unpacked.');
    out.set(name, { name, method, compSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function readEntry(buf: Buffer, e: ZipEntry): Buffer {
  if (buf.readUInt32LE(e.offset) !== 0x04034b50) throw new TabularError('The Excel file is damaged.');
  const nameLen = buf.readUInt16LE(e.offset + 26);
  const extraLen = buf.readUInt16LE(e.offset + 28);
  const start = e.offset + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_UNCOMPRESSED });
  throw new TabularError('That Excel file uses a compression this importer does not support. Save it as CSV instead.');
}

const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&');

const colIndex = (ref: string) => {
  let n = 0;
  for (const ch of ref.replace(/[0-9]/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

export function readXlsx(buf: Buffer): string[][] {
  const entries = readZipEntries(buf);
  const sheetName = [...entries.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))[0];
  if (!sheetName) throw new TabularError('No worksheet was found in that Excel file.');
  const shared: string[] = [];
  const ss = entries.get('xl/sharedStrings.xml');
  if (ss) {
    const xml = readEntry(buf, ss).toString('utf8');
    for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(unxml([...si[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('')));
  }
  const xml = readEntry(buf, entries.get(sheetName)!).toString('utf8');
  const rows: string[][] = [];
  for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    for (const c of r[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]!;
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /t="(\w+)"/.exec(attrs)?.[1];
      const body = c[2] ?? '';
      let v = '';
      if (type === 's') v = shared[Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? -1)] ?? '';
      else if (type === 'inlineStr') v = unxml([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
      else v = unxml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
      if (ref) row[colIndex(ref)] = v;
      else row.push(v);
    }
    const filled = Array.from(row, (x) => x ?? '');
    if (filled.some((v) => v.trim() !== '')) rows.push(filled);
    if (rows.length > MAX_IMPORT_ROWS + 1) throw new TabularError(`Too many rows (the limit is ${MAX_IMPORT_ROWS.toLocaleString('en-ZA')}). Split the file.`);
  }
  return rows;
}

/** Decide the format from the file itself (an .xlsx is a zip), falling back to the name, and read it. Anything that cannot be read says so plainly. */
export function readTable(data: Buffer, filename: string): string[][] {
  if (data.length === 0) throw new TabularError('The file is empty.');
  if (data.length > MAX_IMPORT_BYTES) throw new TabularError('The file is too large (8 MB at most).');
  try {
    const isZip = data.length >= 4 && data.readUInt32LE(0) === 0x04034b50;
    if (isZip) return readXlsx(data);
    if (/\.xls$/i.test(filename)) throw new TabularError('Old .xls files are not supported. Save the sheet as .xlsx or CSV.');
    const text = data.toString('utf8');
    if (text.includes('\u0000')) throw new TabularError('That does not look like a CSV or Excel (.xlsx) file.');
    return parseCsv(text);
  } catch (e) {
    if (e instanceof TabularError) throw e;
    // a damaged archive, a truncated file, a bad compressed stream: never a server error
    throw new TabularError('The file could not be read. Check that it is a valid CSV or Excel (.xlsx) file.');
  }
}

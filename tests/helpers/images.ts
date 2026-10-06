import { Buffer } from 'node:buffer';

/** A real, decodable 2x2 PNG. Uploads are checked by decoding the picture, so tests must use a genuine image, not just PNG header bytes. */
export const VALID_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWM4oaFxQkODAUIBACEuBGGj1lj9AAAAAElFTkSuQmCC', 'base64');

/** A real PNG followed by  filler bytes (decoders ignore trailing data), for tests that need a particular size or distinct content. */
export const pngOf = (extra = 0, fill = 7) => Buffer.concat([VALID_PNG, Buffer.alloc(extra, fill)]);

/** A real zip archive (stored, not compressed) from named entries: enough for an Office-style file the scanner can read. */
export function makeZip(entries: { name: string; data: Buffer }[]): Buffer {
  const { crc32 } = require('node:zlib') as { crc32: (b: Buffer) => number };
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const crc = crc32(e.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(e.data.length, 18); local.writeUInt32LE(e.data.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, e.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(e.data.length, 20); central.writeUInt32LE(e.data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + e.data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

/** A genuine (if minimal) .docx: an Office zip with its two required parts. */
export const realDocx = () => makeZip([{ name: '[Content_Types].xml', data: Buffer.from('<Types/>') }, { name: 'word/document.xml', data: Buffer.from('<w:document/>') }]);

import net from 'node:net';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

/**
 * Upload scanning. The model is built so a real antivirus engine can be added without touching the document model:
 * a scanner returns a verdict, the upload pipeline acts on it, and the file records which engine looked at it.
 *
 *  - builtin: always on. Deterministic structural checks only (the antivirus test signature, PDFs that launch programs or run
 *    scripts, Office files with macros, archives hiding executables or built to explode). It is NOT an antivirus engine and a
 *    file that passes it is recorded as "not scanned".
 *  - clamd: used when CLAMAV_HOST is set. Every upload is streamed to the daemon; a file it flags is refused, and if the daemon
 *    cannot be reached the upload FAILS (closed) rather than letting an unscanned file through.
 */
export type ScanVerdict = { status: 'clean'; engine: string } | { status: 'flagged'; engine: string; reason: string } | { status: 'unavailable'; engine: string; reason: string };

export interface MalwareScanner {
  readonly name: string;
  scan(data: Buffer, mime: string): Promise<ScanVerdict>;
}

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const EXEC_NAME = /\.(exe|dll|bat|cmd|com|scr|msi|js|jse|vbs|vbe|wsf|ps1|jar|app|sh|lnk|hta|cpl|reg)$/i;
const MAX_UNPACKED = 300 * 1024 * 1024;

/** File names and sizes from a zip's central directory (Office files are zips). Throws if it is not readable as a zip. */
export function zipListing(buf: Buffer): { name: string; size: number; compressed: number }[] {
  const min = Math.max(0, buf.length - 65_557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: { name: string; size: number; compressed: number }[] = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('damaged zip');
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    out.push({ name: buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'), size, compressed });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export const builtinScanner: MalwareScanner = {
  name: 'builtin',
  async scan(data, mime) {
    const flag = (reason: string): ScanVerdict => ({ status: 'flagged', engine: 'builtin', reason });
    if (data.includes(EICAR)) return flag('The file matches the antivirus test signature.');
    if (mime === 'application/pdf') {
      const head = data.toString('latin1');
      if (/\/Launch\b/.test(head)) return flag('The PDF is set up to launch a program.');
      if (/\/(JavaScript|JS)\b/.test(head)) return flag('The PDF contains a script.');
    }
    if (mime.includes('officedocument')) {
      let entries: ReturnType<typeof zipListing>;
      try {
        entries = zipListing(data);
      } catch {
        return flag('The Office file is damaged.');
      }
      if (entries.some((e) => /vbaProject\.bin$/i.test(e.name))) return flag('The Office file contains macros.');
      if (entries.some((e) => EXEC_NAME.test(e.name))) return flag('The Office file contains a program.');
      if (entries.reduce((n, e) => n + e.size, 0) > MAX_UNPACKED) return flag('The Office file unpacks to an unreasonable size.');
    }
    return { status: 'clean', engine: 'builtin' };
  },
};

/** ClamAV over the clamd INSTREAM protocol. */
export function clamdScanner(host: string, port: number): MalwareScanner {
  return {
    name: 'clamd',
    scan: (data) =>
      new Promise<ScanVerdict>((resolve) => {
        const unavailable = (reason: string): ScanVerdict => ({ status: 'unavailable', engine: 'clamd', reason });
        const socket = net.createConnection({ host, port });
        let reply = '';
        socket.setTimeout(30_000, () => { socket.destroy(); resolve(unavailable('The scanner timed out.')); });
        socket.on('error', (e) => { logger.error({ err: String(e) }, 'clamd unreachable'); resolve(unavailable('The scanner is not reachable.')); });
        socket.on('data', (c) => { reply += c.toString('utf8'); });
        socket.on('close', () => {
          const r = reply.replace(/\0/g, '').trim();
          if (/OK$/.test(r)) resolve({ status: 'clean', engine: 'clamd' });
          else if (/FOUND$/.test(r)) resolve({ status: 'flagged', engine: 'clamd', reason: 'The antivirus scanner flagged this file.' });
          else resolve(unavailable('The scanner gave no usable answer.'));
        });
        socket.on('connect', () => {
          socket.write('zINSTREAM\0');
          for (let off = 0; off < data.length; off += 64 * 1024) {
            const chunk = data.subarray(off, off + 64 * 1024);
            const len = Buffer.alloc(4);
            len.writeUInt32BE(chunk.length);
            socket.write(len);
            socket.write(chunk);
          }
          socket.write(Buffer.alloc(4));
        });
      }),
  };
}

/** Test seam: a scanner that records what it is asked and answers as told. */
let override: MalwareScanner | null = null;
export function setScannerForTests(s: MalwareScanner | null) { override = s; }

export function activeScanners(): MalwareScanner[] {
  if (override) return [builtinScanner, override];
  const e = env();
  return e.CLAMAV_HOST ? [builtinScanner, clamdScanner(e.CLAMAV_HOST, e.CLAMAV_PORT)] : [builtinScanner];
}

export interface ScanOutcome {
  /** CLEAN only when a real engine said so; NOT_SCANNED when only the structural checks ran. */
  scanStatus: 'CLEAN' | 'NOT_SCANNED';
  engines: string[];
}

export type ScanFailure = { kind: 'flagged'; reason: string; engine: string } | { kind: 'unavailable'; reason: string; engine: string };

export async function scanUpload(data: Buffer, mime: string): Promise<{ ok: true; outcome: ScanOutcome } | { ok: false; failure: ScanFailure }> {
  const engines: string[] = [];
  let realEngine = false;
  for (const s of activeScanners()) {
    const v = await s.scan(data, mime);
    if (v.status === 'flagged') return { ok: false, failure: { kind: 'flagged', reason: v.reason, engine: v.engine } };
    if (v.status === 'unavailable') return { ok: false, failure: { kind: 'unavailable', reason: v.reason, engine: v.engine } };
    engines.push(v.engine);
    if (v.engine !== 'builtin') realEngine = true;
  }
  return { ok: true, outcome: { scanStatus: realEngine ? 'CLEAN' : 'NOT_SCANNED', engines } };
}

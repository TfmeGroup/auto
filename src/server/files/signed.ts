import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';
import { AppError } from '@/lib/errors';

/**
 * Short-lived signed download links for private files. The link carries WHAT it opens (one file, in one business), FOR WHOM
 * and UNTIL WHEN, signed with a server-side key. It is never a storage path: the object store stays private, and when the link
 * is used the server looks the file up again, so a file that was since trashed, hidden from the customer or deleted stops working at once.
 */
export type LinkScope = 'staff' | 'customer';

export interface SignedPayload {
  /** file id */
  f: string;
  /** business id */
  b: string;
  /** who it was issued to (user id; empty for a customer link) */
  u: string;
  s: LinkScope;
  /** the customer link it came through (customer scope only) */
  l?: string;
  /** expiry, seconds since epoch */
  e: number;
  /** open in the browser (true) or force download */
  i?: boolean;
}

const DEV_KEY = 'dev-only-signing-key-do-not-use-in-production!!';
export const DEFAULT_TTL_SEC = 300;
export const MAX_TTL_SEC = 900;

const key = () => {
  const k = env().FILE_SIGNING_KEY;
  return k ? Buffer.from(k, 'base64') : Buffer.from(DEV_KEY);
};

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const sign = (body: string) => createHmac('sha256', key()).update(body).digest();

const expired = () => new AppError('NOT_FOUND', 410, 'This download link has expired. Open the document again to get a new one.');
const invalid = () => new AppError('NOT_FOUND', 404, 'This download link is not valid.');

export function signFileLink(p: Omit<SignedPayload, 'e'>, ttlSec = DEFAULT_TTL_SEC, now = Date.now()): { token: string; expiresAt: Date } {
  const ttl = Math.max(30, Math.min(MAX_TTL_SEC, Math.floor(ttlSec)));
  const payload: SignedPayload = { ...p, e: Math.floor(now / 1000) + ttl };
  const body = b64(JSON.stringify(payload));
  return { token: `${body}.${b64(sign(body))}`, expiresAt: new Date(payload.e * 1000) };
}

export function verifyFileLink(token: string, now = Date.now()): SignedPayload {
  const parts = token.split('.');
  if (parts.length !== 2 || token.length > 1024) throw invalid();
  const [body, sig] = parts as [string, string];
  const expected = sign(body);
  let given: Buffer;
  try { given = Buffer.from(sig, 'base64url'); } catch { throw invalid(); }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalid();
  let p: SignedPayload;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SignedPayload; } catch { throw invalid(); }
  if (typeof p.f !== 'string' || typeof p.b !== 'string' || typeof p.e !== 'number' || (p.s !== 'staff' && p.s !== 'customer')) throw invalid();
  if (p.e * 1000 <= now) throw expired();
  return p;
}

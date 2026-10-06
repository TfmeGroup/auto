import type { Readable } from 'node:stream';

/**
 * Private object storage boundary. Objects are only ever addressed by an
 * opaque server-generated key and are never publicly readable: downloads go
 * through an authorised application endpoint (or a short-lived signed URL).
 */
export interface StorageDriver {
  readonly name: string;
  put(key: string, body: Buffer, opts: { contentType: string }): Promise<void>;
  get(key: string): Promise<{ stream: Readable; size?: number }>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Optional: the objects under a prefix (used only by the conservative orphan cleanup). */
  list?(prefix: string, opts: { limit: number }): Promise<{ key: string; lastModified: Date; size: number }[]>;
  /** Optional: short-lived direct-download URL (S3-compatible drivers). */
  signedUrl?(key: string, opts: { expiresInSec: number; filename?: string }): Promise<string>;
}

export class StorageNotFoundError extends Error {}

/** Keys are server-generated: `<businessId>/<yyyy>/<uuid>` (or `<userId>/avatar/<uuid>` for profile photos). Anything else is rejected. */
const KEY_RE = /^[0-9a-f-]{36}\/(\d{4}|avatar)\/[0-9a-f-]{36}$/;
export function assertValidKey(key: string): void {
  if (!KEY_RE.test(key)) throw new Error('Invalid storage key');
}

import { createReadStream } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { assertValidKey, StorageNotFoundError, type StorageDriver } from './types';

/**
 * Filesystem driver for development and tests. The root must be outside any
 * web-served directory (it is not under /public), and keys are validated so a
 * path can never escape it.
 */
export class LocalStorageDriver implements StorageDriver {
  readonly name = 'local';
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(key: string): string {
    assertValidKey(key);
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error('Invalid storage key');
    return p;
  }

  async put(key: string, body: Buffer, _opts?: { contentType: string }): Promise<void> {
    void _opts; // content type is not needed on a plain filesystem
    const p = this.pathFor(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body, { flag: 'wx' }); // never overwrite an existing object
  }

  async get(key: string) {
    const p = this.pathFor(key);
    try {
      const s = await stat(p);
      return { stream: createReadStream(p), size: s.size };
    } catch {
      throw new StorageNotFoundError(key);
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  /** Objects under a business prefix: <root>/<businessId>/<year>/<uuid>. Only well-formed keys are returned. */
  async list(prefix: string, opts: { limit: number }) {
    const out: { key: string; lastModified: Date; size: number }[] = [];
    const base = resolve(this.root, prefix);
    if (!base.startsWith(this.root + sep) && base !== this.root) return out;
    let years: string[] = [];
    try { years = await readdir(base); } catch { return out; }
    for (const y of years) {
      let names: string[] = [];
      try { names = await readdir(resolve(base, y)); } catch { continue; }
      for (const n of names) {
        const key = `${prefix.replace(/\/$/, '')}/${y}/${n}`;
        try {
          assertValidKey(key);
          const s = await stat(this.pathFor(key));
          out.push({ key, lastModified: s.mtime, size: s.size });
        } catch { /* not one of ours: leave it alone */ }
        if (out.length >= opts.limit) return out;
      }
    }
    return out;
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }
}

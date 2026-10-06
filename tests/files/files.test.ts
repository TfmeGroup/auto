import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, prisma } from '@/server/db/client';
import { createCustomer } from '@/server/customers/service';
import { listFiles, uploadFile } from '@/server/files/service';
import { LocalStorageDriver } from '@/server/storage/local';
import { getStorage, setStorageForTests } from '@/server/storage';
import { StorageNotFoundError, type StorageDriver } from '@/server/storage/types';
import { GET as downloadRoute } from '@/app/api/v1/files/[id]/route';
import { GET as listRoute, POST as uploadRoute } from '@/app/api/v1/files/route';
import { POST as archiveRoute } from '@/app/api/v1/files/[id]/archive/route';
import { call } from '../helpers/http';
import { businessContext, createMemberCtx, createWorkspace, ownerQuery, type TestWorkspace } from '../helpers/factory';
import { customerInput } from '../helpers/customers';
import { pngOf, realDocx } from '../helpers/images';

afterAll(disconnectPrisma);
afterEach(() => setStorageForTests(undefined));

const png = (extra = 0) => pngOf(8 + extra, 7);
const form = (data: Buffer, name: string, extra: Record<string, string> = {}) => {
  const f = new FormData();
  f.set('file', new File([new Uint8Array(data)], name));
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  return f;
};

let ws: TestWorkspace;
beforeAll(async () => {
  ws = await createWorkspace('Files Workshop');
});

describe('upload', () => {
  it('stores the object privately under the business prefix and records metadata', async () => {
    const customer = await createCustomer(ws.ctx, customerInput('Photo Customer'));
    const res = await call(uploadRoute, { token: ws.ctx.token, form: form(png(), 'front-bumper.png', { resourceType: 'customer', resourceId: customer.id }) });
    expect(res.status).toBe(201);
    const row = await ownerQuery('SELECT * FROM files WHERE id = $1', [res.body.data.id]);
    const f = row.rows[0];
    expect(f.storage_key.startsWith(`${ws.businessId}/`)).toBe(true);
    expect(f.mime_type).toBe('image/png');
    expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(f.original_name).toBe('front-bumper.png');
    expect(f.resource_id).toBe(customer.id);
    expect(await getStorage().exists(f.storage_key)).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(f.storage_key); // the key never reaches the client
    const audit = await ownerQuery("SELECT 1 FROM audit_logs WHERE resource_id = $1 AND action = 'file.uploaded'", [res.body.data.id]);
    expect(audit.rowCount).toBe(1);
  });

  it('rejects content that is not an allowed type, whatever the name or declared MIME says', async () => {
    const cases: [Buffer, string][] = [
      [Buffer.from('<html><script>alert(1)</script></html>'), 'photo.png'],
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'logo.svg'],
      [Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00'), 'setup.exe'],
      [Buffer.from('#!/bin/sh\nrm -rf /'), 'notes.txt.sh'],
    ];
    for (const [data, name] of cases) {
      const res = await call(uploadRoute, { token: ws.ctx.token, form: form(data, name) });
      expect(res.status, name).toBe(415);
    }
    expect((await ownerQuery("SELECT 1 FROM files WHERE original_name IN ('photo.png','logo.svg','setup.exe')")).rowCount).toBe(0);
  });

  it('rejects empty and oversized files', async () => {
    expect((await call(uploadRoute, { token: ws.ctx.token, form: form(Buffer.alloc(0), 'empty.png') })).status).toBe(422);
    const big = await call(uploadRoute, { token: ws.ctx.token, form: form(png(3 * 1024 * 1024), 'huge.png') });
    expect(big.status).toBe(413);
    const declared = await call(uploadRoute, { token: ws.ctx.token, headers: { 'content-length': String(500 * 1024 * 1024) }, form: form(png(), 'liar.png') });
    expect(declared.status).toBe(413);
  });

  it('never trusts the client filename for storage paths', async () => {
    const res = await call(uploadRoute, { token: ws.ctx.token, form: form(png(), '../../../../etc/cron.d/evil.png') });
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('evil.png');
    const key = (await ownerQuery('SELECT storage_key FROM files WHERE id = $1', [res.body.data.id])).rows[0].storage_key as string;
    expect(key).toMatch(/^[0-9a-f-]{36}\/\d{4}\/[0-9a-f-]{36}$/);
    expect(key).not.toContain('evil');
  });

  it('requires matching resourceType/resourceId and a known resource type', async () => {
    expect((await call(uploadRoute, { token: ws.ctx.token, form: form(png(), 'a.png', { resourceType: 'customer' }) })).status).toBe(422);
    expect((await call(uploadRoute, { token: ws.ctx.token, form: form(png(), 'a.png', { resourceType: 'spaceship', resourceId: '00000000-0000-4000-8000-000000000000' }) })).status).toBe(422);
  });

  it('leaves no database row behind when the storage write fails', async () => {
    const failing: StorageDriver = {
      name: 'failing',
      put: async () => { throw new Error('disk full'); },
      get: async () => { throw new StorageNotFoundError('x'); },
      delete: async () => {},
      exists: async () => false,
    };
    setStorageForTests(failing);
    const before = (await ownerQuery('SELECT count(*)::int n FROM files WHERE business_id = $1', [ws.businessId])).rows[0].n;
    await expect(uploadFile(ws.ctx, { data: png(), filename: 'x.png' })).rejects.toThrow('disk full');
    expect((await ownerQuery('SELECT count(*)::int n FROM files WHERE business_id = $1', [ws.businessId])).rows[0].n).toBe(before);
  });
});

describe('download', () => {
  it('requires authentication', async () => {
    const f = await uploadFile(ws.ctx, { data: png(), filename: 'auth.png' });
    expect((await call(downloadRoute, { params: { id: f.id } })).status).toBe(401);
  });

  it('streams the exact bytes with hardened headers', async () => {
    const data = png(100);
    const f = await uploadFile(ws.ctx, { data, filename: 'exact.png' });
    const res = await call(downloadRoute, { token: ws.ctx.token, params: { id: f.id } });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.raw.clone().arrayBuffer()).equals(data)).toBe(true);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toMatch(/sandbox/);
    expect(res.headers.get('cache-control')).toMatch(/private/);
    expect(res.headers.get('content-disposition')).toMatch(/^inline/);
  });

  it('forces download for non-image types and when ?download=1', async () => {
    const doc = await uploadFile(ws.ctx, { data: realDocx(), filename: 'quote.docx' });
    const res = await call(downloadRoute, { token: ws.ctx.token, params: { id: doc.id } });
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/);
    const img = await uploadFile(ws.ctx, { data: png(), filename: 'p.png' });
    const forced = await call(downloadRoute, { token: ws.ctx.token, params: { id: img.id }, query: { download: '1' } });
    expect(forced.headers.get('content-disposition')).toMatch(/^attachment/);
  });

  it('returns 404 (not 500) when the object is missing from storage', async () => {
    const f = await uploadFile(ws.ctx, { data: png(), filename: 'gone.png' });
    const key = (await ownerQuery('SELECT storage_key FROM files WHERE id = $1', [f.id])).rows[0].storage_key as string;
    await getStorage().delete(key);
    expect((await call(downloadRoute, { token: ws.ctx.token, params: { id: f.id } })).status).toBe(404);
  });

  it('rejects malformed ids', async () => {
    expect((await call(downloadRoute, { token: ws.ctx.token, params: { id: '../../etc/passwd' } })).status).toBe(422);
  });
});

describe('archive and listing', () => {
  it('archiving needs document.delete, hides the file from lists, keeps the object', async () => {
    const f = await uploadFile(ws.ctx, { data: png(), filename: 'to-archive.png' });
    const tech = await createMemberCtx(ws, 'technician');
    expect((await call(archiveRoute, { token: tech.ctx.token, params: { id: f.id }, body: {} })).status).toBe(403);

    const mgr = await createMemberCtx(ws, 'manager');
    expect((await call(archiveRoute, { token: mgr.ctx.token, params: { id: f.id }, body: {} })).status).toBe(200);

    const listed = await call(listRoute, { token: ws.ctx.token, query: { pageSize: 100 } });
    expect(listed.body.data.map((x: { id: string }) => x.id)).not.toContain(f.id);
    const row = await prisma().file.findMany({ where: { id: f.id } }).catch(() => []);
    void row;
    const db = await ownerQuery('SELECT status, storage_key FROM files WHERE id = $1', [f.id]);
    expect(db.rows[0].status).toBe('ARCHIVED');
    expect(await getStorage().exists(db.rows[0].storage_key)).toBe(true);
  });

  it('paginates and never returns unbounded lists', async () => {
    const r = await call(listRoute, { token: ws.ctx.token, query: { pageSize: 2 } });
    expect(r.body.data.length).toBeLessThanOrEqual(2);
    expect(r.body.meta).toMatchObject({ page: 1, pageSize: 2 });
    expect((await call(listRoute, { token: ws.ctx.token, query: { pageSize: 5000 } })).status).toBe(422);
    const mine = await listFiles(await businessContext(ws.owner), { pageSize: 100 });
    expect(mine.items.every((i) => i.status === 'ACTIVE')).toBe(true);
  });
});

describe('storage drivers', () => {
  const key = '11111111-1111-4111-8111-111111111111/2026/22222222-2222-4222-8222-222222222222';

  it('local driver round-trips and refuses to overwrite', async () => {
    const d = new LocalStorageDriver(join(process.env.STORAGE_LOCAL_DIR!, 'driver-test'));
    await d.put(key, Buffer.from('hello'), { contentType: 'text/plain' });
    const { stream } = await d.get(key);
    const chunks: Buffer[] = [];
    for await (const c of Readable.from(stream)) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).toString()).toBe('hello');
    await expect(d.put(key, Buffer.from('overwrite'), { contentType: 'text/plain' })).rejects.toThrow();
    await d.delete(key);
    expect(await d.exists(key)).toBe(false);
    await expect(d.get(key)).rejects.toBeInstanceOf(StorageNotFoundError);
  });

  it('rejects keys that could escape the storage root', async () => {
    const d = new LocalStorageDriver(join(process.env.STORAGE_LOCAL_DIR!, 'driver-test2'));
    for (const bad of ['../../etc/passwd', '/etc/passwd', 'a/b/c', `${key}/../../x`, '']) {
      await expect(d.put(bad, Buffer.from('x'), { contentType: 'text/plain' })).rejects.toThrow(/Invalid storage key/);
      await expect(d.get(bad)).rejects.toThrow();
    }
  });

  it('stored files live outside any web-served directory', () => {
    const dir = process.env.STORAGE_LOCAL_DIR!;
    expect(dir).not.toMatch(/[\\/]public([\\/]|$)/);
    expect(readdirSync(dir).length).toBeGreaterThan(0);
    void readFileSync;
  });
});

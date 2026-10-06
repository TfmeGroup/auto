import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, prisma } from '@/server/db/client';
import { env } from '@/lib/env';
import { archiveFile } from '@/server/files/service';
import { createDownloadLink, getFile, listVersions, openFile, openSignedFile, setFileVisibility, updateFile, uploadFile, uploadNewVersion } from '@/server/files/service';
import { purgeFile, restoreFile, trashFile, purgeExpiredTrash, cleanupOrphanObjects } from '@/server/files/lifecycle';
import { searchDocuments } from '@/server/files/search';
import { getStorageReport } from '@/server/files/usage';
import { createCategory } from '@/server/files/categories';
import { getDocumentSettings, updateDocumentSettings } from '@/server/files/settings';
import { setScannerForTests } from '@/server/files/scan';
import { getStorage } from '@/server/storage';
import { GET as fileRoute } from '@/app/api/v1/files/[id]/route';
import { GET as publicFileRoute } from '@/app/api/public/files/[token]/route';
import { call } from '../helpers/http';
import { createMemberCtx, createWorkspace, drainJobs, ownerQuery, upgradePlan, type TestWorkspace } from '../helpers/factory';
import { memberWithPermissions, seedCustomerVehicle } from '../helpers/workshop';
import { makeZip, pngOf, realDocx } from '../helpers/images';
import { createVehicle } from '@/server/vehicles/service';
import { createJob } from '@/server/jobcards/service';

afterAll(disconnectPrisma);
afterEach(() => setScannerForTests(null));

let ws: TestWorkspace;
let other: TestWorkspace;
let customerId: string;
let vehicleId: string;
let n = 0;
const png = () => pngOf(64 + ++n, n % 250);
const up = (over: Record<string, unknown> = {}, c = ws.ctx) => uploadFile(c, { data: png(), filename: `photo-${n}.png`, resourceType: 'customer', resourceId: customerId, ...over } as never);
const rejects = (p: Promise<unknown>, status?: number) => expect(p).rejects.toMatchObject(status ? { status } : {});

beforeAll(async () => {
  ws = await createWorkspace('Docs Workshop');
  other = await createWorkspace('Other Docs Workshop');
  const s = await seedCustomerVehicle(ws, 'Doc');
  customerId = s.customer.id;
  vehicleId = s.vehicle.id;
});

describe('metadata and categories', () => {
  it('records who, when, what and where, with sensible defaults taken from the record', async () => {
    const f = await up({ description: 'Front bumper', displayName: 'Bumper damage' });
    expect(f).toMatchObject({ name: 'Bumper damage', originalName: expect.stringMatching(/\.png$/), mimeType: 'image/png', extension: 'png', category: 'CUSTOMER_DOCUMENT', visibility: 'INTERNAL', version: 1, isCurrent: true, source: 'UPLOAD', status: 'ACTIVE', resourceType: 'customer', resourceId: customerId, customerId, hasThumbnail: true });
    expect(f.uploadedById).toBe(ws.ctx.user.id);
    const row = (await ownerQuery('SELECT * FROM files WHERE id = $1', [f.id])).rows[0];
    expect(row.description).toBe('Front bumper');
    expect(row.scan_status).toBe('NOT_SCANNED'); // only the structural checks ran: it is not claimed to be virus-scanned
    expect(row.storage_key).toMatch(new RegExp(`^${ws.businessId}/\\d{4}/[0-9a-f-]{36}$`));
  });

  it('takes the customer from the record, so a vehicle photo is found under its owner', async () => {
    const f = await up({ resourceType: 'vehicle', resourceId: vehicleId, category: 'VEHICLE_PHOTO' });
    expect(f.customerId).toBe(customerId);
  });

  it('only accepts categories that exist for this business, and custom categories need the plan feature', async () => {
    await rejects(up({ category: 'NOT_A_CATEGORY' }), 422);
    const solo = await createWorkspace('Solo Docs');
    await upgradePlan(solo, 'solo');
    await rejects(createCategory(solo.ctx, { label: 'Insurance claims' }), 402);
    const cat = await createCategory(ws.ctx, { label: 'Insurance claims' });
    expect(cat.key).toBe('C_INSURANCE_CLAIMS');
    await rejects(createCategory(ws.ctx, { label: 'insurance claims' }), 409);
    await rejects(createCategory(ws.ctx, { label: 'Warranty' }), 409);
    const f = await up({ category: cat.key });
    expect(f.category).toBe('C_INSURANCE_CLAIMS');
    // another business cannot use it
    const c2 = (await seedCustomerVehicle(other, 'X')).customer.id;
    await rejects(uploadFile(other.ctx, { data: png(), filename: 'a.png', resourceType: 'customer', resourceId: c2, category: cat.key }), 422);
  });

  it('edits the name, description and category, audited; a financial category cannot be assigned by an ordinary user', async () => {
    const f = await up();
    const edited = await updateFile(ws.ctx, f.id, { displayName: 'Renamed', description: 'Note', category: 'WARRANTY' });
    expect(edited).toMatchObject({ name: 'Renamed', category: 'WARRANTY' });
    const audit = await ownerQuery("SELECT 1 FROM audit_logs WHERE resource_id = $1 AND action = 'file.edited'", [f.id]);
    expect(audit.rowCount).toBe(1);
    const tech = await createMemberCtx(ws, 'service_advisor');
    await rejects(updateFile(tech.ctx, f.id, { category: 'INVOICE' }), 403);
  });
});

describe('upload validation', () => {
  it('never trusts the filename or declared type: it decides from the bytes', async () => {
    for (const [data, name] of [
      [Buffer.from('MZ\x90\x00\x03\x00\x00\x00'), 'invoice.pdf'],
      [Buffer.from('<?php system($_GET["c"]); ?>'), 'shell.png'],
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'logo.png'],
    ] as [Buffer, string][]) await rejects(up({ data, filename: name }), 415);
    // a PDF called .png is stored as what it is
    const pdf = await up({ data: Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<<>>\n%%EOF'), filename: 'actually-a-pdf.png', resourceType: 'customer', resourceId: customerId });
    expect(pdf).toMatchObject({ mimeType: 'application/pdf', extension: 'pdf', hasThumbnail: false });
  });

  it('rejects a picture that is only the right first bytes, and empty or oversize files', async () => {
    await rejects(up({ data: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]), filename: 'fake.png' }), 415);
    await rejects(up({ data: Buffer.alloc(0), filename: 'empty.png' }), 422);
    await rejects(up({ data: Buffer.concat([png(), Buffer.alloc(env().MAX_UPLOAD_MB * 1024 * 1024)]), filename: 'huge.png' }), 413);
  });

  it('sanitises path tricks in the name and stores under a server-made key', async () => {
    const f = await up({ filename: '../../etc/passwd\u0000.png' });
    expect(f.originalName).not.toMatch(/\.\.|\//);
    const key = (await ownerQuery('SELECT storage_key FROM files WHERE id = $1', [f.id])).rows[0].storage_key as string;
    expect(key).not.toContain('passwd');
    expect(key.startsWith(`${ws.businessId}/`)).toBe(true);
  });

  it('refuses a file the scanner flags (and audits it), and fails closed when the scanner is down', async () => {
    const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
    await rejects(up({ data: eicar, filename: 'test.txt' }), 415);
    expect((await ownerQuery("SELECT 1 FROM audit_logs WHERE business_id = $1 AND action = 'file.scan_flagged'", [ws.businessId])).rowCount).toBeGreaterThan(0);
    const macro = makeZip([{ name: '[Content_Types].xml', data: Buffer.from('x') }, { name: 'word/vbaProject.bin', data: Buffer.from('x') }]);
    await rejects(up({ data: macro, filename: 'macro.docx' }), 415);
    setScannerForTests({ name: 'down', scan: async () => ({ status: 'unavailable', engine: 'down', reason: 'The scanner is not reachable.' }) });
    await rejects(up(), 503);
    setScannerForTests({ name: 'fake-av', scan: async () => ({ status: 'clean', engine: 'fake-av' }) });
    const ok = await up();
    expect((await ownerQuery('SELECT scan_status FROM files WHERE id = $1', [ok.id])).rows[0].scan_status).toBe('CLEAN');
  });

  it('writes nothing when the record does not exist or belongs to another business', async () => {
    const before = (await ownerQuery('SELECT count(*)::int AS n FROM files WHERE business_id = $1', [ws.businessId])).rows[0].n;
    await rejects(up({ resourceId: randomUUID() }), 404);
    const foreign = (await seedCustomerVehicle(other, 'Foreign')).customer.id;
    await rejects(up({ resourceId: foreign }), 404);
    await rejects(up({ resourceType: 'nonsense', resourceId: customerId }), 422);
    expect((await ownerQuery('SELECT count(*)::int AS n FROM files WHERE business_id = $1', [ws.businessId])).rows[0].n).toBe(before);
  });
});

describe('tenant isolation', () => {
  it('another business cannot open, list, search, edit, share or trash a file, even with its id', async () => {
    const f = await up({ description: 'confidential invoice scan' });
    await rejects(openFile(other.ctx, f.id), 404);
    await rejects(getFile(other.ctx, f.id), 404);
    await rejects(updateFile(other.ctx, f.id, { description: 'x' }), 404);
    await rejects(setFileVisibility(other.ctx, f.id, 'INTERNAL'), 404);
    await rejects(trashFile(other.ctx, f.id), 404);
    await rejects(createDownloadLink(other.ctx, f.id), 404);
    const hit = await searchDocuments(other.ctx, { q: 'confidential' });
    expect(hit.items).toHaveLength(0);
    expect((await searchDocuments(other.ctx, { resourceType: 'customer', resourceId: customerId })).items).toHaveLength(0);
    // and RLS agrees at the database, with no business filter from the app at all
    const rows = await ownerQuery('SELECT count(*)::int AS n FROM files WHERE id = $1', [f.id]);
    expect(rows.rows[0].n).toBe(1);
  });

  it('a signed link names its business: it cannot be pointed at another business\'s file', async () => {
    const mine = await up();
    const theirs = await uploadFile(other.ctx, { data: png(), filename: 'theirs.png', resourceType: 'customer', resourceId: (await seedCustomerVehicle(other, 'T')).customer.id });
    const { token } = signedParts(await createDownloadLink(ws.ctx, mine.id));
    const body = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString());
    const forged = Buffer.from(JSON.stringify({ ...body, f: theirs.id })).toString('base64url');
    await expect(openSignedFile(`${forged}.${token.split('.')[1]}`)).rejects.toMatchObject({ status: 404 });
    const sameBizOtherFile = await up();
    const forged2 = Buffer.from(JSON.stringify({ ...body, f: sameBizOtherFile.id })).toString('base64url');
    await expect(openSignedFile(`${forged2}.${token.split('.')[1]}`)).rejects.toMatchObject({ status: 404 }); // signature no longer matches
  });
});

const signedParts = (l: { path: string }) => ({ token: l.path.split('/').pop()! });

describe('permissions are enforced on the server', () => {
  it('splits viewing, downloading, editing, sharing, deleting and purging', async () => {
    const f = await up();
    const viewer = await memberWithPermissions(ws, ['document.view', 'customer.view']);
    expect((await getFile(viewer.ctx, f.id)).file.id).toBe(f.id);
    await rejects(openFile(viewer.ctx, f.id), 403); // can see it exists, cannot fetch the bytes
    await rejects(createDownloadLink(viewer.ctx, f.id), 403);
    await rejects(updateFile(viewer.ctx, f.id, { description: 'x' }), 403);
    await rejects(uploadFile(viewer.ctx, { data: png(), filename: 'a.png', resourceType: 'customer', resourceId: customerId }), 403);
    await rejects(trashFile(viewer.ctx, f.id), 403);

    const editor = await memberWithPermissions(ws, ['document.view', 'document.download', 'document.edit', 'document.upload', 'customer.view']);
    await updateFile(editor.ctx, f.id, { description: 'edited' });
    await rejects(setFileVisibility(editor.ctx, f.id, 'CUSTOMER'), 403); // sharing is its own permission
    await rejects(up({ visibility: 'CUSTOMER' }, editor.ctx), 403);
    await rejects(archiveFile(editor.ctx, f.id), 403);

    const sharer = await memberWithPermissions(ws, ['document.view', 'document.download', 'document.edit', 'document.share', 'document.delete', 'customer.view']);
    await setFileVisibility(sharer.ctx, f.id, 'CUSTOMER');
    await trashFile(sharer.ctx, f.id);
    await rejects(purgeFile(sharer.ctx, f.id), 403); // only people with document.purge can destroy
  });

  it('a record\'s own permission is needed too: no customer.view, no customer files', async () => {
    const f = await up();
    const noCustomer = await memberWithPermissions(ws, ['document.view', 'document.download']);
    await rejects(getFile(noCustomer.ctx, f.id), 403);
    expect((await searchDocuments(noCustomer.ctx, {})).items.some((x) => x.id === f.id)).toBe(false);
  });

  it('read-only (expired) subscriptions cannot change documents but can still read them', async () => {
    const w = await createWorkspace('Expired Docs');
    const c = (await seedCustomerVehicle(w, 'E')).customer.id;
    const f = await uploadFile(w.ctx, { data: png(), filename: 'a.png', resourceType: 'customer', resourceId: c });
    await ownerQuery("UPDATE subscriptions SET status = 'EXPIRED', trial_ends_at = now() - interval '1 day' WHERE business_id = $1", [w.businessId]);
    const { contextForSession } = await import('../helpers/factory');
    const ro = await contextForSession(w.ctx);
    await rejects(uploadFile(ro, { data: png(), filename: 'b.png', resourceType: 'customer', resourceId: c }), 402);
    await rejects(trashFile(ro, f.id), 402);
    expect((await openFile(ro, f.id)).file.id).toBe(f.id);
  });
});

describe('visibility', () => {
  it('files on supplier, employee, part, purchase order and diagnostic records can never be shown to customers', async () => {
    const { createSupplier } = await import('@/server/inventory/suppliers');
    const s = await createSupplier(ws.ctx, { name: 'Parts Pty', email: 'p@supplier.test' });
    await rejects(uploadFile(ws.ctx, { data: png(), filename: 's.png', resourceType: 'supplier', resourceId: s.id, visibility: 'CUSTOMER' }), 422);
    const sup = await uploadFile(ws.ctx, { data: png(), filename: 's.png', resourceType: 'supplier', resourceId: s.id });
    expect(sup).toMatchObject({ visibility: 'INTERNAL', category: 'SUPPLIER_DOCUMENT' });
    await rejects(setFileVisibility(ws.ctx, sup.id, 'CUSTOMER'), 422);
  });

  it('customer visibility is explicit: nothing is shared by default, and sharing needs a customer-safe record', async () => {
    const f = await up();
    expect(f.visibility).toBe('INTERNAL');
    expect((await setFileVisibility(ws.ctx, f.id, 'CUSTOMER')).visibility).toBe('CUSTOMER');
    expect((await ownerQuery("SELECT 1 FROM audit_logs WHERE resource_id = $1 AND action = 'file.visibility_changed'", [f.id])).rowCount).toBe(1);
    expect((await setFileVisibility(ws.ctx, f.id, 'INTERNAL')).visibility).toBe('INTERNAL');
  });

  it('restricted files are hidden from people without document.view_restricted: in lists, search and direct access', async () => {
    const f = await up({ visibility: 'RESTRICTED', description: 'restricted-needle' });
    const plain = await createMemberCtx(ws, 'technician');
    await rejects(getFile(plain.ctx, f.id), 403);
    await rejects(openFile(plain.ctx, f.id), 403);
    expect((await searchDocuments(plain.ctx, { q: 'restricted-needle' })).items).toHaveLength(0);
    expect((await searchDocuments(ws.ctx, { q: 'restricted-needle' })).items).toHaveLength(1);
  });

  it('employee documents need their own permission and are never visible to ordinary staff', async () => {
    const tech = await createMemberCtx(ws, 'technician');
    const mid = (await ownerQuery('SELECT id FROM memberships WHERE business_id = $1 AND user_id = $2', [ws.businessId, tech.user.id])).rows[0].id as string;
    const f = await uploadFile(ws.ctx, { data: png(), filename: 'cert.png', resourceType: 'employee', resourceId: mid, description: 'welding-cert-needle' });
    expect(f).toMatchObject({ visibility: 'RESTRICTED', category: 'EMPLOYEE_DOCUMENT' });
    await rejects(getFile(tech.ctx, f.id), 403);
    await rejects(uploadFile(tech.ctx, { data: png(), filename: 'x.png', resourceType: 'employee', resourceId: mid }), 403);
    expect((await searchDocuments(tech.ctx, { q: 'welding-cert-needle' })).items).toHaveLength(0);
    const manager = await createMemberCtx(ws, 'manager');
    await rejects(getFile(manager.ctx, f.id), 403); // managers do not get employee documents by default
    expect((await getFile(ws.ctx, f.id)).file.id).toBe(f.id); // the owner does
  });
});

describe('lifecycle: active, archived, trash, permanently deleted', () => {
  it('archive and restore keep the file readable; trash hides it from everyday lists and is reversible', async () => {
    const f = await up({ description: 'lifecycle-needle' });
    await archiveFile(ws.ctx, f.id);
    expect((await searchDocuments(ws.ctx, { q: 'lifecycle-needle' })).items).toHaveLength(0);
    expect((await searchDocuments(ws.ctx, { q: 'lifecycle-needle', state: 'archived' })).items).toHaveLength(1);
    expect((await openFile(ws.ctx, f.id)).file.status).toBe('ARCHIVED'); // still readable
    expect((await restoreFile(ws.ctx, f.id)).status).toBe('ACTIVE');
    const trashed = await trashFile(ws.ctx, f.id);
    expect(trashed.status).toBe('TRASHED');
    expect((await searchDocuments(ws.ctx, { q: 'lifecycle-needle', state: 'trash' })).items).toHaveLength(1);
    expect((await restoreFile(ws.ctx, f.id)).status).toBe('ACTIVE');
    const audit = await ownerQuery("SELECT action FROM audit_logs WHERE resource_id = $1 AND action LIKE 'file.%' ORDER BY created_at", [f.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['file.uploaded', 'file.archived', 'file.downloaded', 'file.restored', 'file.trashed', 'file.restored']);
  });

  it('permanent deletion needs the trash first and its own permission; the object goes, the record stays', async () => {
    const f = await up();
    await rejects(purgeFile(ws.ctx, f.id), 404); // not in the trash
    await trashFile(ws.ctx, f.id);
    const key = (await ownerQuery('SELECT storage_key FROM files WHERE id = $1', [f.id])).rows[0].storage_key as string;
    expect(await getStorage().exists(key)).toBe(true);
    await purgeFile(ws.ctx, f.id);
    expect(await getStorage().exists(key)).toBe(false);
    const row = (await ownerQuery('SELECT status, deleted_at FROM files WHERE id = $1', [f.id])).rows[0];
    expect(row.status).toBe('DELETED');
    await rejects(openFile(ws.ctx, f.id), 404);
    await rejects(restoreFile(ws.ctx, f.id), 404); // gone for good
    expect((await ownerQuery("SELECT 1 FROM audit_logs WHERE resource_id = $1 AND action = 'file.purged'", [f.id])).rowCount).toBe(1);
  });

  it('the database itself refuses to destroy a financial document inside its retention period, or to trash one', async () => {
    const { issuedInvoice } = await import('../helpers/finance');
    const { financeWorkspace } = await import('../helpers/finance');
    const fw = await financeWorkspace('Retention Shop');
    const inv = await issuedInvoice(fw);
    const doc = (await ownerQuery("SELECT id, is_financial, retain_until FROM files WHERE business_id = $1 AND resource_id = $2 AND source = 'GENERATED'", [fw.businessId, inv.id])).rows[0];
    expect(doc.is_financial).toBe(true);
    expect(new Date(doc.retain_until).getTime()).toBeGreaterThan(Date.now() + 4 * 365 * 86_400_000); // years, not days
    await rejects(trashFile(fw.ctx, doc.id), 409);
    await expect(ownerQuery("UPDATE files SET status = 'TRASHED', trashed_at = now() WHERE id = $1", [doc.id])).rejects.toThrow(/cannot be moved to the trash/);
    await expect(ownerQuery("UPDATE files SET status = 'DELETED' WHERE id = $1", [doc.id])).rejects.toThrow();
    await expect(ownerQuery('DELETE FROM files WHERE id = $1', [doc.id])).rejects.toThrow(/cannot be deleted/);
    // it can be archived
    await archiveFile(fw.ctx, doc.id);
  });

  it('the scheduled cleanup removes only what has been in the trash past the retention period', async () => {
    const w = await createWorkspace('Trash Cleanup');
    const c = (await seedCustomerVehicle(w, 'T')).customer.id;
    const mk = () => uploadFile(w.ctx, { data: png(), filename: 'x.png', resourceType: 'customer', resourceId: c });
    const [recent, old, active, archived] = [await mk(), await mk(), await mk(), await mk()];
    await trashFile(w.ctx, recent.id);
    await trashFile(w.ctx, old.id);
    await archiveFile(w.ctx, archived.id);
    await ownerQuery("UPDATE files SET trashed_at = now() - interval '40 days' WHERE id = $1", [old.id]);
    const r = await purgeExpiredTrash();
    expect(r.purged).toBeGreaterThanOrEqual(1);
    const status = async (id: string) => (await ownerQuery('SELECT status FROM files WHERE id = $1', [id])).rows[0].status;
    expect(await status(old.id)).toBe('DELETED');
    expect(await status(recent.id)).toBe('TRASHED');
    expect(await status(active.id)).toBe('ACTIVE');
    expect(await status(archived.id)).toBe('ARCHIVED');
    expect((await ownerQuery("SELECT 1 FROM audit_logs WHERE business_id = $1 AND action = 'document.cleanup'", [w.businessId])).rowCount).toBeGreaterThan(0);
    // a shorter retention setting is honoured per business
    await updateDocumentSettings(w.ctx, { trashRetentionDays: 1 });
    await ownerQuery("UPDATE files SET trashed_at = now() - interval '3 days' WHERE id = $1", [recent.id]);
    await purgeExpiredTrash();
    expect(await status(recent.id)).toBe('DELETED');
  });

  it('retention settings can lengthen financial retention but never shorten it', async () => {
    const s0 = await getDocumentSettings(ws.ctx);
    expect(s0.financialRetentionYears).toBeGreaterThanOrEqual(5);
    const s1 = await updateDocumentSettings(ws.ctx, { financialRetentionYears: 3 });
    expect(s1.financialRetentionYears).toBe(s0.financialRetentionYears);
    const s2 = await updateDocumentSettings(ws.ctx, { financialRetentionYears: 8 });
    expect(s2.financialRetentionYears).toBe(8);
    const solo = await createWorkspace('Solo Settings');
    await upgradePlan(solo, 'solo');
    await rejects(updateDocumentSettings(solo.ctx, { trashRetentionDays: 7 }), 402);
  });
});

describe('versions', () => {
  it('a new version keeps the old one, numbers them, and only the newest is current', async () => {
    const v1 = await up({ data: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj'), filename: 'contract.pdf', resourceType: 'customer', resourceId: customerId });
    const v2 = await uploadNewVersion(ws.ctx, v1.id, { data: Buffer.from('%PDF-1.4\n1 0 obj<</Version 2>>endobj'), filename: 'contract-v2.pdf' });
    expect(v2).toMatchObject({ version: 2, isCurrent: true, resourceType: 'customer', category: v1.category });
    const d = await getFile(ws.ctx, v2.id);
    expect(d.versions.map((v) => [v.version, v.isCurrent])).toEqual([[2, true], [1, false]]);
    await rejects(uploadNewVersion(ws.ctx, v1.id, { data: png(), filename: 'late.png' }), 409); // replace the current one, not an earlier one
    const v3 = await uploadNewVersion(ws.ctx, v2.id, { data: Buffer.from('%PDF-1.4\n1 0 obj<</Version 3>>endobj'), filename: 'c3.pdf' });
    expect((await listVersions(ws.ctx, v3.id)).map((v) => v.version)).toEqual([3, 2, 1]);
    // the old version's bytes are untouched
    const oldBytes = await openFile(ws.ctx, v1.id);
    const chunks: Buffer[] = [];
    for await (const c of oldBytes.stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toContain('obj<<>>');
    // the stored object itself can never be changed in place
    await expect(ownerQuery("UPDATE files SET size_bytes = 1 WHERE id = $1", [v1.id])).rejects.toThrow(/never changes/);
    await expect(ownerQuery("UPDATE files SET storage_key = storage_key || 'x' WHERE id = $1", [v1.id])).rejects.toThrow();
  });
});

describe('storage usage and limits', () => {
  async function tinyPlanWorkspace(name: string) {
    await ownerQuery(`INSERT INTO plans (key, name, price_cents, max_members, max_locations, max_storage_mb, is_public, sort_order, status)
      VALUES ('tiny_docs', 'Tiny', 100, 2, 1, 1, false, 99, 'ARCHIVED') ON CONFLICT (key) DO NOTHING`);
    const w = await createWorkspace(name);
    await ownerQuery(`UPDATE subscriptions SET status = 'ACTIVE', trial_ends_at = NULL, current_period_end = now() + interval '30 days',
      plan_id = (SELECT id FROM plans WHERE key = 'tiny_docs') WHERE business_id = $1`, [w.businessId]);
    const { businessContext } = await import('../helpers/factory');
    w.ctx = await businessContext(w.owner);
    return w;
  }

  it('reports real usage by category and record type, counts the trash, and blocks uploads at the plan limit without deleting anything', async () => {
    const w = await tinyPlanWorkspace('Quota Docs');
    const c = (await seedCustomerVehicle(w, 'Q')).customer.id;
    const big = (kb: number) => pngOf(kb * 1024, 0);
    const limit = 1024 * 1024;
    const r0 = await getStorageReport(w.ctx);
    expect(r0).toMatchObject({ usedBytes: 0, fileCount: 0, state: 'ok', limitBytes: limit });
    const a = await uploadFile(w.ctx, { data: big(600), filename: 'a.png', resourceType: 'customer', resourceId: c });
    const r1 = await getStorageReport(w.ctx);
    expect(r1.usedBytes).toBe(a.sizeBytes);
    expect(r1.byCategory[0]).toMatchObject({ key: 'CUSTOMER_DOCUMENT', files: 1, bytes: a.sizeBytes });
    expect(r1.byRecordType[0]).toMatchObject({ key: 'customer', files: 1 });
    expect(r1.largest[0]).toMatchObject({ id: a.id });
    expect(r1.state).toBe('ok');
    // a second large file does not fit: refused with the plan-limit code, nothing is removed to make room
    await expect(uploadFile(w.ctx, { data: big(600), filename: 'b.png', resourceType: 'customer', resourceId: c })).rejects.toMatchObject({ code: 'PLAN_LIMIT_REACHED' });
    expect((await ownerQuery('SELECT count(*)::int AS n FROM files WHERE business_id = $1', [w.businessId])).rows[0].n).toBe(1);
    // the trash still occupies storage until it is permanently deleted
    await trashFile(w.ctx, a.id);
    expect((await getStorageReport(w.ctx)).usedBytes).toBe(a.sizeBytes);
    await expect(uploadFile(w.ctx, { data: big(600), filename: 'c.png', resourceType: 'customer', resourceId: c })).rejects.toMatchObject({ code: 'PLAN_LIMIT_REACHED' });
    await purgeFile(w.ctx, a.id);
    expect((await getStorageReport(w.ctx)).usedBytes).toBe(0);
    await expect(uploadFile(w.ctx, { data: big(600), filename: 'd.png', resourceType: 'customer', resourceId: c })).resolves.toBeTruthy();
    // close to the limit is reported in words, not just a colour
    await uploadFile(w.ctx, { data: big(300), filename: 'e.png', resourceType: 'customer', resourceId: c });
    expect((await getStorageReport(w.ctx)).state).toBe('near');
  });

  it('a plan change that leaves a business over its new limit keeps every file and only blocks new uploads', async () => {
    const w = await tinyPlanWorkspace('Downgrade Docs');
    const c = (await seedCustomerVehicle(w, 'D')).customer.id;
    const f = await uploadFile(w.ctx, { data: pngOf(700 * 1024, 0), filename: 'a.png', resourceType: 'customer', resourceId: c });
    await ownerQuery("UPDATE plans SET max_storage_mb = 0 WHERE key = 'tiny_docs'").catch(() => {});
    const { businessContext } = await import('../helpers/factory');
    w.ctx = await businessContext(w.owner);
    const r = await getStorageReport(w.ctx);
    expect(['full', 'over']).toContain(r.state);
    expect((await openFile(w.ctx, f.id)).file.id).toBe(f.id);
    await expect(uploadFile(w.ctx, { data: png(), filename: 'x.png', resourceType: 'customer', resourceId: c })).rejects.toMatchObject({ code: 'PLAN_LIMIT_REACHED' });
    await ownerQuery("UPDATE plans SET max_storage_mb = 1 WHERE key = 'tiny_docs'");
  });
});

describe('search', () => {
  let sw: TestWorkspace;
  let cust: { id: string; name: string };
  let veh: { id: string; registration: string | null };
  beforeAll(async () => {
    sw = await createWorkspace('Search Docs');
    const s = await seedCustomerVehicle(sw, 'Srch');
    cust = { id: s.customer.id, name: s.customer.name };
    veh = { id: s.vehicle.id, registration: s.vehicle.registration ?? null };
    const { job } = await createJob(sw.ctx, { customerId: s.customer.id, vehicleId: s.vehicle.id, complaint: 'x', mileageKm: 51_000 });
    (cust as Record<string, unknown>).jobId = job.id;
    (cust as Record<string, unknown>).jobNumber = job.jobNumber;
    const mk = (resourceType: string, resourceId: string, filename: string, over: Record<string, unknown> = {}) => uploadFile(sw.ctx, { data: png(), filename, resourceType, resourceId, ...over } as never);
    await mk('customer', cust.id, 'id-document.png', { description: 'Customer ID copy' });
    await mk('vehicle', veh.id, 'registration-papers.png', { category: 'VEHICLE_REGISTRATION' });
    await mk('job', (cust as Record<string, unknown>).jobId as string, 'engine-bay.png', { category: 'VEHICLE_PHOTO' });
    for (let i = 0; i < 25; i++) await mk('customer', cust.id, `bulk-${String(i).padStart(2, '0')}.png`);
  });

  it('finds documents by their own name, description, customer, registration and job number', async () => {
    const q = async (text: string) => (await searchDocuments(sw.ctx, { q: text })).items.map((i) => i.name);
    expect(await q('id-document')).toEqual(['id-document.png']);
    expect(await q('ID copy')).toEqual(['id-document.png']);
    expect((await searchDocuments(sw.ctx, { q: cust.name })).meta.total).toBe(28); // everything on that customer, its vehicle and its job
    expect(await q(veh.registration!.slice(0, 4))).toEqual(expect.arrayContaining(['registration-papers.png', 'engine-bay.png']));
    expect(await q((cust as Record<string, unknown>).jobNumber as string)).toEqual(['engine-bay.png']);
  });

  it('filters by category, type and visibility, and pages without loading everything', async () => {
    const p1 = await searchDocuments(sw.ctx, { pageSize: 10, page: 1 });
    const p3 = await searchDocuments(sw.ctx, { pageSize: 10, page: 3 });
    expect(p1.items).toHaveLength(10);
    expect(p1.meta).toMatchObject({ total: 28, totalPages: 3, page: 1 });
    expect(p3.items).toHaveLength(8);
    expect(new Set([...p1.items, ...p3.items].map((i) => i.id)).size).toBe(18);
    expect((await searchDocuments(sw.ctx, { category: 'VEHICLE_REGISTRATION' })).items.map((i) => i.name)).toEqual(['registration-papers.png']);
    expect((await searchDocuments(sw.ctx, { fileType: 'pdf' })).items).toHaveLength(0);
    expect((await searchDocuments(sw.ctx, { visibility: 'CUSTOMER' })).items).toHaveLength(0);
    expect((await searchDocuments(sw.ctx, { sort: 'name', pageSize: 3 })).items.map((i) => i.name)).toEqual(['bulk-00.png', 'bulk-01.png', 'bulk-02.png']);
    expect((await searchDocuments(sw.ctx, { resourceType: 'vehicle', resourceId: veh.id })).items).toHaveLength(1);
    await expect(searchDocuments(sw.ctx, { pageSize: 5000 })).rejects.toBeTruthy();
  });

  it('matches wildcard characters literally, not as patterns', async () => {
    expect((await searchDocuments(sw.ctx, { q: '%' })).items).toHaveLength(0);
    expect((await searchDocuments(sw.ctx, { q: '_' })).items).toHaveLength(0);
    expect((await searchDocuments(sw.ctx, { q: "x' OR '1'='1" })).items).toHaveLength(0);
  });
});

describe('downloads', () => {
  it('serves bytes with hardened headers: nosniff, no caching, never inline for unsafe types', async () => {
    const f = await up();
    const res = await call(fileRoute, { token: ws.ctx.token, params: { id: f.id } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('content-disposition')).toMatch(/^inline/);
    const docx = await uploadFile(ws.ctx, { data: realDocx(), filename: 'quote.docx', resourceType: 'customer', resourceId: customerId });
    expect((await call(fileRoute, { token: ws.ctx.token, params: { id: docx.id } })).headers.get('content-disposition')).toMatch(/^attachment/);
    const forced = await call(fileRoute, { token: ws.ctx.token, params: { id: f.id }, query: { download: '1' } });
    expect(forced.headers.get('content-disposition')).toMatch(/^attachment/);
    expect((await call(fileRoute, { params: { id: f.id } })).status).toBe(401);
    expect((await ownerQuery("SELECT count(*)::int AS n FROM audit_logs WHERE resource_id = $1 AND action = 'file.downloaded'", [f.id])).rows[0].n).toBe(2);
  });

  it('gives a thumbnail for photos and none for other files', async () => {
    const f = await up();
    const t = await call(fileRoute, { token: ws.ctx.token, params: { id: f.id }, query: { thumb: '1' } });
    expect(t.status).toBe(200);
    expect(t.headers.get('content-type')).toBe('image/webp');
    expect(Number(t.headers.get('content-length'))).toBeLessThan(f.sizeBytes + 5000);
    expect(t.headers.get('cache-control')).toContain('private');
    const doc = await uploadFile(ws.ctx, { data: realDocx(), filename: 'plain.docx', resourceType: 'customer', resourceId: customerId });
    expect(doc.hasThumbnail).toBe(false);
  });

  it('signed links work without a session, expire, and stop when the file is trashed or the person loses access', async () => {
    const f = await up();
    const link = await createDownloadLink(ws.ctx, f.id, 120);
    const token = link.path.split('/').pop()!;
    const ok = await call(publicFileRoute, { params: { token }, origin: null });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await ownerQuery("SELECT 1 FROM audit_logs WHERE resource_id = $1 AND metadata->>'via' = 'signed_link'", [f.id])).rowCount).toBe(1);
    expect((await call(publicFileRoute, { params: { token: token.slice(0, -3) + 'abc' }, origin: null })).status).toBe(404);
    // expired
    const { signFileLink } = await import('@/server/files/signed');
    const expired = signFileLink({ f: f.id, b: ws.businessId, u: ws.ctx.user.id, s: 'staff' }, 60, Date.now() - 3_600_000).token;
    expect((await call(publicFileRoute, { params: { token: expired }, origin: null })).status).toBe(410);
    // trashed: the same live link stops working
    await trashFile(ws.ctx, f.id);
    expect((await call(publicFileRoute, { params: { token }, origin: null })).status).toBe(404);
    await restoreFile(ws.ctx, f.id);
    expect((await call(publicFileRoute, { params: { token }, origin: null })).status).toBe(200);
    // the person who made the link loses their permission: it stops working
    const m = await memberWithPermissions(ws, ['document.view', 'document.download', 'customer.view']);
    const mlink = (await createDownloadLink(m.ctx, f.id)).path.split('/').pop()!;
    expect((await call(publicFileRoute, { params: { token: mlink }, origin: null })).status).toBe(200);
    await ownerQuery("UPDATE memberships SET status = 'SUSPENDED' WHERE business_id = $1 AND user_id = $2", [ws.businessId, m.user.id]);
    expect((await call(publicFileRoute, { params: { token: mlink }, origin: null })).status).toBe(404);
  });
});

describe('cleanup of objects with no record', () => {
  it('removes only unreferenced, old objects under the business prefix, and reports before it acts', async () => {
    const w = await createWorkspace('Orphans');
    const c = (await seedCustomerVehicle(w, 'O')).customer.id;
    const kept = await uploadFile(w.ctx, { data: png(), filename: 'kept.png', resourceType: 'customer', resourceId: c });
    const root = env().STORAGE_LOCAL_DIR;
    const dir = join(root, w.businessId, String(new Date().getUTCFullYear()));
    mkdirSync(dir, { recursive: true });
    const orphanOld = randomUUID();
    const orphanNew = randomUUID();
    writeFileSync(join(dir, orphanOld), 'left behind');
    writeFileSync(join(dir, orphanNew), 'still being written');
    const longAgo = new Date(Date.now() - 10 * 86_400_000);
    utimesSync(join(dir, orphanOld), longAgo, longAgo);
    const keptKey = (await ownerQuery('SELECT storage_key, thumbnail_key FROM files WHERE id = $1', [kept.id])).rows[0];
    utimesSync(join(root, keptKey.storage_key), longAgo, longAgo); // an old but referenced object must survive
    const dry = await cleanupOrphanObjects(new Date(), { apply: false, businessId: w.businessId });
    expect(dry.wouldRemove).toBe(1);
    expect(dry.removed).toBe(0);
    expect(await getStorage().exists(`${w.businessId}/${new Date().getUTCFullYear()}/${orphanOld}`)).toBe(true);
    const real = await cleanupOrphanObjects(new Date(), { businessId: w.businessId });
    expect(real.removed).toBe(1);
    expect(await getStorage().exists(`${w.businessId}/${new Date().getUTCFullYear()}/${orphanOld}`)).toBe(false);
    expect(await getStorage().exists(`${w.businessId}/${new Date().getUTCFullYear()}/${orphanNew}`)).toBe(true); // too young to touch
    expect(await getStorage().exists(keptKey.storage_key)).toBe(true);
    expect((await openFile(w.ctx, kept.id)).file.id).toBe(kept.id);
  });
});

describe('job photos stay consistent with the document library', () => {
  it('carries category and visibility onto the file, and keeps them in step when changed', async () => {
    const { addJobPhoto, setJobPhotoVisibility } = await import('@/server/jobcards/items');
    const { job } = await createJob(ws.ctx, { customerId, vehicleId, complaint: 'Noise', mileageKm: 52_000 });
    const photo = await addJobPhoto(ws.ctx, job.id, { data: png(), filename: 'front.png' }, { category: 'CHECK_IN_FRONT', visibility: 'CUSTOMER', description: 'Front of the car' });
    const file = (await ownerQuery('SELECT category, visibility, description, resource_type, customer_id FROM files WHERE id = $1', [photo.fileId])).rows[0];
    expect(file).toMatchObject({ category: 'VEHICLE_PHOTO', visibility: 'CUSTOMER', description: 'Front of the car', resource_type: 'job', customer_id: customerId });
    await setJobPhotoVisibility(ws.ctx, job.id, photo.id, 'INTERNAL');
    expect((await ownerQuery('SELECT visibility FROM files WHERE id = $1', [photo.fileId])).rows[0].visibility).toBe('INTERNAL');
    await setFileVisibility(ws.ctx, photo.fileId, 'CUSTOMER');
    expect((await ownerQuery('SELECT visibility FROM job_photos WHERE id = $1', [photo.id])).rows[0].visibility).toBe('CUSTOMER');
    void createVehicle; void drainJobs; void prisma;
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, withTenant } from '@/server/db/client';
import { getPublicJob, openPublicJobFile, createJobCustomerLink, getPublicJobLogo } from '@/server/documents/customer';
import { createDownloadLink, setFileVisibility, uploadFile } from '@/server/files/service';
import { trashFile } from '@/server/files/lifecycle';
import { createJobCustomerLink as _link } from '@/server/documents/customer';
import { addJobNote, createJob } from '@/server/jobcards/service';
import { addJobPhoto } from '@/server/jobcards/items';
import { ensureDocument } from '@/server/documents/generator';
import { revokeDocumentLinks } from '@/server/finance/links';
import { sendCustomerMessage } from '@/server/notifications/comms';
import { updateCommSettings } from '@/server/notifications/settings';
import { recordConsent } from '@/server/notifications/preferences';
import { getCommSettings } from '@/server/notifications/settings';
import { call } from '../helpers/http';
import { appClient, createMemberCtx, drainJobs, ownerQuery, type TestWorkspace } from '../helpers/factory';
import { seedCustomerVehicle } from '../helpers/workshop';
import { financeWorkspace } from '../helpers/finance';
import { pngOf, realDocx } from '../helpers/images';
import { GET as filesGET, POST as filesPOST } from '@/app/api/v1/files/route';
import { GET as fileGET, PATCH as filePATCH } from '@/app/api/v1/files/[id]/route';
import { POST as purgePOST } from '@/app/api/v1/files/[id]/purge/route';
import { POST as visibilityPOST } from '@/app/api/v1/files/[id]/visibility/route';
import { POST as linkPOST } from '@/app/api/v1/files/[id]/link/route';
import { GET as usageGET } from '@/app/api/v1/files/usage/route';
import { POST as reconcilePOST } from '@/app/api/v1/files/reconcile/route';
import { PUT as settingsPUT, GET as settingsGET } from '@/app/api/v1/files/settings/route';
import { POST as categoriesPOST } from '@/app/api/v1/files/categories/route';
import { POST as generatePOST } from '@/app/api/v1/documents/generate/route';
import { GET as generationsGET } from '@/app/api/v1/documents/generations/route';
import { GET as commsGET } from '@/app/api/v1/communications/route';
import { POST as sendPOST } from '@/app/api/v1/communications/send/route';
import { PUT as templatesPUT, GET as templatesGET } from '@/app/api/v1/communication/templates/route';
import { PUT as commSettingsPUT, GET as commSettingsGET } from '@/app/api/v1/communication/settings/route';
import { GET as notificationsGET } from '@/app/api/v1/notifications/route';
import { POST as optoutPOST } from '@/app/api/public/optout/[token]/route';
import { POST as twilioPOST } from '@/app/api/public/webhooks/twilio/route';
import { GET as publicFileGET } from '@/app/api/public/files/[token]/route';
import { GET as publicJobGET } from '@/app/api/public/jobs/[token]/route';
import { GET as publicJobFileGET } from '@/app/api/public/jobs/[token]/files/[fileId]/route';
import { POST as customerLinkPOST } from '@/app/api/v1/jobs/[id]/customer-link/route';

afterAll(disconnectPrisma);

let A: TestWorkspace;
let B: TestWorkspace;
let tech: Awaited<ReturnType<typeof createMemberCtx>>;
let custA: { id: string };
let jobA: { id: string };
let n = 0;
const png = () => pngOf(48 + ++n, n % 200);
const tokenOf = (url: string) => url.split('/').pop()!;
const rejects = (p: Promise<unknown>, status?: number) => expect(p).rejects.toMatchObject(status ? { status } : {});

beforeAll(async () => {
  A = await financeWorkspace('Sec6 A');
  B = await financeWorkspace('Sec6 B');
  tech = await createMemberCtx(A, 'technician');
  const sA = await seedCustomerVehicle(A, 'SecA');
  custA = sA.customer;
  jobA = (await createJob(A.ctx, { customerId: sA.customer.id, vehicleId: sA.vehicle.id, complaint: 'x', mileageKm: 60_000 })).job;
});

describe('the customer job page shows only what was explicitly shared', () => {
  it('internal files, internal notes, diagnostic and supplier documents never appear, whatever is attached to the job', async () => {
    const shared = await uploadFile(A.ctx, { data: png(), filename: 'shared-photo.png', resourceType: 'job', resourceId: jobA.id, visibility: 'CUSTOMER', description: 'Shared photo' });
    const sharedDoc = await uploadFile(A.ctx, { data: realDocx(), filename: 'warranty.docx', resourceType: 'job', resourceId: jobA.id, visibility: 'CUSTOMER' });
    const internal = await uploadFile(A.ctx, { data: png(), filename: 'internal-photo.png', resourceType: 'job', resourceId: jobA.id });
    const restricted = await uploadFile(A.ctx, { data: png(), filename: 'restricted.png', resourceType: 'job', resourceId: jobA.id, visibility: 'RESTRICTED' });
    const trashed = await uploadFile(A.ctx, { data: png(), filename: 'trashed.png', resourceType: 'job', resourceId: jobA.id, visibility: 'CUSTOMER' });
    await trashFile(A.ctx, trashed.id);
    await addJobNote(A.ctx, jobA.id, { body: 'Visible update for the customer', visibility: 'CUSTOMER' });
    await addJobNote(A.ctx, jobA.id, { body: 'SECRET-INTERNAL-NOTE', visibility: 'INTERNAL' });
    const url = (await createJobCustomerLink(A.ctx, jobA.id)).url;
    const token = tokenOf(url);
    const page = await getPublicJob(token, { requestId: 'r' });
    expect(page.job.number).toBeTruthy();
    expect(page.updates.map((u) => u.body)).toEqual(['Visible update for the customer']);
    expect(page.photos.map((p) => p.id)).toEqual([shared.id]);
    expect(page.documents.map((d) => d.id)).toEqual([sharedDoc.id]);
    expect(JSON.stringify(page)).not.toMatch(/SECRET-INTERNAL-NOTE|internal-photo|restricted|trashed|storage|sha256|uploadedById|costCents/i);
    // fetching by id: shared files work, everything else is "not found" (the same answer as for a made-up id)
    const get = (id: string, q: Record<string, string> = {}) => call(publicJobFileGET, { params: { token, fileId: id }, query: q, origin: null });
    expect((await get(shared.id)).status).toBe(200);
    expect((await get(shared.id, { thumb: '1' })).headers.get('content-type')).toBe('image/webp');
    const doc = await get(sharedDoc.id);
    expect(doc.status).toBe(200);
    expect(doc.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(doc.headers.get('x-content-type-options')).toBe('nosniff');
    for (const f of [internal, restricted, trashed]) expect((await get(f.id)).status).toBe(404);
    expect((await get('00000000-0000-0000-0000-000000000000')).status).toBe(404);
    expect((await get('not-a-uuid')).status).toBe(404);
    expect((await ownerQuery("SELECT count(*)::int AS n FROM audit_logs WHERE business_id = $1 AND metadata->>'via' = 'customer_link' AND resource_id = $2", [A.businessId, shared.id])).rows[0].n).toBe(1);
    // taking a file back from the customer removes it at once, through the same link
    await setFileVisibility(A.ctx, shared.id, 'INTERNAL');
    expect((await get(shared.id)).status).toBe(404);
    expect((await getPublicJob(token, { requestId: 'r' })).photos).toHaveLength(0);
  });

  it('a link opens its own job only: another job\'s files, another business\'s files and unrelated record files are out of reach', async () => {
    const sA2 = await seedCustomerVehicle(A, 'SecA2');
    const job2 = (await createJob(A.ctx, { customerId: sA2.customer.id, vehicleId: sA2.vehicle.id, complaint: 'y', mileageKm: 60_000 })).job;
    const otherJobFile = await uploadFile(A.ctx, { data: png(), filename: 'other-job.png', resourceType: 'job', resourceId: job2.id, visibility: 'CUSTOMER' });
    const customerFile = await uploadFile(A.ctx, { data: png(), filename: 'customer-id.png', resourceType: 'customer', resourceId: custA.id, visibility: 'CUSTOMER' });
    const sB = await seedCustomerVehicle(B, 'SecB');
    const jobB = (await createJob(B.ctx, { customerId: sB.customer.id, vehicleId: sB.vehicle.id, complaint: 'z', mileageKm: 60_000 })).job;
    const foreign = await uploadFile(B.ctx, { data: png(), filename: 'foreign.png', resourceType: 'job', resourceId: jobB.id, visibility: 'CUSTOMER' });
    const token = tokenOf((await createJobCustomerLink(A.ctx, jobA.id)).url);
    for (const f of [otherJobFile, customerFile, foreign]) {
      await expect(openPublicJobFile(token, f.id, { requestId: 'r' })).rejects.toMatchObject({ status: 404 });
    }
    // the same for a link to business B's job: it cannot reach A's files either
    const tokenB = tokenOf((await createJobCustomerLink(B.ctx, jobB.id)).url);
    await expect(openPublicJobFile(tokenB, otherJobFile.id, { requestId: 'r' })).rejects.toMatchObject({ status: 404 });
    expect((await openPublicJobFile(tokenB, foreign.id, { requestId: 'r' })).file.id).toBe(foreign.id);
  });

  it('links expire, can be revoked, and reveal nothing about why they failed', async () => {
    const token = tokenOf((await createJobCustomerLink(A.ctx, jobA.id)).url);
    await getPublicJob(token, { requestId: 'r' });
    await ownerQuery("UPDATE document_links SET created_at = now() - interval '2 days', expires_at = now() - interval '1 minute' WHERE kind = 'JOB' AND document_id = $1", [jobA.id]);
    await expect(getPublicJob(token, { requestId: 'r' })).rejects.toMatchObject({ status: 404 });
    const t2 = tokenOf((await createJobCustomerLink(A.ctx, jobA.id)).url);
    await withTenant(A.businessId, (tx) => revokeDocumentLinks(tx, A.businessId, 'JOB', jobA.id));
    const a = await call(publicJobGET, { params: { token: t2 }, origin: null });
    const b = await call(publicJobGET, { params: { token: 'x'.repeat(43) }, origin: null });
    const c = await call(publicJobGET, { params: { token: 'short' }, origin: null });
    expect([a.status, b.status, c.status]).toEqual([404, 404, 404]);
    expect({ code: a.body.error.code, message: a.body.error.message }).toEqual({ code: b.body.error.code, message: b.body.error.message }); // expired, revoked and unknown look the same
    await expect(getPublicJobLogo('x'.repeat(43))).rejects.toMatchObject({ status: 404 });
  });

  it('needs permission to share, and the link is for staff who can see the job', async () => {
    await rejects(createJobCustomerLink(tech.ctx, jobA.id), 403);
    await rejects(createJobCustomerLink(B.ctx, jobA.id), 404);
    expect((await call(customerLinkPOST, { token: tech.ctx.token, params: { id: jobA.id }, body: {} })).status).toBe(403);
    expect((await call(customerLinkPOST, { token: B.ctx.token, params: { id: jobA.id }, body: {} })).status).toBe(404);
    expect((await call(customerLinkPOST, { token: A.ctx.token, params: { id: jobA.id }, body: {} })).status).toBe(201);
    void _link;
  });

  it('job photos marked for the customer reach the page; internal ones never do', async () => {
    const shown = await addJobPhoto(A.ctx, jobA.id, { data: png(), filename: 'show.png' }, { category: 'BEFORE_REPAIR', visibility: 'CUSTOMER', description: 'Worn disc' });
    await addJobPhoto(A.ctx, jobA.id, { data: png(), filename: 'hide.png' }, { category: 'DIAGNOSTIC_EVIDENCE', visibility: 'INTERNAL', description: 'INTERNAL-EVIDENCE' });
    const page = await getPublicJob(tokenOf((await createJobCustomerLink(A.ctx, jobA.id)).url), { requestId: 'r' });
    expect(page.photos.map((p) => p.id)).toContain(shown.fileId);
    expect(JSON.stringify(page)).not.toContain('INTERNAL-EVIDENCE');
  });
});

describe('the database refuses unshareable customer visibility', () => {
  it('a supplier, employee, part or business file cannot be marked customer-visible even by direct SQL', async () => {
    const { createSupplier } = await import('@/server/inventory/suppliers');
    const s = await createSupplier(A.ctx, { name: 'Sec Supplier', email: 's@sec.test' });
    const f = await uploadFile(A.ctx, { data: png(), filename: 'inv.png', resourceType: 'supplier', resourceId: s.id });
    await expect(ownerQuery("UPDATE files SET visibility = 'CUSTOMER' WHERE id = $1", [f.id])).rejects.toThrow(/files_customer_visibility_chk/);
    const biz = await uploadFile(A.ctx, { data: png(), filename: 'licence.png', resourceType: 'business', resourceId: A.businessId });
    await expect(ownerQuery("UPDATE files SET visibility = 'CUSTOMER' WHERE id = $1", [biz.id])).rejects.toThrow(/files_customer_visibility_chk/);
    await rejects(setFileVisibility(A.ctx, f.id, 'CUSTOMER'), 422);
  });
});

describe('every new endpoint enforces authentication and permission on the server', () => {
  const routes: [string, any, Record<string, unknown>][] = [
    ['GET files (search)', filesGET, {}],
    ['POST files', filesPOST, { form: new FormData() }],
    ['GET file', fileGET, { params: { id: '00000000-0000-0000-0000-000000000001' } }],
    ['PATCH file', filePATCH, { method: 'PATCH', params: { id: '00000000-0000-0000-0000-000000000001' }, body: {} }],
    ['POST purge', purgePOST, { params: { id: '00000000-0000-0000-0000-000000000001' }, body: {} }],
    ['POST visibility', visibilityPOST, { params: { id: '00000000-0000-0000-0000-000000000001' }, body: { visibility: 'CUSTOMER' } }],
    ['POST link', linkPOST, { params: { id: '00000000-0000-0000-0000-000000000001' }, body: {} }],
    ['GET usage', usageGET, {}],
    ['POST reconcile', reconcilePOST, {}],
    ['GET file settings', settingsGET, {}],
    ['PUT file settings', settingsPUT, { method: 'PUT', body: { trashRetentionDays: 7 } }],
    ['POST categories', categoriesPOST, { body: { label: 'Nope' } }],
    ['POST generate', generatePOST, { body: { kind: 'invoice', id: '00000000-0000-0000-0000-000000000001' } }],
    ['GET generations', generationsGET, {}],
    ['GET communications', commsGET, {}],
    ['POST send', sendPOST, { body: { customerId: '00000000-0000-0000-0000-000000000001', body: 'hello' } }],
    ['GET templates', templatesGET, {}],
    ['PUT templates', templatesPUT, { method: 'PUT', body: { event: 'QUOTE_SENT', channel: 'EMAIL', subject: 's', body: 'x' } }],
    ['GET comm settings', commSettingsGET, {}],
    ['PUT comm settings', commSettingsPUT, { method: 'PUT', body: { senderName: 'x' } }],
    ['GET notifications', notificationsGET, {}],
  ];

  it('refuses a request with no session', async () => {
    for (const [name, handler, opts] of routes) {
      const r = await call(handler, { ...opts });
      expect(r.status, name).toBe(401);
    }
  });

  it('refuses a technician anything that needs a permission they were not given', async () => {
    const forbidden = ['POST purge', 'POST visibility', 'POST reconcile', 'PUT file settings', 'POST categories', 'GET generations', 'GET communications', 'POST send', 'GET templates', 'PUT templates', 'GET comm settings', 'PUT comm settings'];
    for (const [name, handler, opts] of routes) {
      if (!forbidden.includes(name)) continue;
      const r = await call(handler, { ...opts, token: tech.ctx.token });
      expect(r.status, name).toBe(403);
    }
    // while the centre every member has still works for them
    expect((await call(notificationsGET, { token: tech.ctx.token })).status).toBe(200);
  });

  it('keeps the public endpoints closed to anything without a valid signature or token', async () => {
    expect((await call(twilioPOST, { origin: null, body: 'MessageSid=SM1&MessageStatus=delivered', headers: { 'x-twilio-signature': 'forged' } })).status).toBe(403);
    expect((await call(twilioPOST, { origin: null, body: 'MessageSid=SM1&MessageStatus=delivered' })).status).toBe(403);
    expect((await call(optoutPOST, { params: { token: 'x.y' }, origin: null })).status).toBe(404);
    expect((await call(publicFileGET, { params: { token: 'a.b' }, origin: null })).status).toBe(404);
  });
});

describe('another business cannot see this one\'s notifications or messages', () => {
  it('the notification API returns only the signed-in person\'s own', async () => {
    await withTenant(A.businessId, async (tx) => {
      const { notifyInApp } = await import('@/server/notifications/service');
      await notifyInApp(tx, { businessId: A.businessId, userId: A.ctx.user.id, type: 'LOW_STOCK', title: 'A-only secret title' });
    });
    const mine = await call(notificationsGET, { token: A.ctx.token });
    const theirs = await call(notificationsGET, { token: B.ctx.token });
    expect(JSON.stringify(mine.body)).toContain('A-only secret title');
    expect(JSON.stringify(theirs.body)).not.toContain('A-only secret title');
    expect(JSON.stringify((await call(notificationsGET, { token: tech.ctx.token })).body)).not.toContain('A-only secret title'); // not even a colleague's
  });

  it('row-level security protects every new table', async () => {
    const c = await appClient();
    try {
      const tables = ['document_categories', 'document_settings', 'document_generations', 'communications', 'message_templates', 'communication_settings', 'customer_comm_preferences', 'consent_records', 'service_reminder_log'];
      for (const t of tables) expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, `${t} with no business`).toBe(0);
      const sa = await seedCustomerVehicle(A, 'Rls');
      await withTenant(A.businessId, (tx) => sendCustomerMessage(tx, A.businessId, { event: 'QUOTE_SENT', customerId: sa.customer.id, dedupeKey: `rls:${sa.customer.id}`, vars: { quote_number: 'Q', quote_total: 'R', valid_until: 'x' } }));
      const msg = (await ownerQuery('SELECT id FROM communications WHERE customer_id = $1', [sa.customer.id])).rows[0].id as string;
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.business_id', $1, true)", [B.businessId]);
      expect((await c.query('SELECT count(*)::int AS n FROM communications WHERE id = $1', [msg])).rows[0].n).toBe(0);
      await expect(c.query("INSERT INTO message_templates (business_id, event, channel, body, updated_at) VALUES ($1, 'QUOTE_SENT', 'EMAIL', 'x', now())", [A.businessId])).rejects.toThrow(/row-level security/);
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.business_id', $1, true)", [A.businessId]);
      expect((await c.query('SELECT count(*)::int AS n FROM communications WHERE id = $1', [msg])).rows[0].n).toBe(1);
      await c.query('ROLLBACK');
      // the provider-reference policy shows ONE message to a request that presents its reference, and nothing otherwise
      await ownerQuery("UPDATE communications SET provider_ref = 'ref-xyz', provider = 'memory' WHERE id = $1", [msg]);
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.provider_ref', 'ref-xyz', true)");
      expect((await c.query('SELECT count(*)::int AS n FROM communications')).rows[0].n).toBe(1);
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.provider_ref', 'guess', true)");
      expect((await c.query('SELECT count(*)::int AS n FROM communications')).rows[0].n).toBe(0);
      await c.query('ROLLBACK');
    } finally { await c.end(); }
  });
});

describe('secrets and abuse', () => {
  it('provider credentials never appear in stored messages, settings responses or audit entries', async () => {
    const e = process.env as Record<string, string | undefined>;
    const { resetEnvForTests } = await import('@/lib/env');
    e.TWILIO_AUTH_TOKEN = 'SUPER-SECRET-AUTH-TOKEN-123';
    e.TWILIO_ACCOUNT_SID = 'ACSUPERSECRETSID';
    resetEnvForTests();
    try {
      const w = await financeWorkspace('Secrets');
      const { customer } = await seedCustomerVehicle(w, 'Sx');
      await ownerQuery("UPDATE customers SET preferred_contact = 'SMS' WHERE id = $1", [customer.id]);
      await recordConsent(w.ctx, customer.id, { type: 'SMS', status: 'GRANTED', source: 'phone' });
      await updateCommSettings(w.ctx, { smsEnabled: true });
      await withTenant(w.businessId, (tx) => sendCustomerMessage(tx, w.businessId, { event: 'BOOKING_CANCELLED', customerId: customer.id, dedupeKey: 'sx', vars: { service_name: 's', appointment_date: 'd', appointment_time: 't' } }));
      await drainJobs();
      const dump = JSON.stringify([
        (await ownerQuery('SELECT * FROM communications WHERE business_id = $1', [w.businessId])).rows,
        (await ownerQuery('SELECT * FROM audit_logs WHERE business_id = $1', [w.businessId])).rows,
        (await ownerQuery("SELECT payload FROM jobs WHERE business_id = $1", [w.businessId])).rows,
        await getCommSettings(w.ctx),
        (await call(commSettingsGET, { token: w.ctx.token })).body,
      ]);
      expect(dump).not.toMatch(/SUPER-SECRET|ACSUPERSECRETSID/);
    } finally { delete e.TWILIO_AUTH_TOKEN; delete e.TWILIO_ACCOUNT_SID; resetEnvForTests(); }
  });

  it('a flood of manual messages is slowed by the rate limit, and a mistake cannot fan out to a list', async () => {
    const w = await financeWorkspace('Flood');
    const { customer } = await seedCustomerVehicle(w, 'Fl');
    let limited = 0;
    for (let i = 0; i < 35; i++) {
      const r = await call(sendPOST, { token: w.ctx.token, body: { customerId: customer.id, body: `message number ${i}` } });
      if (r.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
    const sent = (await ownerQuery("SELECT count(*)::int AS n FROM communications WHERE customer_id = $1 AND manual", [customer.id])).rows[0].n as number;
    expect(sent).toBeLessThanOrEqual(30);
  });

  it('a single customer cannot be flooded with the same kind of message', async () => {
    const w = await financeWorkspace('Per Recipient');
    const { customer } = await seedCustomerVehicle(w, 'Pr');
    let skipped = 0;
    for (let i = 0; i < 25; i++) {
      const out = await withTenant(w.businessId, (tx) => sendCustomerMessage(tx, w.businessId, { event: 'QUOTE_SENT', customerId: customer.id, dedupeKey: `flood:${i}`, vars: { quote_number: `Q${i}`, quote_total: 'R', valid_until: 'x' } }));
      if (out.some((o) => o.status === 'skipped')) skipped++;
    }
    expect(skipped).toBe(5); // 20 an hour to one address; the rest are recorded as not sent, not lost silently
    expect((await ownerQuery("SELECT status_detail FROM communications WHERE customer_id = $1 AND status = 'SKIPPED' LIMIT 1", [customer.id])).rows[0].status_detail).toMatch(/Too many messages/);
  });

  it('upload endpoints reject oversize bodies before reading them and do not accept a spoofed type', async () => {
    const f = new FormData();
    f.set('file', new File([new Uint8Array(Buffer.from('MZ\x90\x00'))], 'photo.jpg', { type: 'image/jpeg' }));
    const r = await call(filesPOST, { token: A.ctx.token, form: f });
    expect(r.status).toBe(415);
    const big = await call(filesPOST, { token: A.ctx.token, form: new FormData(), headers: { 'content-length': String(500 * 1024 * 1024) } });
    expect(big.status).toBe(413);
  });
});

describe('generated documents respect the same boundaries', () => {
  it('an invoice document is customer-visible only because the system said so explicitly, and is searchable only by people who may see invoices', async () => {
    const { issuedInvoice } = await import('../helpers/finance');
    const inv = await issuedInvoice(A);
    const g = await ensureDocument(A.ctx, 'invoice', inv.id);
    expect(g.file.visibility).toBe('CUSTOMER');
    const { searchDocuments } = await import('@/server/files/search');
    expect((await searchDocuments(tech.ctx, { q: inv.number })).items).toHaveLength(0); // a technician has no invoice permission
    expect((await searchDocuments(B.ctx, { q: inv.number })).items).toHaveLength(0);
    expect((await searchDocuments(A.ctx, { q: inv.number })).items.length).toBeGreaterThan(0);
    await rejects(createDownloadLink(tech.ctx, g.file.id), 403);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, prisma } from '@/server/db/client';
import { createCustomer, getCustomer, listCustomers } from '@/server/customers/service';
import { uploadFile, listFiles, openFile } from '@/server/files/service';
import { listAuditLog } from '@/server/audit/service';
import { changeMemberRole, changeMemberStatus, listMembers } from '@/server/memberships/service';
import { switchBusiness } from '@/server/businesses/service';
import { globalSearch } from '@/server/search/service';
import { authenticate, resolveBusinessContext } from '@/server/tenancy/context';
import { setActiveBusiness } from '@/server/auth/session';
import { GET as getCustomerRoute, PATCH as patchCustomerRoute } from '@/app/api/v1/customers/[id]/route';
import { POST as archiveRoute } from '@/app/api/v1/customers/[id]/archive/route';
import { GET as listCustomersRoute, POST as createCustomerRoute } from '@/app/api/v1/customers/route';
import { GET as downloadRoute } from '@/app/api/v1/files/[id]/route';
import { POST as uploadRoute } from '@/app/api/v1/files/route';
import { GET as searchRoute } from '@/app/api/v1/search/route';
import { call } from '../helpers/http';
import {
  addMember, businessContext, createMemberCtx, createUser, createWorkspace, ownerQuery, testMeta, userContext,
  type TestWorkspace,
} from '../helpers/factory';

import { customerInput } from '../helpers/customers';
import { VALID_PNG } from '../helpers/images';

afterAll(disconnectPrisma);

const PNG = VALID_PNG;

let A: TestWorkspace;
let B: TestWorkspace;
let bCustomer: Awaited<ReturnType<typeof createCustomer>>;
let bFile: Awaited<ReturnType<typeof uploadFile>>;

beforeAll(async () => {
  A = await createWorkspace('Isolation Workshop A');
  B = await createWorkspace('Isolation Workshop B');
  await createCustomer(A.ctx, customerInput('Alice Anderson', { phone: '082 111 2222' }));
  bCustomer = await createCustomer(B.ctx, customerInput('Zacharias Quillfeather', { phone: '083 999 8877', email: 'zach@b.test' }));
  bFile = await uploadFile(B.ctx, { data: PNG, filename: 'b-secret.png', resourceType: 'customer', resourceId: bCustomer.id });
});

describe('Business A user attempts to reach Business B records — expected: access denied', () => {
  it('cannot read a customer by id (service layer)', async () => {
    await expect(getCustomer(A.ctx, bCustomer.id)).rejects.toMatchObject({ status: 404 });
  });

  it('cannot read a customer by id (HTTP API) and learns nothing about it', async () => {
    const res = await call(getCustomerRoute, { token: A.ctx.token, params: { id: bCustomer.id } });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/Zacharias|Quillfeather|zach@b\.test/);
    // identical to a genuinely non-existent id: existence is not revealed
    const missing = await call(getCustomerRoute, { token: A.ctx.token, params: { id: '00000000-0000-4000-8000-000000000000' } });
    expect(missing.status).toBe(res.status);
    expect(missing.body.error.message).toBe(res.body.error.message);
  });

  it('cannot modify or archive it; the record is untouched', async () => {
    const patch = await call(patchCustomerRoute, { method: 'PATCH', token: A.ctx.token, params: { id: bCustomer.id }, body: { name: 'HACKED' } });
    expect(patch.status).toBe(404);
    const arch = await call(archiveRoute, { token: A.ctx.token, params: { id: bCustomer.id }, body: { archived: true } });
    expect(arch.status).toBe(404);
    const row = await ownerQuery('SELECT name, status FROM customers WHERE id = $1', [bCustomer.id]);
    expect(row.rows[0]).toEqual({ name: 'Zacharias Quillfeather', status: 'ACTIVE' });
  });

  it('never sees B’s customers in lists, searches, or phone/email lookups', async () => {
    const list = await listCustomers(A.ctx, { pageSize: 100 });
    expect(list.items.map((c) => c!.name)).not.toContain('Zacharias Quillfeather');

    for (const q of ['Zacharias', 'Quillfeather', 'zach@b.test', '083 999', '0839998877', 'CUS-000001']) {
      const groups = await globalSearch(A.ctx, { q });
      const names = groups.flatMap((g) => g.items.map((i) => i.title));
      expect(names, `query ${q}`).not.toContain('Zacharias Quillfeather');
    }
    const api = await call(searchRoute, { token: A.ctx.token, query: { q: 'Quillfeather' } });
    expect(api.status).toBe(200);
    expect(api.body.data).toEqual([]);
    const apiList = await call(listCustomersRoute, { token: A.ctx.token, query: { q: 'Quillfeather' } });
    expect(apiList.body.data).toEqual([]);
    expect(apiList.body.meta.total).toBe(0);
  });

  it('B can still find its own customer (the isolation isn’t just “nothing works”)', async () => {
    const groups = await globalSearch(B.ctx, { q: 'Quillfeather' });
    expect(groups[0]?.items[0]?.title).toBe('Zacharias Quillfeather');
  });

  it('cannot download B’s file, attach files to B’s records, or list B’s files', async () => {
    const dl = await call(downloadRoute, { token: A.ctx.token, params: { id: bFile.id } });
    expect(dl.status).toBe(404);
    await expect(openFile(A.ctx, bFile.id)).rejects.toMatchObject({ status: 404 });

    await expect(
      uploadFile(A.ctx, { data: PNG, filename: 'x.png', resourceType: 'customer', resourceId: bCustomer.id }),
    ).rejects.toMatchObject({ status: 404 });
    const form = new FormData();
    form.set('file', new File([PNG], 'x.png', { type: 'image/png' }));
    form.set('resourceType', 'customer');
    form.set('resourceId', bCustomer.id);
    expect((await call(uploadRoute, { token: A.ctx.token, form })).status).toBe(404);

    const files = await listFiles(A.ctx, {});
    expect(files.items.map((f) => f.id)).not.toContain(bFile.id);
    // …and B’s owner can download it fine.
    expect((await call(downloadRoute, { token: B.ctx.token, params: { id: bFile.id } })).status).toBe(200);
  });

  it('cannot read B’s audit trail', async () => {
    const mine = await listAuditLog(A.ctx, { pageSize: 100 });
    expect(mine.items.every((i) => i.resourceId !== bCustomer.id)).toBe(true);
    const targeted = await listAuditLog(A.ctx, { resourceId: bCustomer.id });
    expect(targeted.items).toEqual([]);
    const total = await ownerQuery('SELECT count(*)::int AS n FROM audit_logs WHERE business_id = $1', [A.businessId]);
    expect(mine.meta.total).toBe(total.rows[0]?.n);
  });

  it('cannot see or manage B’s team', async () => {
    const bMember = await createMemberCtx(B, 'technician');
    const bMembership = await prisma().membership.findFirstOrThrow({ where: { userId: bMember.user.id, businessId: B.businessId } });

    const list = await listMembers(A.ctx, {});
    expect(list.items.some((m) => m.id === bMembership.id)).toBe(false);
    await expect(changeMemberRole(A.ctx, bMembership.id, { roleId: A.ctx.membership.roleId })).rejects.toMatchObject({ status: 404 });
    await expect(changeMemberStatus(A.ctx, bMembership.id, 'suspend')).rejects.toMatchObject({ status: 404 });
    expect((await prisma().membership.findUniqueOrThrow({ where: { id: bMembership.id } })).status).toBe('ACTIVE');
  });

  it('cannot switch into B, and a forged active-business pointer never grants access', async () => {
    await expect(switchBusiness(A.ctx, B.businessId)).rejects.toMatchObject({ status: 404 });

    // Attacker with direct DB write to their own session row points it at B…
    await ownerQuery('UPDATE sessions SET active_business_id = $1 WHERE token_hash = (SELECT token_hash FROM sessions WHERE user_id = $2 ORDER BY created_at DESC LIMIT 1)', [B.businessId, A.owner.id]);
    const uctx = await userContext(A.owner);
    await setActiveBusiness(prisma(), uctx.sessionId, B.businessId);
    const auth = await authenticate(uctx.token, testMeta());
    const resolved = await resolveBusinessContext(auth!);
    // …but the membership check re-validates every request, so they land back in A.
    expect(resolved.business.id).toBe(A.businessId);
  });

  it('ignores a client-supplied businessId: records are always created in the caller’s business', async () => {
    const res = await call(createCustomerRoute, {
      token: A.ctx.token,
      body: customerInput('Sneaky', { businessId: B.businessId, business_id: B.businessId }),
    });
    expect(res.status).toBe(201);
    const row = await ownerQuery('SELECT business_id FROM customers WHERE id = $1', [res.body.data.id]);
    expect(row.rows[0]?.business_id).toBe(A.businessId);
  });

  it('numbering is independent per business', async () => {
    const a = await createCustomer(A.ctx, customerInput('Numbering A'));
    const b = await createCustomer(B.ctx, customerInput('Numbering B'));
    const num = (s: string) => Number(s.split('-')[1]);
    expect(a.customerNumber).toMatch(/^CUS-\d{6}$/);
    expect(b.customerNumber).toMatch(/^CUS-\d{6}$/);
    expect(num(a.customerNumber)).not.toBe(0);
    const dup = await ownerQuery(
      'SELECT customer_number, count(*)::int n FROM customers WHERE business_id = $1 GROUP BY 1 HAVING count(*) > 1',
      [A.businessId],
    );
    expect(dup.rowCount).toBe(0);
  });
});

describe('the application database client fails closed', () => {
  it('queries without tenant context return nothing, even with no WHERE clause', async () => {
    expect(await prisma().customer.findMany()).toEqual([]);
    expect(await prisma().file.findMany()).toEqual([]);
    expect(await prisma().auditLog.findMany()).toEqual([]);
    expect(await prisma().notification.findMany()).toEqual([]);
  });

  it('writes without tenant context are rejected', async () => {
    await expect(
      prisma().customer.create({ data: { businessId: A.businessId, customerNumber: 'CUST-X', name: 'Direct' } }),
    ).rejects.toThrow();
  });
});

describe('one person, two businesses', () => {
  it('permissions and data follow the active business, never leak between them', async () => {
    const consultant = await createUser({ name: 'Multi Business' });
    await addMember(A.businessId, consultant, 'technician'); // limited in A
    await addMember(B.businessId, consultant, 'admin'); // admin in B (a business has exactly one Owner)

    const uctx = await userContext(consultant);
    await switchBusiness(uctx, A.businessId);
    const inA = await businessContext(consultant);
    expect(inA.business.id).toBe(A.businessId);
    expect(inA.permissions.has('customer.create')).toBe(false);

    const inAFresh = await userContext(consultant);
    await switchBusiness(inAFresh, B.businessId);
    // new session pointing at B
    const auth = await authenticate(inAFresh.token, testMeta());
    const inB = await resolveBusinessContext(auth!);
    expect(inB.business.id).toBe(B.businessId);
    expect(inB.permissions.has('customer.create')).toBe(true);

    // In B they see B's data; the same call in A context must not show it.
    expect((await listCustomers(inB, {})).items.map((c) => c!.name)).toContain('Zacharias Quillfeather');
    expect((await listCustomers(inA, {})).items.map((c) => c!.name)).not.toContain('Zacharias Quillfeather');
  });
});

describe('losing membership revokes access immediately', () => {
  it('a suspended member is locked out on their very next request, without needing to log out', async () => {
    const m = await createMemberCtx(A, 'service_advisor');
    expect((await call(listCustomersRoute, { token: m.ctx.token })).status).toBe(200);

    await changeMemberStatus(A.ctx, m.ctx.membership.id, 'suspend');
    const after = await call(listCustomersRoute, { token: m.ctx.token });
    expect(after.status).toBe(403);
    expect(after.body.error.code).toBe('NO_BUSINESS');

    await changeMemberStatus(A.ctx, m.ctx.membership.id, 'reactivate');
    expect((await call(listCustomersRoute, { token: m.ctx.token })).status).toBe(200);
  });

  it('a removed member is locked out, but their historical records and audit trail remain', async () => {
    const m = await createMemberCtx(A, 'service_advisor');
    const made = await createCustomer(m.ctx, customerInput('Created By Leaver'));
    await changeMemberStatus(A.ctx, m.ctx.membership.id, 'remove');
    expect((await call(listCustomersRoute, { token: m.ctx.token })).status).toBe(403);
    const row = await ownerQuery('SELECT created_by_id FROM customers WHERE id = $1', [made.id]);
    expect(row.rows[0]?.created_by_id).toBe(m.user.id);
    const audit = await ownerQuery("SELECT 1 FROM audit_logs WHERE user_id = $1 AND action = 'customer.created'", [m.user.id]);
    expect(audit.rowCount).toBe(1);
  });
});

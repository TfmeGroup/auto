import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma } from '@/server/db/client';
import { POST as registerRoute } from '@/app/api/v1/auth/register/route';
import { POST as verifyRoute } from '@/app/api/v1/auth/verify-email/route';
import { POST as loginRoute } from '@/app/api/v1/auth/login/route';
import { POST as createBusinessRoute } from '@/app/api/v1/businesses/route';
import { GET as meRoute } from '@/app/api/v1/me/route';
import { GET as customersRoute, POST as createCustomerRoute } from '@/app/api/v1/customers/route';
import { GET as customerRoute, PATCH as patchCustomerRoute } from '@/app/api/v1/customers/[id]/route';
import { POST as archiveRoute } from '@/app/api/v1/customers/[id]/archive/route';
import { GET as searchRoute } from '@/app/api/v1/search/route';
import { GET as membersRoute } from '@/app/api/v1/members/route';
import { GET as businessRoute, PATCH as patchBusinessRoute } from '@/app/api/v1/business/route';
import { GET as healthRoute } from '@/app/api/health/route';
import { GET as readyRoute } from '@/app/api/health/ready/route';
import { call, sessionTokenFrom } from '../helpers/http';
import { createWorkspace, latestEmailToken, ownerQuery, TEST_PASSWORD, uniqueEmail, type TestWorkspace } from '../helpers/factory';
import { customerInput } from '../helpers/customers';

afterAll(disconnectPrisma);

describe('a new customer’s whole journey through the HTTP API', () => {
  it('register → verify → login → create business → create a customer → find it', async () => {
    const email = uniqueEmail('journey');
    expect((await call(registerRoute, { body: { firstName: 'Journey', lastName: 'Owner', email, password: TEST_PASSWORD } })).status).toBe(202);

    // Before verifying: signed in is fine, but creating a business is not.
    const early = await call(loginRoute, { body: { email, password: TEST_PASSWORD } });
    expect(early.status).toBe(200);
    const earlyToken = sessionTokenFrom(early)!;
    expect((await call(createBusinessRoute, { token: earlyToken, body: { name: 'Too Early Garage' } })).body.error.code).toBe('EMAIL_NOT_VERIFIED');
    expect((await call(meRoute, { token: earlyToken })).body.data.business).toBeNull();

    expect((await call(verifyRoute, { body: { token: await latestEmailToken(email) } })).status).toBe(200);

    const biz = await call(createBusinessRoute, { token: earlyToken, body: { name: 'Journey Motors', phone: '021 555 0100', vatRegistered: true, vatNumber: '4123456789' } });
    expect(biz.status).toBe(201);

    const me = await call(meRoute, { token: earlyToken });
    expect(me.body.data.business).toMatchObject({ name: 'Journey Motors', role: 'Owner' });
    expect(me.body.data.business.permissions).toContain('customer.create');
    expect(me.body.data.business.subscription).toMatchObject({ status: 'TRIALING', canWrite: true });
    expect(JSON.stringify(me.body)).not.toMatch(/password|hash|token/i);

    const created = await call(createCustomerRoute, { token: earlyToken, body: customerInput('Sipho Dlamini', { phone: '+27 82 555 1234', email: 'SIPHO@Example.TEST' }) });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ customerNumber: 'CUS-000001', email: 'sipho@example.test' });

    const found = await call(searchRoute, { token: earlyToken, query: { q: '555 1234' } });
    expect(found.body.data[0].items[0]).toMatchObject({ title: 'Sipho Dlamini', href: `/customers/${created.body.data.id}` });
  });

  it('VAT-registered businesses must supply a VAT number', async () => {
    const email = uniqueEmail('vat');
    await call(registerRoute, { body: { firstName: 'Vat', lastName: 'Owner', email, password: TEST_PASSWORD } });
    await call(verifyRoute, { body: { token: await latestEmailToken(email) } });
    const token = sessionTokenFrom(await call(loginRoute, { body: { email, password: TEST_PASSWORD } }))!;
    const res = await call(createBusinessRoute, { token, body: { name: 'No Vat Number Ltd', vatRegistered: true } });
    expect(res.status).toBe(422);
    expect(res.body.error.details.vatNumber).toBeTruthy();
  });
});

describe('customers API', () => {
  let ws: TestWorkspace;
  beforeAll(async () => {
    ws = await createWorkspace('API Workshop');
    for (let i = 1; i <= 7; i++) {
      await call(createCustomerRoute, { token: ws.ctx.token, body: customerInput(`Customer ${String(i).padStart(2, '0')}`, { phone: `082 000 00${i}0` }) });
    }
  });

  it('paginates with accurate metadata and never returns an unbounded list', async () => {
    const p1 = await call(customersRoute, { token: ws.ctx.token, query: { pageSize: 3, page: 1, sort: 'name', dir: 'asc' } });
    expect(p1.body.data.map((c: { name: string }) => c.name)).toEqual(['Customer 01', 'Customer 02', 'Customer 03']);
    expect(p1.body.meta).toEqual({ page: 1, pageSize: 3, total: 7, totalPages: 3 });
    const p3 = await call(customersRoute, { token: ws.ctx.token, query: { pageSize: 3, page: 3, sort: 'name', dir: 'asc' } });
    expect(p3.body.data).toHaveLength(1);
    expect((await call(customersRoute, { token: ws.ctx.token, query: { page: 99 } })).body.data).toEqual([]);
    expect((await call(customersRoute, { token: ws.ctx.token, query: { pageSize: 101 } })).status).toBe(422);
    expect((await call(customersRoute, { token: ws.ctx.token, query: { page: 0 } })).status).toBe(422);
  });

  it('sorts by whitelisted fields only (no SQL smuggled through sort)', async () => {
    const desc = await call(customersRoute, { token: ws.ctx.token, query: { sort: 'name', dir: 'desc', pageSize: 2 } });
    expect(desc.body.data[0].name).toBe('Customer 07');
    for (const sort of ['name; DROP TABLE customers', 'password', '1', 'created_at desc, (select 1)']) {
      expect((await call(customersRoute, { token: ws.ctx.token, query: { sort } })).status, sort).toBe(422);
    }
    // And with a search term (the raw-SQL path):
    const searched = await call(customersRoute, { token: ws.ctx.token, query: { q: 'Customer', sort: 'name', dir: 'asc', pageSize: 2 } });
    expect(searched.body.data.map((c: { name: string }) => c.name)).toEqual(['Customer 01', 'Customer 02']);
    expect(searched.body.meta.total).toBe(7);
  });

  it('treats hostile search input as plain text', async () => {
    const hostile = ["' OR '1'='1", "'; DROP TABLE customers; --", '%', '_', '\\', '"><script>alert(1)</script>', 'a'.repeat(100)];
    for (const q of hostile) {
      const r = await call(customersRoute, { token: ws.ctx.token, query: { q } });
      expect(r.status, q).toBe(200);
      expect(r.body.data, q).toEqual([]); // wildcards are matched literally: '%' doesn't match everything
      const s = await call(searchRoute, { token: ws.ctx.token, query: { q } });
      expect([200, 422]).toContain(s.status);
    }
    expect((await ownerQuery('SELECT count(*)::int n FROM customers WHERE business_id = $1', [ws.businessId])).rows[0]?.n).toBe(7);
    expect((await call(searchRoute, { token: ws.ctx.token, query: { q: 'a' } })).status).toBe(422); // too short
  });

  it('stores markup as inert data and returns it as JSON, never as HTML', async () => {
    const xss = '<img src=x onerror=alert(1)>';
    const r = await call(createCustomerRoute, { token: ws.ctx.token, body: { firstName: xss, lastName: 'Markup', mobile: '082 000 0000', notes: '<script>steal()</script>' } });
    expect(r.status).toBe(201);
    expect(r.headers.get('content-type')).toMatch(/application\/json/);
    expect(r.body.data.firstName).toBe(xss); // stored verbatim; React escapes on render
  });

  it('updates, archives and restores with a full audit trail', async () => {
    const c = (await call(createCustomerRoute, { token: ws.ctx.token, body: customerInput('Audited Person', { phone: '082 111 1111' }) })).body.data;
    const upd = await call(patchCustomerRoute, { method: 'PATCH', token: ws.ctx.token, params: { id: c.id }, body: { mobile: '083 222 2222' } });
    expect(upd.body.data).toMatchObject({ name: 'Audited Person', mobile: '083 222 2222' });
    expect((await call(archiveRoute, { token: ws.ctx.token, params: { id: c.id }, body: { archived: true } })).body.data.status).toBe('ARCHIVED');
    const active = await call(customersRoute, { token: ws.ctx.token, query: { q: 'Audited Person' } });
    expect(active.body.data).toEqual([]);
    const archived = await call(customersRoute, { token: ws.ctx.token, query: { q: 'Audited Person', status: 'ARCHIVED' } });
    expect(archived.body.data).toHaveLength(1);
    await call(archiveRoute, { token: ws.ctx.token, params: { id: c.id }, body: { archived: false } });
    expect((await call(customerRoute, { token: ws.ctx.token, params: { id: c.id } })).body.data.status).toBe('ACTIVE');

    const audit = await ownerQuery("SELECT action, before, after FROM audit_logs WHERE resource_id = $1 ORDER BY created_at", [c.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['customer.created', 'customer.updated', 'customer.archived', 'customer.restored']);
    expect(audit.rows[1]?.before.mobile).toBe('082 111 1111');
    expect(audit.rows[1]?.after.mobile).toBe('083 222 2222');
  });

  it('rejects malformed ids and bodies cleanly', async () => {
    expect((await call(customerRoute, { token: ws.ctx.token, params: { id: 'abc' } })).status).toBe(422);
    expect((await call(patchCustomerRoute, { method: 'PATCH', token: ws.ctx.token, params: { id: 'abc' }, body: {} })).status).toBe(422);
    expect((await call(createCustomerRoute, { token: ws.ctx.token, body: JSON.stringify({ name: 'x'.repeat(2_000_000) }) })).status).toBe(413);
    expect((await call(createCustomerRoute, { token: ws.ctx.token, body: customerInput('Bad Phone', { phone: 'call me' }) })).status).toBe(422);
  });
});

describe('business settings', () => {
  it('owners can read and update; changes are audited with before/after', async () => {
    const ws = await createWorkspace('Settings Co');
    const upd = await call(patchBusinessRoute, { method: 'PATCH', token: ws.ctx.token, body: { vatRegistered: true, vatNumber: '4999999999', vatRateBps: 1500, city: 'Durban' } });
    expect(upd.status).toBe(200);
    expect(upd.body.data).toMatchObject({ vatRegistered: true, city: 'Durban', currency: 'ZAR', timezone: 'Africa/Johannesburg' });
    const got = await call(businessRoute, { token: ws.ctx.token });
    expect(got.body.data.vatNumber).toBe('4999999999');
    const a = await ownerQuery("SELECT before, after FROM audit_logs WHERE business_id = $1 AND action = 'business.settings_changed'", [ws.businessId]);
    expect(a.rows[0]?.before.vatRegistered).toBe(false);
    expect(a.rows[0]?.after.vatRegistered).toBe(true);
    expect((await call(patchBusinessRoute, { method: 'PATCH', token: ws.ctx.token, body: { vatRateBps: 99999 } })).status).toBe(422);
  });
});

describe('members API and health', () => {
  it('lists members with pagination', async () => {
    const ws = await createWorkspace('Members API Co');
    const r = await call(membersRoute, { token: ws.ctx.token });
    expect(r.status).toBe(200);
    expect(r.body.data[0]).toMatchObject({ status: 'ACTIVE', role: { key: 'owner' } });
    expect(JSON.stringify(r.body)).not.toMatch(/hash|password/i);
  });

  it('exposes liveness and readiness without authentication', async () => {
    expect((await healthRoute()).status).toBe(200);
    const ready = await readyRoute();
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: 'ready', database: 'up' });
  });

  it('every response carries a request id, and a caller-supplied one is honoured', async () => {
    const ws = await createWorkspace('Request Id Co');
    const supplied = await call(customersRoute, { token: ws.ctx.token, headers: { 'x-request-id': 'trace-abc-12345678' } });
    expect(supplied.headers.get('x-request-id')).toBe('trace-abc-12345678');
    const hostile = await call(customersRoute, { token: ws.ctx.token, headers: { 'x-request-id': '<script>alert(1)</script> id' } });
    expect(hostile.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/); // sanitised, not echoed
    expect(supplied.headers.get('cache-control')).toBe('no-store');
  });
});

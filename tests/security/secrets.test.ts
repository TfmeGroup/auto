import { afterAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, prisma } from '@/server/db/client';
import { register, changePassword, requestPasswordReset } from '@/server/auth/service';
import { createRole } from '@/server/roles/service';
import { requestExport } from '@/server/exports/service';
import { changeMemberRole, inviteMember } from '@/server/memberships/service';
import { createCustomer } from '@/server/customers/service';
import { POST as registerRoute } from '@/app/api/v1/auth/register/route';
import { POST as loginRoute } from '@/app/api/v1/auth/login/route';
import { GET as meRoute } from '@/app/api/v1/me/route';
import { GET as accountRoute } from '@/app/api/v1/account/route';
import { GET as sessionsRoute } from '@/app/api/v1/account/sessions/route';
import { GET as mfaRoute } from '@/app/api/v1/account/mfa/route';
import { GET as notifRoute } from '@/app/api/v1/account/notifications/route';
import { GET as eventsRoute } from '@/app/api/v1/account/security-events/route';
import { GET as businessRoute } from '@/app/api/v1/business/route';
import { GET as membersRoute } from '@/app/api/v1/members/route';
import { GET as rolesRoute } from '@/app/api/v1/roles/route';
import { GET as roleDefsRoute } from '@/app/api/v1/role-definitions/route';
import { GET as locationsRoute } from '@/app/api/v1/locations/route';
import { GET as usageRoute } from '@/app/api/v1/usage/route';
import { GET as billingRoute } from '@/app/api/v1/billing/route';
import { GET as invoicesRoute } from '@/app/api/v1/billing/invoices/route';
import { GET as exportsRoute } from '@/app/api/v1/exports/route';
import { GET as auditRoute } from '@/app/api/v1/audit/route';
import { GET as customersRoute } from '@/app/api/v1/customers/route';
import { GET as filesRoute } from '@/app/api/v1/files/route';
import { GET as searchRoute } from '@/app/api/v1/search/route';
import { POST as createCustomerRoute } from '@/app/api/v1/customers/route';
import { call, sessionTokenFrom } from '../helpers/http';
import { enableMfaFor } from '../helpers/mfa';
import { businessContext, createMemberCtx, createUser, createWorkspace, drainJobs, ownerQuery, sentTo, testMeta, TEST_PASSWORD, uniqueEmail, userContext, upgradePlan } from '../helpers/factory';
import { customerInput } from '../helpers/customers';

afterAll(disconnectPrisma);

describe('sensitive credentials are never returned to the client', () => {
  it('no authenticated GET endpoint ever contains a password hash, token hash, MFA secret, session token, recovery code or provider reference', async () => {
    const ws = await createWorkspace('Secrets Co');
    await upgradePlan(ws);
    const { secret, recoveryCodes } = await enableMfaFor(ws.owner);
    ws.ctx = await businessContext(ws.owner);
    await createCustomer(ws.ctx, customerInput('Normal Customer'));
    await createRole(ws.ctx, { name: 'Some Role', permissions: ['job.view'] });
    await requestExport(ws.ctx, {});
    await drainJobs();
    await ownerQuery("UPDATE subscriptions SET provider = 'payfast', provider_subscription_ref = 'tok_PROVIDER_REF_123' WHERE business_id = $1", [ws.businessId]);
    const member = await createMemberCtx(ws, 'technician');
    await changeMemberRole(ws.ctx, member.ctx.membership.id, { roleId: (await prisma().role.findFirstOrThrow({ where: { businessId: null, key: 'manager' } })).id });
    await inviteMember(ws.ctx, { email: uniqueEmail('pending'), roleId: (await prisma().role.findFirstOrThrow({ where: { businessId: null, key: 'technician' } })).id });
    await changePassword(await userContext(ws.owner), { currentPassword: ws.owner.password, newPassword: 'Another-Passw0rd!99' });

    const hash = (await prisma().user.findUniqueOrThrow({ where: { id: ws.owner.id } })).passwordHash;
    const secretEnc = (await prisma().user.findUniqueOrThrow({ where: { id: ws.owner.id } })).mfaSecretEnc!;
    const token = (await userContext(ws.owner)).token;
    const forbidden: [string, RegExp | string][] = [
      ['argon2 hash', /\$argon2/], ['password hash value', hash], ['password hash field', /passwordHash|password_hash/i],
      ['token hash fields', /tokenHash|token_hash|inviteTokenHash|invite_token_hash/i], ['MFA secret (plain)', secret], ['MFA secret (encrypted)', secretEnc],
      ['MFA secret fields', /mfaSecret|mfa_secret|mfaPending/i], ['session token', token], ['provider reference', 'tok_PROVIDER_REF_123'],
      ['provider ref field', /providerSubscriptionRef|provider_subscription_ref/i], ['merchant credentials', /merchant_key|passphrase/i],
      ...recoveryCodes.map((c): [string, string] => ['recovery code', c]), ['recovery hash field', /codeHash|code_hash/i],
      ['storage key field', /storageKey|storage_key/i], ['plain password', ws.owner.password],
    ];

    const endpoints: [string, Parameters<typeof call>[0]][] = [
      ['me', meRoute as never], ['account', accountRoute as never], ['sessions', sessionsRoute as never], ['mfa', mfaRoute as never],
      ['notifications', notifRoute as never], ['security events', eventsRoute as never], ['business', businessRoute as never], ['members', membersRoute as never],
      ['roles', rolesRoute as never], ['role definitions', roleDefsRoute as never], ['locations', locationsRoute as never], ['usage', usageRoute as never],
      ['billing', billingRoute as never], ['invoices', invoicesRoute as never], ['exports', exportsRoute as never], ['audit', auditRoute as never],
      ['customers', customersRoute as never], ['files', filesRoute as never], ['search', searchRoute as never],
    ];
    for (const [name, handler] of endpoints) {
      const res = await call(handler, { token, query: name === 'search' ? { q: 'Normal' } : {} });
      expect(res.status, `${name} should succeed`).toBe(200);
      const text = JSON.stringify(res.body);
      for (const [label, needle] of forbidden) {
        const found = typeof needle === 'string' ? text.includes(needle) : needle.test(text);
        expect(found, `${name} leaked: ${label}`).toBe(false);
      }
    }
  });

  it('the audit trail itself never stores secrets in its before/after/metadata', async () => {
    const ws = await createWorkspace('Audit Secrets Co');
    await enableMfaFor(ws.owner);
    await requestPasswordReset({ email: ws.owner.email }, testMeta());
    await changePassword(await userContext(ws.owner), { currentPassword: ws.owner.password, newPassword: 'Yet-Another-Passw0rd!77' });
    const rows = (await ownerQuery('SELECT before, after, metadata FROM audit_logs WHERE user_id = $1', [ws.owner.id])).rows;
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/\$argon2|passwordHash|password_hash|mfaSecret|tokenHash|recovery/i);
    expect(text).not.toContain(ws.owner.password);
    expect(text).not.toContain('Yet-Another-Passw0rd!77');
  });

  it('login and registration responses carry no token, hash or account-existence hint in the body', async () => {
    const email = uniqueEmail('shape');
    const reg = await call(registerRoute, { body: { firstName: 'Sh', lastName: 'Ape', email, password: TEST_PASSWORD } });
    expect(JSON.stringify(reg.body)).not.toMatch(/token|hash|userId|exists/i);
    const u = await createUser();
    const res = await call(loginRoute, { body: { email: u.email, password: u.password } });
    const cookie = sessionTokenFrom(res)!;
    expect(JSON.stringify(res.body)).not.toContain(cookie);
    expect(JSON.stringify(res.body)).not.toMatch(/hash|password/i);
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/i);
  });

  it('emails that carry one-time links are the only place raw tokens appear — and the job payload is scrubbed once delivered', async () => {
    const email = uniqueEmail('scrub');
    await register({ firstName: 'Sc', lastName: 'Rub', email, password: TEST_PASSWORD }, testMeta());
    await drainJobs();
    expect(sentTo(email)[0]?.text).toMatch(/verify-email\?token=/); // delivered to the person
    const left = await ownerQuery("SELECT payload FROM jobs WHERE type = 'email.send' AND status = 'SUCCEEDED' AND payload::text LIKE $1", [`%${email}%`]);
    expect(left.rowCount).toBe(0); // no copy of the link remains in the queue
  });

  it('server errors never leak internals, SQL, stack traces or file paths', async () => {
    const ws = await createWorkspace('Error Shape Co');
    const bad = await call(createCustomerRoute, { token: ws.ctx.token, body: { name: 'x'.repeat(5000), phone: '1' } });
    const text = JSON.stringify(bad.body);
    expect(text).not.toMatch(/prisma|postgres|SELECT |INSERT |at \w+ \(|\.ts:|node_modules|C:\\\\/i);
    expect(Object.keys(bad.body)).toEqual(['error']);
  });
});

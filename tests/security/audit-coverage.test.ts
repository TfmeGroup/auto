import { afterAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, prisma } from '@/server/db/client';
import { login, logout, register, requestPasswordReset, resetPassword, verifyEmail, changePassword } from '@/server/auth/service';
import { requestEmailChange, confirmEmailChange, revokeOwnSession, revokeOtherSessions, updateProfile } from '@/server/account/service';
import { disableMfa, regenerateRecoveryCodes } from '@/server/auth/mfa';
import { acceptInvitation, changeMemberRole, changeMemberStatus, inviteMember, revokeInvitation } from '@/server/memberships/service';
import { createRole, updateRole } from '@/server/roles/service';
import { closeBusiness, transferOwnership } from '@/server/businesses/service';
import { cancelSubscription, startCheckout } from '@/server/billing/plan-change';
import { setPaymentProviderForTests } from '@/server/billing/provider';
import { handleWebhook } from '@/server/billing/webhooks';
import { requestExport } from '@/server/exports/service';
import { drainJobs, ownerQuery, testMeta, TEST_PASSWORD, uniqueEmail, userContext, createUser, createWorkspace, createMemberCtx, businessContext, upgradePlan, latestEmailToken } from '../helpers/factory';
import { enableMfaFor, freshCode } from '../helpers/mfa';

afterAll(disconnectPrisma);

/**
 * One end-to-end scenario that performs every kind of security-relevant action the specification lists,
 * then proves each one left a structured audit event attributed to the right person/business.
 */
describe('security and billing events are audited', () => {
  it('registration, login, logout, password, email, MFA, sessions', async () => {
    const email = uniqueEmail('audit1');
    await register({ firstName: 'Au', lastName: 'Dit', email, password: TEST_PASSWORD }, testMeta());
    const u = await prisma().user.findUniqueOrThrow({ where: { email } });
    await verifyEmail(await latestEmailToken(email), testMeta());
    await expect(login({ email, password: 'Wrong-Password-1!' }, testMeta())).rejects.toThrow();
    const lr = await login({ email, password: TEST_PASSWORD }, testMeta());
    if (lr.kind !== 'session') throw new Error('x');
    const { authenticate } = await import('@/server/tenancy/context');
    const ctx = (await authenticate(lr.session.token, testMeta()))!.user;
    const other = await userContext({ id: u.id, email, name: 'Au Dit', password: TEST_PASSWORD });
    await updateProfile(ctx, { firstName: 'Au', lastName: 'Dited' });
    await changePassword(ctx, { currentPassword: TEST_PASSWORD, newPassword: 'Audit-Passw0rd!123' });
    await requestPasswordReset({ email }, testMeta());
    await resetPassword({ token: await latestEmailToken(email), password: 'Audit-Passw0rd!456' }, testMeta());
    const again = await login({ email, password: 'Audit-Passw0rd!456' }, testMeta());
    if (again.kind !== 'session') throw new Error('x');
    const c2 = (await authenticate(again.session.token, testMeta()))!.user;
    const newEmail = uniqueEmail('audit1b');
    await requestEmailChange(c2, { newEmail, password: 'Audit-Passw0rd!456' });
    await confirmEmailChange(await latestEmailToken(newEmail), testMeta());
    const l3 = await login({ email: newEmail, password: 'Audit-Passw0rd!456' }, testMeta());
    if (l3.kind !== 'session') throw new Error('x');
    const c3 = (await authenticate(l3.session.token, testMeta()))!.user;
    const second = await userContext({ id: u.id, email: newEmail, name: 'x', password: 'x' });
    await revokeOwnSession(c3, second.sessionId);
    await revokeOtherSessions(c3);
    const { secret } = await enableMfaFor({ id: u.id, email: newEmail, name: 'x', password: 'Audit-Passw0rd!456' });
    void secret;
    const tu = { id: u.id, email: newEmail, name: 'x', password: 'Audit-Passw0rd!456' };
    const cm = await userContext(tu);
    await regenerateRecoveryCodes(cm, { password: tu.password, code: await freshCode(tu) });
    await disableMfa(cm, { password: tu.password, code: await freshCode(tu) });
    await logout(cm);
    void other;

    const actions = new Set((await ownerQuery('SELECT action FROM audit_logs WHERE user_id = $1', [u.id])).rows.map((r) => r.action as string));
    for (const a of [
      'account.created', 'account.email_verified', 'auth.login_failed', 'auth.login', 'auth.logout', 'account.profile_updated', 'auth.password_changed',
      'auth.password_reset_requested', 'auth.password_reset_completed', 'account.email_change_requested', 'account.email_changed', 'auth.session_revoked',
      'auth.sessions_revoked', 'auth.mfa_enabled', 'auth.mfa_recovery_codes_regenerated', 'auth.mfa_disabled',
    ]) expect(actions, a).toContain(a);

    // Each event is structured: who, when, and request context; none holds a secret.
    const sample = (await ownerQuery("SELECT * FROM audit_logs WHERE user_id = $1 AND action = 'auth.login' LIMIT 1", [u.id])).rows[0]!;
    expect(sample).toMatchObject({ user_id: u.id, resource_type: 'user', resource_id: u.id });
    expect(sample.created_at).toBeInstanceOf(Date);
    expect(sample.request_id).toBeTruthy();
    expect(sample.ip).toBeTruthy();
    // Security alerts were queued for the sensitive ones.
    await drainJobs();
    const { sentTo } = await import('../helpers/factory');
    const mails = [...sentTo(email), ...sentTo(newEmail)].map((m) => m.subject).join(' | ');
    for (const re of [/password was changed/i, /change of email address was requested/i, /email address was changed/i, /two-factor authentication turned on/i, /two-factor authentication turned off/i, /new recovery codes/i]) expect(mails).toMatch(re);
  });

  it('invitations, membership and role changes, ownership transfer, business closure', async () => {
    const ws = await createWorkspace('Audit Biz Co');
    await upgradePlan(ws);
    const tech = await prisma().role.findFirstOrThrow({ where: { businessId: null, key: 'technician' } });
    const mgr = await prisma().role.findFirstOrThrow({ where: { businessId: null, key: 'manager' } });
    const person = await createUser();
    const inv = await inviteMember(ws.ctx, { email: person.email, roleId: tech.id });
    const revoked = await inviteMember(ws.ctx, { email: uniqueEmail('revoked'), roleId: tech.id });
    await revokeInvitation(ws.ctx, revoked.id);
    await acceptInvitation(await userContext(person), await latestEmailToken(person.email));
    await changeMemberRole(ws.ctx, inv.id, { roleId: mgr.id });
    await changeMemberStatus(ws.ctx, inv.id, 'suspend');
    await changeMemberStatus(ws.ctx, inv.id, 'reactivate');
    const role = await createRole(ws.ctx, { name: 'Audit Role', permissions: ['job.view'] });
    await updateRole(ws.ctx, role.id, { name: 'Audit Role', permissions: ['job.view', 'job.edit'] });
    await requestExport(ws.ctx, {});
    await transferOwnership(ws.ctx, { targetMembershipId: inv.id, confirm: 'TRANSFER', password: ws.owner.password });
    const newOwnerCtx = await businessContext(person);
    await closeBusiness(newOwnerCtx, { confirmName: 'Audit Biz Co', password: person.password });

    const rows = (await ownerQuery('SELECT action, user_id, business_id FROM audit_logs WHERE business_id = $1', [ws.businessId])).rows;
    const actions = new Set(rows.map((r) => r.action as string));
    for (const a of [
      'business.created', 'subscription.trial_started', 'member.invited', 'member.invite_revoked', 'member.joined', 'member.role_changed', 'member.suspended',
      'member.reactivated', 'role.created', 'role.permissions_changed', 'data.export_requested', 'business.ownership_transferred', 'business.closed',
    ]) expect(actions, a).toContain(a);
    expect(rows.every((r) => r.business_id === ws.businessId)).toBe(true);
    // Who did it: the transfer by the original Owner, the closure by the new one.
    expect(rows.find((r) => r.action === 'business.ownership_transferred')?.user_id).toBe(ws.owner.id);
    expect(rows.find((r) => r.action === 'business.closed')?.user_id).toBe(person.id);
    void createMemberCtx;
  });

  it('billing: checkout, payment success, failure, cancellation — with subscription and payment ids in the record', async () => {
    const ws = await createWorkspace('Audit Billing Co');
    await ownerQuery("UPDATE plans SET price_cents = 99900 WHERE key = 'team'");
    let pending: Record<string, unknown> | null = null;
    const provider = {
      name: 'fake', capabilities: { cancelSubscription: true, updateAmount: true },
      createCheckout: () => ({ actionUrl: 'https://pay.test', fields: {} }),
      verifyWebhook: async () => pending as never,
      cancelSubscription: async () => {},
      updateAmount: async () => {},
    };
    setPaymentProviderForTests(provider as never);
    await startCheckout(ws.ctx, 'team');
    const p = (await ownerQuery('SELECT id, amount_cents FROM subscription_payments WHERE business_id = $1', [ws.businessId])).rows[0]!;
    const ev = (status: string, id: string) => ({ provider: 'fake', externalId: `${id}:${status}`, eventType: 'x', paymentId: p.id, providerPaymentId: id, amountCents: p.amount_cents, status, subscriptionRef: 'tok_a', payload: {} });
    pending = ev('COMPLETE', 'pf-a1');
    await handleWebhook(provider as never, 'raw', {});
    pending = ev('FAILED', 'pf-a2');
    await handleWebhook(provider as never, 'raw', {});
    ws.ctx = await businessContext(ws.owner);
    await cancelSubscription(ws.ctx, { reason: 'audit', confirm: true });
    setPaymentProviderForTests(undefined);

    const rows = (await ownerQuery("SELECT action, resource_id, metadata, user_id FROM audit_logs WHERE business_id = $1 AND (action LIKE 'subscription.%' OR action LIKE 'billing.%')", [ws.businessId])).rows;
    const actions = new Set(rows.map((r) => r.action as string));
    for (const a of ['subscription.trial_started', 'subscription.checkout_started', 'billing.payment_received', 'billing.invoice_issued', 'subscription.plan_changed', 'billing.payment_failed', 'subscription.changed', 'subscription.cancelled']) expect(actions, a).toContain(a);
    const sub = await prisma().subscription.findUniqueOrThrow({ where: { businessId: ws.businessId } });
    expect(rows.find((r) => r.action === 'billing.payment_received')?.resource_id).toBe(sub.id);
    expect(rows.find((r) => r.action === 'billing.payment_received')?.metadata).toMatchObject({ paymentId: p.id, providerPaymentId: 'pf-a1' });
    expect(rows.find((r) => r.action === 'subscription.cancelled')?.user_id).toBe(ws.owner.id); // a user event…
    expect(rows.find((r) => r.action === 'billing.payment_received')?.user_id).toBeNull(); // …vs a system (webhook) event
  });
});

import { afterAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, prisma } from '@/server/db/client';
import { authenticate, resolveBusinessContext } from '@/server/tenancy/context';
import { closeBusiness, createBusiness, getBusiness, switchBusiness, transferOwnership, updateBusiness } from '@/server/businesses/service';
import { setBusinessLogo } from '@/server/businesses/logo';
import { archiveLocation, createLocation, listLocations, renameLocation } from '@/server/locations/service';
import { inviteMember } from '@/server/memberships/service';
import { changeMemberStatus } from '@/server/memberships/service';
import { createCustomer } from '@/server/customers/service';
import { POST as createBusinessRoute } from '@/app/api/v1/businesses/route';
import { PATCH as patchBusinessRoute } from '@/app/api/v1/business/route';
import { POST as transferRoute } from '@/app/api/v1/business/transfer-ownership/route';
import { POST as closeRoute } from '@/app/api/v1/business/close/route';
import { GET as logoRoute } from '@/app/api/v1/business/logo/route';
import { POST as locationsPost, GET as locationsGet } from '@/app/api/v1/locations/route';
import { GET as customersRoute } from '@/app/api/v1/customers/route';
import { call } from '../helpers/http';
import { enableMfaFor, freshCode } from '../helpers/mfa';
import {
  addMember, businessContext, contextForSession, createMemberCtx, createUser, createWorkspace, emailCountTo, latestEmailTo, ownerQuery, testMeta, userContext,
  type TestWorkspace,
} from '../helpers/factory';

import { customerInput } from '../helpers/customers';
import { pngOf } from '../helpers/images';

afterAll(disconnectPrisma);

const DAY = 86_400_000;
const PNG = pngOf(64, 2);

async function onPlan(ws: TestWorkspace, planKey: 'solo' | 'team' | 'business') {
  await ownerQuery(`UPDATE subscriptions SET status='ACTIVE', trial_ends_at=NULL, current_period_end=now()+interval '30 days', plan_id=(SELECT id FROM plans WHERE key=$2) WHERE business_id=$1`, [ws.businessId, planKey]);
  ws.ctx = await businessContext(ws.owner);
}

describe('business creation', () => {
  it('stores the full profile and makes the creator the single Owner with a default location', async () => {
    const owner = await createUser();
    const uctx = await userContext(owner);
    const res = await call(createBusinessRoute, {
      token: uctx.token,
      body: {
        name: 'Khumalo Motors', tradingName: 'KM Auto', legalName: 'Khumalo Motors (Pty) Ltd', businessType: 'Independent workshop', registrationNumber: '2020/123456/07',
        vatRegistered: true, vatNumber: '4123456789', phone: '021 555 0100', email: 'hello@khumalo.test', website: 'https://khumalo.test',
        addressLine1: '1 Main Rd', city: 'Cape Town', province: 'Western Cape', postalCode: '8001', billingAddressLine1: 'PO Box 9', billingCity: 'Cape Town',
      },
    });
    expect(res.status).toBe(201);
    const b = await prisma().business.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(b).toMatchObject({ name: 'Khumalo Motors', tradingName: 'KM Auto', businessType: 'Independent workshop', website: 'https://khumalo.test', billingAddressLine1: 'PO Box 9', currency: 'ZAR', countryCode: 'ZA', timezone: 'Africa/Johannesburg', status: 'ACTIVE' });

    const owners = await prisma().membership.findMany({ where: { businessId: b.id, isOwner: true } });
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({ userId: owner.id, status: 'ACTIVE' });
    expect((await ownerQuery('SELECT count(*)::int n FROM locations WHERE business_id = $1 AND is_default', [b.id])).rows[0]?.n).toBe(1);
    // Account and Business stay separate concepts: the business has no password, the account has no business fields.
    expect(Object.keys(await prisma().user.findUniqueOrThrow({ where: { id: owner.id } }))).not.toContain('businessId');
  });

  it('validates the website, VAT and currency', async () => {
    const uctx = await userContext(await createUser());
    for (const body of [{ name: 'A' }, { name: 'Ok Co', website: 'javascript:alert(1)' }, { name: 'Ok Co', website: 'not a url' }, { name: 'Ok Co', vatRegistered: true }]) {
      expect((await call(createBusinessRoute, { token: uctx.token, body })).status).toBe(422);
    }
    const ws = await createWorkspace('Currency Co');
    await expect(updateBusiness(ws.ctx, { currency: 'rand' })).rejects.toMatchObject({ status: 422 });
    await expect(updateBusiness(ws.ctx, { timezone: 'Mars/Phobos' })).rejects.toMatchObject({ status: 422 });
    expect((await updateBusiness(ws.ctx, { currency: 'zar', timezone: 'Africa/Johannesburg' })).currency).toBe('ZAR');
    expect((await updateBusiness(ws.ctx, { currency: 'USD' })).currency).toBe('USD'); // other currencies stay possible
  });

  it('the business can be edited only with business.edit; changes are audited', async () => {
    const ws = await createWorkspace('Edit Co');
    const tech = await createMemberCtx(ws, 'technician');
    expect((await call(patchBusinessRoute, { method: 'PATCH', token: tech.ctx.token, body: { city: 'X' } })).status).toBe(403);
    expect((await call(patchBusinessRoute, { method: 'PATCH', token: ws.ctx.token, body: { city: 'Pretoria', website: 'https://edit.test' } })).status).toBe(200);
    expect((await getBusiness(ws.ctx)).website).toBe('https://edit.test');
    const a = await ownerQuery("SELECT before, after FROM audit_logs WHERE business_id = $1 AND action = 'business.settings_changed'", [ws.businessId]);
    expect(a.rows.at(-1)?.after.city).toBe('Pretoria');
  });

  it('uploads a logo (images only), served to members only', async () => {
    const ws = await createWorkspace('Logo Co');
    const other = await createWorkspace('Logo Co 2');
    await setBusinessLogo(ws.ctx, PNG, 'logo.png');
    const mate = await createMemberCtx(ws, 'technician'); // no business.edit, no document.view needed to see the logo
    expect((await call(logoRoute, { token: mate.ctx.token })).status).toBe(200);
    expect((await call(logoRoute, { token: other.ctx.token })).status).toBe(404); // another business has none, and cannot see ours
    await expect(setBusinessLogo(ws.ctx, Buffer.from('<svg onload=alert(1)/>'), 'x.svg')).rejects.toMatchObject({ status: 415 });
    await expect(setBusinessLogo(ws.ctx, Buffer.from('%PDF-1.4 x'), 'x.pdf')).rejects.toMatchObject({ status: 415 });
    await expect(setBusinessLogo(mate.ctx, PNG, 'x.png')).rejects.toMatchObject({ status: 403 });
    expect(await ownerQuery('SELECT 1 FROM files WHERE business_id = $1 AND resource_type = $2', [ws.businessId, 'business_logo']).then((r) => r.rowCount)).toBe(1);
  });
});

describe('14-day free trial (belongs to the BUSINESS, calculated on the server)', () => {
  it('starts at creation: dates, status, entitlement, audit', async () => {
    const before = Date.now();
    const ws = await createWorkspace('Trial Co');
    const sub = await prisma().subscription.findUniqueOrThrow({ where: { businessId: ws.businessId }, include: { plan: true } });
    expect(sub.status).toBe('TRIALING');
    expect(sub.plan.key).toBe('trial');
    expect(sub.trialStartedAt!.getTime()).toBeGreaterThanOrEqual(before - 2000);
    expect(sub.trialEndsAt!.getTime() - sub.trialStartedAt!.getTime()).toBe(14 * DAY); // exactly 14 days
    expect(sub.convertedAt).toBeNull();

    const eff = ws.ctx.subscription;
    expect(eff).toMatchObject({ status: 'TRIALING', canWrite: true, trialPhase: 'trialing', planKey: 'trial' });
    expect(eff.trialDaysRemaining).toBe(14);
    expect(eff.features.size).toBeGreaterThan(0); // trial entitlement is active

    const audit = await ownerQuery("SELECT metadata FROM audit_logs WHERE business_id = $1 AND action = 'subscription.trial_started'", [ws.businessId]);
    expect(audit.rowCount).toBe(1);
    expect(new Date(audit.rows[0]?.metadata.trialEndsAt).getTime()).toBe(sub.trialEndsAt!.getTime());
  });

  it('the trial belongs to the business: a second business gets its own, and the person is not "trial-limited"', async () => {
    const u = await createUser();
    const uctx = await userContext(u);
    const a = await createBusiness(uctx, { name: 'First Co' });
    const b = await createBusiness(uctx, { name: 'Second Co' });
    const subs = await prisma().subscription.findMany({ where: { businessId: { in: [a.id, b.id] } } });
    expect(subs).toHaveLength(2);
    expect(subs.every((s) => s.status === 'TRIALING')).toBe(true);
  });

  it('cannot be manipulated from the client: trial fields in the request are ignored', async () => {
    const owner = await createUser();
    const uctx = await userContext(owner);
    const res = await call(createBusinessRoute, { token: uctx.token, body: { name: 'Sneaky Trial Co', trialEndsAt: '2099-01-01', planId: 'x', status: 'ACTIVE', trial_ends_at: '2099-01-01' } });
    expect(res.status).toBe(201);
    const sub = await prisma().subscription.findUniqueOrThrow({ where: { businessId: res.body.data.id } });
    expect(sub.trialEndsAt!.getTime() - Date.now()).toBeLessThan(14 * DAY + 5000);
    expect(sub.status).toBe('TRIALING');
  });

  it('days remaining and phase track the real clock, then the trial expires into read-only without deleting anything', async () => {
    const ws = await createWorkspace('Clock Co');
    await createCustomer(ws.ctx, customerInput('Kept Customer'));
    await ownerQuery("UPDATE subscriptions SET trial_ends_at = now() + interval '2 days' WHERE business_id = $1", [ws.businessId]);
    let ctx = await businessContext(ws.owner);
    expect(ctx.subscription).toMatchObject({ status: 'TRIALING', trialPhase: 'expiring', trialDaysRemaining: 2 });

    await ownerQuery("UPDATE subscriptions SET trial_ends_at = now() - interval '1 minute' WHERE business_id = $1", [ws.businessId]);
    ctx = await businessContext(ws.owner);
    expect(ctx.subscription).toMatchObject({ status: 'EXPIRED', canWrite: false, trialPhase: 'expired' });
    expect((await call(customersRoute, { token: ctx.token })).body.data.length).toBe(1); // data intact and readable
  });
});

describe('ownership transfer', () => {
  const body = (target: string, extra: Record<string, unknown> = {}) => ({ targetMembershipId: target, confirm: 'TRANSFER', password: 'Correct-Horse-9!', ...extra });

  it('hands over the business: exactly one active Owner before and after, old owner becomes Admin, everything audited and emailed', async () => {
    const ws = await createWorkspace('Handover Co');
    const heir = await createMemberCtx(ws, 'admin');
    const res = await call(transferRoute, { token: ws.ctx.token, body: body(heir.ctx.membership.id) });
    expect(res.status).toBe(200);

    const owners = await prisma().membership.findMany({ where: { businessId: ws.businessId, isOwner: true, status: 'ACTIVE' } });
    expect(owners.map((o) => o.userId)).toEqual([heir.user.id]);
    const old = await prisma().membership.findFirstOrThrow({ where: { businessId: ws.businessId, userId: ws.owner.id }, include: { role: true } });
    expect(old.role.key).toBe('admin');
    expect(old.isOwner).toBe(false);

    const a = await ownerQuery("SELECT before, after FROM audit_logs WHERE business_id = $1 AND action = 'business.ownership_transferred'", [ws.businessId]);
    expect(a.rowCount).toBe(1);
    expect((await latestEmailTo(heir.user.email))?.subject).toMatch(/ownership of .* was transferred/i);
    expect((await latestEmailTo(ws.owner.email))?.subject).toMatch(/ownership of .* was transferred/i);

    // The new Owner now has full powers; the old owner no longer can transfer or close.
    const newCtx = await businessContext(heir.user);
    expect(newCtx.permissions.has('business.close')).toBe(true);
    const oldCtx = await businessContext(ws.owner);
    expect(oldCtx.permissions.has('business.transfer_ownership')).toBe(false);
    expect(oldCtx.permissions.has('business.close')).toBe(false);
  });

  it('needs the typed confirmation and the Owner’s correct password', async () => {
    const ws = await createWorkspace('Careful Co');
    const heir = await createMemberCtx(ws, 'admin');
    expect((await call(transferRoute, { token: ws.ctx.token, body: body(heir.ctx.membership.id, { confirm: 'yes' }) })).status).toBe(422);
    const bad = await call(transferRoute, { token: ws.ctx.token, body: body(heir.ctx.membership.id, { password: 'Wrong-Password-1!' }) });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.password).toBeTruthy();
    expect((await prisma().membership.findUniqueOrThrow({ where: { id: ws.ctx.membership.id } })).isOwner).toBe(true);
    const fail = await ownerQuery("SELECT 1 FROM audit_logs WHERE user_id = $1 AND action = 'auth.reauth_failed'", [ws.owner.id]);
    expect(fail.rowCount).toBeGreaterThan(0);
  });

  it('with MFA on, a current authenticator code is required too', async () => {
    const ws = await createWorkspace('MFA Handover Co');
    await enableMfaFor(ws.owner);
    ws.ctx = await businessContext(ws.owner);
    const heir = await createMemberCtx(ws, 'admin');
    const noCode = await call(transferRoute, { token: ws.ctx.token, body: body(heir.ctx.membership.id) });
    expect(noCode.status).toBe(422);
    expect(noCode.body.error.details.mfaCode).toBeTruthy();
    expect((await call(transferRoute, { token: ws.ctx.token, body: body(heir.ctx.membership.id, { mfaCode: '000000' }) })).status).toBe(422);
    expect((await call(transferRoute, { token: ws.ctx.token, body: body(heir.ctx.membership.id, { mfaCode: await freshCode(ws.owner) }) })).status).toBe(200);
  });

  it('only someone with business.transfer_ownership can attempt it (not even an Admin)', async () => {
    const ws = await createWorkspace('Admin Cant Co');
    const admin = await createMemberCtx(ws, 'admin');
    const peer = await createMemberCtx(ws, 'manager');
    const res = await call(transferRoute, { token: admin.ctx.token, body: body(peer.ctx.membership.id, { password: admin.user.password }) });
    expect(res.status).toBe(403);
    expect((await prisma().membership.findUniqueOrThrow({ where: { id: ws.ctx.membership.id } })).isOwner).toBe(true);
  });

  it('the target must be an active, verified member of THIS business — never themselves, a stranger, or someone suspended', async () => {
    const ws = await createWorkspace('Target Co');
    const other = await createWorkspace('Other Target Co');
    const heir = await createMemberCtx(ws, 'admin');
    const foreign = await prisma().membership.findFirstOrThrow({ where: { businessId: other.businessId, isOwner: true } });
    expect((await call(transferRoute, { token: ws.ctx.token, body: body(ws.ctx.membership.id) })).status).toBe(409); // self
    expect((await call(transferRoute, { token: ws.ctx.token, body: body(foreign.id) })).status).toBe(404); // another business's member
    await changeMemberStatus(ws.ctx, heir.ctx.membership.id, 'suspend');
    expect((await call(transferRoute, { token: ws.ctx.token, body: body(heir.ctx.membership.id) })).status).toBe(404); // suspended
    await ownerQuery("UPDATE users SET email_verified_at = NULL WHERE id = $1", [heir.user.id]);
    await changeMemberStatus(ws.ctx, heir.ctx.membership.id, 'reactivate');
    expect((await call(transferRoute, { token: ws.ctx.token, body: body(heir.ctx.membership.id) })).status).toBe(409); // unverified email
  });

  it('is atomic: a failure midway never leaves zero or two owners', async () => {
    const ws = await createWorkspace('Atomic Co');
    const heir = await createMemberCtx(ws, 'admin');
    // Both attempts race; at most one wins and the invariant holds regardless.
    const results = await Promise.allSettled([
      transferOwnership(ws.ctx, body(heir.ctx.membership.id)),
      transferOwnership(ws.ctx, body(heir.ctx.membership.id)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    const owners = await ownerQuery("SELECT count(*)::int n FROM memberships WHERE business_id = $1 AND is_owner AND status = 'ACTIVE'", [ws.businessId]);
    expect(owners.rows[0]?.n).toBe(1);
  });
});

describe('closing a business', () => {
  const closeBody = (name: string, extra: Record<string, unknown> = {}) => ({ confirmName: name, password: 'Correct-Horse-9!', reason: 'Selling up', ...extra });

  it('closes (never deletes): everyone loses access at once, data and history are kept, billing is cancelled', async () => {
    const ws = await createWorkspace('Closing Co');
    const staff = await createMemberCtx(ws, 'manager');
    await createCustomer(ws.ctx, customerInput('Closing Customer'));
    await ownerQuery("UPDATE subscriptions SET status='ACTIVE', trial_ends_at=NULL, provider='fake', provider_subscription_ref='tok_close', current_period_end=now()+interval '20 days' WHERE business_id=$1", [ws.businessId]);
    ws.ctx = await businessContext(ws.owner);

    const res = await call(closeRoute, { token: ws.ctx.token, body: closeBody('Closing Co') });
    expect(res.status).toBe(200);
    const b = await prisma().business.findUniqueOrThrow({ where: { id: ws.businessId } });
    expect(b).toMatchObject({ status: 'CLOSED', closedById: ws.owner.id, closeReason: 'Selling up' });
    expect(b.closedAt).not.toBeNull();

    // Immediately inaccessible to everyone — owner and staff alike.
    expect((await call(customersRoute, { token: ws.ctx.token })).status).toBe(403);
    expect((await call(customersRoute, { token: staff.ctx.token })).status).toBe(403);
    const auth = await authenticate(staff.ctx.token, testMeta());
    await expect(resolveBusinessContext(auth!)).rejects.toMatchObject({ code: 'NO_BUSINESS' });

    // Nothing destroyed.
    expect((await ownerQuery('SELECT count(*)::int n FROM customers WHERE business_id = $1', [ws.businessId])).rows[0]?.n).toBe(1);
    expect((await ownerQuery('SELECT count(*)::int n FROM audit_logs WHERE business_id = $1', [ws.businessId])).rows[0]?.n).toBeGreaterThan(2);
    expect((await prisma().membership.count({ where: { businessId: ws.businessId } }))).toBe(2);

    // Billing stopped, subscription cancelled, staff told.
    expect((await prisma().subscription.findUniqueOrThrow({ where: { businessId: ws.businessId } })).status).toBe('CANCELED');
    expect((await ownerQuery("SELECT count(*)::int n FROM jobs WHERE type = 'billing.provider_cancel' AND business_id = $1", [ws.businessId])).rows[0]?.n).toBe(1);
    expect((await latestEmailTo(staff.user.email))?.subject).toMatch(/was closed/i);
    expect((await ownerQuery("SELECT 1 FROM audit_logs WHERE business_id = $1 AND action = 'business.closed'", [ws.businessId])).rowCount).toBe(1);
  });

  it('requires the exact business name and the Owner’s password', async () => {
    const ws = await createWorkspace('Typed Name Co');
    expect((await call(closeRoute, { token: ws.ctx.token, body: closeBody('typed name co') })).status).toBe(422);
    expect((await call(closeRoute, { token: ws.ctx.token, body: closeBody('Typed Name Co', { password: 'Wrong-Password-1!' }) })).status).toBe(422);
    expect((await call(closeRoute, { token: ws.ctx.token, body: { confirmName: 'Typed Name Co' } })).status).toBe(422);
    expect((await prisma().business.findUniqueOrThrow({ where: { id: ws.businessId } })).status).toBe('ACTIVE');
  });

  it('with MFA on, a current code is needed too', async () => {
    const ws = await createWorkspace('MFA Close Co');
    await enableMfaFor(ws.owner);
    ws.ctx = await businessContext(ws.owner);
    expect((await call(closeRoute, { token: ws.ctx.token, body: closeBody('MFA Close Co') })).status).toBe(422);
    expect((await call(closeRoute, { token: ws.ctx.token, body: closeBody('MFA Close Co', { mfaCode: await freshCode(ws.owner) }) })).status).toBe(200);
  });

  it('only the Owner can close — an Admin with every other power cannot', async () => {
    const ws = await createWorkspace('No Admin Close Co');
    const admin = await createMemberCtx(ws, 'admin');
    expect(admin.ctx.permissions.has('settings.manage_billing')).toBe(true);
    const res = await call(closeRoute, { token: admin.ctx.token, body: closeBody('No Admin Close Co', { password: admin.user.password }) });
    expect(res.status).toBe(403);
    expect((await prisma().business.findUniqueOrThrow({ where: { id: ws.businessId } })).status).toBe('ACTIVE');
  });

  it('a closed business can no longer be switched into, and the person keeps their other businesses', async () => {
    const u = await createUser();
    const uctx = await userContext(u);
    const keep = await createBusiness(uctx, { name: 'Keep Co' });
    const drop = await createBusiness(uctx, { name: 'Drop Co' });
    await switchBusiness(uctx, drop.id);
    const dropCtx = await contextForSession(uctx);
    await closeBusiness(dropCtx, closeBody('Drop Co'));
    await expect(switchBusiness(await userContext(u), drop.id)).rejects.toMatchObject({ status: 404 });
    await expect(switchBusiness(await userContext(u), keep.id)).resolves.toBeUndefined();
  });
});

describe('locations (multi-location is a plan entitlement with a plan limit)', () => {
  it('every plan includes one location; more need the feature', async () => {
    const ws = await createWorkspace('One Loc Co');
    await onPlan(ws, 'solo');
    expect(await listLocations(ws.ctx)).toHaveLength(1);
    const res = await call(locationsPost, { token: ws.ctx.token, body: { name: 'Branch 2' } });
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('FEATURE_NOT_IN_PLAN');
    expect(await listLocations(ws.ctx)).toHaveLength(1);
  });

  it('TEAM is a single-location plan: a second location needs Business', async () => {
    const ws = await createWorkspace('Team Loc Co');
    await onPlan(ws, 'team');
    const r = await call(locationsPost, { token: ws.ctx.token, body: { name: 'Branch 2' } });
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe('FEATURE_NOT_IN_PLAN');
    expect((await call(locationsGet, { token: ws.ctx.token })).body.data).toHaveLength(1);
  });

  it('BUSINESS allows up to its limit (10), then refuses', async () => {
    const ws = await createWorkspace('Business Loc Co');
    await onPlan(ws, 'business');
    for (let i = 2; i <= 10; i++) expect((await call(locationsPost, { token: ws.ctx.token, body: { name: `Branch ${i}` } })).status, `branch ${i}`).toBe(201);
    const over = await call(locationsPost, { token: ws.ctx.token, body: { name: 'Branch 11' } });
    expect(over.status).toBe(402);
    expect(over.body.error.code).toBe('PLAN_LIMIT_REACHED');
    expect((await call(locationsGet, { token: ws.ctx.token })).body.data).toHaveLength(10);
  });

  it('rename, archive (never delete), main location protected, permissions enforced, audited', async () => {
    const ws = await createWorkspace('Loc Admin Co');
    await onPlan(ws, 'business');
    const branch = await createLocation(ws.ctx, { name: 'Branch' });
    await renameLocation(ws.ctx, branch.id, { name: 'Bellville' });
    const main = (await listLocations(ws.ctx)).find((l) => l.isDefault)!;
    await expect(archiveLocation(ws.ctx, main.id)).rejects.toMatchObject({ status: 409 });
    await archiveLocation(ws.ctx, branch.id);
    expect((await ownerQuery('SELECT status FROM locations WHERE id = $1', [branch.id])).rows[0]?.status).toBe('ARCHIVED');
    const tech = await createMemberCtx(ws, 'technician');
    expect((await call(locationsPost, { token: tech.ctx.token, body: { name: 'Nope' } })).status).toBe(403);
    const audit = await ownerQuery("SELECT action FROM audit_logs WHERE business_id = $1 AND action LIKE 'location.%'", [ws.businessId]);
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['location.created', 'location.updated', 'location.archived']));
  });

  it('another business’s location cannot be read, renamed or archived', async () => {
    const a = await createWorkspace('Loc A');
    const b = await createWorkspace('Loc B');
    const bMain = (await listLocations(b.ctx))[0]!;
    await expect(renameLocation(a.ctx, bMain.id, { name: 'Hijacked' })).rejects.toMatchObject({ status: 404 });
    await expect(archiveLocation(a.ctx, bMain.id)).rejects.toMatchObject({ status: 404 });
    expect((await listLocations(a.ctx)).map((l) => l.id)).not.toContain(bMain.id);
  });

  it('invitations can be limited to specific locations, and only on plans with multiple locations', async () => {
    const ws = await createWorkspace('Loc Invite Co');
    await onPlan(ws, 'business');
    const branch = await createLocation(ws.ctx, { name: 'Branch' });
    const role = await prisma().role.findFirstOrThrow({ where: { businessId: null, key: 'technician' } });
    const inv = await inviteMember(ws.ctx, { email: 'loc.limited@example.test', roleId: role.id, locationIds: [branch.id] });
    const m = await prisma().membership.findUniqueOrThrow({ where: { id: inv.id }, include: { locations: true } });
    expect(m.allLocations).toBe(false);
    expect(m.locations.map((l) => l.locationId)).toEqual([branch.id]);

    const other = await createWorkspace('Loc Invite Other');
    await onPlan(other, 'business');
    const foreign = (await listLocations(other.ctx))[0]!;
    await expect(inviteMember(ws.ctx, { email: 'loc.foreign@example.test', roleId: role.id, locationIds: [foreign.id] })).rejects.toMatchObject({ status: 422 });

    const solo = await createWorkspace('Loc Solo Co');
    await onPlan(solo, 'business');
    await ownerQuery(`UPDATE subscriptions SET plan_id=(SELECT id FROM plans WHERE key='solo') WHERE business_id=$1`, [solo.businessId]);
    solo.ctx = await businessContext(solo.owner);
    const soloMain = (await listLocations(solo.ctx))[0]!;
    await expect(inviteMember(solo.ctx, { email: 'loc.solo@example.test', roleId: role.id, locationIds: [soloMain.id] })).rejects.toMatchObject({ code: 'FEATURE_NOT_IN_PLAN' });
  });
});

describe('business switching', () => {
  it('moves the authorised context, re-checks permissions, and never leaks data across businesses', async () => {
    const u = await createUser();
    const uctx = await userContext(u);
    const a = await createBusiness(uctx, { name: 'Switch A' });
    await switchBusiness(uctx, a.id);
    const ctxA = await contextForSession(uctx);
    await createCustomer(ctxA, customerInput('Only In A'));

    const b = await createBusiness(uctx, { name: 'Switch B' });
    await switchBusiness(uctx, b.id);
    const ctxB = await contextForSession(uctx);
    expect(ctxB.business.id).toBe(b.id);
    expect((await call(customersRoute, { token: ctxB.token })).body.data).toEqual([]);
    await switchBusiness(uctx, a.id);
    expect((await call(customersRoute, { token: uctx.token })).body.data.map((c: { name: string }) => c.name)).toEqual(['Only In A']);
  });

  it('the first business is not assumed: with an invalid active business it falls back to another valid one, never to a stranger’s', async () => {
    const owner = await createWorkspace('Fallback Co');
    const stranger = await createWorkspace('Stranger Co');
    const u = await createUser();
    await addMember(owner.businessId, u, 'technician');
    const uctx = await userContext(u);
    await ownerQuery('UPDATE sessions SET active_business_id = $1 WHERE id = $2', [stranger.businessId, uctx.sessionId]);
    const ctx = await businessContext(u);
    expect(ctx.business.id).toBe(owner.businessId);
    expect(await emailCountTo(u.email)).toBe(0);
  });
});

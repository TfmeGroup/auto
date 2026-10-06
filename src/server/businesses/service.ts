import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma, withTx, withTenant, setTenant, seq } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { optionalEmail, optionalPhone, optionalText, parseOrThrow } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { consume } from '@/server/security/rate-limit';
import { assertCanWrite, startTrial } from '@/server/billing/subscriptions';
import { requireFeature } from '@/server/billing/features';
import { scheduleProviderCancel } from '@/server/billing/provider-ops';
import { setActiveBusiness } from '@/server/auth/session';
import { reauthSchema, verifyReauth } from '@/server/auth/reauth';
import { emailUser } from '@/server/notifications/service';
import { templates } from '@/server/notifications/templates';
import { requireAnyPermission, requirePermission } from '@/server/permissions/authorize';
import { OWNER_ROLE_KEY } from '@/server/permissions/catalog';
import { seedWorkshopDefaults } from '@/server/workshop/service';
import type { BusinessContext, UserContext } from '@/server/context';

export const BUSINESS_TYPES = [
  'Independent workshop', 'Franchise / dealership', 'Tyre & battery centre', 'Panel beater / body shop',
  'Fleet maintenance', 'Mobile mechanic', 'Specialist (e.g. diesel, auto-electrical)', 'Other',
] as const;

const websiteSchema = z
  .union([z.literal(''), z.url({ protocol: /^https?$/, message: 'Enter a full web address, e.g. https://example.co.za' })])
  .optional()
  .transform((v) => (v ? v : undefined));

const timezoneSchema = z.string().max(64).refine((tz) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Unknown timezone');

export const businessFieldsSchema = z.object({
  name: z.string().trim().min(2, 'Enter your business name').max(120),
  tradingName: optionalText(120),
  legalName: optionalText(160),
  businessType: optionalText(80),
  registrationNumber: optionalText(40),
  vatRegistered: z.boolean().default(false),
  vatNumber: optionalText(20),
  phone: optionalPhone,
  email: optionalEmail,
  website: websiteSchema,
  addressLine1: optionalText(160),
  addressLine2: optionalText(160),
  city: optionalText(80),
  province: optionalText(80),
  postalCode: optionalText(12),
  billingAddressLine1: optionalText(160),
  billingAddressLine2: optionalText(160),
  billingCity: optionalText(80),
  billingProvince: optionalText(80),
  billingPostalCode: optionalText(12),
});

export const createBusinessSchema = businessFieldsSchema.refine((v) => !v.vatRegistered || !!v.vatNumber, {
  path: ['vatNumber'],
  message: 'Enter your VAT number or untick "VAT registered"',
});

// Zod keeps `.default()` values under `.partial()`, so every defaulted field is re-declared as plainly optional:
// an update that does not mention VAT registration must not switch it off.
export const updateBusinessSchema = businessFieldsSchema.partial().extend({
  vatRegistered: z.boolean().optional(),
  vatRateBps: z.number().int().min(0).max(10_000).optional(),
  timezone: timezoneSchema.optional(),
  locale: z.string().max(16).optional(),
  // ISO 4217 code. ZAR by default; nothing else in the system assumes it.
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code, e.g. ZAR').optional(),
});

/** Create a workspace for the signed-in (and email-verified) user, who becomes its single Owner. */
export async function createBusiness(ctx: UserContext, input: unknown) {
  if (!ctx.user.emailVerified) throw Errors.emailNotVerified();
  const data = parseOrThrow(createBusinessSchema, input);
  await consume({ key: `business-create:user:${ctx.user.id}`, limit: 5, windowSec: 86_400 });

  // Generated up front so the tenant context can be set before the first insert.
  const businessId = randomUUID();

  return withTx(async (tx) => {
    await setTenant(tx, businessId);
    const ownerRole = await tx.role.findFirstOrThrow({ where: { businessId: null, key: OWNER_ROLE_KEY } });

    const business = await tx.business.create({ data: { id: businessId, ...data, createdById: ctx.user.id } });
    await tx.location.create({ data: { businessId, name: 'Main workshop', isDefault: true } });
    await seedWorkshopDefaults(tx, businessId);
    const membership = await tx.membership.create({
      data: { businessId, userId: ctx.user.id, roleId: ownerRole.id, status: 'ACTIVE', joinedAt: new Date() },
    });
    // The 14-day trial belongs to the BUSINESS, and is calculated here on the server only.
    const { trialEndsAt } = await startTrial(tx, businessId);
    await setActiveBusiness(tx, ctx.sessionId, businessId);
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.businessCreated,
      businessId,
      userId: ctx.user.id,
      resourceType: 'business',
      resourceId: businessId,
      after: { name: business.name, vatRegistered: business.vatRegistered },
      metadata: { membershipId: membership.id },
    });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.trialStarted,
      businessId,
      userId: ctx.user.id,
      resourceType: 'subscription',
      metadata: { trialEndsAt: trialEndsAt.toISOString() },
    });
    return business;
  });
}

export async function getBusiness(ctx: BusinessContext) {
  requireAnyPermission(ctx, ['business.view', 'settings.view']);
  return prisma().business.findUniqueOrThrow({ where: { id: ctx.business.id } });
}

export async function updateBusiness(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'business.edit');
  const data = parseOrThrow(updateBusinessSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const before = await tx.business.findUniqueOrThrow({ where: { id: ctx.business.id } });
    const merged = {
      vatRegistered: data.vatRegistered ?? before.vatRegistered,
      vatNumber: data.vatNumber ?? before.vatNumber,
    };
    if (merged.vatRegistered && !merged.vatNumber) {
      throw Errors.validation({ vatNumber: 'A VAT number is required for VAT-registered businesses.' });
    }
    const after = await tx.business.update({
      where: { id: ctx.business.id },
      data: Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)),
    });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.businessSettingsChanged,
      businessId: ctx.business.id,
      userId: ctx.user.id,
      resourceType: 'business',
      resourceId: ctx.business.id,
      before,
      after,
    });
    return after;
  });
}

/** Businesses the user can currently act in (ACTIVE memberships only). */
export async function listMyBusinesses(userId: string) {
  const rows = await prisma().membership.findMany({
    where: { userId, status: 'ACTIVE', business: { status: 'ACTIVE' } },
    include: { business: { select: { id: true, name: true } }, role: { select: { name: true } } },
    orderBy: { joinedAt: 'asc' },
  });
  return rows.map((m) => ({ id: m.business.id, name: m.business.name, roleName: m.role.name }));
}

export async function switchBusiness(ctx: UserContext, businessId: string) {
  const m = await prisma().membership.findFirst({
    where: { userId: ctx.user.id, businessId, status: 'ACTIVE', business: { status: 'ACTIVE' } },
  });
  // Same answer for "doesn't exist" and "not yours": reveals nothing.
  if (!m) throw Errors.notFound('Business');
  await withTx(async (tx) => {
    await setActiveBusiness(tx, ctx.sessionId, businessId);
    await setTenant(tx, businessId);
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.businessSwitched,
      businessId,
      userId: ctx.user.id,
      resourceType: 'business',
      resourceId: businessId,
    });
  });
}

// ─────────────── business-level security ───────────────

export const mfaRequirementSchema = z.object({ required: z.boolean() });

/**
 * Require every member to use two-factor authentication. Gated by plan entitlement and
 * by the requester having MFA themselves (otherwise they would lock themselves out).
 */
export async function setMfaRequirement(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'settings.manage_security');
  assertCanWrite(ctx.subscription);
  requireFeature(ctx.subscription, 'mfa_enforcement');
  const { required } = parseOrThrow(mfaRequirementSchema, input);
  if (required && !ctx.user.mfaEnabled) {
    throw Errors.conflict('Turn on two-factor authentication for your own account first, so you are not locked out.');
  }
  return withTenant(ctx.business.id, async (tx) => {
    const before = await tx.business.findUniqueOrThrow({ where: { id: ctx.business.id }, select: { requireMfa: true } });
    await tx.business.update({ where: { id: ctx.business.id }, data: { requireMfa: required } });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.businessMfaRequirementChanged,
      businessId: ctx.business.id,
      userId: ctx.user.id,
      resourceType: 'business',
      resourceId: ctx.business.id,
      before,
      after: { requireMfa: required },
    });
    return { requireMfa: required };
  });
}

// ─────────────── ownership transfer ───────────────

export const transferOwnershipSchema = reauthSchema.extend({
  targetMembershipId: z.uuid(),
  confirm: z.literal('TRANSFER', { message: 'Type TRANSFER to confirm' }),
});

/**
 * Hand the business to another ACTIVE member. Deliberate and protected: needs the
 * business.transfer_ownership permission, a typed confirmation, and the Owner's password
 * (+ MFA code). The previous Owner becomes Admin. There is exactly one active Owner at
 * every instant — enforced by a unique index, so the swap demotes before it promotes.
 */
export async function transferOwnership(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'business.transfer_ownership');
  const data = parseOrThrow(transferOwnershipSchema, input);
  if (data.targetMembershipId === ctx.membership.id) throw Errors.conflict('You already own this business.');
  await verifyReauth(ctx, data);

  return withTenant(ctx.business.id, async (tx) => {
    const target = await tx.membership.findFirst({
      where: { id: data.targetMembershipId, businessId: ctx.business.id },
      include: { user: true },
    });
    if (!target || target.status !== 'ACTIVE' || !target.user) throw Errors.notFound('Member');
    if (!target.user.emailVerifiedAt) throw Errors.conflict('That person has not verified their email address yet.');
    if (ctx.business.requireMfa && !target.user.mfaEnabled) throw Errors.conflict('This business requires two-factor authentication, and that person has not turned it on.');

    const [ownerRole, adminRole] = await seq([
      tx.role.findFirstOrThrow({ where: { businessId: null, key: OWNER_ROLE_KEY } }),
      tx.role.findFirstOrThrow({ where: { businessId: null, key: 'admin' } }),
    ]);
    await tx.membership.update({ where: { id: ctx.membership.id }, data: { roleId: adminRole.id } }); // demote first…
    await tx.membership.update({ where: { id: target.id }, data: { roleId: ownerRole.id } }); // …then promote

    await recordAudit(tx, ctx.meta, {
      action: AuditActions.ownershipTransferred,
      businessId: ctx.business.id,
      userId: ctx.user.id,
      resourceType: 'business',
      resourceId: ctx.business.id,
      before: { ownerMembershipId: ctx.membership.id },
      after: { ownerMembershipId: target.id },
      metadata: { newOwnerUserId: target.userId },
    });
    const me = await tx.user.findUniqueOrThrow({ where: { id: ctx.user.id } });
    await emailUser(tx, target.user, 'security', (to, name) => templates.ownershipTransferred(to, target.user!.firstName || name, ctx.business.name, 'new owner'));
    await emailUser(tx, me, 'security', (to, name) => templates.ownershipTransferred(to, me.firstName || name, ctx.business.name, 'previous owner'));
    return { newOwnerMembershipId: target.id };
  });
}

// ─────────────── closure ───────────────

export const closeBusinessSchema = reauthSchema.extend({
  confirmName: z.string().min(1),
  reason: optionalText(500),
});

/**
 * Close the business. Never a delete: the status becomes CLOSED, everyone loses access
 * immediately, data and audit history are retained per the platform retention policy,
 * and any provider billing is cancelled so the customer is not charged for a closed workspace.
 */
export async function closeBusiness(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'business.close');
  const data = parseOrThrow(closeBusinessSchema, input);
  if (data.confirmName !== ctx.business.name) {
    throw Errors.validation({ confirmName: 'Type the business name exactly to confirm.' });
  }
  await verifyReauth(ctx, data);

  return withTenant(ctx.business.id, async (tx) => {
    const sub = await tx.subscription.findUnique({ where: { businessId: ctx.business.id } });
    await tx.business.update({
      where: { id: ctx.business.id },
      data: { status: 'CLOSED', closedAt: new Date(), closedById: ctx.user.id, closeReason: data.reason ?? null },
    });
    if (sub?.providerSubscriptionRef && sub.provider) {
      await scheduleProviderCancel(tx, { businessId: ctx.business.id, provider: sub.provider, ref: sub.providerSubscriptionRef });
    }
    if (sub && sub.status !== 'EXPIRED') {
      await tx.subscription.update({ where: { id: sub.id }, data: { status: 'CANCELED', cancelAtPeriodEnd: true, canceledAt: new Date(), canceledById: ctx.user.id, cancelReason: 'Business closed' } });
    }
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.businessClosed,
      businessId: ctx.business.id,
      userId: ctx.user.id,
      resourceType: 'business',
      resourceId: ctx.business.id,
      metadata: { reason: data.reason ?? null },
    });
    const members = await tx.membership.findMany({ where: { businessId: ctx.business.id, status: 'ACTIVE', userId: { not: null } }, include: { user: true } });
    for (const m of members) {
      if (m.user) await emailUser(tx, m.user, 'account', (to, name) => templates.businessClosed(to, m.user!.firstName || name, ctx.business.name));
    }
    return { closed: true };
  });
}


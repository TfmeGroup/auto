import { prisma, seq, withTenant } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { pageMeta, paginationSchema, parseOrThrow, uuidSchema } from '@/lib/validation';
import { vatOnExclusive } from '@/lib/money';
import { requirePermission } from '@/server/permissions/authorize';
import { getUsage } from '@/server/usage/service';
import { overLimitOf } from './entitlements';
import { getPlatformSettings } from '@/server/settings/platform';
import type { BusinessContext } from '@/server/context';
import { PLATFORM_VAT_RATE_BPS } from './constants';
import { ALL_FEATURES, FEATURES, isFeatureKey } from './features';
import { getPaymentProvider } from './provider';

/** Everything the Billing screen shows, assembled server-side. Contains no secrets and no card data. */
export async function getBillingOverview(ctx: BusinessContext) {
  requirePermission(ctx, 'settings.manage_billing');
  const s = ctx.subscription;
  const [usage, plans, settings, payments, invoices, owner] = await Promise.all([
    getUsage(ctx),
    prisma().plan.findMany({ where: { status: 'ACTIVE', isPublic: true }, include: { features: true }, orderBy: { sortOrder: 'asc' } }),
    getPlatformSettings(),
    prisma().subscriptionPayment.findMany({ where: { businessId: ctx.business.id }, orderBy: { createdAt: 'desc' }, take: 20 }),
    withTenant(ctx.business.id, (tx) => tx.subscriptionInvoice.findMany({ where: { businessId: ctx.business.id }, orderBy: { issuedAt: 'desc' }, take: 24 })),
    prisma().membership.findFirst({ where: { businessId: ctx.business.id, isOwner: true, status: 'ACTIVE' }, include: { user: { select: { name: true, email: true } } } }),
  ]);

  const nextBilling = s.status === 'ACTIVE' || s.status === 'PAST_DUE' || s.status === 'GRACE_PERIOD' ? s.currentPeriodEnd : null;
  return {
    subscription: {
      status: s.status,
      planKey: s.planKey,
      planName: s.planName,
      isCustom: s.isCustom,
      billingInterval: s.billingInterval,
      trial: { startedAt: s.trialStartedAt, endsAt: s.trialEndsAt, daysRemaining: s.trialDaysRemaining, phase: s.trialPhase },
      currentPeriodEnd: s.currentPeriodEnd,
      nextBillingDate: nextBilling,
      cancelAtPeriodEnd: s.cancelAtPeriodEnd,
      cancelReason: s.cancelReason,
      pastDueSince: s.pastDueSince,
      pendingPlan: s.pendingPlanKey ? { key: s.pendingPlanKey, effectiveAt: s.pendingChangeAt } : null,
      paymentMethod: s.paymentMethodSummary ?? (s.provider ? `Managed by ${s.provider}` : null),
      provider: s.provider,
      canWrite: s.canWrite,
      features: ALL_FEATURES.map((k) => ({ key: k, label: FEATURES[k], included: s.features.has(k) })),
    },
    usage,
    overLimit: overLimitOf(usage),
    timing: { pastDueRetryDays: settings.pastDueRetryDays, graceDays: settings.graceDays },
    onlineBillingAvailable: getPaymentProvider() !== null,
    billingContact: owner?.user ?? null,
    plans: plans.map((p) => ({
      key: p.key,
      name: p.name,
      isCustom: p.isCustom,
      interval: p.billingInterval,
      priceCents: p.priceCents,
      priceInclVatCents: p.priceCents === null ? null : p.priceCents + vatOnExclusive(p.priceCents, PLATFORM_VAT_RATE_BPS),
      maxMembers: p.maxMembers,
      maxLocations: p.maxLocations,
      maxStorageMb: p.maxStorageMb,
      features: p.features.filter((f) => f.enabled).map((f) => f.featureKey).filter(isFeatureKey),
      current: p.key === s.planKey,
    })),
    payments: payments.map((p) => ({ id: p.id, status: p.status, amountCents: p.amountCents, provider: p.provider, createdAt: p.createdAt })),
    invoices: invoices.map((i) => ({ id: i.id, number: i.number, totalCents: i.totalCents, issuedAt: i.issuedAt, planName: i.planName })),
  };
}

export const invoiceListSchema = paginationSchema;

export async function listSubscriptionInvoices(ctx: BusinessContext, query: unknown) {
  requirePermission(ctx, 'settings.manage_billing');
  const q = parseOrThrow(invoiceListSchema, query);
  return withTenant(ctx.business.id, async (tx) => {
    const where = { businessId: ctx.business.id };
    const [total, rows] = await seq([
      tx.subscriptionInvoice.count({ where }),
      tx.subscriptionInvoice.findMany({ where, orderBy: { issuedAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { items: rows, meta: pageMeta(q.page, q.pageSize, total) };
  });
}

/** One tax invoice, only for the business it was issued to. */
export async function getSubscriptionInvoice(ctx: BusinessContext, id: string) {
  requirePermission(ctx, 'settings.manage_billing');
  const invoiceId = parseOrThrow(uuidSchema, id);
  const [invoice, business] = await Promise.all([
    withTenant(ctx.business.id, (tx) => tx.subscriptionInvoice.findFirst({ where: { id: invoiceId, businessId: ctx.business.id } })),
    prisma().business.findUniqueOrThrow({ where: { id: ctx.business.id } }),
  ]);
  if (!invoice) throw Errors.notFound('Invoice');
  return { invoice, business };
}

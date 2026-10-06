import { z } from 'zod';
import { withTenant, type Tx } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { parseOrThrow, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { decryptSecret, encryptSecret } from '@/server/auth/totp';
import { requireFeature, canUseFeature } from '@/server/billing/features';
import { requireAnyPermission, requirePermission } from '@/server/permissions/authorize';
import { assertCanWrite } from '@/server/billing/subscriptions';
import { listTechnicians } from '@/server/workshop/people';
import type { BusinessContext } from '@/server/context';
import { loadFinanceSettings } from './common';
import { getCustomerProvider, providerKeys } from './providers';

const prefix = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,8}$/, 'Use 1–8 letters or digits');
const text = (max: number) =>
  z.string().trim().max(max).nullable().optional().transform((v) => (v === undefined ? undefined : v === null || v === '' ? null : v));
const methods = z.array(z.enum(['CARD', 'EFT', 'CASH', 'ONLINE', 'OTHER'])).min(1, 'Keep at least one payment method').max(5);

// Built from a default-free shape: every key is optional and absent means "leave unchanged".
export const financeSettingsSchema = z.object({
  quotePrefix: prefix.optional(),
  invoicePrefix: prefix.optional(),
  paymentPrefix: prefix.optional(),
  receiptPrefix: prefix.optional(),
  creditNotePrefix: prefix.optional(),
  refundPrefix: prefix.optional(),
  numberPadding: z.coerce.number().int().min(3).max(9).optional(),
  quoteValidityDays: z.coerce.number().int().min(1).max(365).optional(),
  paymentTermsDays: z.coerce.number().int().min(0).max(365).optional(),
  pricesIncludeVat: z.boolean().optional(),
  quoteTerms: text(4000),
  invoiceTerms: text(4000),
  invoiceFooter: text(500),
  paymentInstructions: text(2000),
  enabledMethods: methods.optional(),
  depositsEnabled: z.boolean().optional(),
  remindersEnabled: z.boolean().optional(),
  reminderOffsets: z.array(z.coerce.number().int().min(-30).max(120)).max(8).optional(),
  reminderRepeatDays: z.coerce.number().int().min(0).max(120).optional(),
  onlineProvider: z.union([z.null(), z.literal(''), z.string().max(30)]).optional(),
  onlineSandbox: z.boolean().optional(),
  /** Write-only. Keys must be fields the chosen provider declares. */
  onlineCredentials: z.record(z.string().max(40), z.string().max(300)).optional(),
});

export type OnlineConfig = { provider: string; sandbox: boolean; credentials: Record<string, string> };

/** The business's online-payment configuration with credentials decrypted. SERVER ONLY: never return this from an API. */
export async function loadOnlineConfig(tx: Tx, businessId: string): Promise<OnlineConfig | null> {
  const s = await loadFinanceSettings(tx, businessId);
  const provider = getCustomerProvider(s.onlineProvider);
  if (!provider || !s.onlineCredentialsEnc) return null;
  let credentials: Record<string, string>;
  try {
    credentials = JSON.parse(decryptSecret(s.onlineCredentialsEnc)) as Record<string, string>;
  } catch {
    return null;
  }
  if (provider.credentialFields.some((f) => f.required && !credentials[f.key])) return null;
  return { provider: provider.key, sandbox: s.onlineSandbox, credentials };
}

/** What the settings screen may show. Credentials are never included, not even masked. */
export async function getFinanceSettings(ctx: BusinessContext) {
  requirePermission(ctx, 'settings.view');
  return withTenant(ctx.business.id, async (tx) => {
    const s = await loadFinanceSettings(tx, ctx.business.id);
    const provider = getCustomerProvider(s.onlineProvider);
    let have: Record<string, string> = {};
    if (s.onlineCredentialsEnc) {
      try { have = JSON.parse(decryptSecret(s.onlineCredentialsEnc)) as Record<string, string>; } catch { have = {}; }
    }
    const { onlineCredentialsEnc: _c, ...safe } = s;
    void _c;
    return {
      ...safe,
      online: {
        availableProviders: providerKeys().map((k) => ({ key: k, label: getCustomerProvider(k)!.label, fields: getCustomerProvider(k)!.credentialFields.map((f) => ({ key: f.key, label: f.label, secret: f.secret, required: f.required })) })),
        provider: s.onlineProvider,
        sandbox: s.onlineSandbox,
        entitled: canUseFeature(ctx.subscription, 'online_payments'),
        configured: !!provider && !provider.credentialFields.some((f) => f.required && !have[f.key]),
        fields: (provider?.credentialFields ?? []).map((f) => ({ key: f.key, label: f.label, secret: f.secret, required: f.required, isSet: !!have[f.key], value: f.secret ? null : (have[f.key] ?? null) })),
      },
      reminders: { entitled: canUseFeature(ctx.subscription, 'payment_reminders') },
    };
  });
}

export async function updateFinanceSettings(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'finance.manage_settings');
  assertCanWrite(ctx.subscription);
  const d = parseOrThrow(financeSettingsSchema, input);
  await withTenant(ctx.business.id, async (tx) => {
    const before = await loadFinanceSettings(tx, ctx.business.id);
    const data: Record<string, unknown> = {};
    for (const k of ['quotePrefix', 'invoicePrefix', 'paymentPrefix', 'receiptPrefix', 'creditNotePrefix', 'refundPrefix', 'numberPadding', 'quoteValidityDays', 'paymentTermsDays', 'pricesIncludeVat', 'quoteTerms', 'invoiceTerms', 'invoiceFooter', 'paymentInstructions', 'enabledMethods', 'depositsEnabled', 'remindersEnabled', 'reminderRepeatDays', 'onlineSandbox'] as const) {
      if (d[k] !== undefined) data[k] = d[k];
    }
    if (d.reminderOffsets) data.reminderOffsets = [...new Set(d.reminderOffsets)].sort((a, b) => a - b);

    if (d.remindersEnabled === true) requireFeature(ctx.subscription, 'payment_reminders');

    const touchesOnline = d.onlineProvider !== undefined || d.onlineCredentials !== undefined || d.onlineSandbox !== undefined;
    let credentialsChanged = false;
    if (touchesOnline) {
      const wantsProvider = d.onlineProvider === undefined ? before.onlineProvider : d.onlineProvider === '' ? null : d.onlineProvider;
      if (wantsProvider) requireFeature(ctx.subscription, 'online_payments');
      if (wantsProvider && !getCustomerProvider(wantsProvider)) throw Errors.validation({ onlineProvider: 'That payment provider is not available.' });
      data.onlineProvider = wantsProvider;
      if (!wantsProvider) {
        data.onlineCredentialsEnc = null;
        credentialsChanged = before.onlineCredentialsEnc !== null;
      } else if (d.onlineCredentials || wantsProvider !== before.onlineProvider) {
        const provider = getCustomerProvider(wantsProvider)!;
        const allowed = new Set(provider.credentialFields.map((f) => f.key));
        for (const k of Object.keys(d.onlineCredentials ?? {})) if (!allowed.has(k)) throw Errors.validation({ onlineCredentials: `Unknown credential "${k}".` });
        // A different provider starts from nothing; the same provider keeps the secrets not re-sent (they are write-only).
        let current: Record<string, string> = {};
        if (wantsProvider === before.onlineProvider && before.onlineCredentialsEnc) {
          try { current = JSON.parse(decryptSecret(before.onlineCredentialsEnc)) as Record<string, string>; } catch { current = {}; }
        }
        const merged: Record<string, string> = { ...current };
        for (const [k, v] of Object.entries(d.onlineCredentials ?? {})) {
          if (v.trim() === '') delete merged[k];
          else merged[k] = v.trim();
        }
        const missing = provider.credentialFields.filter((f) => f.required && !merged[f.key]).map((f) => f.label);
        if (missing.length) throw Errors.validation({ onlineCredentials: `Still needed: ${missing.join(', ')}.` });
        data.onlineCredentialsEnc = encryptSecret(JSON.stringify(merged));
        credentialsChanged = true;
      }
    }

    if (Object.keys(data).length === 0) return;
    await tx.financeSettings.update({ where: { businessId: ctx.business.id }, data: { ...data, updatedById: ctx.user.id } as never });
    const { onlineCredentialsEnc: _a, ...safeBefore } = before;
    void _a;
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.financeSettingsChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'finance_settings', resourceId: ctx.business.id,
      before: safeBefore,
      metadata: { changed: Object.keys(data).filter((k) => k !== 'onlineCredentialsEnc'), onlineCredentialsChanged: credentialsChanged },
    });
  });
  return getFinanceSettings(ctx);
}

// ───────── Technician cost rates (operational gross profit only) ─────────

export async function listLabourCostRates(ctx: BusinessContext) {
  requirePermission(ctx, 'finance.manage_settings');
  return withTenant(ctx.business.id, async (tx) => {
    const techs = await listTechnicians(tx, ctx.business.id);
    const rows = await tx.membership.findMany({ where: { businessId: ctx.business.id, id: { in: techs.map((t) => t.membershipId) } }, select: { id: true, labourCostCentsPerHour: true } });
    const rates = new Map(rows.map((r) => [r.id, r.labourCostCentsPerHour]));
    return techs.map((t) => ({ ...t, labourCostCentsPerHour: rates.get(t.membershipId) ?? null }));
  });
}

export const labourCostSchema = z.object({ labourCostCentsPerHour: z.union([z.null(), z.coerce.number().int().min(0).max(10_000_000)]) });

export async function setLabourCostRate(ctx: BusinessContext, membershipId: string, input: unknown) {
  requirePermission(ctx, 'finance.manage_settings');
  assertCanWrite(ctx.subscription);
  const id = parseOrThrow(uuidSchema, membershipId);
  const d = parseOrThrow(labourCostSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const m = await tx.membership.findFirst({ where: { id, businessId: ctx.business.id } });
    if (!m) throw Errors.notFound('Team member');
    await tx.membership.update({ where: { id }, data: { labourCostCentsPerHour: d.labourCostCentsPerHour } });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.labourCostRateChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'membership', resourceId: id,
      before: { labourCostCentsPerHour: m.labourCostCentsPerHour }, after: { labourCostCentsPerHour: d.labourCostCentsPerHour },
    });
    return { membershipId: id, labourCostCentsPerHour: d.labourCostCentsPerHour };
  });
}

/**
 * The few settings every finance screen needs to prefill a form or show the right choices (default terms, validity, payment
 * methods). Available to anyone who works with quotes, invoices or payments; it contains nothing secret.
 */
export async function getDocumentDefaults(ctx: BusinessContext) {
  requireAnyPermission(ctx, ['quote.view', 'quote.create', 'invoice.view', 'invoice.create', 'payment.view', 'payment.create']);
  return withTenant(ctx.business.id, async (tx) => {
    const s = await loadFinanceSettings(tx, ctx.business.id);
    return {
      quoteTerms: s.quoteTerms, invoiceTerms: s.invoiceTerms, quoteValidityDays: s.quoteValidityDays, paymentTermsDays: s.paymentTermsDays, pricesIncludeVat: s.pricesIncludeVat,
      enabledMethods: s.enabledMethods as string[], depositsEnabled: s.depositsEnabled,
      tax: { vatRegistered: ctx.business.vatRegistered, vatRateBps: ctx.business.vatRateBps, pricesIncludeVat: s.pricesIncludeVat },
    };
  });
}

// ───────── Location document codes ─────────

export const docCodeSchema = z.object({ docCode: z.union([z.null(), z.literal(''), z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,6}$/, 'Use 1–6 letters or digits')]) });

export async function listLocationDocCodes(ctx: BusinessContext) {
  requirePermission(ctx, 'finance.manage_settings');
  return withTenant(ctx.business.id, (tx) =>
    tx.location.findMany({ where: { businessId: ctx.business.id, status: 'ACTIVE' }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }], select: { id: true, name: true, docCode: true, isDefault: true } }),
  );
}

/** A short code that goes into this location's document numbers (INV-CPT-000001), each location counting on its own. */
export async function setLocationDocCode(ctx: BusinessContext, locationId: string, input: unknown) {
  requirePermission(ctx, 'finance.manage_settings');
  assertCanWrite(ctx.subscription);
  const id = parseOrThrow(uuidSchema, locationId);
  const d = parseOrThrow(docCodeSchema, input);
  const code = d.docCode ? d.docCode : null;
  return withTenant(ctx.business.id, async (tx) => {
    const loc = await tx.location.findFirst({ where: { id, businessId: ctx.business.id } });
    if (!loc) throw Errors.notFound('Location');
    if (code && (await tx.location.count({ where: { businessId: ctx.business.id, docCode: code, id: { not: id } } })) > 0) throw Errors.conflict('Another location already uses that code.');
    await tx.location.update({ where: { id }, data: { docCode: code } });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.financeSettingsChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'location', resourceId: id, before: { docCode: loc.docCode }, after: { docCode: code }, metadata: { changed: ['docCode'] },
    });
    return { id, docCode: code };
  });
}

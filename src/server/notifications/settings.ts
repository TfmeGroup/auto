import { z } from 'zod';
import { Errors } from '@/lib/errors';
import { parseOrThrow } from '@/lib/validation';
import { withTenant, type Tx } from '@/server/db/client';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { assertCanWrite } from '@/server/billing/subscriptions';
import { requireFeature } from '@/server/billing/features';
import { requirePermission } from '@/server/permissions/authorize';
import { isPermission } from '@/server/permissions/catalog';
import type { BusinessContext } from '@/server/context';
import { INTERNAL_EVENTS, JOB_UPDATE_EVENTS, type NotificationType } from './events';
import { isChannelConfigured } from './providers/text';

/**
 * How a business wants its communication to behave. These settings tune the business's own operational messages. They can never
 * switch off security alerts or account emails (those are not business settings and are not in this table), and the sending address
 * of an email is always the platform's: a business chooses the NAME it appears under and where replies go.
 */
export interface InternalRule {
  enabled: boolean;
  /** People holding this permission are told. */
  permission: string;
  inApp: boolean;
  email: boolean;
}

export interface CommSettingsOut {
  senderName: string | null;
  replyTo: string | null;
  signature: string | null;
  smsEnabled: boolean;
  whatsappEnabled: boolean;
  jobUpdateEvents: string[];
  bookingReminderHours: number;
  serviceReminderDays: number;
  serviceReminderKm: number;
  serviceRemindersOn: boolean;
  bookingRemindersOn: boolean;
  maxPerHour: number;
  internalRules: Partial<Record<NotificationType, InternalRule>>;
}

const ruleSchema = z.object({ enabled: z.boolean(), permission: z.string().refine(isPermission, 'Unknown permission'), inApp: z.boolean(), email: z.boolean() });
const rulesSchema = z.record(z.string(), ruleSchema);

export async function loadCommSettings(tx: Tx, businessId: string): Promise<CommSettingsOut> {
  const s = await tx.communicationSettings.upsert({ where: { businessId }, create: { businessId }, update: {} });
  const parsed = rulesSchema.safeParse(s.internalRules);
  return {
    senderName: s.senderName, replyTo: s.replyTo, signature: s.signature, smsEnabled: s.smsEnabled, whatsappEnabled: s.whatsappEnabled, jobUpdateEvents: s.jobUpdateEvents,
    bookingReminderHours: s.bookingReminderHours, serviceReminderDays: s.serviceReminderDays, serviceReminderKm: s.serviceReminderKm, serviceRemindersOn: s.serviceRemindersOn,
    bookingRemindersOn: s.bookingRemindersOn, maxPerHour: s.maxPerHour, internalRules: (parsed.success ? parsed.data : {}) as CommSettingsOut['internalRules'],
  };
}

export async function getCommSettings(ctx: BusinessContext) {
  requirePermission(ctx, 'notification.manage_settings');
  const settings = await withTenant(ctx.business.id, (tx) => loadCommSettings(tx, ctx.business.id));
  return { settings, providers: { smsConfigured: isChannelConfigured('sms'), whatsappConfigured: isChannelConfigured('whatsapp') }, jobUpdateEvents: JOB_UPDATE_EVENTS, internalEvents: INTERNAL_EVENTS };
}

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

const updateSchema = z.object({
  senderName: optionalText(80).refine((v) => !v || !/[\r\n<>"]/.test(v), 'Use plain letters and numbers for the name.'),
  replyTo: z.string().trim().max(254).nullable().optional().refine((v) => !v || z.email().safeParse(v).success, 'Enter a valid email address.'),
  signature: optionalText(500),
  smsEnabled: z.boolean().optional(),
  whatsappEnabled: z.boolean().optional(),
  jobUpdateEvents: z.array(z.string()).max(20).optional(),
  bookingReminderHours: z.coerce.number().int().min(1).max(336).optional(),
  serviceReminderDays: z.coerce.number().int().min(0).max(120).optional(),
  serviceReminderKm: z.coerce.number().int().min(0).max(20000).optional(),
  serviceRemindersOn: z.boolean().optional(),
  bookingRemindersOn: z.boolean().optional(),
  maxPerHour: z.coerce.number().int().min(1).max(100000).optional(),
  internalRules: rulesSchema.optional(),
});

export async function updateCommSettings(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'notification.manage_settings');
  assertCanWrite(ctx.subscription);
  const d = parseOrThrow(updateSchema, input);
  if (d.smsEnabled) requireFeature(ctx.subscription, 'sms_notifications');
  if (d.whatsappEnabled) requireFeature(ctx.subscription, 'whatsapp_notifications');
  if (d.serviceRemindersOn) requireFeature(ctx.subscription, 'service_reminders');
  if (d.jobUpdateEvents?.length || d.internalRules) requireFeature(ctx.subscription, 'advanced_communication');
  if (d.jobUpdateEvents) {
    const bad = d.jobUpdateEvents.filter((e) => !(JOB_UPDATE_EVENTS as string[]).includes(e));
    if (bad.length) throw Errors.validation({ jobUpdateEvents: `Unknown job update: ${bad[0]}` });
  }
  if (d.internalRules) {
    const bad = Object.keys(d.internalRules).filter((k) => !(k in INTERNAL_EVENTS));
    if (bad.length) throw Errors.validation({ internalRules: `"${bad[0]}" is not something you can tune.` });
  }
  return withTenant(ctx.business.id, async (tx) => {
    const before = await loadCommSettings(tx, ctx.business.id);
    const { internalRules, jobUpdateEvents, ...rest } = d;
    await tx.communicationSettings.update({
      where: { businessId: ctx.business.id },
      data: { ...rest, ...(jobUpdateEvents ? { jobUpdateEvents } : {}), ...(internalRules ? { internalRules } : {}) },
    });
    const after = await loadCommSettings(tx, ctx.business.id);
    await recordAudit(tx, ctx.meta, { action: AuditActions.commSettingsChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'communication_settings', resourceId: ctx.business.id, before, after });
    return after;
  });
}

/** Who is told about an internal event: the business's rule if it set one, else the default. */
export function internalRuleFor(settings: CommSettingsOut, type: NotificationType): InternalRule | null {
  const def = INTERNAL_EVENTS[type];
  if (!def) return null;
  const set = settings.internalRules[type];
  // A job changing stage is frequent: by default only the technician on the job hears; managers opt in with a rule.
  return set ?? { enabled: type !== 'JOB_STATUS_CHANGED', permission: def.permission, inApp: true, email: false };
}

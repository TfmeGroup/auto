import { z } from 'zod';
import { Errors } from '@/lib/errors';
import { parseOrThrow } from '@/lib/validation';
import { withTenant, type Tx } from '@/server/db/client';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { assertCanWrite } from '@/server/billing/subscriptions';
import { requireFeature, canUseFeature } from '@/server/billing/features';
import { requirePermission } from '@/server/permissions/authorize';
import type { BusinessContext } from '@/server/context';
import { EVENTS, EVENT_KEYS, allowedVariables, isEventKey, VARIABLES, CATEGORY_LABEL, type CommChannelKey, type EventDef, type EventKey } from './events';
import { emailHtml, renderText, sampleVars, validateTemplate } from './render';

/**
 * Message templates. The system supplies a default for every event and channel (always there; it cannot be switched off, so a
 * mandatory message such as an invoice or a booking change can never be left without wording). A business may replace the wording
 * with its own (Team plan and above), may switch its own wording off to fall back to the default, and can preview before saving.
 */
export interface ResolvedTemplate {
  subject: string | null;
  body: string;
  version: number;
  custom: boolean;
}

export async function resolveTemplate(tx: Tx, businessId: string, event: EventKey, channel: CommChannelKey): Promise<ResolvedTemplate> {
  const custom = await tx.messageTemplate.findFirst({ where: { businessId, event, channel, active: true } });
  const def = (EVENTS[event] as EventDef).defaults[channel];
  if (custom) {
    // A saved template is revalidated: if the registry changed under it, fall back to the default rather than send a broken message.
    if (validateTemplate(event, custom.subject, custom.body, channel).length === 0) return { subject: custom.subject, body: custom.body, version: custom.version + 1, custom: true };
  }
  if (!def) throw new Error(`No default template for ${event}/${channel}`);
  return { subject: def.subject ?? null, body: def.body, version: 1, custom: false };
}

export const channelsOf = (e: EventDef): CommChannelKey[] => ['EMAIL', ...e.channels];

export async function listTemplates(ctx: BusinessContext) {
  requirePermission(ctx, 'notification.manage_templates');
  const rows = await withTenant(ctx.business.id, (tx) => tx.messageTemplate.findMany({ where: { businessId: ctx.business.id } }));
  const items = EVENT_KEYS.flatMap((key) => {
    const e = EVENTS[key] as EventDef;
    return channelsOf(e).map((channel) => {
      const custom = rows.find((r) => r.event === key && r.channel === channel);
      const def = e.defaults[channel];
      return {
        event: key, label: e.label, category: CATEGORY_LABEL[e.category], audience: e.audience, mandatory: e.mandatory, channel,
        system: { subject: def?.subject ?? null, body: def?.body ?? '' },
        custom: custom ? { subject: custom.subject, body: custom.body, active: custom.active, version: custom.version, updatedAt: custom.updatedAt } : null,
        variables: allowedVariables(key),
      };
    });
  });
  return { items, variables: Object.fromEntries(Object.entries(VARIABLES).map(([k, v]) => [k, v.description])), canCustomise: canUseFeature(ctx.subscription, 'custom_templates') };
}

const saveSchema = z.object({
  event: z.string().refine(isEventKey, 'Unknown message type'),
  channel: z.enum(['EMAIL', 'SMS', 'WHATSAPP']),
  subject: z.string().trim().max(200).nullable().optional(),
  body: z.string().max(4500),
});

function check(input: z.output<typeof saveSchema>) {
  const event = input.event as EventKey;
  const e = EVENTS[event] as EventDef;
  if (!channelsOf(e).includes(input.channel)) throw Errors.validation({ channel: 'This message cannot be sent by that channel.' });
  const problems = validateTemplate(event, input.subject, input.body, input.channel);
  if (problems.length) throw Errors.validation(Object.fromEntries(problems.map((p) => [p.field, p.message])));
  return event;
}

export async function saveTemplate(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'notification.manage_templates');
  requireFeature(ctx.subscription, 'custom_templates');
  assertCanWrite(ctx.subscription);
  const d = parseOrThrow(saveSchema, input);
  const event = check(d);
  return withTenant(ctx.business.id, async (tx) => {
    const before = await tx.messageTemplate.findFirst({ where: { businessId: ctx.business.id, event, channel: d.channel } });
    const data = { subject: d.channel === 'EMAIL' ? d.subject ?? null : null, body: d.body, active: true, updatedById: ctx.user.id };
    const row = before
      ? await tx.messageTemplate.update({ where: { id: before.id }, data: { ...data, version: { increment: 1 } } })
      : await tx.messageTemplate.create({ data: { businessId: ctx.business.id, event, channel: d.channel, ...data } });
    await recordAudit(tx, ctx.meta, {
      action: AuditActions.templateChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'message_template', resourceId: row.id,
      before: before ? { subject: before.subject, body: before.body, active: before.active } : null, after: { subject: row.subject, body: row.body, active: row.active }, metadata: { event, channel: d.channel, version: row.version },
    });
    return row;
  });
}

/** Switch the business's own wording off (the system wording is used again) or back on. The system wording itself cannot be turned off. */
export async function setTemplateActive(ctx: BusinessContext, event: string, channel: string, active: boolean) {
  requirePermission(ctx, 'notification.manage_templates');
  assertCanWrite(ctx.subscription);
  const d = parseOrThrow(z.object({ event: z.string().refine(isEventKey), channel: z.enum(['EMAIL', 'SMS', 'WHATSAPP']) }), { event, channel });
  return withTenant(ctx.business.id, async (tx) => {
    const row = await tx.messageTemplate.findFirst({ where: { businessId: ctx.business.id, event: d.event, channel: d.channel } });
    if (!row) throw Errors.notFound('Template');
    if (row.active === active) return row;
    if (active) requireFeature(ctx.subscription, 'custom_templates');
    const after = await tx.messageTemplate.update({ where: { id: row.id }, data: { active } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.templateChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'message_template', resourceId: row.id, before: { active: row.active }, after: { active }, metadata: { event: d.event, channel: d.channel } });
    return after;
  });
}

/** Render a template with representative placeholder values. Reads nothing about any real customer. */
export async function previewTemplate(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'notification.manage_templates');
  const d = parseOrThrow(saveSchema, input);
  const event = check(d);
  const vars = sampleVars(event);
  const body = renderText(d.body, vars);
  const subject = d.channel === 'EMAIL' ? renderText(d.subject ?? '', vars) : null;
  return {
    subject, text: body, html: d.channel === 'EMAIL' ? emailHtml(`Hi ${vars.customer_name},\n\n${body}`, { businessName: vars.business_name ?? 'Your business' }) : null,
    characters: body.length, parts: d.channel === 'EMAIL' ? undefined : Math.ceil(body.length / 160),
  };
}

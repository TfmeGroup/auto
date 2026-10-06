import { z } from 'zod';
import { Errors } from '@/lib/errors';
import { parseOrThrow } from '@/lib/validation';
import { withTenant } from '@/server/db/client';
import { AuditActions, recordAudit } from '@/server/audit/audit';
import { assertCanWrite } from '@/server/billing/subscriptions';
import { requireFeature } from '@/server/billing/features';
import { can, requirePermission } from '@/server/permissions/authorize';
import { loadFinanceSettings } from '@/server/finance/common';
import { loadInventorySettings } from '@/server/inventory/common';
import { JOB_STATUSES, JOB_STATUS_LABEL, type JobStatus } from '@/server/jobcards/transitions';
import { PRESETS } from '@/server/reports/range';
import type { BusinessContext } from '@/server/context';
import { loadConfig, type BusinessConfigRow } from './config';

/**
 * Business configuration. Every setting here changes how a real workflow behaves (the code that reads it is named next to it), every change is
 * validated before it is stored, and every change is audited with the old and new values. Nothing here ever rewrites history: numbers
 * already issued, labour already recorded, vehicles and jobs already saved keep exactly what they have.
 */

// ───────────────────────── shared pieces ─────────────────────────

const prefix = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,8}$/, 'Use 1–8 letters or digits');
const padding = z.coerce.number().int().min(3, 'Use at least 3 digits').max(10, 'Use at most 10 digits');
const pick = <T extends Record<string, unknown>>(row: T, keys: readonly (keyof T)[]) => Object.fromEntries(keys.map((k) => [k, row[k]]));
const defined = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

async function saveConfig(ctx: BusinessContext, section: string, action: string, keys: readonly (keyof BusinessConfigRow)[], patch: Record<string, unknown>) {
  const clean = defined(patch);
  if (Object.keys(clean).length === 0) return getConfig(ctx);
  await withTenant(ctx.business.id, async (tx) => {
    const before = await loadConfig(tx, ctx.business.id);
    await tx.businessConfig.update({ where: { businessId: ctx.business.id }, data: { ...clean, updatedById: ctx.user.id } as never });
    const after = await loadConfig(tx, ctx.business.id);
    await recordAudit(tx, ctx.meta, { action, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'business_config', resourceId: ctx.business.id, before: pick(before, keys), after: pick(after, keys), metadata: { section } });
  });
  return getConfig(ctx);
}

export async function getConfig(ctx: BusinessContext) {
  requirePermission(ctx, 'settings.view');
  return withTenant(ctx.business.id, (tx) => loadConfig(tx, ctx.business.id));
}

// ───────────────────────── numbering ─────────────────────────

/** Every numbered record: where its prefix is stored and which sequence counts it. */
const NUMBER_KINDS = [
  { id: 'customer', label: 'Customers', group: 'workshop', seq: 'customer' },
  { id: 'booking', label: 'Bookings', group: 'workshop', seq: 'booking' },
  { id: 'job', label: 'Jobs', group: 'workshop', seq: 'job_card' },
  { id: 'quote', label: 'Quotes', group: 'finance', seq: 'quote' },
  { id: 'invoice', label: 'Invoices', group: 'finance', seq: 'invoice' },
  { id: 'payment', label: 'Payments', group: 'finance', seq: 'payment' },
  { id: 'receipt', label: 'Receipts', group: 'finance', seq: 'receipt' },
  { id: 'credit_note', label: 'Credit notes', group: 'finance', seq: 'credit_note' },
  { id: 'refund', label: 'Refunds', group: 'finance', seq: 'refund' },
  { id: 'purchase_order', label: 'Purchase orders', group: 'inventory', seq: 'purchase_order' },
  { id: 'goods_receipt', label: 'Goods received notes', group: 'inventory', seq: 'goods_receipt' },
  { id: 'stock_transfer', label: 'Stock transfers', group: 'inventory', seq: 'stock_transfer' },
  { id: 'supplier_return', label: 'Supplier returns', group: 'inventory', seq: 'supplier_return' },
] as const;

type Prefixes = Record<(typeof NUMBER_KINDS)[number]['id'], string>;

function currentPrefixes(c: BusinessConfigRow, f: Awaited<ReturnType<typeof loadFinanceSettings>>, i: Awaited<ReturnType<typeof loadInventorySettings>>): Prefixes {
  return {
    customer: c.customerPrefix, booking: c.bookingPrefix, job: c.jobPrefix, quote: f.quotePrefix, invoice: f.invoicePrefix, payment: f.paymentPrefix, receipt: f.receiptPrefix,
    credit_note: f.creditNotePrefix, refund: f.refundPrefix, purchase_order: i.poPrefix, goods_receipt: i.receiptPrefix, stock_transfer: i.transferPrefix, supplier_return: i.supplierReturnPrefix,
  };
}

export async function getNumbering(ctx: BusinessContext) {
  requirePermission(ctx, 'settings.view');
  return withTenant(ctx.business.id, async (tx) => {
    const [c, f, i] = [await loadConfig(tx, ctx.business.id), await loadFinanceSettings(tx, ctx.business.id), await loadInventorySettings(tx, ctx.business.id)];
    const p = currentPrefixes(c, f, i);
    const pad = { workshop: { customer: c.customerPadding, booking: c.bookingPadding, job: c.jobPadding }, finance: f.numberPadding, inventory: i.numberPadding };
    const seqs = await tx.numberSequence.findMany({ where: { businessId: ctx.business.id } });
    const issued = (key: string) => seqs.filter((s) => s.kind === key || s.kind.startsWith(`${key}:`)).reduce((a, s) => a + (s.nextValue - 1), 0);
    const locations = await tx.location.findMany({ where: { businessId: ctx.business.id, status: 'ACTIVE' }, select: { id: true, name: true, docCode: true }, orderBy: { name: 'asc' } });
    return {
      kinds: NUMBER_KINDS.map((k) => {
        const width = k.group === 'workshop' ? pad.workshop[k.id as 'customer'] : k.group === 'finance' ? pad.finance : pad.inventory;
        const next = issued(k.seq) + 1;
        return { id: k.id, label: k.label, group: k.group, prefix: p[k.id], padding: width, issued: issued(k.seq), nextNumber: `${p[k.id]}-${String(next).padStart(width, '0')}` };
      }),
      locations,
      canEdit: { workshop: can(ctx, 'settings.manage_workshop'), finance: can(ctx, 'finance.manage_settings'), inventory: can(ctx, 'inventory.manage_settings') },
    };
  });
}

const numberingSchema = z.object({
  customerPrefix: prefix, bookingPrefix: prefix, jobPrefix: prefix, customerPadding: padding, bookingPadding: padding, jobPadding: padding,
  quotePrefix: prefix, invoicePrefix: prefix, paymentPrefix: prefix, receiptPrefix: prefix, creditNotePrefix: prefix, refundPrefix: prefix, financePadding: padding,
  poPrefix: prefix, goodsReceiptPrefix: prefix, transferPrefix: prefix, supplierReturnPrefix: prefix, inventoryPadding: padding,
}).partial();

/**
 * Change number prefixes and lengths. Only NEW numbers change: each record kind keeps counting from where it was, so an issued number is
 * never reused or rewritten, and two kinds can never share a prefix (they would look like the same series). Each group needs its own permission.
 */
export async function updateNumbering(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'settings.view');
  assertCanWrite(ctx.subscription);
  const d = parseOrThrow(numberingSchema, input);
  const workshop = ['customerPrefix', 'bookingPrefix', 'jobPrefix', 'customerPadding', 'bookingPadding', 'jobPadding'] as const;
  const finance = ['quotePrefix', 'invoicePrefix', 'paymentPrefix', 'receiptPrefix', 'creditNotePrefix', 'refundPrefix', 'financePadding'] as const;
  const inventory = ['poPrefix', 'goodsReceiptPrefix', 'transferPrefix', 'supplierReturnPrefix', 'inventoryPadding'] as const;
  if (workshop.some((k) => d[k] !== undefined)) requirePermission(ctx, 'settings.manage_workshop');
  if (finance.some((k) => d[k] !== undefined)) requirePermission(ctx, 'finance.manage_settings');
  if (inventory.some((k) => d[k] !== undefined)) requirePermission(ctx, 'inventory.manage_settings');
  return withTenant(ctx.business.id, async (tx) => {
    const [c, f, i] = [await loadConfig(tx, ctx.business.id), await loadFinanceSettings(tx, ctx.business.id), await loadInventorySettings(tx, ctx.business.id)];
    const before = currentPrefixes(c, f, i);
    const after: Prefixes = {
      ...before,
      ...defined({ customer: d.customerPrefix, booking: d.bookingPrefix, job: d.jobPrefix, quote: d.quotePrefix, invoice: d.invoicePrefix, payment: d.paymentPrefix, receipt: d.receiptPrefix, credit_note: d.creditNotePrefix, refund: d.refundPrefix, purchase_order: d.poPrefix, goods_receipt: d.goodsReceiptPrefix, stock_transfer: d.transferPrefix, supplier_return: d.supplierReturnPrefix }),
    };
    const seen = new Map<string, string>();
    for (const k of NUMBER_KINDS) {
      const other = seen.get(after[k.id]);
      if (other) throw Errors.validation({ [k.id]: `${after[k.id]} is already used for ${other}. Each kind of record needs its own prefix, so their numbers can never be confused.` });
      seen.set(after[k.id], k.label.toLowerCase());
    }
    await tx.businessConfig.update({
      where: { businessId: ctx.business.id },
      data: { ...defined({ customerPrefix: d.customerPrefix, bookingPrefix: d.bookingPrefix, jobPrefix: d.jobPrefix, customerPadding: d.customerPadding, bookingPadding: d.bookingPadding, jobPadding: d.jobPadding }), updatedById: ctx.user.id },
    });
    const fin = defined({ quotePrefix: d.quotePrefix, invoicePrefix: d.invoicePrefix, paymentPrefix: d.paymentPrefix, receiptPrefix: d.receiptPrefix, creditNotePrefix: d.creditNotePrefix, refundPrefix: d.refundPrefix, numberPadding: d.financePadding });
    if (Object.keys(fin).length) await tx.financeSettings.update({ where: { businessId: ctx.business.id }, data: { ...fin, updatedById: ctx.user.id } });
    const inv = defined({ poPrefix: d.poPrefix, receiptPrefix: d.goodsReceiptPrefix, transferPrefix: d.transferPrefix, supplierReturnPrefix: d.supplierReturnPrefix, numberPadding: d.inventoryPadding });
    if (Object.keys(inv).length) await tx.inventorySettings.update({ where: { businessId: ctx.business.id }, data: { ...inv, updatedById: ctx.user.id } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.numberingChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'numbering', resourceId: ctx.business.id, before: { prefixes: before, padding: { customer: c.customerPadding, booking: c.bookingPadding, job: c.jobPadding, finance: f.numberPadding, inventory: i.numberPadding } }, after: { prefixes: after, changed: Object.keys(d) } });
    return { ok: true };
  });
}

// ───────────────────────── labour rules ─────────────────────────

const labourSchema = z.object({
  minBillableMinutes: z.coerce.number().int().min(0).max(480),
  timeRoundingMinutes: z.coerce.number().int().refine((v) => [0, 5, 10, 15, 30, 60].includes(v), 'Choose none, 5, 10, 15, 30 or 60 minutes'),
  timeRoundingMode: z.enum(['UP', 'NEAREST']),
}).partial();
const LABOUR_KEYS = ['minBillableMinutes', 'timeRoundingMinutes', 'timeRoundingMode'] as const;

export async function updateLabourRules(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'labour.manage_rates');
  requireFeature(ctx.subscription, 'advanced_settings');
  assertCanWrite(ctx.subscription);
  return saveConfig(ctx, 'labour', AuditActions.labourSettingsChanged, LABOUR_KEYS, parseOrThrow(labourSchema, input));
}

/**
 * Billed time for recorded time: round the actual minutes up (or to the nearest step), then apply the minimum. Used when a time entry becomes a
 * labour line, so the line carries the BILLED minutes while the time entry keeps the ACTUAL ones. Pure.
 */
export function billedMinutes(actual: number, rules: { minBillableMinutes: number; timeRoundingMinutes: number; timeRoundingMode: string }): number {
  let m = Math.max(1, actual);
  const step = rules.timeRoundingMinutes;
  if (step > 0) m = rules.timeRoundingMode === 'NEAREST' ? Math.max(step, Math.round(m / step) * step) : Math.ceil(m / step) * step;
  return Math.max(m, rules.minBillableMinutes);
}

// ───────────────────────── jobs ─────────────────────────

/** Statuses that are optional steps in the workflow: they can be switched off without breaking the path a job takes. */
export const RETIRABLE_STATUSES = ['AWAITING_PARTS', 'ON_HOLD'] as const satisfies readonly JobStatus[];
export const JOB_REQUIRED_FIELDS = { complaint: 'The customer\'s complaint', mileageKm: 'Mileage in', primaryTechnician: 'A technician in charge', serviceType: 'The service type' } as const;
export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export const DEFAULT_PRIORITY_LABEL: Record<(typeof PRIORITIES)[number], string> = { LOW: 'Low', NORMAL: 'Normal', HIGH: 'High', URGENT: 'Urgent' };

const label = z.string().trim().min(1, 'A label cannot be empty').max(30, 'Keep labels to 30 characters').regex(/^[^<>\r\n]+$/, 'Use plain text');
const jobSchema = z.object({
  statusLabels: z.partialRecord(z.enum(JOB_STATUSES), label),
  priorityLabels: z.partialRecord(z.enum(PRIORITIES), label),
  retiredStatuses: z.array(z.enum(RETIRABLE_STATUSES)).max(2),
  requiredFields: z.array(z.enum(['complaint', 'mileageKm', 'primaryTechnician', 'serviceType'])).max(4),
}).partial();

export function jobLabels(c: Pick<BusinessConfigRow, 'jobStatusLabels' | 'priorityLabels' | 'retiredJobStatuses'>) {
  const s = (c.jobStatusLabels ?? {}) as Partial<Record<JobStatus, string>>;
  const p = (c.priorityLabels ?? {}) as Partial<Record<(typeof PRIORITIES)[number], string>>;
  return {
    status: Object.fromEntries(JOB_STATUSES.map((k) => [k, s[k] ?? JOB_STATUS_LABEL[k]])) as Record<JobStatus, string>,
    priority: Object.fromEntries(PRIORITIES.map((k) => [k, p[k] ?? DEFAULT_PRIORITY_LABEL[k]])) as Record<(typeof PRIORITIES)[number], string>,
    retired: c.retiredJobStatuses as JobStatus[],
  };
}

/** The names this business uses for job statuses and priorities. Not sensitive: anyone working in the business sees them. */
export async function getJobLabels(ctx: Pick<BusinessContext, 'business'>) {
  return withTenant(ctx.business.id, async (tx) => jobLabels(await loadConfig(tx, ctx.business.id)));
}

export async function getJobConfig(ctx: BusinessContext) {
  requirePermission(ctx, 'settings.view');
  return withTenant(ctx.business.id, async (tx) => {
    const c = await loadConfig(tx, ctx.business.id);
    return { ...jobLabels(c), requiredFields: c.jobRequiredFields, defaults: { status: JOB_STATUS_LABEL, priority: DEFAULT_PRIORITY_LABEL } };
  });
}

export async function updateJobConfig(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'settings.manage_workshop');
  requireFeature(ctx.subscription, 'advanced_settings');
  assertCanWrite(ctx.subscription);
  const d = parseOrThrow(jobSchema, input);
  const patch: Record<string, unknown> = {};
  if (d.statusLabels) {
    const merged = Object.fromEntries(JOB_STATUSES.map((k) => [k, d.statusLabels![k] ?? JOB_STATUS_LABEL[k]]));
    const seen = new Set<string>();
    for (const [k, v] of Object.entries(merged)) {
      if (seen.has(String(v).toLowerCase())) throw Errors.validation({ statusLabels: `Two statuses cannot both be called "${v}".` });
      seen.add(String(v).toLowerCase());
      void k;
    }
    // Only differences from the standard wording are stored, so a later change to the standard wording still reaches everyone who did not rename it.
    patch.jobStatusLabels = Object.fromEntries(Object.entries(d.statusLabels).filter(([k, v]) => v !== JOB_STATUS_LABEL[k as JobStatus]));
  }
  if (d.priorityLabels) patch.priorityLabels = Object.fromEntries(Object.entries(d.priorityLabels).filter(([k, v]) => v !== DEFAULT_PRIORITY_LABEL[k as (typeof PRIORITIES)[number]]));
  if (d.retiredStatuses) patch.retiredJobStatuses = [...new Set(d.retiredStatuses)];
  if (d.requiredFields) patch.jobRequiredFields = [...new Set(d.requiredFields)];
  return saveConfig(ctx, 'jobs', AuditActions.jobConfigChanged, ['jobStatusLabels', 'priorityLabels', 'retiredJobStatuses', 'jobRequiredFields'], patch);
}

/** Fields a business insists on when a job is opened. A booking that has not arrived yet cannot know its mileage, so that one waits for arrival. */
export function assertJobRequirements(required: readonly string[], job: { complaint?: string | null; mileageKm?: number | null; technician?: string | null; serviceType?: string | null; arrived: boolean }): void {
  const missing: Record<string, string> = {};
  if (required.includes('complaint') && !job.complaint?.trim()) missing.complaint = 'Describe the complaint.';
  if (required.includes('mileageKm') && job.arrived && (job.mileageKm === null || job.mileageKm === undefined)) missing.mileageKm = 'Enter the mileage.';
  if (required.includes('primaryTechnician') && !job.technician) missing.primaryTechnicianMembershipId = 'Choose the technician in charge.';
  if (required.includes('serviceType') && !job.serviceType) missing.serviceTypeId = 'Choose the service type.';
  if (Object.keys(missing).length) throw Errors.validation(missing, 'This workshop requires a few more details before a job can be opened.');
}

// ───────────────────────── vehicles ─────────────────────────

export const VEHICLE_FIELDS = { registration: 'Registration', vin: 'VIN', make: 'Make', model: 'Model', year: 'Year', colour: 'Colour', fuelType: 'Fuel type', transmission: 'Transmission', driveType: 'Drive type' } as const;
export const FUEL = ['PETROL', 'DIESEL', 'HYBRID', 'ELECTRIC', 'LPG', 'OTHER'] as const;
export const TRANSMISSION = ['MANUAL', 'AUTOMATIC', 'CVT', 'DCT', 'OTHER'] as const;
export const DRIVE = ['FWD', 'RWD', 'AWD', 'FOUR_BY_FOUR', 'OTHER'] as const;

const vehicleSchema = z.object({
  requiredFields: z.array(z.enum(Object.keys(VEHICLE_FIELDS) as [keyof typeof VEHICLE_FIELDS])).max(10),
  mileageRequired: z.boolean(),
  enabledFuelTypes: z.array(z.enum(FUEL)).max(6),
  enabledTransmissions: z.array(z.enum(TRANSMISSION)).max(5),
  enabledDriveTypes: z.array(z.enum(DRIVE)).max(5),
  defaultIntervalKm: z.union([z.null(), z.literal(''), z.coerce.number().int().min(100).max(200_000)]).transform((v) => (v === '' ? null : v)),
  defaultIntervalMonths: z.union([z.null(), z.literal(''), z.coerce.number().int().min(1).max(120)]).transform((v) => (v === '' ? null : v)),
}).partial();

export async function getVehicleConfig(ctx: BusinessContext) {
  requirePermission(ctx, 'settings.view');
  return withTenant(ctx.business.id, async (tx) => {
    const c = await loadConfig(tx, ctx.business.id);
    return { requiredFields: c.vehicleRequiredFields, mileageRequired: c.vehicleMileageRequired, enabledFuelTypes: c.enabledFuelTypes, enabledTransmissions: c.enabledTransmissions, enabledDriveTypes: c.enabledDriveTypes, defaultIntervalKm: c.defaultIntervalKm, defaultIntervalMonths: c.defaultIntervalMonths };
  });
}

export async function updateVehicleConfig(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'settings.manage_workshop');
  requireFeature(ctx.subscription, 'advanced_settings');
  assertCanWrite(ctx.subscription);
  const d = parseOrThrow(vehicleSchema, input);
  return saveConfig(ctx, 'vehicles', AuditActions.vehicleConfigChanged, ['vehicleRequiredFields', 'vehicleMileageRequired', 'enabledFuelTypes', 'enabledTransmissions', 'enabledDriveTypes', 'defaultIntervalKm', 'defaultIntervalMonths'], {
    vehicleRequiredFields: d.requiredFields ? [...new Set(d.requiredFields)] : undefined, vehicleMileageRequired: d.mileageRequired, enabledFuelTypes: d.enabledFuelTypes, enabledTransmissions: d.enabledTransmissions,
    enabledDriveTypes: d.enabledDriveTypes, defaultIntervalKm: d.defaultIntervalKm, defaultIntervalMonths: d.defaultIntervalMonths,
  });
}

/**
 * Rules for a NEW vehicle (or a changed field). A value that was retired from the lists stays valid on vehicles that already have it:
 * only choosing it afresh is refused, so history is never invalidated.
 */
export function assertVehicleRules(c: Pick<BusinessConfigRow, 'vehicleRequiredFields' | 'vehicleMileageRequired' | 'enabledFuelTypes' | 'enabledTransmissions' | 'enabledDriveTypes'>, v: Record<string, unknown>, existing: Record<string, unknown> | null, o: { creating: boolean }): void {
  const problems: Record<string, string> = {};
  for (const f of c.vehicleRequiredFields) {
    const touched = o.creating || f in v;
    const value = f in v ? v[f] : existing?.[f];
    if (touched && (value === undefined || value === null || value === '')) problems[f] = `${VEHICLE_FIELDS[f as keyof typeof VEHICLE_FIELDS] ?? f} is required.`;
  }
  if (o.creating && c.vehicleMileageRequired && (v.mileageKm === undefined || v.mileageKm === null)) problems.mileageKm = 'The mileage is required.';
  const limited: [string, readonly string[]][] = [['fuelType', c.enabledFuelTypes], ['transmission', c.enabledTransmissions], ['driveType', c.enabledDriveTypes]];
  for (const [field, allowed] of limited) {
    const value = v[field];
    if (typeof value === 'string' && value && allowed.length && !allowed.includes(value) && existing?.[field] !== value) problems[field] = 'That option is not used by this workshop.';
  }
  if (Object.keys(problems).length) throw Errors.validation(problems);
}

// ───────────────────────── inventory defaults ─────────────────────────

const inventoryDefaultsSchema = z.object({
  defaultReorderQuantity: z.union([z.null(), z.literal(''), z.coerce.number().int().min(1).max(1_000_000)]).transform((v) => (v === '' ? null : v)),
  defaultMarkupPercent: z.union([z.null(), z.literal(''), z.coerce.number().min(0).max(1000)]).transform((v) => (v === '' ? null : v)),
}).partial();

export async function getInventoryDefaults(ctx: BusinessContext) {
  requirePermission(ctx, 'settings.view');
  return withTenant(ctx.business.id, async (tx) => {
    const c = await loadConfig(tx, ctx.business.id);
    return { defaultReorderQuantity: c.defaultReorderQuantity, defaultMarkupPercent: c.defaultMarkupBps === null ? null : c.defaultMarkupBps / 100 };
  });
}

export async function updateInventoryDefaults(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'inventory.manage_settings');
  assertCanWrite(ctx.subscription);
  const d = parseOrThrow(inventoryDefaultsSchema, input);
  return saveConfig(ctx, 'inventory', AuditActions.inventoryConfigChanged, ['defaultReorderQuantity', 'defaultMarkupBps'], {
    defaultReorderQuantity: d.defaultReorderQuantity, defaultMarkupBps: d.defaultMarkupPercent === undefined ? undefined : d.defaultMarkupPercent === null ? null : Math.round(d.defaultMarkupPercent * 100),
  });
}

/** Sell price from cost and the business's default markup (whole cents, half up). */
export const priceWithMarkup = (costCents: number, markupBps: number) => Math.round((costCents * (10_000 + markupBps)) / 10_000);

// ───────────────────────── reporting preferences ─────────────────────────

export const DASHBOARD_KPIS = { revenue: 'Money', stock: 'Stock', jobs: 'Job counts', bookings: 'Today\'s bookings', activity: 'Recent activity' } as const;
const reportingSchema = z.object({
  reportDefaultRange: z.enum(PRESETS.filter((p) => p !== 'CUSTOM') as [string, ...string[]]),
  reportDefaultFormat: z.enum(['CSV', 'XLSX', 'PDF']),
  slowMovingDays: z.coerce.number().int().min(14).max(730),
  lapsedCustomerDays: z.coerce.number().int().min(30).max(1095),
  dashboardHiddenKpis: z.array(z.enum(Object.keys(DASHBOARD_KPIS) as [keyof typeof DASHBOARD_KPIS])).max(5),
}).partial();

/** Which dashboard blocks this business hides. A preference, readable by anyone in the business. */
export async function getDashboardPrefs(ctx: Pick<BusinessContext, 'business'>): Promise<ReadonlySet<string>> {
  return withTenant(ctx.business.id, async (tx) => new Set((await loadConfig(tx, ctx.business.id)).dashboardHiddenKpis));
}

export async function getReportingSettings(ctx: BusinessContext) {
  requirePermission(ctx, 'settings.view');
  return withTenant(ctx.business.id, async (tx) => {
    const c = await loadConfig(tx, ctx.business.id);
    return { reportDefaultRange: c.reportDefaultRange, reportDefaultFormat: c.reportDefaultFormat, slowMovingDays: c.slowMovingDays, lapsedCustomerDays: c.lapsedCustomerDays, dashboardHiddenKpis: c.dashboardHiddenKpis, timezone: ctx.business.timezone };
  });
}

/** A preference, not a permission: nothing here can reveal a report or a number the person's role does not already allow. */
export async function updateReportingSettings(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'settings.edit');
  assertCanWrite(ctx.subscription);
  const d = parseOrThrow(reportingSchema, input);
  return saveConfig(ctx, 'reporting', AuditActions.reportingSettingsChanged, ['reportDefaultRange', 'reportDefaultFormat', 'slowMovingDays', 'lapsedCustomerDays', 'dashboardHiddenKpis'], d);
}

// ───────────────────────── security (business level) ─────────────────────────

const securitySchema = z.object({
  sessionMaxHours: z.union([z.null(), z.literal(''), z.coerce.number().int().min(1).max(720)]).transform((v) => (v === '' ? null : v)),
  invitationExpiryDays: z.union([z.null(), z.literal(''), z.coerce.number().int().min(1).max(30)]).transform((v) => (v === '' ? null : v)),
}).partial();

export async function getSecuritySettings(ctx: BusinessContext) {
  requirePermission(ctx, 'settings.view');
  return withTenant(ctx.business.id, async (tx) => {
    const c = await loadConfig(tx, ctx.business.id);
    return { sessionMaxHours: c.sessionMaxHours, invitationExpiryDays: c.invitationExpiryDays, requireMfa: ctx.business.requireMfa };
  });
}

export async function updateSecuritySettings(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'settings.manage_security');
  assertCanWrite(ctx.subscription);
  return saveConfig(ctx, 'security', AuditActions.securitySettingsChanged, ['sessionMaxHours', 'invitationExpiryDays'], parseOrThrow(securitySchema, input));
}

// ───────────────────────── retention ─────────────────────────

const retentionSchema = z.object({
  trashRetentionDays: z.coerce.number().int().min(1).max(3650),
  financialRetentionYears: z.coerce.number().int().min(1).max(50),
  reportRunRetentionDays: z.coerce.number().int().min(7).max(3650),
  importRetentionDays: z.coerce.number().int().min(1).max(365),
}).partial();

export async function getRetention(ctx: BusinessContext) {
  requirePermission(ctx, 'settings.view');
  return withTenant(ctx.business.id, async (tx) => {
    const c = await loadConfig(tx, ctx.business.id);
    const doc = await tx.documentSettings.upsert({ where: { businessId: ctx.business.id }, create: { businessId: ctx.business.id }, update: {} });
    return { trashRetentionDays: doc.trashRetentionDays, financialRetentionYears: doc.financialRetention, reportRunRetentionDays: c.reportRunRetentionDays, importRetentionDays: c.importRetentionDays, floors: { financialRetentionYears: doc.financialRetention } };
  });
}

/**
 * Retention periods. Financial documents can only be kept LONGER (a floor that never goes down: they were promised that long), the trash period
 * must stay at least a day, and the log of report runs and imports is short-lived working data. Audit logs and communication history are kept
 * for ever and are not settable here.
 */
export async function updateRetention(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'settings.edit');
  requirePermission(ctx, 'document.manage');
  assertCanWrite(ctx.subscription);
  const d = parseOrThrow(retentionSchema, input);
  return withTenant(ctx.business.id, async (tx) => {
    const c = await loadConfig(tx, ctx.business.id);
    const doc = await tx.documentSettings.upsert({ where: { businessId: ctx.business.id }, create: { businessId: ctx.business.id }, update: {} });
    if (d.financialRetentionYears !== undefined && d.financialRetentionYears < doc.financialRetention) throw Errors.validation({ financialRetentionYears: `Financial documents are already kept for ${doc.financialRetention} years. That can be lengthened but never shortened.` });
    const before = { trashRetentionDays: doc.trashRetentionDays, financialRetentionYears: doc.financialRetention, reportRunRetentionDays: c.reportRunRetentionDays, importRetentionDays: c.importRetentionDays };
    await tx.documentSettings.update({ where: { businessId: ctx.business.id }, data: { ...defined({ trashRetentionDays: d.trashRetentionDays, financialRetention: d.financialRetentionYears }) } });
    await tx.businessConfig.update({ where: { businessId: ctx.business.id }, data: { ...defined({ reportRunRetentionDays: d.reportRunRetentionDays, importRetentionDays: d.importRetentionDays }), updatedById: ctx.user.id } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.retentionSettingsChanged, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'retention', resourceId: ctx.business.id, before, after: { ...before, ...d } });
    return { ok: true };
  });
}

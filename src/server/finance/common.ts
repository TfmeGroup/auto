import { z } from 'zod';
import { Errors } from '@/lib/errors';
import { uuidSchema } from '@/lib/validation';
import type { Tx } from '@/server/db/client';
import type { BusinessContext, RequestMeta } from '@/server/context';
import { can } from '@/server/permissions/authorize';
import { nextNumber } from '@/server/numbering/sequence';
import { calculateDocument, type DocCalc, type DocDiscount, type LineCalcInput, type TaxContext } from './calc';

/** Things every finance service needs: settings, numbering, line validation and storage, relationship checks, the event log. */

export type FinanceSettingsRow = Awaited<ReturnType<Tx['financeSettings']['findFirstOrThrow']>>;

/** The business's finance settings. Created with defaults the first time they are needed. */
export async function loadFinanceSettings(tx: Tx, businessId: string): Promise<FinanceSettingsRow> {
  const found = await tx.financeSettings.findUnique({ where: { businessId } });
  if (found) return found;
  await tx.financeSettings.createMany({
    data: [{ businessId, enabledMethods: ['CARD', 'EFT', 'CASH', 'OTHER'], reminderOffsets: [-3, 0, 7] }],
    skipDuplicates: true,
  });
  return tx.financeSettings.findUniqueOrThrow({ where: { businessId } });
}

export type DocKind = 'quote' | 'invoice' | 'payment' | 'receipt' | 'credit_note' | 'refund';
const PREFIX_FIELD = {
  quote: 'quotePrefix', invoice: 'invoicePrefix', payment: 'paymentPrefix', receipt: 'receiptPrefix', credit_note: 'creditNotePrefix', refund: 'refundPrefix',
} as const;

/**
 * Next number for a finance document, e.g. INV-000123, or INV-CPT-000123 when the location has a document code.
 * Generated on the server inside the caller's transaction (see numbering/sequence.ts): two requests can never get the
 * same number, and a rollback gives the number back. Changing a prefix later never touches numbers already issued.
 */
export async function nextDocumentNumber(tx: Tx, businessId: string, kind: DocKind, settings: FinanceSettingsRow, locationId?: string | null): Promise<string> {
  const base = settings[PREFIX_FIELD[kind]];
  let code: string | null = null;
  if (locationId) code = (await tx.location.findFirst({ where: { id: locationId, businessId }, select: { docCode: true } }))?.docCode ?? null;
  return nextNumber(tx, businessId, code ? `${kind}:${code}` : kind, code ? `${base}-${code}` : base, settings.numberPadding);
}

export const taxContext = (ctx: BusinessContext, s: FinanceSettingsRow): TaxContext => ({
  vatRegistered: ctx.business.vatRegistered,
  vatRateBps: ctx.business.vatRateBps,
  pricesIncludeVat: s.pricesIncludeVat,
});

// ───────── Lines ─────────

/** Optional text where a missing, empty or null value all mean "none" (a client can send back what it read). */
const nullableText = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : undefined));
const optionalUuid = z.union([z.literal(''), z.null(), uuidSchema]).optional().transform((v) => (v ? v : undefined));

export const lineInputSchema = z.object({
  /** Present when editing an existing line: keeps its cost and source references. */
  id: optionalUuid,
  lineType: z.enum(['PART', 'LABOUR', 'SERVICE', 'CHARGE', 'OTHER']).default('OTHER'),
  description: z.string().trim().min(1, 'Describe the line').max(300),
  sku: nullableText(60),
  unit: nullableText(20),
  quantityMilli: z.coerce.number().int('Quantity must be a whole number of thousandths').min(1, 'Quantity must be more than zero').max(1_000_000_000),
  unitPriceCents: z.coerce.number().int('Price must be in whole cents').min(0, 'Price cannot be negative').max(2_000_000_000),
  discountType: z.enum(['NONE', 'PERCENT', 'FIXED']).default('NONE'),
  discountValue: z.coerce.number().int().min(0).max(2_000_000_000).default(0),
  taxTreatment: z.enum(['STANDARD', 'ZERO_RATED', 'EXEMPT']).default('STANDARD'),
  unitCostCents: z.coerce.number().int().min(0).max(2_000_000_000).nullable().optional(),
  recommendedWorkId: optionalUuid,
  /** A part from the stock catalogue. The server fills in its cost; the browser's word for a cost is never needed. */
  inventoryItemId: optionalUuid,
});
export type LineInput = z.output<typeof lineInputSchema>;

/** What the server stores for a line: the input plus references only the server sets. */
type OptionalLineKeys = 'id' | 'sku' | 'unit' | 'recommendedWorkId' | 'unitCostCents';
export interface LineData extends Omit<LineInput, OptionalLineKeys | 'inventoryItemId'>, Partial<Pick<LineInput, OptionalLineKeys>> {
  jobPartId?: string | null;
  jobLabourId?: string | null;
  inventoryItemId?: string | null;
  technicianMembershipId?: string | null;
  minutes?: number | null;
  quoteLineId?: string | null;
}

export const discountInputSchema = z.object({
  discountType: z.enum(['NONE', 'PERCENT', 'FIXED']).default('NONE'),
  discountValue: z.coerce.number().int().min(0).max(2_000_000_000).default(0),
});

export const toCalcInput = (l: Pick<LineData, 'quantityMilli' | 'unitPriceCents' | 'discountType' | 'discountValue' | 'taxTreatment'>): LineCalcInput => ({
  quantityMilli: l.quantityMilli, unitPriceCents: l.unitPriceCents, discountType: l.discountType, discountValue: l.discountValue, taxTreatment: l.taxTreatment,
});

/** Calculate a document and return both the totals and the rows to store (calculated columns filled in). */
export function priceLines(lines: LineData[], tax: TaxContext, discount: DocDiscount) {
  if (lines.length > 200) throw Errors.validation({ lines: 'A document can have at most 200 lines.' });
  const calc = calculateDocument(lines.map(toCalcInput), tax, discount);
  const rows = lines.map((l, i) => ({
    position: i + 1,
    lineType: l.lineType,
    description: l.description,
    sku: l.sku ?? null,
    unit: l.unit ?? null,
    quantityMilli: l.quantityMilli,
    unitPriceCents: l.unitPriceCents,
    discountType: l.discountType,
    discountValue: l.discountValue,
    taxTreatment: l.taxTreatment,
    vatRateBps: calc.lines[i]!.vatRateBps,
    baseCents: calc.lines[i]!.baseCents,
    discountCents: calc.lines[i]!.discountCents,
    taxableCents: calc.lines[i]!.taxableCents,
    vatCents: calc.lines[i]!.vatCents,
    totalCents: calc.lines[i]!.totalCents,
    unitCostCents: l.unitCostCents ?? null,
    inventoryItemId: l.inventoryItemId ?? null,
    jobPartId: l.jobPartId ?? null,
    jobLabourId: l.jobLabourId ?? null,
    recommendedWorkId: l.recommendedWorkId ?? null,
    technicianMembershipId: l.technicianMembershipId ?? null,
    minutes: l.minutes ?? null,
  }));
  return { calc, rows };
}

export const totalsOf = (c: DocCalc) => ({
  subtotalCents: c.subtotalCents, discountCents: c.discountCents, taxableCents: c.taxableCents, vatCents: c.vatCents, totalCents: c.totalCents,
});

/**
 * Merge the lines a client sent with the stored ones. A line that names an existing id keeps its cost and its
 * references to the job (parts, labour, technician); a client can never invent those, and cost can only be typed by
 * someone allowed to see costs.
 */
export function mergeLines<E extends { id: string; unitCostCents: number | null; jobPartId: string | null; jobLabourId: string | null; inventoryItemId: string | null; technicianMembershipId: string | null; minutes: number | null; recommendedWorkId: string | null }>(
  ctx: BusinessContext,
  incoming: LineInput[],
  existing: E[],
): LineData[] {
  const byId = new Map(existing.map((e) => [e.id, e]));
  const costAllowed = can(ctx, 'finance.view_costs');
  return incoming.map((l) => {
    const old = l.id ? byId.get(l.id) : undefined;
    if (l.id && !old) throw Errors.validation({ lines: 'A line you sent does not belong to this document.' });
    return {
      ...l,
      unitCostCents: costAllowed && l.unitCostCents !== undefined ? l.unitCostCents : (old?.unitCostCents ?? null),
      jobPartId: old?.jobPartId ?? null,
      jobLabourId: old?.jobLabourId ?? null,
      inventoryItemId: l.inventoryItemId ?? old?.inventoryItemId ?? null,
      technicianMembershipId: old?.technicianMembershipId ?? null,
      minutes: old?.minutes ?? null,
      recommendedWorkId: l.recommendedWorkId ?? old?.recommendedWorkId ?? undefined,
    };
  });
}

/** Cost per unit cannot be seen without finance.view_costs. */
export function stripCosts<T extends { unitCostCents?: number | null }>(ctx: BusinessContext, rows: T[]): T[] {
  if (can(ctx, 'finance.view_costs')) return rows;
  return rows.map((r) => ({ ...r, unitCostCents: null }));
}

// ───────── Relationships ─────────

export interface DocParties {
  customerId: string;
  vehicleId: string | null;
  jobId: string | null;
  locationId: string | null;
}

/**
 * Check that the customer, vehicle and job named on a document exist in THIS business and belong together
 * (the vehicle is the customer's, the job is for that customer and vehicle). Nothing is ever duplicated or moved;
 * documents just point at the existing records.
 */
export async function validateParties(tx: Tx, businessId: string, p: { customerId: string; vehicleId?: string | null; jobId?: string | null; locationId?: string | null }): Promise<DocParties> {
  const customer = await tx.customer.findFirst({ where: { id: p.customerId, businessId } });
  if (!customer) throw Errors.validation({ customerId: 'Choose a customer of this business.' });
  if (customer.status === 'ARCHIVED') throw Errors.validation({ customerId: 'That customer is archived. Restore them first.' });
  let vehicleId = p.vehicleId ?? null;
  const jobId = p.jobId ?? null;
  let locationId = p.locationId ?? null;
  if (jobId) {
    const job = await tx.jobCard.findFirst({ where: { id: jobId, businessId } });
    if (!job) throw Errors.validation({ jobId: 'Choose a job of this business.' });
    if (job.customerId !== customer.id) throw Errors.validation({ jobId: 'That job is for a different customer.' });
    if (vehicleId && job.vehicleId !== vehicleId) throw Errors.validation({ jobId: 'That job is for a different vehicle.' });
    vehicleId = vehicleId ?? job.vehicleId;
    locationId = locationId ?? job.locationId;
  }
  if (vehicleId) {
    const v = await tx.vehicle.findFirst({ where: { id: vehicleId, businessId } });
    if (!v) throw Errors.validation({ vehicleId: 'Choose a vehicle of this business.' });
    if (v.customerId !== customer.id) throw Errors.validation({ vehicleId: 'That vehicle belongs to a different customer.' });
  }
  if (locationId) {
    const l = await tx.location.findFirst({ where: { id: locationId, businessId, status: 'ACTIVE' }, select: { id: true } });
    if (!l) throw Errors.validation({ locationId: 'Choose a location of this business.' });
  } else {
    locationId = (await tx.location.findFirst({ where: { businessId, isDefault: true, status: 'ACTIVE' }, select: { id: true } }))?.id ?? null;
  }
  return { customerId: customer.id, vehicleId, jobId, locationId };
}

/** A recommended-work reference on a line must be real work on that document's job. */
export async function validateWorkRefs(tx: Tx, businessId: string, jobId: string | null, lines: { recommendedWorkId?: string | null; inventoryItemId?: string | null; lineType?: string; sku?: string | null; unitCostCents?: number | null }[]): Promise<void> {
  await resolveCatalogueRefs(tx, businessId, lines);
  const ids = [...new Set(lines.map((l) => l.recommendedWorkId).filter((v): v is string => !!v))];
  if (ids.length === 0) return;
  if (!jobId) throw Errors.validation({ lines: 'Lines can only refer to recommended work when the document is for a job.' });
  const found = await tx.recommendedWork.count({ where: { id: { in: ids }, businessId, jobId } });
  if (found !== ids.length) throw Errors.validation({ lines: 'A line refers to recommended work that is not on this job.' });
}

/**
 * A line that names a catalogue part must name a part of THIS business and be a part line; its SKU and (when no cost was given) its cost are taken from the
 * catalogue, so profit reports have a cost even when the person typing the document may not see costs. Stock itself is not touched by a quote or invoice:
 * it moves when parts are reserved and fitted on the job.
 */
export async function resolveCatalogueRefs(tx: Tx, businessId: string, lines: { inventoryItemId?: string | null; lineType?: string; sku?: string | null; unitCostCents?: number | null }[]): Promise<void> {
  const ids = [...new Set(lines.map((l) => l.inventoryItemId).filter((v): v is string => !!v))];
  if (ids.length === 0) return;
  const parts = await tx.part.findMany({ where: { businessId, id: { in: ids } }, select: { id: true, sku: true, costCents: true } });
  const byId = new Map(parts.map((p) => [p.id, p]));
  for (const l of lines) {
    if (!l.inventoryItemId) continue;
    const p = byId.get(l.inventoryItemId);
    if (!p) throw Errors.validation({ lines: 'A line refers to a part that is not in your catalogue.' });
    if (l.lineType && l.lineType !== 'PART') throw Errors.validation({ lines: 'Only part lines can come from the catalogue.' });
    if (!l.sku) l.sku = p.sku;
    if (l.unitCostCents === undefined || l.unitCostCents === null) l.unitCostCents = p.costCents;
  }
}

// ───────── Event log ─────────

export type FinanceActor = { kind: 'STAFF'; userId: string; name: string } | { kind: 'CUSTOMER'; name: string } | { kind: 'SYSTEM'; name?: string };

export const staffActor = (ctx: BusinessContext): FinanceActor => ({ kind: 'STAFF', userId: ctx.user.id, name: ctx.user.name });

export async function recordFinanceEvent(
  tx: Tx,
  businessId: string,
  e: { entityType: 'quote' | 'invoice' | 'payment' | 'credit_note' | 'refund'; entityId: string; type: string; version?: number | null; actor: FinanceActor; meta?: RequestMeta; detail?: Record<string, unknown> },
): Promise<void> {
  await tx.financeEvent.create({
    data: {
      businessId, entityType: e.entityType, entityId: e.entityId, type: e.type, version: e.version ?? null,
      actorKind: e.actor.kind, actorUserId: e.actor.kind === 'STAFF' ? e.actor.userId : null, actorName: e.actor.kind === 'SYSTEM' ? (e.actor.name ?? 'System') : e.actor.name,
      ip: e.meta?.ip ?? null, userAgent: e.meta?.userAgent?.slice(0, 300) ?? null, detail: (e.detail ?? undefined) as never,
    },
  });
}

/** Lock a row for the rest of the transaction so two people changing it are applied one after the other. */
export async function lockRow(tx: Tx, table: 'quotes' | 'invoices' | 'payments' | 'credit_notes' | 'customers', businessId: string, id: string): Promise<void> {
  const rows = await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM ${table} WHERE id = $1::uuid AND business_id = $2::uuid FOR UPDATE`, id, businessId);
  if (rows.length === 0) throw Errors.notFound();
}

/**
 * The business details that go on a document, frozen when it is issued. A document that belongs to a location uses that location's own contact
 * details where it has them (precedence: the location's phone, email and address, else the business's); everything else stays the business's.
 */
export async function businessSnapshot(tx: Tx, businessId: string, settings: FinanceSettingsRow, locationId?: string | null) {
  const b = await tx.business.findUniqueOrThrow({ where: { id: businessId } });
  const loc = locationId ? await tx.location.findFirst({ where: { id: locationId, businessId }, select: { phone: true, email: true, addressLine1: true, city: true, province: true, postalCode: true } }) : null;
  const locAddress = loc ? [loc.addressLine1, loc.city, loc.province, loc.postalCode].filter(Boolean).join(', ') : '';
  return {
    name: b.name, tradingName: b.tradingName, legalName: b.legalName, registrationNumber: b.registrationNumber, vatNumber: b.vatRegistered ? b.vatNumber : null,
    vatRegistered: b.vatRegistered, phone: loc?.phone || b.phone, email: loc?.email || b.email, website: b.website, logoFileId: b.logoFileId,
    address: locAddress || [b.addressLine1, b.addressLine2, b.city, b.province, b.postalCode].filter(Boolean).join(', ') || null,
    currency: b.currency, locale: b.locale, timezone: b.timezone,
    paymentInstructions: settings.paymentInstructions, footer: settings.invoiceFooter,
  };
}
export type BusinessSnapshot = Awaited<ReturnType<typeof businessSnapshot>>;

export async function customerSnapshot(tx: Tx, businessId: string, customerId: string) {
  const c = await tx.customer.findFirstOrThrow({ where: { id: customerId, businessId } });
  return {
    name: c.type === 'BUSINESS' && c.companyName ? c.companyName : c.name, contactName: c.name, customerNumber: c.customerNumber, email: c.email, mobile: c.mobile,
    address: [c.addressLine1, c.addressLine2, c.city, c.province, c.postalCode].filter(Boolean).join(', ') || null, companyRegNumber: c.companyRegNumber,
  };
}
export type CustomerSnapshot = Awaited<ReturnType<typeof customerSnapshot>>;

export const money = (cents: number) => cents / 100;

/** A YYYY-MM-DD string as a date-only value (stored in DATE columns), and back. */
export const dateOnly = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
export const isoOf = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

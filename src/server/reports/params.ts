import { z } from 'zod';
import { parseOrThrow } from '@/lib/validation';
import type { FilterKey, Params } from './types';

const id = z.uuid();
const opt = <T extends z.ZodType>(s: T) => z.preprocess((v) => (v === '' || v === null ? undefined : v), s.optional());
const text = (max = 80) => opt(z.string().trim().max(max));

/** Everything a report URL / API call may carry. Values are validated here; a report only reads the ones it declares. */
export const paramsSchema = z.object({
  preset: opt(z.string().max(20)),
  from: opt(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-03-31')),
  to: opt(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-03-31')),
  locationIds: z.preprocess((v) => (typeof v === 'string' ? (v === '' ? [] : v.split(',')) : v ?? []), z.array(id).max(25)),
  customerId: opt(id),
  technicianId: opt(id),
  vehicleId: opt(id),
  serviceTypeId: opt(id),
  jobStatus: opt(z.enum(['BOOKED', 'CHECKED_IN', 'INSPECTION', 'DIAGNOSIS', 'AWAITING_APPROVAL', 'APPROVED', 'AWAITING_PARTS', 'IN_PROGRESS', 'QUALITY_CHECK', 'READY_FOR_COLLECTION', 'COMPLETED', 'CANCELLED', 'ON_HOLD'])),
  bookingStatus: opt(z.enum(['REQUESTED', 'CONFIRMED', 'REMINDER_SENT', 'CHECKED_IN', 'NO_SHOW', 'CANCELLED', 'RESCHEDULED', 'COMPLETED'])),
  quoteStatus: opt(z.enum(['DRAFT', 'SENT', 'VIEWED', 'APPROVED', 'DECLINED', 'EXPIRED', 'CONVERTED', 'CANCELLED'])),
  invoiceStatus: opt(z.enum(['PAID', 'PARTIALLY_PAID', 'UNPAID', 'OVERDUE', 'CANCELLED', 'WRITTEN_OFF'])),
  paymentMethod: opt(z.enum(['ONLINE', 'CARD', 'EFT', 'CASH', 'OTHER'])),
  supplierId: opt(id),
  partId: opt(id),
  categoryId: opt(id),
  make: text(60),
  model: text(60),
  year: opt(z.coerce.number().int().min(1900).max(2100)),
  vehicleStatus: opt(z.enum(['ACTIVE', 'AWAITING_SERVICE', 'IN_WORKSHOP', 'AWAITING_PARTS', 'REPAIR_REQUIRED', 'INACTIVE'])),
  customerStatus: opt(z.enum(['ACTIVE', 'INACTIVE'])),
  stockStatus: opt(z.enum(['LOW', 'OUT', 'OK'])),
  movementType: opt(z.enum(['RECEIVED', 'SOLD', 'USED', 'RESERVED', 'UNRESERVED', 'RETURNED', 'ADJUSTED', 'DAMAGED', 'LOST', 'TRANSFER_IN', 'TRANSFER_OUT', 'SUPPLIER_RETURN'])),
  poStatus: opt(z.enum(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'])),
  bucket: opt(z.enum(['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'])),
  search: text(80),
  docType: opt(z.enum(['INVOICE', 'CREDIT_NOTE', 'PAYMENT', 'REFUND'])),
  groupBy: opt(z.string().max(30)),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(10).max(200).default(50),
});

const FILTER_FIELDS: Record<FilterKey, (keyof Params)[]> = {
  range: ['preset', 'from', 'to'], location: ['locationIds'], customer: ['customerId'], technician: ['technicianId'], vehicle: ['vehicleId'], serviceType: ['serviceTypeId'],
  jobStatus: ['jobStatus'], bookingStatus: ['bookingStatus'], quoteStatus: ['quoteStatus'], invoiceStatus: ['invoiceStatus'], paymentMethod: ['paymentMethod'],
  supplier: ['supplierId'], part: ['partId'], category: ['categoryId'], make: ['make'], model: ['model'], year: ['year'], vehicleStatus: ['vehicleStatus'],
  customerStatus: ['customerStatus'], stockStatus: ['stockStatus'], movementType: ['movementType'], poStatus: ['poStatus'], bucket: ['bucket'], search: ['search'], docType: ['docType'],
};

/** Validate a raw query / saved config and keep only the filters the report declares (the rest cannot influence it). */
export function parseParams(raw: unknown, allowed: FilterKey[], groupBys: string[] = []): Params {
  const p = parseOrThrow(paramsSchema, raw ?? {});
  const keep = new Set<string>(['page', 'pageSize', ...allowed.flatMap((f) => FILTER_FIELDS[f])]);
  const out: Record<string, unknown> = { page: p.page, pageSize: p.pageSize, locationIds: [], preset: p.preset ?? '' };
  for (const [k, v] of Object.entries(p)) if (keep.has(k) && v !== undefined) out[k] = v;
  if (!allowed.includes('location')) out.locationIds = [];
  if (p.groupBy && groupBys.includes(p.groupBy)) out.groupBy = p.groupBy;
  return out as unknown as Params;
}

/** The filters worth showing back to the reader / writing into an export header. */
export function describeFilters(p: Params): Record<string, string | number | string[]> {
  const out: Record<string, string | number | string[]> = {};
  for (const [k, v] of Object.entries(p)) {
    if (['page', 'pageSize', 'preset', 'from', 'to'].includes(k)) continue;
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v as string | number | string[];
  }
  return out;
}

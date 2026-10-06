import { z } from 'zod';
import type { Tx } from '@/server/db/client';
import type { FeatureKey } from '@/server/billing/features';
import type { Permission } from '@/server/permissions/catalog';
import { customerInputSchema } from '@/server/customers/service';
import { supplierCreateSchema } from '@/server/inventory/suppliers';
import { normalizeRegistration, vehicleCreateSchema } from '@/server/vehicles/service';
import { assertVehicleRules } from '@/server/settings/config-service';
import { loadConfig } from '@/server/settings/config';
import { nextCustomerNumber } from '@/server/numbering/sequence';
import { AuditActions, recordAudit } from '@/server/audit/audit';
import type { BusinessContext } from '@/server/context';

/**
 * What can be imported, field by field. Each kind says: which columns it understands (with the names people usually give them), how one row is
 * validated (with the SAME rules as creating the record by hand), how a row is recognised as a duplicate, and how it is saved. The import
 * engine (service.ts) does the staging, preview, safety and reporting the same way for every kind.
 */

export type ImportKind = 'customers' | 'vehicles' | 'suppliers';

export interface FieldDef { key: string; label: string; required: boolean; synonyms: string[] }

/** A way two records are "the same", checked against existing records AND earlier rows of the same file. */
export interface DupKey { type: string; value: string; label: string }

export interface RowCheck {
  values?: Record<string, unknown>;
  errors: string[];
  warnings: string[];
  keys: DupKey[];
}

/** Everything a kind needs to know about the business, loaded once per validation / commit pass. */
export interface Lookups {
  /** Existing duplicate keys -> description of the record that already has them. */
  existing: Map<string, string>;
  customers?: {
    byNumber: Map<string, string[]>;
    byEmail: Map<string, string[]>;
    byMobile: Map<string, string[]>;
  };
  vehicleRules?: Awaited<ReturnType<typeof loadConfig>>;
}

export interface KindDef {
  key: ImportKind;
  label: string;
  description: string;
  /** All must be held (plus data.import). */
  permissions: Permission[];
  feature?: FeatureKey;
  fields: FieldDef[];
  /** Keys that count as duplicates of an existing record (lower-cased) are `${type}:${value}`. */
  load(tx: Tx, businessId: string): Promise<Lookups>;
  check(row: Record<string, string>, lookups: Lookups, ctx: { ctx: BusinessContext }): RowCheck;
  insert(ctx: BusinessContext, tx: Tx, values: Record<string, unknown>, batchId: string): Promise<string>;
}

const f = (key: string, label: string, required: boolean, ...synonyms: string[]): FieldDef => ({ key, label, required, synonyms });
export const norm = (s: string) => s.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
const digits = (s: string) => s.replace(/\D/g, '');
/** Phones are compared by their last 9 digits so "082 123 4567", "+27 82 123 4567" and "0821234567" are the same number. */
export const phoneKey = (s: string) => { const d = digits(s); return d.length >= 7 ? d.slice(-9) : ''; };
const issues = (r: { error: z.ZodError }) => r.error.issues.map((i) => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`);
const yes = (v: string) => /^(y|yes|true|1)$/i.test(v.trim());

// ───────────────────────── customers ─────────────────────────

const customers: KindDef = {
  key: 'customers', label: 'Customers', description: 'Customer records: names, contact details and address. Marketing consent is never imported.',
  permissions: ['customer.create'],
  fields: [
    f('firstName', 'First name', true, 'first name', 'firstname', 'name', 'given name'), f('lastName', 'Last name', true, 'last name', 'lastname', 'surname', 'family name'),
    f('fullName', 'Full name (if not split)', false, 'full name', 'customer name', 'customer'), f('mobile', 'Mobile', true, 'mobile', 'cell', 'cellphone', 'cell phone', 'phone', 'mobile number', 'telephone'),
    f('email', 'Email', false, 'email', 'e-mail', 'email address'), f('type', 'Type (Individual or Business)', false, 'type', 'customer type'), f('companyName', 'Company name', false, 'company', 'company name', 'business name'),
    f('altPhone', 'Other phone', false, 'alt phone', 'alternative phone', 'other phone', 'work phone', 'home phone'), f('addressLine1', 'Address', false, 'address', 'address line 1', 'street'),
    f('city', 'City', false, 'city', 'town', 'suburb'), f('province', 'Province', false, 'province', 'state', 'region'), f('postalCode', 'Postal code', false, 'postal code', 'zip', 'postcode', 'zip code'),
    f('notes', 'Notes', false, 'notes', 'comments'), f('customerNumber', 'Existing customer number (for matching only)', false, 'customer number', 'customer no', 'account number', 'customer id', 'account'),
  ],
  async load(tx, businessId) {
    const rows = await tx.customer.findMany({ where: { businessId, status: { not: 'ARCHIVED' } }, select: { customerNumber: true, name: true, email: true, mobile: true, altPhone: true } });
    const existing = new Map<string, string>();
    for (const c of rows) {
      const who = `${c.name} (${c.customerNumber})`;
      existing.set(`number:${c.customerNumber.toLowerCase()}`, who);
      if (c.email) existing.set(`email:${c.email.toLowerCase()}`, who);
      for (const p of [c.mobile, c.altPhone]) if (p && phoneKey(p)) existing.set(`phone:${phoneKey(p)}`, who);
    }
    return { existing };
  },
  check(r) {
    const errors: string[] = [];
    const warnings: string[] = [];
    let first = r.firstName ?? '';
    let last = r.lastName ?? '';
    if ((!first || !last) && r.fullName) {
      const parts = r.fullName.trim().split(/\s+/);
      if (parts.length >= 2) { last = last || parts.slice(-1)[0]!; first = first || parts.slice(0, -1).join(' '); }
      else { first = first || (parts[0] ?? ''); warnings.push('The name has one word; the last name was left for you to complete.'); }
    }
    const type = /^b/i.test(r.type ?? '') ? 'BUSINESS' : 'INDIVIDUAL';
    const candidate = { type, firstName: first, lastName: last, mobile: r.mobile ?? '', email: r.email || undefined, companyName: r.companyName || undefined, altPhone: r.altPhone || undefined, addressLine1: r.addressLine1 || undefined, city: r.city || undefined, province: r.province || undefined, postalCode: r.postalCode || undefined, notes: r.notes || undefined, marketingConsent: false };
    const parsed = customerInputSchema.safeParse(candidate);
    if (!parsed.success) errors.push(...issues(parsed));
    const keys: DupKey[] = [];
    if (r.customerNumber) keys.push({ type: 'number', value: r.customerNumber.toLowerCase(), label: 'customer number' });
    if (r.email) keys.push({ type: 'email', value: r.email.toLowerCase(), label: 'email' });
    if (r.mobile && phoneKey(r.mobile)) keys.push({ type: 'phone', value: phoneKey(r.mobile), label: 'phone number' });
    return { values: parsed.success ? (parsed.data as Record<string, unknown>) : undefined, errors, warnings, keys };
  },
  async insert(ctx, tx, values, batchId) {
    const d = values as { firstName: string; lastName: string };
    const customerNumber = await nextCustomerNumber(tx, ctx.business.id);
    const c = await tx.customer.create({ data: { ...(values as object), name: `${d.firstName} ${d.lastName}`.replace(/\s+/g, ' ').trim(), businessId: ctx.business.id, customerNumber, createdById: ctx.user.id } as never });
    await recordAudit(tx, ctx.meta, { action: AuditActions.customerCreated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'customer', resourceId: c.id, metadata: { import: batchId } });
    return c.id;
  },
};

// ───────────────────────── vehicles ─────────────────────────

const FUEL: Record<string, string> = { petrol: 'PETROL', gasoline: 'PETROL', diesel: 'DIESEL', hybrid: 'HYBRID', electric: 'ELECTRIC', ev: 'ELECTRIC', lpg: 'LPG', other: 'OTHER' };
const TRANS: Record<string, string> = { manual: 'MANUAL', automatic: 'AUTOMATIC', auto: 'AUTOMATIC', cvt: 'CVT', dct: 'DCT', other: 'OTHER' };
const DRIVE: Record<string, string> = { fwd: 'FWD', rwd: 'RWD', awd: 'AWD', '4x4': 'FOUR_BY_FOUR', '4wd': 'FOUR_BY_FOUR', other: 'OTHER' };

const vehicles: KindDef = {
  key: 'vehicles', label: 'Vehicles', description: 'Vehicles, each linked to its owner by customer number, email or mobile number. The owner must already exist.',
  permissions: ['vehicle.create', 'customer.view'],
  fields: [
    f('registration', 'Registration', false, 'registration', 'reg', 'reg no', 'plate', 'number plate', 'licence plate'), f('vin', 'VIN', false, 'vin', 'chassis', 'chassis number'),
    f('make', 'Make', false, 'make', 'brand', 'manufacturer'), f('model', 'Model', false, 'model'), f('year', 'Year', false, 'year', 'model year'), f('colour', 'Colour', false, 'colour', 'color'),
    f('fuelType', 'Fuel type', false, 'fuel', 'fuel type'), f('transmission', 'Transmission', false, 'transmission', 'gearbox'), f('driveType', 'Drive type', false, 'drive', 'drive type'),
    f('mileageKm', 'Mileage (km)', false, 'mileage', 'odometer', 'km', 'kilometres'),
    f('ownerCustomerNumber', 'Owner customer number', false, 'customer number', 'owner customer number', 'customer no', 'account number'), f('ownerEmail', 'Owner email', false, 'owner email', 'customer email', 'email'),
    f('ownerMobile', 'Owner mobile', false, 'owner mobile', 'customer mobile', 'mobile', 'cell', 'phone'),
  ],
  async load(tx, businessId) {
    const [vs, cs, config] = [
      await tx.vehicle.findMany({ where: { businessId, archivedAt: null }, select: { registrationNorm: true, vin: true, registration: true } }),
      await tx.customer.findMany({ where: { businessId, status: { not: 'ARCHIVED' } }, select: { id: true, customerNumber: true, email: true, mobile: true, altPhone: true } }),
      await loadConfig(tx, businessId),
    ];
    const existing = new Map<string, string>();
    for (const v of vs) {
      const who = `vehicle ${v.registration ?? v.vin}`;
      if (v.registrationNorm) existing.set(`reg:${v.registrationNorm}`, who);
      if (v.vin) existing.set(`vin:${v.vin}`, who);
    }
    const byNumber = new Map<string, string[]>(), byEmail = new Map<string, string[]>(), byMobile = new Map<string, string[]>();
    const add = (m: Map<string, string[]>, k: string | null | undefined, id: string) => { if (!k) return; const a = m.get(k) ?? []; if (!a.includes(id)) a.push(id); m.set(k, a); };
    for (const c of cs) {
      add(byNumber, c.customerNumber.toLowerCase(), c.id);
      add(byEmail, c.email?.toLowerCase(), c.id);
      add(byMobile, c.mobile ? phoneKey(c.mobile) : null, c.id);
      add(byMobile, c.altPhone ? phoneKey(c.altPhone) : null, c.id);
    }
    return { existing, customers: { byNumber, byEmail, byMobile }, vehicleRules: config };
  },
  check(r, l) {
    const errors: string[] = [];
    const warnings: string[] = [];
    const keys: DupKey[] = [];
    const norm1 = (m: Record<string, string>, s: string) => m[norm(s)];
    const owners = (() => {
      const c = l.customers!;
      const tries: [string, string[] | undefined][] = [];
      if (r.ownerCustomerNumber) tries.push(['customer number', c.byNumber.get(r.ownerCustomerNumber.toLowerCase())]);
      if (r.ownerEmail) tries.push(['email', c.byEmail.get(r.ownerEmail.toLowerCase())]);
      if (r.ownerMobile && phoneKey(r.ownerMobile)) tries.push(['mobile number', c.byMobile.get(phoneKey(r.ownerMobile))]);
      if (!tries.length) { errors.push('No owner given: add the customer number, email or mobile of the owner.'); return null; }
      for (const [how, ids] of tries) {
        if (ids && ids.length === 1) return ids[0]!;
        if (ids && ids.length > 1) { errors.push(`More than one customer has that ${how}, so the owner is ambiguous. Use the customer number.`); return null; }
      }
      errors.push('The owner was not found. Import the customer first, or check the customer number, email or mobile.');
      return null;
    })();
    const fuel = r.fuelType ? norm1(FUEL, r.fuelType) : undefined;
    if (r.fuelType && !fuel) errors.push(`Fuel type "${r.fuelType}" is not recognised (petrol, diesel, hybrid, electric, LPG or other).`);
    const trans = r.transmission ? norm1(TRANS, r.transmission) : undefined;
    if (r.transmission && !trans) errors.push(`Transmission "${r.transmission}" is not recognised (manual, automatic, CVT, DCT or other).`);
    const drive = r.driveType ? norm1(DRIVE, r.driveType) : undefined;
    if (r.driveType && !drive) errors.push(`Drive type "${r.driveType}" is not recognised (FWD, RWD, AWD or 4x4).`);
    const candidate = { customerId: owners ?? '00000000-0000-4000-8000-000000000000', registration: r.registration || undefined, vin: r.vin || undefined, make: r.make || undefined, model: r.model || undefined, year: r.year || undefined, colour: r.colour || undefined, fuelType: fuel, transmission: trans, driveType: drive, mileageKm: (r.mileageKm || '').replace(/[\s,]/g, '') || undefined };
    const parsed = vehicleCreateSchema.safeParse(candidate);
    if (!parsed.success) errors.push(...issues(parsed));
    else {
      try { assertVehicleRules(l.vehicleRules!, parsed.data as Record<string, unknown>, null, { creating: true }); }
      catch (e) { const d = (e as { details?: Record<string, string> }).details; errors.push(...(d ? Object.values(d) : ['Does not meet this workshop\'s vehicle rules.'])); }
    }
    if (r.registration) keys.push({ type: 'reg', value: normalizeRegistration(r.registration), label: 'registration' });
    if (r.vin) keys.push({ type: 'vin', value: r.vin.toUpperCase().replace(/\s+/g, ''), label: 'VIN' });
    return { values: parsed.success && owners ? (parsed.data as Record<string, unknown>) : undefined, errors, warnings, keys };
  },
  async insert(ctx, tx, values, batchId) {
    const { mileageKm, ...data } = values as { mileageKm?: number; registration?: string; customerId: string };
    const v = await tx.vehicle.create({
      data: { ...(data as object), registration: data.registration?.toUpperCase() ?? null, registrationNorm: data.registration ? normalizeRegistration(data.registration) : null, mileageKm: mileageKm ?? null, businessId: ctx.business.id, createdById: ctx.user.id } as never,
    });
    if (mileageKm !== undefined) await tx.vehicleMileage.create({ data: { businessId: ctx.business.id, vehicleId: v.id, mileageKm, source: 'CREATED', recordedById: ctx.user.id } });
    await recordAudit(tx, ctx.meta, { action: AuditActions.vehicleCreated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'vehicle', resourceId: v.id, metadata: { import: batchId } });
    return v.id;
  },
};

// ───────────────────────── suppliers ─────────────────────────

const suppliers: KindDef = {
  key: 'suppliers', label: 'Suppliers', description: 'Parts suppliers with contact and account details.', permissions: ['inventory.manage_suppliers'], feature: 'advanced_import',
  fields: [
    f('name', 'Supplier name', true, 'name', 'supplier', 'supplier name', 'company'), f('tradingName', 'Trading name', false, 'trading name', 'trading as'), f('contactPerson', 'Contact person', false, 'contact', 'contact person'),
    f('phone', 'Phone', false, 'phone', 'telephone', 'tel', 'mobile'), f('email', 'Email', false, 'email', 'e-mail'), f('address', 'Address', false, 'address'), f('vatNumber', 'VAT number', false, 'vat number', 'vat no', 'vat'),
    f('registrationNumber', 'Registration number', false, 'registration number', 'company reg', 'reg no'), f('accountNumber', 'Supplier reference / account number', false, 'account number', 'account', 'supplier reference', 'supplier code', 'reference', 'code'),
    f('paymentTerms', 'Payment terms', false, 'payment terms', 'terms'), f('notes', 'Notes', false, 'notes', 'comments'),
  ],
  async load(tx, businessId) {
    const rows = await tx.supplier.findMany({ where: { businessId, status: { not: 'ARCHIVED' } }, select: { name: true, accountNumber: true } });
    const existing = new Map<string, string>();
    for (const s of rows) {
      existing.set(`name:${s.name.toLowerCase()}`, `supplier ${s.name}`);
      if (s.accountNumber) existing.set(`ref:${s.accountNumber.toLowerCase()}`, `supplier ${s.name}`);
    }
    return { existing };
  },
  check(r) {
    const errors: string[] = [];
    const parsed = supplierCreateSchema.safeParse({ name: r.name ?? '', tradingName: r.tradingName, contactPerson: r.contactPerson, phone: r.phone, email: r.email || undefined, address: r.address, vatNumber: r.vatNumber, registrationNumber: r.registrationNumber, accountNumber: r.accountNumber, paymentTerms: r.paymentTerms, notes: r.notes });
    if (!parsed.success) errors.push(...issues(parsed));
    const keys: DupKey[] = [];
    if (r.accountNumber) keys.push({ type: 'ref', value: r.accountNumber.toLowerCase(), label: 'supplier reference' });
    if (r.name) keys.push({ type: 'name', value: r.name.toLowerCase().trim(), label: 'name' });
    return { values: parsed.success ? (parsed.data as Record<string, unknown>) : undefined, errors, warnings: [], keys };
  },
  async insert(ctx, tx, values, batchId) {
    const s = await tx.supplier.create({ data: { ...(values as object), businessId: ctx.business.id, createdById: ctx.user.id, updatedById: ctx.user.id } as never });
    await recordAudit(tx, ctx.meta, { action: AuditActions.supplierCreated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'supplier', resourceId: s.id, metadata: { import: batchId } });
    return s.id;
  },
};

export const KINDS: Record<ImportKind, KindDef> = { customers, vehicles, suppliers };
export const isKind = (k: string): k is ImportKind => Object.prototype.hasOwnProperty.call(KINDS, k);
void yes;

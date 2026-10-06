import { z } from 'zod';
import { withTenant, type Tx } from '@/server/db/client';
import { Errors } from '@/lib/errors';
import { MoneyError, parseDecimalToCents } from '@/lib/money';
import { MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, readTable, TabularError } from '@/lib/tabular-read';
import { parseOrThrow, uuidSchema } from '@/lib/validation';
import { recordAudit, AuditActions } from '@/server/audit/audit';
import { assertCanWrite } from '@/server/billing/subscriptions';
import { requireFeature } from '@/server/billing/features';
import { requirePermission } from '@/server/permissions/authorize';
import { consume } from '@/server/security/rate-limit';
import type { BusinessContext } from '@/server/context';
import { accessibleLocations, actorOf, canSeeCosts, loadInventorySettings, lockPartIdentifiers, trimOrNull } from './common';
import { createPartTx, partCreateSchema, recordPriceChange } from './parts';
import { applyMovement } from './stock';

/**
 * Importing parts from CSV or Excel, in the order the business asked for: upload -> map columns -> validate -> preview -> confirm -> process ->
 * report. Nothing is imported by the preview. A row with a problem is never imported quietly: the preview lists every problem, and a commit
 * with problems is refused unless the person explicitly chooses to skip the bad rows. Rows that would change an existing part's price or cost
 * need an explicit confirmation too. Permissions are the same as doing the work by hand (create, edit, adjust, costs).
 */

export const IMPORT_FIELDS = [
  { key: 'sku', label: 'SKU', required: false, synonyms: ['sku', 'stock code', 'item code', 'code'] },
  { key: 'partNumber', label: 'Part number', required: false, synonyms: ['part number', 'part no', 'part #', 'partnumber', 'mpn'] },
  { key: 'name', label: 'Name', required: true, synonyms: ['name', 'description', 'part name', 'item', 'title'] },
  { key: 'description', label: 'Notes / description', required: false, synonyms: ['details', 'long description', 'notes'] },
  { key: 'category', label: 'Category', required: false, synonyms: ['category', 'group', 'type'] },
  { key: 'brand', label: 'Brand', required: false, synonyms: ['brand', 'make', 'manufacturer'] },
  { key: 'supplier', label: 'Supplier', required: false, synonyms: ['supplier', 'vendor'] },
  { key: 'cost', label: 'Cost price', required: false, synonyms: ['cost', 'cost price', 'buy price', 'purchase price'] },
  { key: 'sellPrice', label: 'Selling price', required: false, synonyms: ['price', 'selling price', 'sell price', 'retail', 'retail price'] },
  { key: 'vat', label: 'VAT treatment', required: false, synonyms: ['vat', 'tax', 'vat treatment', 'tax treatment'] },
  { key: 'minStock', label: 'Minimum stock', required: false, synonyms: ['min', 'min stock', 'minimum stock', 'minimum'] },
  { key: 'reorderLevel', label: 'Reorder level', required: false, synonyms: ['reorder level', 'reorder point'] },
  { key: 'reorderQuantity', label: 'Reorder quantity', required: false, synonyms: ['reorder quantity', 'reorder qty', 'order qty'] },
  { key: 'barcode', label: 'Barcode', required: false, synonyms: ['barcode', 'ean', 'upc', 'gtin'] },
  { key: 'unit', label: 'Unit', required: false, synonyms: ['unit', 'uom'] },
  { key: 'location', label: 'Location', required: false, synonyms: ['location', 'branch', 'warehouse'] },
  { key: 'bin', label: 'Bin', required: false, synonyms: ['bin', 'shelf', 'bin location'] },
  { key: 'quantity', label: 'Opening quantity', required: false, synonyms: ['quantity', 'qty', 'on hand', 'stock', 'opening stock'] },
] as const;
type FieldKey = (typeof IMPORT_FIELDS)[number]['key'];

export const importSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  /** The file, base64 encoded. */
  content: z.string().min(1).max(Math.ceil((MAX_IMPORT_BYTES * 4) / 3) + 16),
  mapping: z.record(z.string(), z.string().max(200)).default({}),
  onDuplicate: z.enum(['error', 'update']).default('error'),
  mode: z.enum(['preview', 'commit']).default('preview'),
  skipInvalid: z.boolean().default(false),
  /** Needed on commit when the file changes the price or cost of parts that already exist. */
  confirmPriceChanges: z.boolean().default(false),
});

const norm = (s: string) => s.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');

function suggestMapping(headers: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of IMPORT_FIELDS) {
    const hit = headers.find((h) => [f.label, f.key, ...f.synonyms].map(norm).includes(norm(h)));
    if (hit) out[f.key] = hit;
  }
  return out;
}

function parseMoney(raw: string): number | null {
  let s = raw.replace(/[R\s ]/gi, '');
  if (s === '') return null;
  if (s.includes(',') && !s.includes('.')) s = s.replace(',', '.');
  else s = s.replace(/,/g, '');
  try {
    return parseDecimalToCents(s);
  } catch (e) {
    if (e instanceof MoneyError) throw new Error(`"${raw}" is not an amount`);
    throw e;
  }
}
function parseInt0(raw: string, label: string): number | null {
  const s = raw.replace(/\s/g, '');
  if (s === '') return null;
  if (!/^\d+$/.test(s)) throw new Error(`${label} must be a whole number (got "${raw}")`);
  return Number(s);
}
const TAX: Record<string, 'STANDARD' | 'ZERO_RATED' | 'EXEMPT'> = { standard: 'STANDARD', yes: 'STANDARD', vat: 'STANDARD', '15': 'STANDARD', '15%': 'STANDARD', zero: 'ZERO_RATED', 'zero rated': 'ZERO_RATED', '0': 'ZERO_RATED', '0%': 'ZERO_RATED', exempt: 'EXEMPT', no: 'EXEMPT' };

interface ParsedRow {
  row: number;
  sku: string;
  data: Record<FieldKey, string>;
  errors: string[];
}

export interface ImportResult {
  mode: 'preview' | 'commit';
  headers: string[];
  suggestedMapping: Record<string, string>;
  fields: { key: string; label: string; required: boolean }[];
  totals: { rows: number; valid: number; invalid: number; toCreate: number; toUpdate: number; priceChanges: number; newCategories: string[] };
  problems: { row: number; messages: string[] }[];
  sample: { row: number; sku: string; name: string; status: 'create' | 'update' | 'error' }[];
  committed?: { created: number; updated: number; skipped: number; failed: { row: number; message: string }[] };
}

export async function importParts(ctx: BusinessContext, input: unknown): Promise<ImportResult> {
  requirePermission(ctx, 'inventory.import');
  requirePermission(ctx, 'inventory.create');
  requireFeature(ctx.subscription, 'bulk_inventory');
  const d = parseOrThrow(importSchema, input);
  if (d.mode === 'commit') assertCanWrite(ctx.subscription);
  await consume({ key: `inventory-import:${ctx.business.id}`, limit: 30, windowSec: 3600 });

  let table: string[][];
  try {
    table = readTable(Buffer.from(d.content, 'base64'), d.filename);
  } catch (e) {
    if (e instanceof TabularError) throw Errors.validation({ file: e.message });
    throw e;
  }
  if (table.length < 2) throw Errors.validation({ file: 'The file needs a header row and at least one row of data.' });
  if (table.length - 1 > MAX_IMPORT_ROWS) throw Errors.validation({ file: `Too many rows (the limit is ${MAX_IMPORT_ROWS.toLocaleString('en-ZA')}).` });
  const headers = table[0]!.map((h) => h.trim());
  const suggestedMapping = suggestMapping(headers);
  const mapping = Object.keys(d.mapping).length ? d.mapping : suggestedMapping;
  for (const [k, h] of Object.entries(mapping)) {
    if (!IMPORT_FIELDS.some((f) => f.key === k)) throw Errors.validation({ mapping: `Unknown field "${k}".` });
    if (h && !headers.includes(h)) throw Errors.validation({ mapping: `The file has no column called "${h}".` });
  }
  if (!mapping.name) throw Errors.validation({ mapping: 'Choose which column holds the part name.' });
  if (mapping.cost && !canSeeCosts(ctx)) throw Errors.forbidden('You do not have permission to import costs.');
  if (mapping.quantity) requirePermission(ctx, 'inventory.adjust');
  if (d.onDuplicate === 'update') requirePermission(ctx, 'inventory.edit');

  const idx = new Map<FieldKey, number>();
  for (const f of IMPORT_FIELDS) {
    const h = mapping[f.key];
    if (h) idx.set(f.key, headers.indexOf(h));
  }
  const cell = (r: string[], k: FieldKey) => (idx.has(k) ? (r[idx.get(k)!] ?? '').trim() : '');

  const prepared = await withTenant(ctx.business.id, async (tx) => {
    const settings = await loadInventorySettings(tx, ctx.business.id);
    const existing = await tx.part.findMany({ where: { businessId: ctx.business.id }, select: { id: true, sku: true, partNumber: true, barcode: true, name: true, costCents: true, sellPriceCents: true, status: true, categoryId: true } });
    const bySku = new Map(existing.map((p) => [p.sku.toLowerCase(), p]));
    const pnSet = new Map(existing.filter((p) => p.partNumber).map((p) => [p.partNumber!.toLowerCase(), p.sku]));
    const bcSet = new Map(existing.filter((p) => p.barcode).map((p) => [p.barcode!.toLowerCase(), p.sku]));
    const categories = new Map((await tx.partCategory.findMany({ where: { businessId: ctx.business.id, status: 'ACTIVE', parentId: null } })).map((c) => [c.name.toLowerCase(), c.id]));
    const suppliers = new Map((await tx.supplier.findMany({ where: { businessId: ctx.business.id, status: 'ACTIVE' }, select: { id: true, name: true } })).map((s) => [s.name.toLowerCase(), s.id]));
    const locs = new Map((await accessibleLocations(tx, ctx)).map((l) => [l.name.toLowerCase(), l.id]));

    const seenSku = new Set<string>();
    const seenPn = new Set<string>();
    const seenBc = new Set<string>();
    const parsed: (ParsedRow & { values?: z.output<typeof partCreateSchema>; supplierId?: string | null; locationId?: string | null; categoryName?: string | null; action?: 'create' | 'update'; existingId?: string; priceChange?: boolean })[] = [];
    const newCategories = new Set<string>();

    for (let i = 1; i < table.length; i++) {
      const r = table[i]!;
      const errors: string[] = [];
      const data = Object.fromEntries(IMPORT_FIELDS.map((f) => [f.key, cell(r, f.key)])) as Record<FieldKey, string>;
      const attempt = <T>(fn: () => T, fallback: T): T => {
        try {
          return fn();
        } catch (e) {
          errors.push(e instanceof Error ? e.message : 'Invalid value');
          return fallback;
        }
      };
      const cost = attempt(() => parseMoney(data.cost), null);
      const sell = attempt(() => parseMoney(data.sellPrice), null);
      const minStock = attempt(() => parseInt0(data.minStock, 'Minimum stock'), null);
      const reorderLevel = attempt(() => parseInt0(data.reorderLevel, 'Reorder level'), null);
      const reorderQuantity = attempt(() => parseInt0(data.reorderQuantity, 'Reorder quantity'), null);
      const quantity = attempt(() => parseInt0(data.quantity, 'Opening quantity'), null);
      const tax = data.vat ? TAX[norm(data.vat)] : 'STANDARD';
      if (data.vat && !tax) errors.push(`VAT treatment "${data.vat}" is not recognised (use Standard, Zero rated or Exempt)`);
      let supplierId: string | null = null;
      if (data.supplier) {
        supplierId = suppliers.get(data.supplier.toLowerCase()) ?? null;
        if (!supplierId) errors.push(`Supplier "${data.supplier}" is not one of your active suppliers`);
      }
      let locationId: string | null = null;
      if (data.location) {
        locationId = locs.get(data.location.toLowerCase()) ?? null;
        if (!locationId) errors.push(`Location "${data.location}" is not one you can use`);
      }
      const sku = data.sku;
      const lower = sku.toLowerCase();
      const ex = lower ? bySku.get(lower) : undefined;
      let action: 'create' | 'update' = 'create';
      if (ex) {
        if (d.onDuplicate === 'error') errors.push(`SKU "${sku}" already exists`);
        else action = 'update';
      }
      if (lower) {
        if (seenSku.has(lower)) errors.push(`SKU "${sku}" appears more than once in the file`);
        seenSku.add(lower);
      }
      const pn = data.partNumber.toLowerCase();
      if (pn && settings.uniquePartNumber) {
        const owner = pnSet.get(pn);
        if ((owner && owner.toLowerCase() !== lower) || seenPn.has(pn)) errors.push(`Part number "${data.partNumber}" is already used`);
        seenPn.add(pn);
      }
      const bc = data.barcode.toLowerCase();
      if (bc && settings.uniqueBarcode) {
        const owner = bcSet.get(bc);
        if ((owner && owner.toLowerCase() !== lower) || seenBc.has(bc)) errors.push(`Barcode "${data.barcode}" is already used`);
        seenBc.add(bc);
      }
      if (!data.name) errors.push('The name is empty');
      if (data.category && !categories.has(data.category.toLowerCase())) newCategories.add(data.category);

      const candidate = {
        sku, partNumber: data.partNumber || null, name: data.name, description: data.description || null, brand: data.brand || null, barcode: data.barcode || null, unit: data.unit || 'each',
        costCents: cost, sellPriceCents: sell, taxTreatment: tax ?? 'STANDARD', minStock: minStock ?? 0, reorderLevel, reorderQuantity, primarySupplierId: supplierId, openingQuantity: quantity, openingLocationId: locationId, bin: data.bin || null,
      };
      const check = partCreateSchema.safeParse(candidate);
      if (!check.success) for (const issue of check.error.issues) errors.push(`${issue.path.join('.') || 'row'}: ${issue.message}`);
      const priceChange = action === 'update' && ex ? ((idx.has('cost') && cost !== ex.costCents) || (idx.has('sellPrice') && sell !== ex.sellPriceCents)) : false;
      parsed.push({ row: i + 1, sku, data, errors, values: check.success ? check.data : undefined, supplierId, locationId, categoryName: data.category || null, action, existingId: ex?.id, priceChange });
    }

    const bad = parsed.filter((p) => p.errors.length > 0);
    const good = parsed.filter((p) => p.errors.length === 0);
    const priceChanges = good.filter((p) => p.priceChange).length;
    const result: ImportResult = {
      mode: d.mode, headers, suggestedMapping, fields: IMPORT_FIELDS.map((f) => ({ key: f.key, label: f.label, required: f.required })),
      totals: { rows: parsed.length, valid: good.length, invalid: bad.length, toCreate: good.filter((p) => p.action === 'create').length, toUpdate: good.filter((p) => p.action === 'update').length, priceChanges, newCategories: [...newCategories] },
      problems: bad.slice(0, 200).map((p) => ({ row: p.row, messages: p.errors })),
      sample: parsed.slice(0, 12).map((p) => ({ row: p.row, sku: p.sku || '(new SKU)', name: p.data.name, status: p.errors.length ? 'error' : (p.action ?? 'create') })),
    };
    if (d.mode === 'preview') return { result, good: [] as GoodRow[] };

    if (bad.length > 0 && !d.skipInvalid) throw Errors.conflict(`${bad.length} row${bad.length === 1 ? ' has' : 's have'} problems. Fix the file, or choose to skip the rows with problems.`, { problems: result.problems });
    if (priceChanges > 0 && !d.confirmPriceChanges) throw Errors.conflict(`${priceChanges} existing part${priceChanges === 1 ? '' : 's'} would get a new price or cost. Confirm the price changes to continue.`, { code: 'CONFIRM_PRICE_CHANGES', priceChanges });
    if (good.length === 0) throw Errors.validation({ file: 'There is nothing valid to import.' });
    return { result, good: good as GoodRow[] };
  });
  if (d.mode === 'preview') return prepared.result;

  // Large files are processed in batches, each one atomic, so one batch cannot hold the database for long. The result says exactly what happened.
  const total = { created: 0, updated: 0, skipped: 0, failed: [] as { row: number; message: string }[] };
  for (let i = 0; i < prepared.good.length; i += 100) {
    const batch = prepared.good.slice(i, i + 100);
    try {
      const r = await withTenant(ctx.business.id, async (tx) => {
        const cats = new Map((await tx.partCategory.findMany({ where: { businessId: ctx.business.id, status: 'ACTIVE', parentId: null } })).map((c) => [c.name.toLowerCase(), c.id]));
        return commit(ctx, tx, batch, cats, d.onDuplicate);
      });
      total.created += r.created; total.updated += r.updated; total.skipped += r.skipped;
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not import these rows';
      for (const row of batch) total.failed.push({ row: row.row, message });
    }
  }
  return { ...prepared.result, committed: total };
}

type GoodRow = {
  row: number; sku: string; data: Record<FieldKey, string>; values?: z.output<typeof partCreateSchema>; supplierId?: string | null; locationId?: string | null; categoryName?: string | null; action?: 'create' | 'update'; existingId?: string;
};

async function commit(ctx: BusinessContext, tx: Tx, rows: GoodRow[], categories: Map<string, string>, onDuplicate: 'error' | 'update') {
  const out = { created: 0, updated: 0, skipped: 0, failed: [] as { row: number; message: string }[] };
  const settings = await loadInventorySettings(tx, ctx.business.id);
  await lockPartIdentifiers(tx, ctx.business.id);
  for (const r of rows) {
    if (!r.values) { out.skipped++; continue; }
    let categoryId: string | null = null;
    if (r.categoryName) {
      categoryId = categories.get(r.categoryName.toLowerCase()) ?? null;
      if (!categoryId) {
        const c = await tx.partCategory.create({ data: { businessId: ctx.business.id, name: r.categoryName, createdById: ctx.user.id } });
        categories.set(r.categoryName.toLowerCase(), c.id);
        categoryId = c.id;
      }
    }
    if (r.action === 'update' && r.existingId && onDuplicate === 'update') {
      const before = await tx.part.findFirstOrThrow({ where: { id: r.existingId, businessId: ctx.business.id } });
      const v = r.values;
      const patch: Record<string, unknown> = { updatedById: ctx.user.id };
      const set = (k: string, val: unknown, present: boolean) => { if (present) patch[k] = val; };
      set('name', v.name, !!r.data.name);
      set('description', v.description ?? null, !!r.data.description);
      set('partNumber', v.partNumber ?? null, !!r.data.partNumber);
      set('brand', v.brand ?? null, !!r.data.brand);
      set('barcode', v.barcode ?? null, !!r.data.barcode);
      set('unit', v.unit, !!r.data.unit);
      set('costCents', v.costCents ?? null, r.data.cost !== '');
      set('sellPriceCents', v.sellPriceCents ?? null, r.data.sellPrice !== '');
      set('taxTreatment', v.taxTreatment, r.data.vat !== '');
      set('minStock', v.minStock, r.data.minStock !== '');
      set('reorderLevel', v.reorderLevel ?? null, r.data.reorderLevel !== '');
      set('reorderQuantity', v.reorderQuantity ?? null, r.data.reorderQuantity !== '');
      set('categoryId', categoryId, !!r.categoryName);
      set('primarySupplierId', r.supplierId ?? null, !!r.supplierId);
      const after = await tx.part.update({ where: { id: before.id }, data: patch });
      await recordPriceChange(tx, ctx.business.id, ctx.user.id, before.id, { previousCost: before.costCents, newCost: after.costCents, previousSell: before.sellPriceCents, newSell: after.sellPriceCents, source: 'IMPORT', reason: 'File import' });
      if (r.supplierId) await tx.partSupplier.upsert({ where: { partId_supplierId: { partId: before.id, supplierId: r.supplierId } }, create: { businessId: ctx.business.id, partId: before.id, supplierId: r.supplierId, preferred: true }, update: { status: 'ACTIVE' } });
      if (r.data.bin && r.locationId !== undefined) {
        await tx.$executeRaw`INSERT INTO stock_levels (business_id, part_id, location_id, bin, updated_at) VALUES (${ctx.business.id}::uuid, ${before.id}::uuid, ${r.locationId ?? (await defaultLocation(tx, ctx))}::uuid, ${r.data.bin}, now()) ON CONFLICT (part_id, location_id) DO UPDATE SET bin = EXCLUDED.bin`;
      }
      if (r.values.openingQuantity && r.values.openingQuantity > 0) {
        const loc = r.locationId ?? (await defaultLocation(tx, ctx));
        await applyMovement(tx, actorOf(ctx), { partId: before.id, locationId: loc, type: 'ADJUSTED', onHandDelta: r.values.openingQuantity, referenceType: 'adjustment', reasonCode: 'DATA_CORRECTION', reason: 'Quantity added by file import' }, { settings });
      }
      out.updated++;
    } else {
      const v = { ...r.values, categoryId, primarySupplierId: r.supplierId ?? null, openingLocationId: r.locationId ?? null };
      await createPartTx(tx, ctx, v, 'IMPORT');
      out.created++;
    }
  }
  await recordAudit(tx, ctx.meta, { action: AuditActions.partsImported, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'parts', resourceId: ctx.business.id, metadata: { created: out.created, updated: out.updated, skipped: out.skipped, rows: rows.length } });
  return out;
}

async function defaultLocation(tx: Tx, ctx: BusinessContext): Promise<string> {
  const l = (await accessibleLocations(tx, ctx))[0];
  if (!l) throw Errors.validation({ location: 'You do not have access to any location.' });
  return l.id;
}

// ───────── Bulk changes to parts already in the catalogue ─────────

export const bulkSchema = z.object({
  ids: z.array(uuidSchema).min(1, 'Choose at least one part').max(500),
  action: z.enum(['category', 'min_stock', 'status', 'bin', 'sell_price', 'cost']),
  categoryId: z.union([z.literal(''), z.null(), uuidSchema]).optional().transform((v) => (v ? v : null)),
  minStock: z.coerce.number().int().min(0).max(10_000_000).optional(),
  reorderLevel: z.union([z.literal(''), z.null(), z.coerce.number().int().min(0).max(10_000_000)]).optional().transform((v) => (v === '' ? null : v)),
  reorderQuantity: z.union([z.literal(''), z.null(), z.coerce.number().int().min(0).max(10_000_000)]).optional().transform((v) => (v === '' ? null : v)),
  status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']).optional(),
  locationId: z.union([z.literal(''), z.null(), uuidSchema]).optional().transform((v) => (v ? v : undefined)),
  bin: z.string().trim().max(40).optional(),
  storageArea: z.string().trim().max(60).optional(),
  /** Prices: percent in hundredths (1000 = 10.00%), a change in cents, or a new value in cents. */
  priceMode: z.enum(['percent', 'delta', 'set']).optional(),
  priceValue: z.coerce.number().int().min(-1_000_000_000).max(1_000_000_000).optional(),
  reason: z.string().trim().max(200).optional(),
  preview: z.boolean().default(true),
  /** Required to apply a price or cost change. */
  confirm: z.boolean().default(false),
});

export async function bulkUpdateParts(ctx: BusinessContext, input: unknown) {
  requirePermission(ctx, 'inventory.edit');
  requireFeature(ctx.subscription, 'bulk_inventory');
  assertCanWrite(ctx.subscription);
  const d = parseOrThrow(bulkSchema, input);
  if (d.action === 'cost') requirePermission(ctx, 'inventory.view_costs');
  const risky = d.action === 'sell_price' || d.action === 'cost';
  if (!d.preview && risky && !d.confirm) throw Errors.validation({ confirm: 'Confirm the price change to apply it.' });
  if (risky && (d.priceMode === undefined || d.priceValue === undefined)) throw Errors.validation({ priceValue: 'Say how the price should change.' });
  if (d.action === 'category' && d.categoryId === undefined) throw Errors.validation({ categoryId: 'Choose a category.' });
  if (d.action === 'min_stock' && d.minStock === undefined) throw Errors.validation({ minStock: 'Enter the minimum stock.' });
  if (d.action === 'status' && !d.status) throw Errors.validation({ status: 'Choose a status.' });
  if (d.action === 'bin' && d.bin === undefined && d.storageArea === undefined) throw Errors.validation({ bin: 'Enter a bin or storage area.' });
  await consume({ key: `inventory-bulk:${ctx.business.id}`, limit: 60, windowSec: 3600 });

  return withTenant(ctx.business.id, async (tx) => {
    const ids = [...new Set(d.ids)];
    const parts = await tx.part.findMany({ where: { businessId: ctx.business.id, id: { in: ids } } });
    if (parts.length !== ids.length) throw Errors.validation({ ids: 'One or more parts are not in your catalogue.' });
    if (d.action === 'category' && d.categoryId && !(await tx.partCategory.findFirst({ where: { id: d.categoryId, businessId: ctx.business.id, status: 'ACTIVE' }, select: { id: true } }))) throw Errors.validation({ categoryId: 'Choose a category of this business.' });
    let locationId: string | null = null;
    if (d.action === 'bin') {
      const mine = await accessibleLocations(tx, ctx);
      locationId = d.locationId ?? mine.find((l) => l.isDefault)?.id ?? mine[0]?.id ?? null;
      if (!locationId || !mine.some((l) => l.id === locationId)) throw Errors.validation({ locationId: 'Choose a location you have access to.' });
    }
    const newPrice = (current: number | null): number => {
      const c = current ?? 0;
      const v = d.priceValue!;
      const n = d.priceMode === 'percent' ? Math.round((c * (10_000 + v)) / 10_000) : d.priceMode === 'delta' ? c + v : v;
      if (n < 0 || n > 1_000_000_000) throw Errors.validation({ priceValue: 'That would give a price outside the allowed range.' });
      return n;
    };
    const changes = parts.map((p) => {
      if (d.action === 'category') return { p, before: { categoryId: p.categoryId }, after: { categoryId: d.categoryId }, patch: { categoryId: d.categoryId } };
      if (d.action === 'min_stock') return { p, before: { minStock: p.minStock, reorderLevel: p.reorderLevel, reorderQuantity: p.reorderQuantity }, after: { minStock: d.minStock, reorderLevel: d.reorderLevel ?? p.reorderLevel, reorderQuantity: d.reorderQuantity ?? p.reorderQuantity }, patch: { minStock: d.minStock, ...(d.reorderLevel !== undefined ? { reorderLevel: d.reorderLevel } : {}), ...(d.reorderQuantity !== undefined ? { reorderQuantity: d.reorderQuantity } : {}) } };
      if (d.action === 'status') return { p, before: { status: p.status }, after: { status: d.status }, patch: { status: d.status, archivedAt: d.status === 'ARCHIVED' ? new Date() : null } };
      if (d.action === 'bin') return { p, before: {}, after: { bin: d.bin, storageArea: d.storageArea }, patch: {} };
      if (d.action === 'sell_price') return { p, before: { sellPriceCents: p.sellPriceCents }, after: { sellPriceCents: newPrice(p.sellPriceCents) }, patch: { sellPriceCents: newPrice(p.sellPriceCents) } };
      return { p, before: { costCents: p.costCents }, after: { costCents: newPrice(p.costCents) }, patch: { costCents: newPrice(p.costCents) } };
    });
    const summary = { action: d.action, count: changes.length, items: changes.slice(0, 50).map((c) => ({ id: c.p.id, sku: c.p.sku, name: c.p.name, before: c.before, after: c.after })), requiresConfirmation: risky };
    if (d.preview) return { applied: false as const, ...summary };

    if (d.action === 'status' && d.status === 'ARCHIVED') {
      const stock = await tx.stockLevel.groupBy({ by: ['partId'], where: { businessId: ctx.business.id, partId: { in: ids } }, _sum: { onHand: true, reserved: true } });
      const blocked = stock.filter((s) => (s._sum.onHand ?? 0) !== 0 || (s._sum.reserved ?? 0) !== 0).length;
      if (blocked > 0) throw Errors.conflict(`${blocked} of these parts still have stock. Adjust or transfer it first, or mark them inactive instead.`);
    }
    for (const c of changes) {
      if (d.action === 'bin') {
        await tx.$executeRaw`INSERT INTO stock_levels (business_id, part_id, location_id, bin, storage_area, updated_at) VALUES (${ctx.business.id}::uuid, ${c.p.id}::uuid, ${locationId}::uuid, ${trimOrNull(d.bin)}, ${trimOrNull(d.storageArea)}, now()) ON CONFLICT (part_id, location_id) DO UPDATE SET bin = COALESCE(EXCLUDED.bin, stock_levels.bin), storage_area = COALESCE(EXCLUDED.storage_area, stock_levels.storage_area)`;
        continue;
      }
      const after = await tx.part.update({ where: { id: c.p.id }, data: { ...c.patch, updatedById: ctx.user.id } });
      if (risky) await recordPriceChange(tx, ctx.business.id, ctx.user.id, c.p.id, { previousCost: c.p.costCents, newCost: after.costCents, previousSell: c.p.sellPriceCents, newSell: after.sellPriceCents, source: 'BULK', reason: d.reason ?? null });
    }
    await recordAudit(tx, ctx.meta, { action: AuditActions.partsBulkUpdated, businessId: ctx.business.id, userId: ctx.user.id, resourceType: 'parts', resourceId: ctx.business.id, metadata: { action: d.action, count: changes.length, priceMode: d.priceMode ?? null, priceValue: d.priceValue ?? null, reason: d.reason ?? null, ids } });
    return { applied: true as const, ...summary };
  });
}

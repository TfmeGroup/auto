import { afterAll, describe, expect, it } from 'vitest';
import { disconnectPrisma } from '@/server/db/client';
import { AppError } from '@/lib/errors';
import { createCategory, listCategories, setCategoryArchived, updateCategory } from '@/server/inventory/categories';
import { addCompatibility, createPart, getPart, linkSupplier, listParts, removeCompatibility, unlinkSupplier, updatePart } from '@/server/inventory/parts';
import { createSupplier, getSupplier, listSuppliers, setSupplierStatus, updateSupplier } from '@/server/inventory/suppliers';
import { partFitsVehicle, ruleMatchesVehicle } from '@/server/inventory/calc';
import { bulkUpdateParts, importParts } from '@/server/inventory/import';
import { exportInventory } from '@/server/inventory/exports';
import { runInventoryTasks } from '@/server/inventory/alerts';
import { adjustStock } from '@/server/inventory/stock';
import { createPurchaseOrder, placePurchaseOrder } from '@/server/inventory/purchasing';
import { createCustomer } from '@/server/customers/service';
import { createVehicle } from '@/server/vehicles/service';
import { toXlsx } from '@/lib/tabular';
import { upgradePlan, ownerQuery } from '../helpers/factory';
import { customerInput } from '../helpers/customers';
import { memberWithPermissions } from '../helpers/workshop';
import { invWorkspace, mkPart, mkSupplier } from '../helpers/inventory';

afterAll(disconnectPrisma);

const rejects = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(AppError);
  return e as AppError;
};

describe('categories', () => {
  it('are the business\'s own: created, renamed, nested one level, archived, never deleted', async () => {
    const w = await invWorkspace('Categories');
    const brakes = await createCategory(w.ctx, { name: 'Brakes' });
    const pads = await createCategory(w.ctx, { name: 'Pads', parentId: brakes.id });
    await rejects(createCategory(w.ctx, { name: 'brakes' })); // same name at the same level
    await rejects(createCategory(w.ctx, { name: 'Deep', parentId: pads.id })); // one level only
    await createCategory(w.ctx, { name: 'Pads' }); // same name under a different parent is fine
    await updateCategory(w.ctx, brakes.id, { name: 'Braking' });
    const p = await createPart(w.ctx, { name: 'Pad set', categoryId: pads.id });
    expect((await listCategories(w.ctx)).find((c) => c.id === pads.id)).toMatchObject({ partCount: 1, parentId: brakes.id });
    // the parent cannot be archived while a sub-category is live; the part keeps pointing at an archived category
    await rejects(setCategoryArchived(w.ctx, brakes.id, true));
    await setCategoryArchived(w.ctx, pads.id, true);
    await setCategoryArchived(w.ctx, brakes.id, true);
    expect((await getPart(w.ctx, p.id)).part.categoryName).toBe('Pads');
    await rejects(createPart(w.ctx, { name: 'Another', categoryId: pads.id })); // archived categories cannot be chosen
    await expect(ownerQuery('DELETE FROM part_categories WHERE id = $1', [pads.id])).rejects.toThrow(/cannot be deleted/);
    const byCategory = await listParts(w.ctx, { categoryId: pads.id });
    expect(byCategory.items.map((i) => i.id)).toEqual([p.id]);
  });

  it('only reach a business\'s own parts', async () => {
    const w = await invWorkspace('Cat A');
    const other = await invWorkspace('Cat B');
    const foreign = await createCategory(other.ctx, { name: 'Foreign' });
    await rejects(createPart(w.ctx, { name: 'Part', categoryId: foreign.id }));
    await rejects(updateCategory(w.ctx, foreign.id, { name: 'Hijack' }));
  });
});

describe('vehicle compatibility', () => {
  it('matches deterministically: a blank attribute does not restrict, a named one must agree, and nothing is guessed', () => {
    const hilux = { make: 'Toyota', model: 'Hilux', year: 2019, engineSizeCc: 2800, fuelType: 'DIESEL', transmission: 'MANUAL' };
    expect(ruleMatchesVehicle({ make: 'toyota' }, hilux)).toBe(true);
    expect(ruleMatchesVehicle({ make: 'Toyota', model: 'Corolla' }, hilux)).toBe(false);
    expect(ruleMatchesVehicle({ yearFrom: 2016, yearTo: 2020 }, hilux)).toBe(true);
    expect(ruleMatchesVehicle({ yearFrom: 2020 }, hilux)).toBe(false);
    expect(ruleMatchesVehicle({ yearTo: 2018 }, hilux)).toBe(false);
    expect(ruleMatchesVehicle({ make: 'Toyota', yearFrom: 2016 }, { make: 'Toyota' })).toBe(false); // vehicle has no year: not a match
    expect(ruleMatchesVehicle({ engineSizeCc: 2800, fuelType: 'DIESEL' }, hilux)).toBe(true);
    expect(ruleMatchesVehicle({ fuelType: 'PETROL' }, hilux)).toBe(false);
    expect(partFitsVehicle([{ make: 'Ford' }, { make: 'Toyota', model: 'Hilux' }], hilux)).toBe(true);
    expect(partFitsVehicle([], hilux)).toBe(false);
  });

  it('finds parts for a vehicle by the same rules in the database, and validates the entries', async () => {
    const w = await invWorkspace('Compat');
    const customer = await createCustomer(w.ctx, customerInput('Compat Customer'));
    const hilux = await createVehicle(w.ctx, { customerId: customer.id, registration: 'CA 111 111', make: 'Toyota', model: 'Hilux', year: 2019, fuelType: 'DIESEL', engineSizeCc: 2800 });
    const polo = await createVehicle(w.ctx, { customerId: customer.id, registration: 'CA 222 222', make: 'Volkswagen', model: 'Polo', year: 2015 });
    const fits = await createPart(w.ctx, { sku: 'F-1', name: 'Hilux oil filter' });
    const other = await createPart(w.ctx, { sku: 'F-2', name: 'Polo oil filter' });
    const none = await createPart(w.ctx, { sku: 'F-3', name: 'Universal wiper' });
    await addCompatibility(w.ctx, fits.id, { make: 'Toyota', model: 'Hilux', yearFrom: 2016, yearTo: 2021 });
    await addCompatibility(w.ctx, other.id, { make: 'Volkswagen', model: 'Polo', yearTo: 2012 });
    expect((await listParts(w.ctx, { compatibleWith: hilux.id })).items.map((i) => i.id)).toEqual([fits.id]);
    expect((await listParts(w.ctx, { compatibleWith: polo.id })).items.map((i) => i.id)).toEqual([]); // the Polo is newer than the rule
    expect((await listParts(w.ctx, { make: 'toyota', model: 'hilux', year: 2018 })).items.map((i) => i.id)).toEqual([fits.id]);
    expect((await listParts(w.ctx, { q: 'hilux' })).items.map((i) => i.id).sort()).toEqual([fits.id].sort()); // makes and models are searchable
    await rejects(addCompatibility(w.ctx, none.id, {}));
    await rejects(addCompatibility(w.ctx, none.id, { make: 'Toyota', yearFrom: 2020, yearTo: 2010 }));
    const rule = (await getPart(w.ctx, fits.id)).compatibility[0]!;
    await removeCompatibility(w.ctx, fits.id, rule.id);
    expect((await listParts(w.ctx, { compatibleWith: hilux.id })).items).toHaveLength(0);
    // another business's vehicle is not something we can match against
    const other2 = await invWorkspace('Compat Other');
    await rejects(listParts(other2.ctx, { compatibleWith: hilux.id }));
  });
});

describe('suppliers', () => {
  it('are searchable by name, phone digits, email, account number and VAT, and archived rather than deleted', async () => {
    const w = await invWorkspace('Suppliers');
    const a = await createSupplier(w.ctx, { name: 'Brake Barn', phone: '082 123 4567', email: 'Orders@BrakeBarn.test', accountNumber: 'ACC-778', vatNumber: '4120000001', contactPerson: 'Thandi' });
    await createSupplier(w.ctx, { name: 'Oil Depot', phone: '011 555 0000' });
    const find = async (q: string) => (await listSuppliers(w.ctx, { q })).items.map((s) => s.id);
    for (const q of ['brake', '0821234567', '082 123', 'orders@brakebarn.test', 'acc-778', '4120000001']) expect(await find(q)).toEqual([a.id]);
    expect(await find('%')).toEqual([]);
    expect((await getSupplier(w.ctx, a.id)).supplier).toMatchObject({ email: 'orders@brakebarn.test', status: 'ACTIVE' });
    await updateSupplier(w.ctx, a.id, { paymentTerms: '30 days', notes: null });
    await setSupplierStatus(w.ctx, a.id, 'INACTIVE');
    expect((await listSuppliers(w.ctx, { q: 'brake' })).items[0]!.status).toBe('INACTIVE');
    await setSupplierStatus(w.ctx, a.id, 'ARCHIVED');
    expect((await listSuppliers(w.ctx, {})).items.map((s) => s.id)).not.toContain(a.id);
    await expect(ownerQuery('DELETE FROM suppliers WHERE id = $1', [a.id])).rejects.toThrow(/cannot be deleted/);
    await rejects(createPart(w.ctx, { name: 'P', primarySupplierId: a.id })); // archived suppliers cannot be chosen
  });

  it('cannot be archived while orders are open; links keep their own supplier part number and cost', async () => {
    const w = await invWorkspace('Part Suppliers');
    const s = await mkSupplier(w, 'Linked Supplier');
    const p = await createPart(w.ctx, { sku: 'L-1', name: 'Linked part', costCents: 5_000 });
    await linkSupplier(w.ctx, p.id, { supplierId: s.id, supplierPartNumber: 'SUP-PN-9', supplierCostCents: 4_800, leadTimeDays: 3, preferred: true });
    const view = await getPart(w.ctx, p.id);
    expect(view.suppliers[0]).toMatchObject({ supplierPartNumber: 'SUP-PN-9', supplierCostCents: 4_800, leadTimeDays: 3, preferred: true });
    expect((await listParts(w.ctx, { q: 'sup-pn-9' })).items.map((i) => i.id)).toEqual([p.id]);
    expect((await listParts(w.ctx, { supplierId: s.id })).items.map((i) => i.id)).toEqual([p.id]);
    expect((await getSupplier(w.ctx, s.id)).parts.map((x) => x.sku)).toEqual(['L-1']);
    const po = await createPurchaseOrder(w.ctx, { supplierId: s.id, lines: [{ partId: p.id, quantity: 1, unitCostCents: 4_800 }] });
    expect((await ownerQuery('SELECT supplier_part_number FROM purchase_order_lines WHERE purchase_order_id = $1', [po.id])).rows[0]!.supplier_part_number).toBe('SUP-PN-9');
    await placePurchaseOrder(w.ctx, po.id);
    await rejects(setSupplierStatus(w.ctx, s.id, 'ARCHIVED'));
    // changing the supplier's quoted cost never rewrites the order already placed
    await linkSupplier(w.ctx, p.id, { supplierId: s.id, supplierCostCents: 9_999 });
    expect((await ownerQuery('SELECT unit_cost_cents FROM purchase_order_lines WHERE purchase_order_id = $1', [po.id])).rows[0]!.unit_cost_cents).toBe(4_800);
    await unlinkSupplier(w.ctx, p.id, s.id);
    expect((await getPart(w.ctx, p.id)).suppliers[0]).toMatchObject({ status: 'INACTIVE', preferred: false });
    expect((await getPart(w.ctx, p.id)).part.primarySupplierId).toBeNull();
  });

  it('keep supplier costs from people who cannot see costs', async () => {
    const w = await invWorkspace('Supplier Costs');
    const s = await mkSupplier(w);
    const p = await createPart(w.ctx, { name: 'Costed', costCents: 1_000 });
    await linkSupplier(w.ctx, p.id, { supplierId: s.id, supplierCostCents: 900 });
    const viewer = await memberWithPermissions(w, ['inventory.view']);
    expect((await getPart(viewer.ctx, p.id)).suppliers[0]!.supplierCostCents).toBeNull();
    expect((await getSupplier(viewer.ctx, s.id)).parts[0]!.supplierCostCents).toBeNull();
    await rejects(linkSupplier(viewer.ctx, p.id, { supplierId: s.id, supplierCostCents: 1 }));
    await rejects(createSupplier(viewer.ctx, { name: 'Nope' }));
  });
});

describe('import and bulk changes', () => {
  const csv = (rows: string[][]) => Buffer.from(rows.map((r) => r.join(',')).join('\n'), 'utf8').toString('base64');
  const HEAD = ['SKU', 'Part number', 'Name', 'Category', 'Brand', 'Cost', 'Selling price', 'VAT', 'Min stock', 'Barcode', 'Bin', 'Quantity'];

  it('previews first, refuses bad rows unless told to skip them, and reports what happened', async () => {
    const w = await invWorkspace('Import');
    await createPart(w.ctx, { sku: 'EXIST-1', name: 'Existing part', costCents: 1_000, sellPriceCents: 2_000 });
    const file = csv([
      HEAD,
      ['NEW-1', 'PN-1', 'Air filter', 'Filters', 'Acme', '45.50', '89.99', 'standard', '5', '111', 'A12', '10'],
      ['NEW-2', '', 'Cabin filter', 'Filters', '', '"R 1 234,50"', '1999', 'zero rated', '2', '', '', ''],
      ['NEW-1', '', 'Duplicate in the file', '', '', '', '', '', '', '', '', ''],
      ['EXIST-1', '', 'Clash with the catalogue', '', '', '', '', '', '', '', '', ''],
      ['NEW-3', '', '', '', '', 'abc', '', '', '', '', '', ''],
    ]);
    const preview = await importParts(w.ctx, { filename: 'parts.csv', content: file, mode: 'preview' });
    expect(preview.totals).toMatchObject({ rows: 5, valid: 2, invalid: 3, toCreate: 2, newCategories: ['Filters'] });
    expect(preview.suggestedMapping).toMatchObject({ sku: 'SKU', name: 'Name', cost: 'Cost', sellPrice: 'Selling price', minStock: 'Min stock', quantity: 'Quantity' });
    const msgs = preview.problems.flatMap((p) => p.messages).join(' | ');
    expect(msgs).toMatch(/appears more than once/);
    expect(msgs).toMatch(/already exists/);
    expect(msgs).toMatch(/name is empty/);
    expect(msgs).toMatch(/not an amount/);
    expect((await listParts(w.ctx, { q: 'NEW-' })).items).toHaveLength(0); // a preview imports nothing
    const e = await rejects(importParts(w.ctx, { filename: 'parts.csv', content: file, mode: 'commit' }));
    expect(e.message).toMatch(/3 rows have problems/);
    expect((await listParts(w.ctx, { q: 'NEW-' })).items).toHaveLength(0);
    const done = await importParts(w.ctx, { filename: 'parts.csv', content: file, mode: 'commit', skipInvalid: true });
    expect(done.committed).toMatchObject({ created: 2, updated: 0, failed: [] });
    const one = (await listParts(w.ctx, { q: 'NEW-1' })).items.find((i) => i.sku === 'NEW-1')!;
    expect(one).toMatchObject({ name: 'Air filter', costCents: 4_550, sellPriceCents: 8_999, minStock: 5, categoryName: 'Filters', onHand: 10, barcode: '111' });
    const two = (await listParts(w.ctx, { q: 'NEW-2' })).items[0]!;
    expect(two).toMatchObject({ costCents: 123_450, taxTreatment: 'ZERO_RATED' });
    expect((await ownerQuery("SELECT bin FROM stock_levels sl JOIN parts p ON p.id = sl.part_id WHERE p.sku = 'NEW-1'")).rows[0]!.bin).toBe('A12');
    expect((await ownerQuery("SELECT 1 FROM audit_logs WHERE business_id = $1 AND action = 'parts.imported'", [w.businessId])).rowCount).toBe(1);
  });

  it('reads Excel files too, and updating prices of existing parts needs an explicit confirmation', async () => {
    const w = await invWorkspace('Import Xlsx');
    const p = await createPart(w.ctx, { sku: 'UPD-1', name: 'Old name', costCents: 1_000, sellPriceCents: 2_000 });
    const xlsx = toXlsx('Parts', [{ header: 'SKU', kind: 'text' }, { header: 'Name', kind: 'text' }, { header: 'Selling price', kind: 'text' }], [['UPD-1', 'New name', '30.00'], ['XL-1', 'From Excel', '5.00']]);
    const content = xlsx.toString('base64');
    const preview = await importParts(w.ctx, { filename: 'parts.xlsx', content, mode: 'preview', onDuplicate: 'update' });
    expect(preview.totals).toMatchObject({ valid: 2, toCreate: 1, toUpdate: 1, priceChanges: 1 });
    const e = await rejects(importParts(w.ctx, { filename: 'parts.xlsx', content, mode: 'commit', onDuplicate: 'update' }));
    expect((e.details as { code: string }).code).toBe('CONFIRM_PRICE_CHANGES');
    expect((await getPart(w.ctx, p.id)).part).toMatchObject({ name: 'Old name', sellPriceCents: 2_000 });
    const done = await importParts(w.ctx, { filename: 'parts.xlsx', content, mode: 'commit', onDuplicate: 'update', confirmPriceChanges: true });
    expect(done.committed).toMatchObject({ created: 1, updated: 1 });
    expect((await getPart(w.ctx, p.id)).part).toMatchObject({ name: 'New name', sellPriceCents: 3_000, costCents: 1_000 });
    expect((await ownerQuery("SELECT source FROM part_price_history WHERE part_id = $1 ORDER BY changed_at DESC LIMIT 1", [p.id])).rows[0]!.source).toBe('IMPORT');
  });

  it('rejects things that are not spreadsheets, oversized or malformed input, and needs permission and the plan', async () => {
    const w = await invWorkspace('Import Guard');
    await rejects(importParts(w.ctx, { filename: 'x.csv', content: Buffer.from('\u0000\u0001binary').toString('base64'), mode: 'preview' }));
    await rejects(importParts(w.ctx, { filename: 'x.csv', content: csv([['Name']]), mode: 'preview' })); // header only
    await rejects(importParts(w.ctx, { filename: 'x.csv', content: csv([['Colour'], ['red']]), mode: 'preview' })); // no name column
    await rejects(importParts(w.ctx, { filename: 'x.csv', content: csv([HEAD, ['A', '', 'Ok']]), mapping: { name: 'Nope' }, mode: 'preview' }));
    const staff = await memberWithPermissions(w, ['inventory.view', 'inventory.create']);
    await rejects(importParts(staff.ctx, { filename: 'x.csv', content: csv([HEAD, ['A', '', 'Ok']]), mode: 'preview' }));
    const solo = await invWorkspace('Import Solo');
    await upgradePlan(solo, 'solo');
    const e = await rejects(importParts(solo.ctx, { filename: 'x.csv', content: csv([HEAD, ['A', '', 'Ok']]), mode: 'preview' }));
    expect(e.code).toBe('FEATURE_NOT_IN_PLAN');
  });

  it('bulk changes preview first and need confirmation for prices', async () => {
    const w = await invWorkspace('Bulk');
    const a = await mkPart(w, { sellPriceCents: 10_000 });
    const b = await mkPart(w, { sellPriceCents: 20_000 });
    const preview = await bulkUpdateParts(w.ctx, { ids: [a.id, b.id], action: 'sell_price', priceMode: 'percent', priceValue: 1000, preview: true });
    expect(preview).toMatchObject({ applied: false, count: 2 });
    expect(preview.items.map((i) => i.after)).toEqual([{ sellPriceCents: 11_000 }, { sellPriceCents: 22_000 }]);
    expect((await getPart(w.ctx, a.id)).part.sellPriceCents).toBe(10_000);
    await rejects(bulkUpdateParts(w.ctx, { ids: [a.id, b.id], action: 'sell_price', priceMode: 'percent', priceValue: 1000, preview: false }));
    const applied = await bulkUpdateParts(w.ctx, { ids: [a.id, b.id], action: 'sell_price', priceMode: 'percent', priceValue: 1000, preview: false, confirm: true, reason: 'Annual increase' });
    expect(applied.applied).toBe(true);
    expect((await getPart(w.ctx, b.id)).part.sellPriceCents).toBe(22_000);
    const cat = await createCategory(w.ctx, { name: 'Bulk cat' });
    await bulkUpdateParts(w.ctx, { ids: [a.id, b.id], action: 'category', categoryId: cat.id, preview: false });
    await bulkUpdateParts(w.ctx, { ids: [a.id], action: 'min_stock', minStock: 7, preview: false });
    expect((await getPart(w.ctx, a.id)).part).toMatchObject({ categoryId: cat.id, minStock: 7 });
    await rejects(bulkUpdateParts(w.ctx, { ids: [a.id, '00000000-0000-4000-8000-000000000000'], action: 'min_stock', minStock: 1, preview: false }));
    const staff = await memberWithPermissions(w, ['inventory.view']);
    await rejects(bulkUpdateParts(staff.ctx, { ids: [a.id], action: 'min_stock', minStock: 1, preview: false }));
    expect((await ownerQuery("SELECT 1 FROM audit_logs WHERE business_id = $1 AND action = 'parts.bulk_updated'", [w.businessId])).rowCount).toBe(3);
    expect((await ownerQuery("SELECT count(*)::int AS n FROM part_price_history WHERE part_id = $1 AND source = 'BULK'", [a.id])).rows[0]!.n).toBe(1);
  });
});

describe('exports', () => {
  it('exports the stock list, audited, with costs only for people who may see them, and spreadsheet formulas defused', async () => {
    const w = await invWorkspace('Exports');
    const p = await createPart(w.ctx, { sku: 'EXP-1', name: '=HYPERLINK("http://evil.test","click")', costCents: 4_500, sellPriceCents: 9_000, minStock: 1 });
    await adjustStock(w.ctx, { partId: p.id, kind: 'INCREASE', quantity: 3, reasonCode: 'OPENING_BALANCE', reason: 'Seed stock' });
    const r = await exportInventory(w.ctx, { dataset: 'stock_list', format: 'csv' });
    const text = r.data.toString('utf8');
    expect(text).toContain('Cost');
    expect(text).toContain('45.00');
    expect(text).toContain("'=HYPERLINK");
    expect(r.rows).toBe(1);
    const noCosts = await memberWithPermissions(w, ['inventory.view', 'inventory.export']);
    const r2 = (await exportInventory(noCosts.ctx, { dataset: 'stock_list', format: 'csv' })).data.toString('utf8');
    expect(r2).not.toContain('Cost');
    expect(r2).not.toContain('45.00');
    const xlsx = await exportInventory(w.ctx, { dataset: 'movements', format: 'xlsx' });
    expect(xlsx.data.subarray(0, 2).toString()).toBe('PK');
    const viewer = await memberWithPermissions(w, ['inventory.view']);
    await rejects(exportInventory(viewer.ctx, { dataset: 'stock_list' }));
    await rejects(exportInventory(noCosts.ctx, { dataset: 'profitability' }));
    const audit = await ownerQuery("SELECT metadata FROM audit_logs WHERE business_id = $1 AND action = 'inventory.exported' ORDER BY created_at", [w.businessId]);
    expect(audit.rows.map((r) => r.metadata.dataset)).toEqual(['stock_list', 'stock_list', 'movements']);
    expect(audit.rows[0]!.metadata).toMatchObject({ withCosts: true, rows: 1 });
    expect(audit.rows[1]!.metadata).toMatchObject({ withCosts: false });
  });
});

describe('scheduled stock alerts', () => {
  it('announce a part once when it becomes low or out, and again only after it has recovered', async () => {
    const w = await invWorkspace('Alerts');
    const p = await mkPart(w, { minStock: 5, sku: 'ALERT-1' }, 10);
    const notes = async () => (await ownerQuery("SELECT title, body, group_count FROM notifications WHERE business_id = $1 AND type = 'LOW_STOCK' ORDER BY created_at", [w.businessId])).rows;
    await runInventoryTasks();
    expect(await notes()).toHaveLength(0);
    await adjustStock(w.ctx, { partId: p.id, kind: 'COUNT', quantity: 4, reasonCode: 'STOCK_COUNT', reason: 'Counted' });
    const first = await runInventoryTasks();
    expect(first.partsAlerted).toBeGreaterThanOrEqual(1);
    const n1 = await notes();
    expect(n1).toHaveLength(1);
    expect(n1[0]!.body).toContain('ALERT-1 (low)');
    await runInventoryTasks();
    expect((await notes())[0]!.group_count).toBe(1); // not repeated
    await adjustStock(w.ctx, { partId: p.id, kind: 'COUNT', quantity: 0, reasonCode: 'STOCK_COUNT', reason: 'Sold out' });
    await runInventoryTasks();
    // a low-priority alert that is still unread folds into the same notification instead of piling up
    const n2 = await notes();
    expect(n2).toHaveLength(1);
    expect(n2[0]!.group_count).toBe(2);
    expect(n2[0]!.body).toContain('ALERT-1 (out)');
    await adjustStock(w.ctx, { partId: p.id, kind: 'COUNT', quantity: 20, reasonCode: 'STOCK_COUNT', reason: 'Restocked' });
    await runInventoryTasks();
    await adjustStock(w.ctx, { partId: p.id, kind: 'COUNT', quantity: 1, reasonCode: 'STOCK_COUNT', reason: 'Used a lot' });
    await runInventoryTasks();
    expect((await notes())[0]!.group_count).toBe(3);
  });

  it('flag a late purchase order once for its expected date', async () => {
    const w = await invWorkspace('Late Orders');
    const s = await mkSupplier(w);
    const p = await mkPart(w);
    const po = await createPurchaseOrder(w.ctx, { supplierId: s.id, poDate: '2020-01-01', expectedDate: '2020-01-10', lines: [{ partId: p.id, quantity: 1, unitCostCents: 100 }] });
    await runInventoryTasks();
    expect((await ownerQuery("SELECT 1 FROM notifications WHERE business_id = $1 AND type = 'PO_LATE'", [w.businessId])).rowCount).toBe(0); // a draft is not "late"
    await placePurchaseOrder(w.ctx, po.id);
    const a = await runInventoryTasks();
    expect(a.lateOrders).toBeGreaterThanOrEqual(1);
    await runInventoryTasks();
    expect((await ownerQuery("SELECT 1 FROM notifications WHERE business_id = $1 AND type = 'PO_LATE'", [w.businessId])).rowCount).toBe(1);
  });
});

void updatePart;

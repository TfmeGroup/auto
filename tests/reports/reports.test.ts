import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma } from '@/server/db/client';
import { AppError } from '@/lib/errors';
import { todayIso } from '@/lib/tz';
import { createInvoice, finaliseInvoice } from '@/server/finance/invoices';
import { createCreditNote, issueCreditNote } from '@/server/finance/creditnotes';
import { availableReports, runReport } from '@/server/reports/run';
import { REPORTS } from '@/server/reports/registry';
import { presetDays, resolveRange } from '@/server/reports/range';
import { createMemberCtx, ownerQuery, upgradePlan, createWorkspace, type TestWorkspace } from '../helpers/factory';
import { L, financeWorkspace, pay, party } from '../helpers/finance';
import { addJobPart } from '@/server/jobcards/items';
import { mkPart, openJob } from '../helpers/inventory';
import { memberWithPermissions } from '../helpers/workshop';

afterAll(disconnectPrisma);

const err = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { if (e instanceof AppError) return e; throw e; }
  throw new Error('expected an AppError');
};
const val = (r: { summary: { key: string; value: unknown }[] }, key: string) => r.summary.find((m) => m.key === key)?.value;

let ws: TestWorkspace;
const q = { preset: 'THIS_YEAR' };

/**
 * One known job: invoice R10,000 ex VAT (parts R6,000 costing R3,000; labour 2h at R2,000 costing R1,000/h = R2,000), a R4,000 payment.
 *   Revenue 10,000 | parts cost 3,000 | labour cost 2,000 | gross profit 5,000 | outstanding 6,000
 * Stock: 20 on hand with 5 reserved.
 */
beforeAll(async () => {
  ws = await financeWorkspace('Reports7 Workshop');
  await upgradePlan(ws, 'business');
  const { job, customer, vehicle } = await openJob(ws);
  const draft = await createInvoice(ws.ctx, {
    customerId: customer.id, vehicleId: vehicle.id, jobId: job.id,
    lines: [L('Brake pads', 1, 600_000, { unitCostCents: 300_000 }), L('Labour', 2, 200_000, { lineType: 'LABOUR', unitCostCents: 100_000, minutes: 120 })],
  });
  const inv = await finaliseInvoice(ws.ctx, draft.id);
  await pay(ws, draft.id, 400_000, 'EFT');
  void inv;
  const part = await mkPart(ws, { costCents: 5_000, reorderLevel: 3 }, 20);
  const other = await openJob(ws);
  await addJobPart(ws.ctx, other.job.id, { inventoryItemId: part.id, quantity: 5 }); // reserves 5 through the stock ledger
});

describe('report correctness on known books', () => {
  it('revenue separates invoiced, received and outstanding', async () => {
    const r = await runReport(ws.ctx, 'revenue', q);
    expect(val(r, 'invoiced')).toBe(1_000_000);
    expect(val(r, 'received')).toBe(400_000);
    expect(val(r, 'outstanding')).toBe(600_000);
    expect(val(r, 'netRevenue')).toBe(1_000_000);
    expect(r.notes.join(' ')).toMatch(/not revenue/i);
  });

  it('receivables and the invoice report agree: R6,000 is owed', async () => {
    const r = await runReport(ws.ctx, 'receivables', {});
    expect(val(r, 'total')).toBe(600_000);
    expect(r.rows).toHaveLength(1);
    const inv = await runReport(ws.ctx, 'invoices', q);
    expect(val(inv, 'count')).toBe(1);
    expect(val(inv, 'partial')).toBe(1);
  });

  it('payments report shows the R4,000 by method', async () => {
    const r = await runReport(ws.ctx, 'payments', q);
    expect(val(r, 'received')).toBe(400_000);
    expect(val(r, 'm_EFT')).toBe(400_000);
    expect(val(r, 'm_CASH')).toBe(0);
  });

  it('profitability: revenue 10,000 - parts 3,000 - labour 2,000 = 5,000 (50%)', async () => {
    const r = await runReport(ws.ctx, 'profitability', q);
    expect(val(r, 'revenue')).toBe(1_000_000);
    expect(val(r, 'partsCost')).toBe(300_000);
    expect(val(r, 'labourCost')).toBe(200_000);
    expect(val(r, 'profit')).toBe(500_000);
    expect(val(r, 'margin')).toBe(50);
    const byJob = await runReport(ws.ctx, 'profitability', { ...q, groupBy: 'job' });
    expect(byJob.rows).toHaveLength(1);
    expect(byJob.rows[0]).toMatchObject({ revenue: 1_000_000, partsCost: 300_000, labourCost: 200_000, grossProfit: 500_000, margin: 50 });
  });

  it('stock: 20 on hand, 5 reserved, 15 available', async () => {
    const r = await runReport(ws.ctx, 'stock', {});
    expect(val(r, 'onHand')).toBe(20);
    expect(val(r, 'reserved')).toBe(5);
    expect(val(r, 'available')).toBe(15);
    expect(r.rows[0]).toMatchObject({ onHand: 20, reserved: 5, available: 15 });
  });

  it('a credit note reduces net revenue but not what was invoiced', async () => {
    const w = await financeWorkspace('Reports7 Credit', { vat: false });
    await upgradePlan(w, 'business');
    const p = await party(w, 'Cr');
    const d = await createInvoice(w.ctx, { customerId: p.customer.id, vehicleId: p.vehicle.id, lines: [L('Part', 1, 100_000)] });
    await finaliseInvoice(w.ctx, d.id);
    const cn = await createCreditNote(w.ctx, { invoiceId: d.id, reason: 'Returned', lines: [L('Part returned', 1, 25_000)] });
    await issueCreditNote(w.ctx, cn.id);
    const r = await runReport(w.ctx, 'revenue', q);
    expect(val(r, 'invoiced')).toBe(100_000);
    expect(val(r, 'credits')).toBe(25_000);
    expect(val(r, 'netRevenue')).toBe(75_000);
  });
});

describe('every standard report runs against real data without error', () => {
  for (const def of REPORTS) {
    it(`${def.key}`, async () => {
      const r = await runReport(ws.ctx, def.key, { ...q, ...(def.paged ? { page: 1 } : {}) });
      expect(r.key).toBe(def.key);
      expect(Array.isArray(r.rows)).toBe(true);
      expect(r.columns.length).toBeGreaterThan(0);
      for (const g of def.groupBys ?? []) {
        if (g.key === 'location') continue;
        const x = await runReport(ws.ctx, def.key, { ...q, groupBy: g.key });
        expect(x.columns.length).toBeGreaterThan(0);
      }
    });
  }
});

describe('date presets use the business calendar', () => {
  it('computes week, month, quarter and year boundaries', () => {
    const today = '2026-05-20'; // a Wednesday
    expect(presetDays('THIS_WEEK', today)).toEqual({ from: '2026-05-18', to: '2026-05-24' });
    expect(presetDays('LAST_WEEK', today)).toEqual({ from: '2026-05-11', to: '2026-05-17' });
    expect(presetDays('THIS_MONTH', today)).toEqual({ from: '2026-05-01', to: '2026-05-31' });
    expect(presetDays('LAST_MONTH', today)).toEqual({ from: '2026-04-01', to: '2026-04-30' });
    expect(presetDays('THIS_QUARTER', today)).toEqual({ from: '2026-04-01', to: '2026-06-30' });
    expect(presetDays('LAST_QUARTER', today)).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    expect(presetDays('THIS_YEAR', today)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(presetDays('LAST_YEAR', today)).toEqual({ from: '2025-01-01', to: '2025-12-31' });
    expect(presetDays('YESTERDAY', today)).toEqual({ from: '2026-05-19', to: '2026-05-19' });
  });

  it('"today" follows the business time zone, not UTC', () => {
    // 22:30 UTC on 30 Jan is already 00:30 on 31 Jan in Johannesburg (UTC+2).
    const now = new Date('2026-01-30T22:30:00Z');
    expect(resolveRange('Africa/Johannesburg', 'TODAY', undefined, undefined, now).from).toBe('2026-01-31');
    expect(resolveRange('UTC', 'TODAY', undefined, undefined, now).from).toBe('2026-01-30');
  });

  it('rejects a backwards or oversized custom range', () => {
    expect(() => resolveRange('UTC', 'CUSTOM', '2026-03-10', '2026-03-01')).toThrow();
    expect(() => resolveRange('UTC', 'CUSTOM', '2020-01-01', '2026-03-01')).toThrow();
    expect(() => resolveRange('UTC', 'CUSTOM', '2026-03-01')).toThrow();
  });

  it('a custom range only counts what falls inside it', async () => {
    const day = todayIso('Africa/Johannesburg');
    const past = await runReport(ws.ctx, 'revenue', { preset: 'CUSTOM', from: '2020-01-01', to: '2020-01-31' });
    expect(val(past, 'invoiced')).toBe(0);
    const now = await runReport(ws.ctx, 'revenue', { preset: 'CUSTOM', from: day, to: day });
    expect(val(now, 'invoiced')).toBe(1_000_000);
  });
});

describe('report permissions are enforced on the server', () => {
  it('a technician has no report access at all', async () => {
    const t = await createMemberCtx(ws, 'technician');
    expect(availableReports(t.ctx)).toEqual([]);
    expect((await err(runReport(t.ctx, 'revenue', q))).status).toBe(403);
    expect((await err(runReport(t.ctx, 'jobs', q))).status).toBe(403);
  });

  it('report.view alone does not open financial reports', async () => {
    const m = await memberWithPermissions(ws, ['report.view', 'job.view']);
    expect(availableReports(m.ctx).map((r) => r.key)).toContain('jobs');
    expect(availableReports(m.ctx).map((r) => r.key)).not.toContain('revenue');
    expect((await err(runReport(m.ctx, 'revenue', q))).status).toBe(403);
    expect((await err(runReport(m.ctx, 'profitability', q))).status).toBe(403);
  });

  it('job reports hide invoiced value without pricing permission, and profit needs cost permission', async () => {
    const m = await memberWithPermissions(ws, ['report.view', 'job.view', 'finance.view_reports']);
    const r = await runReport(m.ctx, 'jobs', { ...q, groupBy: 'status' });
    // finance.view_reports lets the value columns show; remove it and they must disappear
    expect(r.columns.some((c) => c.key === 'invoiced')).toBe(true);
    const noPrice = await memberWithPermissions(ws, ['report.view', 'job.view']);
    const r2 = await runReport(noPrice.ctx, 'jobs', { ...q, groupBy: 'status' });
    expect(r2.columns.some((c) => c.key === 'invoiced')).toBe(false);
    expect(r2.summary.some((s) => s.key === 'average')).toBe(false);
    expect(JSON.stringify(r2)).not.toContain('"invoiced"');
    const costless = await memberWithPermissions(ws, ['report.view', 'finance.view_reports']);
    expect((await err(runReport(costless.ctx, 'profitability', q))).status).toBe(403);
  });

  it('inventory costs and stock value are removed without inventory.view_costs', async () => {
    const m = await memberWithPermissions(ws, ['report.view', 'inventory.view']);
    const r = await runReport(m.ctx, 'stock', {});
    expect(r.columns.map((c) => c.key)).not.toContain('cost');
    expect(r.columns.map((c) => c.key)).not.toContain('value');
    expect(r.summary.map((s) => s.key)).not.toContain('value');
    expect(JSON.stringify(r.rows)).not.toContain('"cost"');
    const full = await runReport(ws.ctx, 'stock', {});
    expect(full.columns.map((c) => c.key)).toContain('value');
  });

  it('a plan without the feature is refused with 402, whatever the permissions', async () => {
    const solo = await createWorkspace('Reports7 Solo');
    await ownerQuery("UPDATE subscriptions SET status = 'ACTIVE', trial_ends_at = NULL, plan_id = (SELECT id FROM plans WHERE key = 'solo'), current_period_start = now(), current_period_end = now() + interval '30 days' WHERE business_id = $1", [solo.businessId]);
    const { businessContext } = await import('../helpers/factory');
    solo.ctx = await businessContext(solo.owner);
    expect((await err(runReport(solo.ctx, 'quotes', q))).status).toBe(402);
    expect((await err(runReport(solo.ctx, 'profitability', q))).status).toBe(402);
    expect(val(await runReport(solo.ctx, 'revenue', q), 'invoiced')).toBe(0);
    const list = availableReports(solo.ctx);
    expect(list.find((r) => r.key === 'quotes')?.locked).toBe(true);
    expect(list.find((r) => r.key === 'revenue')?.locked).toBe(false);
  });

  it('another business\'s data never appears', async () => {
    const other = await financeWorkspace('Reports7 Other');
    await upgradePlan(other, 'business');
    const r = await runReport(other.ctx, 'revenue', q);
    expect(val(r, 'invoiced')).toBe(0);
    expect((await runReport(other.ctx, 'invoices', q)).rows).toHaveLength(0);
    expect((await runReport(other.ctx, 'stock', {})).rows).toHaveLength(0);
    // a filter that names the first business's customer id returns nothing, and does not reveal that it exists
    const foreign = (await ownerQuery<{ id: string }>('SELECT id FROM customers WHERE business_id = $1 LIMIT 1', [ws.businessId])).rows[0]!.id;
    const f = await runReport(other.ctx, 'invoices', { ...q, customerId: foreign });
    expect(f.rows).toHaveLength(0);
  });
});

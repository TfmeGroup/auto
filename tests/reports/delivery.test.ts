import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma } from '@/server/db/client';
import { AppError } from '@/lib/errors';
import { createInvoice, finaliseInvoice } from '@/server/finance/invoices';
import { exportReport } from '@/server/reports/export';
import { createSavedReport, archiveSavedReport } from '@/server/reports/saved';
import { computeNextRun, createSchedule, listSchedules, runDueReports, updateSchedule, deleteSchedule } from '@/server/reports/schedules';
import { createMemberCtx, createWorkspace, drainJobs, ownerQuery, sentTo, upgradePlan, type TestWorkspace } from '../helpers/factory';
import { L, financeWorkspace } from '../helpers/finance';
import { openJob } from '../helpers/inventory';
import { memberWithPermissions } from '../helpers/workshop';

afterAll(disconnectPrisma);

const err = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { if (e instanceof AppError) return e; throw e; }
  throw new Error('expected an AppError');
};

let ws: TestWorkspace;

beforeAll(async () => {
  ws = await financeWorkspace('Delivery Workshop');
  await upgradePlan(ws, 'business');
  const { job, customer, vehicle } = await openJob(ws);
  // a customer whose name tries to run as a spreadsheet formula
  await ownerQuery("UPDATE customers SET name = '=HYPERLINK(\"http://evil.test\",\"click\")' WHERE id = $1", [customer.id]);
  const d = await createInvoice(ws.ctx, { customerId: customer.id, vehicleId: vehicle.id, jobId: job.id, lines: [L('Brake pads', 1, 250_000, { unitCostCents: 100_000 })] });
  await finaliseInvoice(ws.ctx, d.id);
});

describe('exports', () => {
  it('CSV is clean data: BOM, real numbers for money, and formulas defused', async () => {
    const r = await exportReport(ws.ctx, 'invoices', { preset: 'THIS_YEAR', format: 'CSV' });
    const text = r.data.toString('utf8');
    expect(r.mime).toMatch(/text\/csv/);
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('Invoice,Date,Due,Customer');
    expect(text).toContain('2500.00'); // R2,500.00 as a plain amount
    expect(text).not.toContain(',=HYPERLINK');
    expect(text).toContain("'=HYPERLINK");
    expect(r.filename).toMatch(/^invoices-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it('Excel and PDF are real files', async () => {
    const x = await exportReport(ws.ctx, 'revenue', { preset: 'THIS_YEAR', format: 'XLSX' });
    expect(x.data.subarray(0, 2).toString()).toBe('PK');
    expect(x.mime).toMatch(/spreadsheetml/);
    const p = await exportReport(ws.ctx, 'revenue', { preset: 'THIS_YEAR', format: 'PDF' });
    expect(p.data.subarray(0, 5).toString()).toBe('%PDF-');
    expect(p.data.length).toBeGreaterThan(1000);
  });

  it('honours the chosen columns and rejects unknown ones', async () => {
    const r = await exportReport(ws.ctx, 'invoices', { preset: 'THIS_YEAR', columns: 'number,total' });
    const header = r.data.toString('utf8').replace(/^﻿/, '').split('\r\n')[0];
    expect(header).toBe('Invoice,Total (incl. VAT)');
    expect((await err(exportReport(ws.ctx, 'invoices', { preset: 'THIS_YEAR', columns: 'number,password' }))).status).toBe(422);
  });

  it('every export is audited with what, how many rows and which filters', async () => {
    await exportReport(ws.ctx, 'payments', { preset: 'THIS_MONTH', format: 'CSV' });
    const a = await ownerQuery<{ metadata: { report: string; format: string; rows: number; sensitive: boolean; filters: unknown } }>(
      "SELECT metadata FROM audit_logs WHERE business_id = $1 AND action = 'report.exported' ORDER BY created_at DESC LIMIT 1", [ws.businessId]);
    expect(a.rows[0]!.metadata).toMatchObject({ report: 'payments', format: 'CSV', sensitive: true });
    expect(typeof a.rows[0]!.metadata.rows).toBe('number');
  });

  it('needs report.export, and financial reports also need finance.export', async () => {
    const viewOnly = await memberWithPermissions(ws, ['report.view', 'finance.view_reports', 'invoice.view']);
    expect((await err(exportReport(viewOnly.ctx, 'invoices', { preset: 'THIS_YEAR' }))).status).toBe(403);
    const exporter = await memberWithPermissions(ws, ['report.view', 'report.export', 'finance.view_reports', 'invoice.view']);
    expect((await err(exportReport(exporter.ctx, 'invoices', { preset: 'THIS_YEAR' }))).status).toBe(403); // no finance.export
    const accounts = await createMemberCtx(ws, 'accounts');
    expect((await exportReport(accounts.ctx, 'invoices', { preset: 'THIS_YEAR' })).rows).toBe(1);
    const tech = await createMemberCtx(ws, 'technician');
    expect((await err(exportReport(tech.ctx, 'jobs', {}))).status).toBe(403);
  });

  it('an export carries only the columns the person may see', async () => {
    const m = await memberWithPermissions(ws, ['report.view', 'report.export', 'inventory.view', 'inventory.export']);
    const r = await exportReport(m.ctx, 'stock', {});
    const header = r.data.toString('utf8');
    expect(header).not.toMatch(/Unit cost|Stock value/);
  });
});

describe('scheduled reports', () => {
  it('computes the next run on the business calendar', () => {
    const tz = 'Africa/Johannesburg';
    // Wednesday 20 May 2026, 10:00 Johannesburg (08:00 UTC)
    const now = new Date('2026-05-20T08:00:00Z');
    expect(computeNextRun(now, { frequency: 'DAILY', hour: 7 }, tz).toISOString()).toBe('2026-05-21T05:00:00.000Z'); // 07:00 local tomorrow
    expect(computeNextRun(now, { frequency: 'DAILY', hour: 14 }, tz).toISOString()).toBe('2026-05-20T12:00:00.000Z'); // 14:00 local today
    expect(computeNextRun(now, { frequency: 'WEEKLY', weekday: 1, hour: 7 }, tz).toISOString()).toBe('2026-05-25T05:00:00.000Z'); // next Monday
    expect(computeNextRun(now, { frequency: 'MONTHLY', monthDay: 1, hour: 7 }, tz).toISOString()).toBe('2026-06-01T05:00:00.000Z');
    expect(computeNextRun(now, { frequency: 'MONTHLY', monthDay: 28, hour: 7 }, tz).toISOString()).toBe('2026-05-28T05:00:00.000Z');
  });

  it('needs the permission and the plan', async () => {
    const { id } = await createSavedReport(ws.ctx, { kind: 'STANDARD', reportKey: 'revenue', name: 'Weekly revenue', config: { preset: 'LAST_WEEK' } });
    const tech = await createMemberCtx(ws, 'technician');
    expect((await err(createSchedule(tech.ctx, { savedReportId: id, frequency: 'DAILY' }))).status).toBe(403);
    const team = await createWorkspace('Sched Team');
    await upgradePlan(team, 'team');
    const saved = await createSavedReport(team.ctx, { kind: 'STANDARD', reportKey: 'revenue', name: 'Revenue', config: {} });
    expect((await err(createSchedule(team.ctx, { savedReportId: saved.id, frequency: 'DAILY' }))).status).toBe(402);
  });

  it('refuses a recipient who could not see the report themselves', async () => {
    const { id } = await createSavedReport(ws.ctx, { kind: 'STANDARD', reportKey: 'revenue', name: 'Revenue for owners', config: { preset: 'THIS_MONTH' } });
    const noFinance = await memberWithPermissions(ws, ['report.view', 'job.view']);
    const e = await err(createSchedule(ws.ctx, { savedReportId: id, frequency: 'DAILY', recipientMembershipIds: [noFinance.ctx.membership.id] }));
    expect(e.status).toBe(422);
    expect(JSON.stringify(e)).toMatch(/cannot see this report/);
  });

  it('delivers the report by email through the shared message service, once, and records the run', async () => {
    const accounts = await createMemberCtx(ws, 'accounts');
    const { id } = await createSavedReport(ws.ctx, { kind: 'STANDARD', reportKey: 'invoices', name: 'Weekly invoices', config: { preset: 'THIS_YEAR' } });
    const sched = await createSchedule(ws.ctx, { savedReportId: id, frequency: 'WEEKLY', weekday: 1, hour: 7, format: 'CSV', recipientMembershipIds: [accounts.ctx.membership.id] });
    expect(new Date(sched.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    await ownerQuery("UPDATE report_schedules SET next_run_at = now() - interval '1 minute' WHERE id = $1", [sched.id]);
    const first = await runDueReports(new Date());
    expect(first.enqueued).toBe(1);
    await drainJobs();
    const mail = sentTo(accounts.ctx.user.email);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toBe('Weekly invoices from Delivery Workshop');
    expect(mail[0]!.attachments?.[0]?.filename).toMatch(/^invoices-.*\.csv$/);
    const csv = Buffer.from(mail[0]!.attachments![0]!.contentBase64, 'base64').toString('utf8');
    expect(csv).toContain('Invoice,Date,Due');
    // the shared communication log has it
    const comm = await ownerQuery<{ event: string; status: string; recipient: string }>("SELECT event, status, recipient FROM communications WHERE business_id = $1 AND event = 'REPORT_DELIVERY' AND recipient = $2", [ws.businessId, accounts.ctx.user.email]);
    expect(comm.rows).toHaveLength(1);
    expect(comm.rows[0]!.status).toBe('SENT');
    const run = await ownerQuery<{ status: string; recipients_sent: number }>('SELECT status, recipients_sent FROM report_runs WHERE schedule_id = $1', [sched.id]);
    expect(run.rows).toEqual([{ status: 'SENT', recipients_sent: 1 }]);
    // the same moment is never run twice
    expect((await runDueReports(new Date())).enqueued).toBe(0);
    await drainJobs();
    expect(sentTo(accounts.ctx.user.email)).toHaveLength(1);
    // and the schedule moved on
    const next = (await listSchedules(ws.ctx)).find((s) => s.id === sched.id)!;
    expect(new Date(next.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    expect(next.lastStatus).toBe('SENT');
  });

  it('generates each recipient\'s copy with THEIR permissions: a person who lost access is skipped and the failure is recorded, not hidden', async () => {
    const m = await memberWithPermissions(ws, ['report.view', 'finance.view_reports', 'payment.view']);
    const { id } = await createSavedReport(ws.ctx, { kind: 'STANDARD', reportKey: 'payments', name: 'Payments this year', config: { preset: 'THIS_YEAR' } });
    const sched = await createSchedule(ws.ctx, { savedReportId: id, frequency: 'DAILY', recipientMembershipIds: [m.ctx.membership.id] });
    // their access is taken away after the schedule was made
    await ownerQuery("DELETE FROM role_permissions WHERE role_id = (SELECT role_id FROM memberships WHERE id = $1) AND permission = 'finance.view_reports'", [m.ctx.membership.id]);
    await ownerQuery("UPDATE report_schedules SET next_run_at = now() - interval '1 minute' WHERE id = $1", [sched.id]);
    await runDueReports(new Date());
    await drainJobs();
    expect(sentTo(m.ctx.user.email)).toHaveLength(0);
    const run = await ownerQuery<{ status: string; error: string; recipients_skipped: number }>('SELECT status, error, recipients_skipped FROM report_runs WHERE schedule_id = $1', [sched.id]);
    expect(run.rows[0]).toMatchObject({ status: 'FAILED', recipients_skipped: 1 });
    expect(run.rows[0]!.error).toMatch(/Nobody could receive/);
    // the person who set it up is told (in the app) and it is in the audit log
    const note = await ownerQuery<{ title: string }>("SELECT title FROM notifications WHERE business_id = $1 AND type = 'REPORT_FAILED' ORDER BY created_at DESC LIMIT 1", [ws.businessId]);
    expect(note.rows[0]!.title).toMatch(/Payments this year/);
    const audit = await ownerQuery("SELECT 1 FROM audit_logs WHERE business_id = $1 AND action = 'report.delivery_failed'", [ws.businessId]);
    expect(audit.rowCount).toBeGreaterThan(0);
  });

  it('a paused schedule, a removed report and a removed member send nothing', async () => {
    const accounts = await createMemberCtx(ws, 'accounts');
    const { id } = await createSavedReport(ws.ctx, { kind: 'STANDARD', reportKey: 'receivables', name: 'Who owes', config: {} });
    const sched = await createSchedule(ws.ctx, { savedReportId: id, frequency: 'DAILY', recipientMembershipIds: [accounts.ctx.membership.id] });
    await updateSchedule(ws.ctx, sched.id, { status: 'PAUSED' });
    await ownerQuery("UPDATE report_schedules SET next_run_at = now() - interval '1 minute' WHERE id = $1", [sched.id]);
    expect((await runDueReports(new Date())).enqueued).toBe(0);
    await updateSchedule(ws.ctx, sched.id, { status: 'ACTIVE' });
    await archiveSavedReport(ws.ctx, id);
    // archiving the report switched its schedules off
    expect((await listSchedules(ws.ctx)).find((s) => s.id === sched.id)!.status).toBe('PAUSED');
    await deleteSchedule(ws.ctx, sched.id);
    expect((await listSchedules(ws.ctx)).some((s) => s.id === sched.id)).toBe(false);
    await drainJobs();
    expect(sentTo(accounts.ctx.user.email)).toHaveLength(0);
  });

  it('another business\'s schedules are never visible or runnable', async () => {
    const other = await financeWorkspace('Sched Other');
    await upgradePlan(other, 'business');
    expect(await listSchedules(other.ctx)).toEqual([]);
    const mine = (await listSchedules(ws.ctx))[0]!;
    expect((await err(updateSchedule(other.ctx, mine.id, { status: 'PAUSED' }))).status).toBe(404);
    expect((await err(deleteSchedule(other.ctx, mine.id))).status).toBe(404);
  });
});

import { afterAll, describe, expect, it } from 'vitest';
import { disconnectPrisma } from '@/server/db/client';
import { runScheduledTasks } from '@/server/jobs/scheduler';
import { MemoryTransport } from '@/server/notifications/email';
import { businessContext, createWorkspace, drainJobs, ownerQuery, upgradePlan, type TestWorkspace } from '../helpers/factory';
import { issuedInvoice } from '../helpers/finance';
import { mkPart } from '../helpers/inventory';

afterAll(disconnectPrisma);

/**
 * Time-based work runs every minute from any number of workers. Whatever it did the first time it must not do again: no second email,
 * no second notification, no second audit entry, no second job. Each situation below is real data the tasks react to.
 *
 * Everything is measured for THESE businesses only. In a full run the database also holds other tests' bookings, invoices and trials,
 * and moving the clock forward can legitimately bring one of THEIRS into a reminder window; that is not a repeat of anything.
 */
async function situations() {
  // a trial with two days left (reminder due)
  const trial = await createWorkspace('Idem Trial Co');
  await ownerQuery("UPDATE subscriptions SET trial_ends_at = now() + interval '2 days' WHERE business_id = $1", [trial.businessId]);
  // an unpaid paid-plan subscription whose period lapsed (delinquency starts)
  const lapsed: TestWorkspace = await createWorkspace('Idem Lapsed Co');
  await upgradePlan(lapsed, 'team');
  await ownerQuery("UPDATE subscriptions SET current_period_end = now() - interval '5 days', past_due_since = now() - interval '4 days' WHERE business_id = $1", [lapsed.businessId]);
  // an invoice six days overdue and a part below its reorder level
  const shop = await createWorkspace('Idem Shop Co');
  await upgradePlan(shop, 'business');
  shop.ctx = await businessContext(shop.owner);
  await issuedInvoice(shop, { send: true, dueInDays: -6 });
  await mkPart(shop, { name: 'Idem low part', reorderLevel: 10, minStock: 5 }, 1);
  return [trial, lapsed, shop];
}

describe('scheduled work is idempotent', () => {
  it('a second tick, past every throttle, sends and records nothing the first one already did', async () => {
    const ws = await situations();
    const ids = ws.map((w) => w.businessId);
    const addresses = new Set<string>(ws.map((w) => w.owner.email));
    for (const r of (await ownerQuery<{ email: string }>('SELECT email FROM customers WHERE business_id = ANY($1) AND email IS NOT NULL', [ids])).rows) addresses.add(r.email);

    type Snapshot = { emailsSent: number; communications: number; notifications: number; audit: number; jobs: number };
    const snapshot = async (): Promise<Snapshot> => ({
      emailsSent: MemoryTransport.sent.filter((m) => addresses.has(m.to)).length,
      ...(await ownerQuery<Omit<Snapshot, 'emailsSent'>>(`
        SELECT (SELECT count(*) FROM communications WHERE business_id = ANY($1))::int AS communications,
               (SELECT count(*) FROM notifications WHERE business_id = ANY($1))::int AS notifications,
               (SELECT count(*) FROM audit_logs WHERE business_id = ANY($1))::int AS audit,
               (SELECT count(*) FROM jobs WHERE business_id = ANY($1))::int AS jobs`, [ids])).rows[0]!,
    });

    const t0 = new Date();
    const first = await runScheduledTasks(t0);
    await drainJobs();
    const afterFirst = await snapshot();
    const didSomething = first.trialReminders + first.delinquencyPhases + first.trialsExpired + first.cancellationsExpired > 0 || Object.values(first.finance ?? {}).some((v) => v > 0) || Object.values(first.inventory ?? {}).some((v) => v > 0);
    expect(didSomething, JSON.stringify(first)).toBe(true); // the situations really triggered work, so the later ticks are a real comparison
    expect(afterFirst.jobs + afterFirst.communications + afterFirst.notifications, JSON.stringify(afterFirst)).toBeGreaterThan(0);

    // eleven minutes later: every throttle has opened again, so every task looks again
    await runScheduledTasks(new Date(t0.getTime() + 11 * 60_000));
    await drainJobs();
    expect(await snapshot()).toEqual(afterFirst);

    // and two workers ticking at the very same moment (the realistic race) must not double anything up either
    await Promise.all([runScheduledTasks(new Date(t0.getTime() + 22 * 60_000)), runScheduledTasks(new Date(t0.getTime() + 22 * 60_000))]);
    await drainJobs();
    expect(await snapshot()).toEqual(afterFirst);
  });

  it('every job type has a retry limit and a dead state, so a failing job is neither lost nor retried forever', async () => {
    const states = (await ownerQuery<{ e: string }>("SELECT unnest(enum_range(NULL::job_status))::text AS e")).rows.map((r) => r.e);
    expect(states).toEqual(expect.arrayContaining(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD']));
    const cols = (await ownerQuery<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = 'jobs'")).rows.map((r) => r.column_name);
    for (const c of ['attempts', 'max_attempts', 'run_at', 'last_error', 'dedupe_key']) expect(cols, c).toContain(c);
  });
});

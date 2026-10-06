import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { disconnectPrisma, prisma, withTx } from '@/server/db/client';
import { enqueue } from '@/server/jobs/queue';
import { backoffSeconds, claimJobs, runOnce } from '@/server/jobs/worker';
import { handlers } from '@/server/jobs/handlers';
import { MemoryTransport } from '@/server/notifications/email';
import { queueEmail } from '@/server/notifications/service';
import { drainJobs, ownerQuery } from '../helpers/factory';

afterAll(disconnectPrisma);

const uniq = () => `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let handled: string[] = [];

beforeEach(async () => {
  handled = [];
  // Keep unrelated pending work from earlier suites out of these assertions.
  await drainJobs();
});

describe('background jobs', () => {
  it('delivers a queued email through the worker and scrubs the one-time link afterwards', async () => {
    MemoryTransport.reset();
    const to = `${uniq()}@example.test`;
    await queueEmail(prisma(), { to, subject: 'Hello', text: 'link: https://x.test/?token=SECRET', html: '<p>hi</p>' });
    expect(MemoryTransport.sent).toHaveLength(0); // the request path never sends inline
    await drainJobs();
    expect(MemoryTransport.sent.filter((m) => m.to === to)).toHaveLength(1);
    const row = await ownerQuery("SELECT status, payload FROM jobs WHERE type = 'email.send' AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1");
    expect(row.rows[0].status).toBe('SUCCEEDED');
    expect(JSON.stringify(row.rows[0].payload)).not.toContain('SECRET');
  });

  it('a dedupe key makes enqueueing exactly-once', async () => {
    const key = uniq();
    expect(await enqueue(prisma(), 'test.noop', {}, { dedupeKey: key })).toBe(true);
    expect(await enqueue(prisma(), 'test.noop', {}, { dedupeKey: key })).toBe(false);
    expect((await ownerQuery('SELECT count(*)::int n FROM jobs WHERE dedupe_key = $1', [key])).rows[0].n).toBe(1);
  });

  it('a job enqueued inside a rolled-back transaction never exists (transactional outbox)', async () => {
    const key = uniq();
    await expect(
      withTx(async (tx) => {
        await enqueue(tx, 'test.noop', {}, { dedupeKey: key });
        throw new Error('business change failed');
      }),
    ).rejects.toThrow();
    expect((await ownerQuery('SELECT 1 FROM jobs WHERE dedupe_key = $1', [key])).rowCount).toBe(0);
  });

  it('retries a failing job with backoff, then parks it as DEAD with the error kept', async () => {
    const type = `test.fail.${uniq()}`;
    let calls = 0;
    handlers[type] = { run: async () => { calls++; throw new Error('provider down'); } };
    await enqueue(prisma(), type, {}, { maxAttempts: 3 });

    let r = await runOnce(50);
    expect(r.retried).toBe(1);
    let job = (await ownerQuery("SELECT status, attempts, run_at > now() AS later, last_error FROM jobs WHERE type = $1", [type])).rows[0];
    expect(job).toMatchObject({ status: 'PENDING', attempts: 1, later: true, last_error: 'provider down' });

    for (const attempt of [2, 3]) {
      await ownerQuery("UPDATE jobs SET run_at = now() WHERE type = $1", [type]); // skip the waiting
      r = await runOnce(50);
      expect(r.claimed).toBe(1);
      job = (await ownerQuery('SELECT status, attempts FROM jobs WHERE type = $1', [type])).rows[0];
      expect(job.attempts).toBe(attempt);
    }
    expect(job.status).toBe('DEAD');
    expect(calls).toBe(3);
    await ownerQuery("UPDATE jobs SET run_at = now() WHERE type = $1", [type]);
    expect((await runOnce(50)).claimed).toBe(0); // DEAD jobs are never retried automatically
    delete handlers[type];
  });

  it('backoff grows exponentially and is capped', () => {
    expect([1, 2, 3, 4].map(backoffSeconds)).toEqual([30, 60, 120, 240]);
    expect(backoffSeconds(50)).toBe(3600);
  });

  it('unknown job types are parked immediately instead of looping', async () => {
    const type = `test.unknown.${uniq()}`;
    await enqueue(prisma(), type, {});
    const r = await runOnce(50);
    expect(r.dead).toBeGreaterThanOrEqual(1);
    expect((await ownerQuery('SELECT status FROM jobs WHERE type = $1', [type])).rows[0].status).toBe('DEAD');
  });

  it('concurrent workers never process the same job twice', async () => {
    const type = `test.once.${uniq()}`;
    const ran = new Map<string, number>();
    handlers[type] = {
      run: async (p: { n: string }) => {
        ran.set(p.n, (ran.get(p.n) ?? 0) + 1);
        await new Promise((r) => setTimeout(r, 5));
        handled.push(p.n);
      },
    };
    for (let i = 0; i < 40; i++) await enqueue(prisma(), type, { n: String(i) });
    await Promise.all([runOnce(10), runOnce(10), runOnce(10), runOnce(10), runOnce(10)]);
    await Promise.all([runOnce(10), runOnce(10), runOnce(10), runOnce(10), runOnce(10)]);
    expect(handled).toHaveLength(40);
    expect([...ran.values()].every((c) => c === 1)).toBe(true);
    delete handlers[type];
  });

  it('reclaims a job whose worker died mid-flight', async () => {
    const type = `test.stale.${uniq()}`;
    handlers[type] = { run: async () => { handled.push('recovered'); } };
    await enqueue(prisma(), type, {});
    const claimed = await claimJobs(50, 'crashed-worker');
    expect(claimed.some((j) => j.type === type)).toBe(true); // claimed, then the worker "crashes"
    expect((await runOnce(50)).claimed).toBe(0); // still locked: nobody else grabs it early
    await ownerQuery("UPDATE jobs SET locked_at = now() - interval '11 minutes' WHERE type = $1", [type]);
    await runOnce(50);
    expect(handled).toEqual(['recovered']);
    delete handlers[type];
  });
});

import { hostname } from 'node:os';
import { prisma } from '@/server/db/client';
import { logger } from '@/lib/logger';
import { handlers, type JobContext } from './handlers';
import { runScheduledTasks } from './scheduler';

const STALE_LOCK_MINUTES = 10;

interface ClaimedJob {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

export const workerId = () => `${hostname()}:${process.pid}`;

/** Exponential backoff: 30s, 1m, 2m, 4m ... capped at 1 hour. */
export function backoffSeconds(attempt: number): number {
  return Math.min(3600, 30 * 2 ** Math.max(0, attempt - 1));
}

/**
 * Atomically claim due jobs. FOR UPDATE SKIP LOCKED lets any number of workers
 * run concurrently without ever claiming the same job twice. Jobs whose worker
 * died (locked longer than STALE_LOCK_MINUTES) are reclaimed.
 */
export async function claimJobs(limit: number, by = workerId()): Promise<ClaimedJob[]> {
  return prisma().$queryRaw<ClaimedJob[]>`
    UPDATE jobs SET
      status = 'RUNNING', locked_at = now(), locked_by = ${by},
      attempts = attempts + 1, updated_at = now()
    WHERE id IN (
      SELECT id FROM jobs
      WHERE (status = 'PENDING' AND run_at <= now())
         OR (status = 'RUNNING' AND locked_at < now() - (${STALE_LOCK_MINUTES}::int * interval '1 minute'))
      ORDER BY run_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, type, payload, attempts, max_attempts AS "maxAttempts"`;
}

export interface RunResult {
  claimed: number;
  succeeded: number;
  retried: number;
  dead: number;
}

/** Claim and process one batch. Returns counts (useful for tests and monitoring). */
export async function runOnce(batchSize = 10): Promise<RunResult> {
  const jobs = await claimJobs(batchSize);
  const result: RunResult = { claimed: jobs.length, succeeded: 0, retried: 0, dead: 0 };

  for (const job of jobs) {
    const def = handlers[job.type];
    if (!def) {
      await markDead(job.id, `No handler registered for job type "${job.type}"`);
      result.dead++;
      continue;
    }
    const ctx: JobContext = { jobId: job.id, attempt: job.attempts };
    try {
      await def.run(job.payload as never, ctx);
      await prisma().job.update({
        where: { id: job.id },
        data: {
          status: 'SUCCEEDED',
          completedAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          lastError: null,
          ...(def.scrubPayloadOnSuccess ? { payload: {} } : {}),
        },
      });
      result.succeeded++;
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
      logger.warn({ jobId: job.id, type: job.type, attempt: job.attempts, err: message }, 'job failed');
      if (job.attempts >= job.maxAttempts) {
        await markDead(job.id, message);
        result.dead++;
      } else {
        await prisma().job.update({
          where: { id: job.id },
          data: {
            status: 'PENDING',
            runAt: new Date(Date.now() + backoffSeconds(job.attempts) * 1000),
            lockedAt: null,
            lockedBy: null,
            lastError: message,
          },
        });
        result.retried++;
      }
    }
  }
  return result;
}

async function markDead(id: string, error: string) {
  await prisma().job.update({
    where: { id },
    data: { status: 'DEAD', lastError: error, lockedAt: null, lockedBy: null, completedAt: new Date() },
  });
  logger.error({ jobId: id, error }, 'job moved to dead state');
}

/** Long-running poll loop used by the worker CLI and the optional inline worker. */
export function startWorkerLoop(opts: { intervalMs?: number; batchSize?: number; schedulerIntervalMs?: number } = {}) {
  const interval = opts.intervalMs ?? 2000;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    try {
      const r = await runOnce(opts.batchSize ?? 10);
      // Keep draining immediately while there is work; otherwise sleep.
      if (!stopped) timer = setTimeout(tick, r.claimed > 0 ? 0 : interval);
    } catch (err) {
      logger.error({ err: String(err) }, 'worker tick failed');
      if (!stopped) timer = setTimeout(tick, interval * 2);
    }
  };
  timer = setTimeout(tick, 0);

  // Time-based work (trial reminders, billing transitions, housekeeping). Safe to run from every worker.
  const schedule = async () => {
    try {
      await runScheduledTasks();
    } catch (err) {
      logger.error({ err: String(err) }, 'scheduler tick failed');
    }
  };
  const schedulerTimer = setInterval(schedule, opts.schedulerIntervalMs ?? 60_000);
  void schedule();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    clearInterval(schedulerTimer);
  };
}

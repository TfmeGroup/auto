/**
 * Runs once when the Next.js server starts. With JOBS_INLINE_WORKER=true the
 * background job worker runs inside the web process — convenient for local
 * development and single-instance hosting. For production scale, run
 * `npm run worker` as its own process instead and leave this off.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.JOBS_INLINE_WORKER === 'true') {
    const { startWorkerLoop } = await import('@/server/jobs/worker');
    startWorkerLoop();
  }
}

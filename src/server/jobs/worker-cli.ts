/**
 * Standalone background worker:  npm run worker
 * Run one or more of these alongside the web app in production.
 */
import { logger } from '@/lib/logger';
import { disconnectPrisma } from '@/server/db/client';
import { startWorkerLoop } from './worker';

try {
  process.loadEnvFile('.env');
} catch {
  // rely on real environment
}

const stop = startWorkerLoop();
logger.info('job worker started');

async function shutdown(signal: string) {
  logger.info({ signal }, 'job worker shutting down');
  stop();
  await disconnectPrisma();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

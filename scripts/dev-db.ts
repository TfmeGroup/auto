/**
 * `npm run db:local` — start a local PostgreSQL (no Docker needed), create the
 * dev database, apply migrations, and keep running until Ctrl+C.
 * Data persists in .local-data/pg between runs.
 */
import { resolve } from 'node:path';
import { ensureDatabase, startLocalPostgres } from './lib/local-pg';
import { migrateDatabase } from './lib/migrate-db';

const PORT = 54320;
const DB = 'tfme_auto';
const APP_PASSWORD = 'tfme_app_dev_password';

async function main() {
  const local = await startLocalPostgres({ dir: resolve('.local-data/pg'), port: PORT, quiet: true });
  await ensureDatabase(local.adminUrl(), DB);

  const ownerUrl = local.adminUrl(DB);
  const appUrl = `postgresql://tfme_app:${APP_PASSWORD}@localhost:${PORT}/${DB}`;
  await migrateDatabase({ ownerUrl, appUrl });

  console.log(`
Local PostgreSQL is running on port ${PORT}.

Put this in .env (copy .env.example first):
  DATABASE_URL=${appUrl}
  MIGRATE_DATABASE_URL=${ownerUrl}

Press Ctrl+C to stop.`);

  const shutdown = async () => {
    await local.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

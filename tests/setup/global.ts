import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDatabase, startLocalPostgres, type LocalPostgres } from '../../scripts/lib/local-pg';
import { migrateDatabase } from '../../scripts/lib/migrate-db';

/**
 * Starts a throwaway real PostgreSQL, applies the REAL migrations through
 * `prisma migrate deploy` (so the tests exercise exactly what production runs,
 * including row-level security and the restricted tfme_app role), and exposes
 * connection strings to the test workers.
 */
let local: LocalPostgres | undefined;
let dataDir: string | undefined;

export const TEST_PORT = 54399;
export const TEST_DB = 'tfme_auto_test';
export const TEST_APP_PASSWORD = 'tfme_app_test_password';

export async function setup() {
  dataDir = mkdtempSync(join(tmpdir(), 'tfme-auto-pg-'));
  local = await startLocalPostgres({ dir: join(dataDir, 'pg'), port: TEST_PORT, persistent: false, quiet: true });
  await ensureDatabase(local.adminUrl(), TEST_DB);

  const ownerUrl = local.adminUrl(TEST_DB);
  const appUrl = `postgresql://tfme_app:${TEST_APP_PASSWORD}@localhost:${TEST_PORT}/${TEST_DB}`;
  await migrateDatabase({ ownerUrl, appUrl, quiet: true });

  process.env.TEST_OWNER_DATABASE_URL = ownerUrl;
  process.env.TEST_APP_DATABASE_URL = appUrl;
}

export async function teardown() {
  await local?.stop().catch(() => {});
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
}

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client';
import { syncSystemRoles } from '../../src/server/permissions/sync';
import { syncPlans } from '../../src/server/billing/plans';

/**
 * Apply migrations and sync reference data. Connects as the schema OWNER.
 *
 *  1. `prisma migrate deploy`  — applies prisma/migrations in order.
 *  2. Sets the tfme_app role's password from the app's DATABASE_URL (the SQL
 *     migration creates the role but never contains a password).
 *  3. Syncs system roles + plan catalog from code (idempotent).
 */
export async function migrateDatabase(opts: { ownerUrl: string; appUrl: string; quiet?: boolean }): Promise<void> {
  const prismaCli = join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js');
  const res = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    env: { ...process.env, MIGRATE_DATABASE_URL: opts.ownerUrl },
    stdio: opts.quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(`prisma migrate deploy failed:\n${res.stdout ?? ''}\n${res.stderr ?? ''}`);
  }

  const app = new URL(opts.appUrl);
  if (app.username !== 'tfme_app') throw new Error('DATABASE_URL must connect as the "tfme_app" role');
  const password = decodeURIComponent(app.password);
  if (!password) throw new Error('DATABASE_URL must include a password for tfme_app');

  const client = new pg.Client({ connectionString: opts.ownerUrl });
  await client.connect();
  try {
    const stmt = await client.query('SELECT format($1, $2::text) AS sql', ['ALTER ROLE tfme_app PASSWORD %L', password]);
    await client.query(stmt.rows[0].sql as string);
  } finally {
    await client.end();
  }

  const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: opts.ownerUrl }) });
  try {
    await syncSystemRoles(owner);
    await syncPlans(owner);
  } finally {
    await owner.$disconnect();
  }
}

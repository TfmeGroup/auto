import { existsSync } from 'node:fs';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

/**
 * A real PostgreSQL server (embedded binaries) for development and tests on
 * machines without Docker. Production uses a managed Postgres instead — see
 * docs/OPERATIONS.md.
 */
export interface LocalPostgres {
  pg: EmbeddedPostgres;
  adminUrl: (database?: string) => string;
  stop: () => Promise<void>;
}

export const LOCAL_SUPERUSER = 'postgres';
export const LOCAL_SUPERUSER_PASSWORD = 'password';

export async function startLocalPostgres(opts: { dir: string; port: number; persistent?: boolean; quiet?: boolean }): Promise<LocalPostgres> {
  const server = new EmbeddedPostgres({
    databaseDir: opts.dir,
    user: LOCAL_SUPERUSER,
    password: LOCAL_SUPERUSER_PASSWORD,
    port: opts.port,
    persistent: opts.persistent ?? true,
    // Force UTF-8 regardless of the Windows code page; the schema and data are UTF-8.
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: opts.quiet ? () => {} : (m) => console.log(String(m).trimEnd()),
    onError: opts.quiet ? () => {} : (m) => console.error(String(m).trimEnd()),
  });
  if (!existsSync(join(opts.dir, 'PG_VERSION'))) await server.initialise();
  await server.start();

  const adminUrl = (database = 'postgres') =>
    `postgresql://${LOCAL_SUPERUSER}:${LOCAL_SUPERUSER_PASSWORD}@localhost:${opts.port}/${database}`;
  return { pg: server, adminUrl, stop: () => server.stop() };
}

export async function ensureDatabase(adminUrl: string, name: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const r = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (r.rowCount === 0) await client.query(`CREATE DATABASE "${name.replace(/"/g, '')}"`);
  } finally {
    await client.end();
  }
}

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '@/generated/prisma/client';
import { env } from '@/lib/env';
import { Errors } from '@/lib/errors';

/** Transaction client handed to service functions. */
export type Tx = Prisma.TransactionClient;
/** Anything that can run queries: the root client or a transaction. */
export type Db = PrismaClient | Tx;

const globalForPrisma = globalThis as unknown as { __tfmePrisma?: PrismaClient };

function createClient(connectionString: string): PrismaClient {
  // Pin the session timezone: timestamps are stored/compared in UTC no matter where the DB server runs.
  return new PrismaClient({ adapter: new PrismaPg({ connectionString, options: '-c timezone=UTC' }) });
}

/**
 * Root client, connected as the restricted `tfme_app` role. Row-level security
 * applies: tenant tables return nothing unless queried through withTenant().
 */
export function prisma(): PrismaClient {
  if (!globalForPrisma.__tfmePrisma) {
    globalForPrisma.__tfmePrisma = createClient(env().DATABASE_URL);
  }
  return globalForPrisma.__tfmePrisma;
}

export async function disconnectPrisma(): Promise<void> {
  if (globalForPrisma.__tfmePrisma) {
    await globalForPrisma.__tfmePrisma.$disconnect();
    globalForPrisma.__tfmePrisma = undefined;
  }
}

/** Owner-privileged client for scripts (migrate, seed). Never used by request handling. */
export function createOwnerClient(): PrismaClient {
  const url = env().MIGRATE_DATABASE_URL;
  if (!url) throw new Error('MIGRATE_DATABASE_URL is required for owner operations');
  return createClient(url);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const TX_OPTIONS = { timeout: 20_000, maxWait: 10_000 } as const;

/**
 * Scope an already-open transaction to a business (transaction-local). Use when
 * the business is only discovered mid-transaction, e.g. after loading a payment.
 */
export async function setTenant(tx: Tx, businessId: string): Promise<void> {
  if (!isUuid(businessId)) throw Errors.badRequest('Invalid business id');
  await tx.$executeRaw`SELECT set_config('app.business_id', ${businessId}, true)`;
}

/**
 * Run `fn` inside a transaction scoped to one business. The tenant id is set
 * with set_config(..., is_local = true), so it is discarded at commit/rollback
 * and can never leak across pooled connections. Postgres RLS then restricts
 * every tenant table to this business — even if a query forgets a WHERE.
 */
export async function withTenant<T>(
  businessId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!isUuid(businessId)) throw Errors.badRequest('Invalid business id');
  return prisma().$transaction(async (tx) => {
    await setTenant(tx, businessId);
    return fn(tx);
  }, TX_OPTIONS);
}

/**
 * Transaction scoped to one PERSON (not a business). Lets a user read their own
 * account-level security events, which have no business. Transaction-local, like withTenant.
 */
export async function withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!isUuid(userId)) throw Errors.badRequest('Invalid user id');
  return prisma().$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
    return fn(tx);
  }, TX_OPTIONS);
}

/** Transaction without tenant context, for control-plane work (users, sessions, memberships). */
export async function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma().$transaction(fn, TX_OPTIONS);
}

export { Prisma };

/**
 * Await several reads one after another on the SAME connection. Inside a transaction every query shares one
 * connection, and sending overlapping queries down it (as Promise.all would) is deprecated in the pg driver and
 * removed in pg 9. Prisma queries are lazy, so passing them here does not start them early.
 */
export async function seq<const T extends readonly unknown[]>(items: T): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  const out: unknown[] = [];
  for (const item of items) out.push(await item);
  return out as { -readonly [K in keyof T]: Awaited<T[K]> };
}

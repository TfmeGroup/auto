import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { MemoryTransport } from '@/server/notifications/email';
import { prisma } from '@/server/db/client';
import { hashPassword } from '@/server/auth/password';
import { createSession } from '@/server/auth/session';
import { authenticate, resolveBusinessContext } from '@/server/tenancy/context';
import { createBusiness } from '@/server/businesses/service';
import { type BusinessContext, type UserContext } from '@/server/context';

export const TEST_PASSWORD = 'Correct-Horse-9!';

/** Unique client IP per call so per-IP rate limits never couple unrelated tests. */
export const randomIp = () =>
  `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

export const testMeta = (ip = randomIp()) => ({ requestId: `test-${randomUUID()}`, ip });

/** Latest queued email to an address (read straight from the job outbox). */
export async function latestEmailTo(email: string) {
  const r = await ownerQuery<{ payload: { to: string; subject: string; text: string; html: string } }>(
    "SELECT payload FROM jobs WHERE type IN ('email.send', 'comm.deliver') AND payload->>'to' = $1 ORDER BY created_at DESC LIMIT 1",
    [email],
  );
  return r.rows[0]?.payload;
}

/** The one-time token in the most recent email's link (verify / reset / invite). */
export async function latestEmailToken(email: string): Promise<string> {
  const mail = await latestEmailTo(email);
  const m = mail && /[?&]token=([\w-]+)/.exec(mail.text);
  if (!m?.[1]) throw new Error(`no token link found in latest email to ${email}`);
  return m[1];
}

export async function emailCountTo(email: string): Promise<number> {
  const r = await ownerQuery<{ n: number }>(
    "SELECT count(*)::int AS n FROM jobs WHERE type IN ('email.send', 'comm.deliver') AND payload->>'to' = $1",
    [email],
  );
  return r.rows[0]?.n ?? 0;
}

let counter = 0;
export const uniqueEmail = (label = 'user') => `${label}.${Date.now()}.${++counter}@example.test`;

export interface TestUser {
  id: string;
  email: string;
  name: string;
  password: string;
}

export async function createUser(opts: { email?: string; name?: string; verified?: boolean } = {}): Promise<TestUser> {
  const email = (opts.email ?? uniqueEmail()).toLowerCase();
  const name = opts.name ?? 'Test User';
  const [firstName = 'Test', ...rest] = name.split(' ');
  const u = await prisma().user.create({
    data: {
      email,
      name,
      firstName,
      lastName: rest.join(' ') || 'User',
      passwordHash: await hashPassword(TEST_PASSWORD),
      emailVerifiedAt: opts.verified === false ? null : new Date(),
    },
  });
  return { id: u.id, email, name, password: TEST_PASSWORD };
}

/** A real session + resolved user context, exactly as an HTTP request would produce. */
export async function userContext(user: TestUser): Promise<UserContext & { token: string }> {
  const meta = testMeta();
  const s = await createSession(prisma(), user.id, meta);
  const auth = await authenticate(s.token, meta);
  if (!auth) throw new Error('test session failed to authenticate');
  return { ...auth.user, token: s.token };
}

export async function businessContext(user: TestUser): Promise<BusinessContext & { token: string }> {
  const uctx = await userContext(user);
  const auth = await authenticate(uctx.token, uctx.meta);
  if (!auth) throw new Error('unauthenticated');
  return { ...(await resolveBusinessContext(auth)), token: uctx.token };
}

export interface TestWorkspace {
  owner: TestUser;
  businessId: string;
  ctx: BusinessContext & { token: string };
}

/** A verified owner with a freshly created business (trial subscription, default location). */
export async function createWorkspace(name = 'Test Auto Workshop'): Promise<TestWorkspace> {
  const owner = await createUser({ name: `${name} Owner` });
  const uctx = await userContext(owner);
  const business = await createBusiness(uctx, { name, vatRegistered: false });
  const ctx = await businessContext(owner);
  return { owner, businessId: business.id, ctx };
}

/** Add an existing user to a business with a system role (test shortcut; real flow is the invitation). */
export async function addMember(businessId: string, user: TestUser, roleKey: string) {
  const role = await prisma().role.findFirstOrThrow({ where: { businessId: null, key: roleKey } });
  await prisma().membership.create({
    data: { businessId, userId: user.id, roleId: role.id, status: 'ACTIVE', joinedAt: new Date() },
  });
}

/** Create a member with a role and return their ready-to-use context for that business. */
export async function createMemberCtx(ws: TestWorkspace, roleKey: string) {
  const user = await createUser({ name: `${roleKey} member` });
  await addMember(ws.businessId, user, roleKey);
  const uctx = await userContext(user);
  const { setActiveBusiness } = await import('@/server/auth/session');
  await setActiveBusiness(prisma(), uctx.sessionId, ws.businessId);
  return { user, ctx: await businessContext(user) };
}

/** Superuser connection that bypasses RLS: for asserting what the DB really contains. */
export async function ownerQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
  await client.connect();
  try {
    return await client.query<T>(sql, params);
  } finally {
    await client.end();
  }
}

/** Connection as the restricted app role, for raw SQL probes of RLS/grants. */
export async function appClient() {
  const client = new pg.Client({ connectionString: process.env.TEST_APP_DATABASE_URL });
  await client.connect();
  return client;
}

/** Run the background worker until no due jobs remain. */
export async function drainJobs(): Promise<void> {
  const { runOnce } = await import('@/server/jobs/worker');
  for (let i = 0; i < 50; i++) {
    const r = await runOnce(100);
    if (r.claimed === 0) return;
  }
}

/** Put a workspace on a paid plan (as a verified payment would) and refresh its cached context. */
export async function upgradePlan(ws: TestWorkspace, planKey = 'business'): Promise<void> {
  await ownerQuery(
    `UPDATE subscriptions SET status = 'ACTIVE', trial_ends_at = NULL, plan_id = (SELECT id FROM plans WHERE key = $2),
            current_period_start = now(), current_period_end = now() + interval '30 days' WHERE business_id = $1`,
    [ws.businessId, planKey],
  );
  ws.ctx = await businessContext(ws.owner);
}

/** Business context for an EXISTING session (keeps its active business, unlike businessContext() which opens a new session). */
export async function contextForSession(uctx: UserContext & { token: string }): Promise<BusinessContext & { token: string }> {
  const auth = await authenticate(uctx.token, uctx.meta);
  if (!auth) throw new Error('unauthenticated');
  return { ...(await resolveBusinessContext(auth)), token: uctx.token };
}

/** Emails actually DELIVERED to an address (after the worker ran). Delivered job payloads are scrubbed by design. */
export function sentTo(email: string) {
  return MemoryTransport.sent.filter((m) => m.to === email);
}

/** Restore an environment variable to its previous value (deleting it if it was unset: assigning undefined would store "undefined"). */
export function restoreEnv(key: string, value: string | undefined) {
  const e = process.env as Record<string, string | undefined>;
  if (value === undefined) delete e[key];
  else e[key] = value;
}

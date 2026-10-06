import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { ZodError, z, type ZodType } from 'zod';
import { env } from '@/lib/env';
import { AppError, Errors, isAppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { fieldErrors } from '@/lib/validation';
import { Prisma } from '@/server/db/client';
import { SESSION_COOKIE } from '@/server/auth/session';
import { authenticate, resolveBusinessContext } from '@/server/tenancy/context';
import { consume } from '@/server/security/rate-limit';
import { requireAnyPermission } from '@/server/permissions/authorize';
import { assertCanWrite } from '@/server/billing/subscriptions';
import { requireFeature, type FeatureKey } from '@/server/billing/features';
import { requirePlatformAdmin } from '@/server/platform/service';
import type { Permission } from '@/server/permissions/catalog';
import type { BusinessContext, RequestMeta, UserContext } from '@/server/context';

/**
 * The single entry point for API handlers. It enforces, in order:
 *   request id → CSRF → authentication → email verification → business
 *   membership → permission → subscription (writes) → rate limit → error mapping
 * so individual handlers cannot forget a step.
 */

export interface CookieSpec {
  name: string;
  value: string;
  options: { httpOnly?: boolean; secure?: boolean; sameSite?: 'lax' | 'strict' | 'none'; path?: string; expires?: Date; maxAge?: number };
}

export interface ApiResult {
  status?: number;
  data?: unknown;
  meta?: unknown;
  cookies?: CookieSpec[];
  headers?: Record<string, string>;
}

export const ok = (data?: unknown, meta?: unknown, extra: Omit<ApiResult, 'data' | 'meta'> = {}): ApiResult => ({
  status: 200,
  data,
  meta,
  ...extra,
});
export const created = (data: unknown, extra: Omit<ApiResult, 'data'> = {}): ApiResult => ({ status: 201, data, ...extra });

type HandlerReturn = ApiResult | Response | void;

interface BaseOptions {
  /** Skip the Origin/Sec-Fetch-Site check (only for machine endpoints with their own auth). */
  csrf?: boolean;
  /** Extra per-route rate limit, keyed after auth. */
  rateLimit?: { name: string; limit: number; windowSec: number; by?: 'user' | 'ip' };
}
interface PublicOptions extends BaseOptions {
  access: 'public';
}
interface UserOptions extends BaseOptions {
  access: 'user';
  /** Require a verified email (default false). */
  verified?: boolean;
}
interface BusinessOptions extends BaseOptions {
  access: 'business';
  /** Caller needs at least one of these permissions. `null` = any active member of the business. */
  permission: Permission | Permission[] | null;
  /** Mutating route: blocked when the subscription is expired (read-only mode). */
  write?: boolean;
  /** Plan entitlement required (402 FEATURE_NOT_IN_PLAN otherwise). Enforced here, not in the UI. */
  feature?: FeatureKey;
  /** Skip the business's "require MFA" rule (only for routes a member needs in order to SET UP MFA). */
  allowWithoutMfa?: boolean;
}
interface PlatformOptions extends BaseOptions {
  /** TFME platform administration: platform_admins only, MFA required. Never reachable via a business role. */
  access: 'platform';
}

export interface RouteArgs<C> {
  req: Request;
  ctx: C;
  params: Record<string, string>;
  meta: RequestMeta;
}

type CtxFor<O> = O extends BusinessOptions ? BusinessContext : O extends UserOptions | PlatformOptions ? UserContext : undefined;

type NextHandler = (req: Request, extra: { params: Promise<Record<string, string>> }) => Promise<Response>;

export function route<O extends PublicOptions | UserOptions | BusinessOptions | PlatformOptions>(
  options: O,
  handler: (args: RouteArgs<CtxFor<O>>) => Promise<HandlerReturn> | HandlerReturn,
): NextHandler {
  return async (req, extra) => {
    const meta = buildMeta(req);
    try {
      if (options.csrf !== false && isMutation(req.method)) assertSameOrigin(req);

      const params = (await extra.params) ?? {};
      let ctx: unknown;

      if (options.access !== 'public') {
        const auth = await authenticate(readCookie(req, SESSION_COOKIE), meta);
        if (!auth) throw Errors.unauthenticated();
        if (options.access === 'user' && (options as UserOptions).verified && !auth.user.user.emailVerified) {
          throw Errors.emailNotVerified();
        }
        await consume({ key: `api:user:${auth.user.user.id}`, limit: 600, windowSec: 60 });

        if (options.access === 'business') {
          const bo = options as BusinessOptions;
          const bctx = await resolveBusinessContext(auth);
          // A business can require two-factor authentication of every member (plan entitlement).
          if (bctx.business.requireMfa && !bctx.user.mfaEnabled && !bo.allowWithoutMfa) throw Errors.mfaRequired();
          if (bo.permission !== null) requireAnyPermission(bctx, Array.isArray(bo.permission) ? bo.permission : [bo.permission]);
          if (bo.feature) requireFeature(bctx.subscription, bo.feature);
          if (bo.write) assertCanWrite(bctx.subscription);
          ctx = bctx;
        } else if (options.access === 'platform') {
          await requirePlatformAdmin(auth.user);
          ctx = auth.user;
        } else {
          ctx = auth.user;
        }
      }

      if (options.rateLimit) {
        const rl = options.rateLimit;
        const who =
          rl.by === 'ip' || !ctx
            ? `ip:${meta.ip ?? 'unknown'}`
            : `user:${(ctx as UserContext).user.id}`;
        await consume({ key: `${rl.name}:${who}`, limit: rl.limit, windowSec: rl.windowSec });
      }

      const result = await handler({ req, ctx: ctx as CtxFor<O>, params, meta });
      return toResponse(result, meta);
    } catch (err) {
      return errorResponse(err, meta, req);
    }
  };
}

// ───────────────────────── helpers ─────────────────────────

export function buildMeta(req: Request): RequestMeta {
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const ip = env().TRUST_PROXY ? (req.headers.get('x-real-ip') ?? forwarded ?? undefined) : undefined;
  return {
    requestId: sanitizeRequestId(req.headers.get('x-request-id')) ?? randomUUID(),
    ip,
    userAgent: req.headers.get('user-agent') ?? undefined,
  };
}

function sanitizeRequestId(v: string | null): string | undefined {
  return v && /^[\w-]{8,64}$/.test(v) ? v : undefined;
}

const isMutation = (m: string) => !['GET', 'HEAD', 'OPTIONS'].includes(m.toUpperCase());

/**
 * Cross-site request forgery defence for cookie-authenticated endpoints, layered
 * on top of SameSite=Lax cookies: a present Origin must match this app; otherwise
 * browsers' Sec-Fetch-Site must not say "cross-site".
 */
export function assertSameOrigin(req: Request): void {
  const origin = req.headers.get('origin');
  if (origin) {
    const allowed = new URL(env().APP_URL).origin;
    if (origin !== allowed && origin !== new URL(req.url).origin) throw Errors.csrf();
    return;
  }
  const site = req.headers.get('sec-fetch-site');
  if (site && !['same-origin', 'same-site', 'none'].includes(site)) throw Errors.csrf();
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0 && part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

const MAX_JSON_BYTES = 1_000_000;

/** Parse and validate a JSON body. Authoritative server-side validation lives in the schema. */
export async function readJson<S extends ZodType>(req: Request, schema: S): Promise<z.output<S>> {
  const text = await req.text();
  if (text.length > MAX_JSON_BYTES) throw Errors.tooLarge(1);
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw Errors.badRequest('Request body must be valid JSON.');
  }
  const r = schema.safeParse(body);
  if (!r.success) throw Errors.validation(fieldErrors(r.error));
  return r.data;
}

/** Parse a JSON body without validating it, for services that run their own authoritative validation. */
export async function readBody(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > MAX_JSON_BYTES) throw Errors.tooLarge(1);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw Errors.badRequest("Request body must be valid JSON.");
  }
}

/** Parse and validate URL query parameters. */
export function readQuery<S extends ZodType>(req: Request, schema: S): z.output<S> {
  const obj = Object.fromEntries(new URL(req.url).searchParams.entries());
  const r = schema.safeParse(obj);
  if (!r.success) throw Errors.validation(fieldErrors(r.error));
  return r.data;
}

function toResponse(result: HandlerReturn, meta: RequestMeta): Response {
  if (result instanceof Response) {
    result.headers.set('x-request-id', meta.requestId);
    return result;
  }
  const r = result ?? {};
  const status = r.status ?? 200;
  const res =
    status === 204
      ? new NextResponse(null, { status })
      : NextResponse.json({ data: r.data ?? null, ...(r.meta !== undefined ? { meta: r.meta } : {}) }, { status });
  for (const c of r.cookies ?? []) res.cookies.set(c.name, c.value, c.options);
  for (const [k, v] of Object.entries(r.headers ?? {})) res.headers.set(k, v);
  res.headers.set('x-request-id', meta.requestId);
  res.headers.set('cache-control', 'no-store');
  return res;
}

function errorResponse(err: unknown, meta: RequestMeta, req: Request): Response {
  let appErr: AppError;
  if (isAppError(err)) {
    appErr = err;
  } else if (err instanceof ZodError) {
    appErr = Errors.validation(fieldErrors(err));
  } else if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    appErr = Errors.conflict('A record with those details already exists.');
  } else if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
    appErr = Errors.notFound();
  } else {
    // Unexpected: log full detail internally, return nothing sensitive.
    logger.error(
      { err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err), requestId: meta.requestId, path: new URL(req.url).pathname, method: req.method },
      'unhandled error',
    );
    appErr = new AppError('INTERNAL', 500, 'Something went wrong on our side. Please try again.');
  }

  if (appErr.status >= 500) logger.error({ code: appErr.code, requestId: meta.requestId }, 'server error response');

  const res = NextResponse.json(
    {
      error: {
        code: appErr.code,
        message: appErr.message,
        ...(appErr.details !== undefined ? { details: appErr.details } : {}),
        requestId: meta.requestId,
      },
    },
    { status: appErr.status },
  );
  res.headers.set('x-request-id', meta.requestId);
  res.headers.set('cache-control', 'no-store');
  if (appErr.code === 'RATE_LIMITED') {
    const retry = (appErr.details as { retryAfterSec?: number } | undefined)?.retryAfterSec;
    if (retry) res.headers.set('retry-after', String(retry));
  }
  return res;
}

/** Raw URL query parameters, for services that validate their own input. */
export const rawQuery = (req: Request): Record<string, string> => Object.fromEntries(new URL(req.url).searchParams.entries());

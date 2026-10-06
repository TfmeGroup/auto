import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { resetEnvForTests } from '@/lib/env';
import { LOG_CENSOR, LOG_REDACT_PATHS } from '@/lib/logger';
import { sessionCookieOptions } from '@/server/auth/session';
import { setStorageForTests } from '@/server/storage';
import { GET as readyRoute } from '@/app/api/health/ready/route';
import { GET as liveRoute } from '@/app/api/health/route';
import { disconnectPrisma } from '@/server/db/client';
import { restoreEnv } from '../helpers/factory';
import nextConfig from '../../next.config';

afterAll(disconnectPrisma);

const walk = (dir: string, out: string[] = []): string[] => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|cjs)$/.test(f)) out.push(p);
  }
  return out;
};

describe('security headers', () => {
  it('every response carries the production header set', async () => {
    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.source).toBe('/:path*'); // all routes, not a subset
    const h = Object.fromEntries(rules[0]!.headers.map((x) => [x.key.toLowerCase(), x.value]));
    expect(h['strict-transport-security']).toMatch(/max-age=(\d{8,})/);
    expect(Number(/max-age=(\d+)/.exec(h['strict-transport-security']!)![1])).toBeGreaterThanOrEqual(31_536_000);
    expect(h['strict-transport-security']).toContain('includeSubDomains');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(h['permissions-policy']).toContain('geolocation=()');
    const csp = h['content-security-policy']!;
    for (const d of ["default-src 'self'", "object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'"]) expect(csp, d).toContain(d);
    expect(csp).not.toMatch(/script-src[^;]*\*/); // no wildcard script source
    expect(csp).not.toMatch(/http:\/\/(?!localhost)/); // nothing may be loaded over plain http
    expect(nextConfig.poweredByHeader).toBe(false); // does not advertise the framework
  });
});

describe('cookies and sessions', () => {
  it('the session cookie is HttpOnly, SameSite and Secure in production', () => {
    const prev = process.env.NODE_ENV;
    const prevSms = process.env.SMS_DRIVER;
    const prevWa = process.env.WHATSAPP_DRIVER;
    const setEnv = (v: string) => { (process.env as Record<string, string | undefined>).NODE_ENV = v; resetEnvForTests(); };
    try {
      const expires = new Date(Date.now() + 3_600_000);
      setEnv('production');
      // production env validation needs its secrets; only the cookie flags are under test, so read them through a minimal env
      process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
      process.env.FILE_SIGNING_KEY = Buffer.alloc(32, 2).toString('base64');
      process.env.APP_URL = 'https://auto.example.test';
      process.env.EMAIL_DRIVER = 'smtp';
      process.env.SMTP_HOST = 'smtp.example.test';
      process.env.SMTP_PORT = '587';
      process.env.BILLING_PROVIDER = 'none';
      process.env.SMS_DRIVER = 'none';
      process.env.WHATSAPP_DRIVER = 'none';
      const o = sessionCookieOptions(expires);
      expect(o).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
    } finally {
      restoreEnv('NODE_ENV', prev);
      restoreEnv('SMS_DRIVER', prevSms);
      restoreEnv('WHATSAPP_DRIVER', prevWa);
      for (const k of ['MFA_ENCRYPTION_KEY', 'FILE_SIGNING_KEY', 'APP_URL', 'EMAIL_DRIVER', 'SMTP_HOST', 'SMTP_PORT', 'BILLING_PROVIDER']) delete process.env[k];
      resetEnvForTests();
    }
  });
});

describe('logging never contains secrets', () => {
  it('every sensitive field name in the redaction list is censored, at the top level and one level down', () => {
    let out = '';
    const sink = new Writable({ write(chunk, _enc, cb) { out += chunk.toString(); cb(); } });
    const log = pino({ redact: { paths: LOG_REDACT_PATHS, censor: LOG_CENSOR } }, sink);
    const names = ['password', 'newPassword', 'currentPassword', 'passwordHash', 'token', 'accessToken', 'refreshToken', 'authToken', 'secret', 'credentials', 'merchantKey', 'passphrase', 'apiKey', 'mfaSecret'];
    const value = 'TOP-SECRET-VALUE-123';
    for (const n of names) {
      log.info({ [n]: value }, 'top');
      log.info({ nested: { [n]: value } }, 'nested');
    }
    log.info({ headers: { cookie: value, authorization: value } }, 'headers');
    expect(out).not.toContain(value);
    expect(out).toContain(LOG_CENSOR);
  });
});

describe('health checks', () => {
  it('liveness needs no dependency; readiness says storage and database are up and exposes no secret', async () => {
    expect((await liveRoute()).status).toBe(200);
    const res = await readyRoute();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ status: 'ready', database: 'up', storage: 'up' });
    expect(Object.keys(body.providers).sort()).toEqual(['email', 'payments', 'sms', 'whatsapp']);
    expect(Object.values(body.providers).every((v) => typeof v === 'boolean')).toBe(true); // configured or not: never a credential
    expect(JSON.stringify(body)).not.toMatch(/key|secret|password|token|postgres/i);
  });

  it('readiness turns 503 when object storage is down, without leaking why', async () => {
    setStorageForTests({
      name: 'broken',
      put: async () => { throw new Error('boom: s3 access key AKIA-SECRET'); },
      get: async () => { throw new Error('boom'); },
      delete: async () => { throw new Error('boom'); },
      exists: async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:9000 secret-bucket'); },
    });
    try {
      const res = await readyRoute();
      const body = await res.json();
      expect(res.status).toBe(503);
      expect(body).toMatchObject({ status: 'unavailable', database: 'up', storage: 'down' });
      expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|secret|AKIA/);
    } finally {
      setStorageForTests(undefined);
    }
  });
});

describe('no development shortcuts reach production code', () => {
  const files = walk('src').filter((f) => !f.includes('generated'));
  const text = (f: string) => readFileSync(f, 'utf8');

  it('there are no debug, test or admin-bypass routes', () => {
    const routes = walk('src/app/api').map((f) => f.replace(/\\/g, '/'));
    expect(routes.filter((r) => /\/(debug|test|dev|seed|backdoor|__)/i.test(r))).toEqual([]);
  });

  it('nothing is gated on "not production" to skip a security check', () => {
    const offenders = files.filter((f) => /NODE_ENV\s*!==?\s*['"]production['"][^\n]*(skip|bypass|allow|disable)/i.test(text(f)));
    expect(offenders).toEqual([]);
  });

  it('no hard-coded credentials, keys or provider tokens in the source', () => {
    const patterns = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/, /\bsk_(live|test)_[A-Za-z0-9]{10,}/, /\bghp_[A-Za-z0-9]{30,}/, /\bxox[baprs]-[A-Za-z0-9-]{10,}/, /postgres(ql)?:\/\/[^\s:'"]+:[^\s@'"$]{4,}@(?!localhost|127\.0\.0\.1)/];
    const offenders: string[] = [];
    for (const f of [...files, ...walk('scripts'), 'Dockerfile', 'docker-compose.yml', '.env.example']) {
      let t = '';
      try { t = text(f); } catch { continue; }
      if (patterns.some((p) => p.test(t))) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it('in-memory and console drivers are test/development only: production refuses them', () => {
    const src = text('src/lib/env.ts');
    expect(src).toContain('EMAIL_DRIVER must be "smtp" in production');
    expect(src).toContain('memory SMS/WhatsApp drivers are for tests only');
    expect(src).toContain('PAYFAST_SANDBOX must be false in production');
  });

  it('the .env file is never committed and the example holds placeholders only', () => {
    const ignore = text('.gitignore');
    expect(ignore).toMatch(/^\.env$/m);
    expect(ignore).toMatch(/^\.env\.\*$/m);
    const example = text('.env.example');
    for (const line of example.split(/\r?\n/)) {
      const m = /^([A-Z0-9_]*(SECRET|PASSWORD|KEY|PASSPHRASE|TOKEN)[A-Z0-9_]*)=(.+)$/.exec(line.trim());
      if (m) expect(m[3], m[1]).toMatch(/^(change-me.*|<.*>|your[-_ ].*|replace.*|""|'')$/i);
    }
  });
});

describe('configuration is documented', () => {
  it('every environment variable the application reads appears in .env.example (so a deployment never depends on guesswork)', () => {
    const schema = readFileSync('src/lib/env.ts', 'utf8');
    const keys = [...schema.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(30);
    const example = readFileSync('.env.example', 'utf8');
    const undocumented = keys.filter((k) => !new RegExp(`\\b${k}\\b`).test(example));
    expect(undocumented).toEqual([]);
    // and nothing outside the validated schema is read straight from the environment, except what Next.js itself sets
    const direct = new Set<string>();
    for (const f of [...walk('src'), ...walk('scripts')]) for (const m of readFileSync(f, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) direct.add(m[1]!);
    const allowed = new Set(['NEXT_RUNTIME', 'NODE_ENV', 'LOG_LEVEL', ...keys]);
    expect([...direct].filter((k) => !allowed.has(k) && !/^(MIGRATE_DATABASE_URL|TEST_)/.test(k))).toEqual([]);
  });
});

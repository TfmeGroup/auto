import { z } from 'zod';

/**
 * Typed, validated environment configuration. Server-only: never import this
 * from a client component (nothing here is exposed to the browser).
 *
 * Evaluated lazily so tests can set process.env before first use.
 */

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.url().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // Database. DATABASE_URL = restricted app role (RLS applies).
  // MIGRATE_DATABASE_URL = schema owner, used by migrate/seed scripts only.
  DATABASE_URL: z.string().min(1),
  MIGRATE_DATABASE_URL: z.string().optional(),

  // Auth
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  // Set when running behind a reverse proxy you control (Vercel, nginx, ...).
  TRUST_PROXY: bool.default(false),

  // 32-byte key (base64) that encrypts MFA secrets at rest. Generate: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  MFA_ENCRYPTION_KEY: z.string().optional(),

  // Email
  EMAIL_DRIVER: z.enum(['console', 'smtp', 'memory']).default('console'),
  EMAIL_FROM: z.string().default('TFME Auto <no-reply@localhost>'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_SECURE: bool.default(false),

  // Object storage (private)
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage-data'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default(false),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(100).default(25),

  // Billing
  BILLING_PROVIDER: z.enum(['none', 'payfast']).default('none'),
  PAYFAST_MERCHANT_ID: z.string().optional(),
  PAYFAST_MERCHANT_KEY: z.string().optional(),
  PAYFAST_PASSPHRASE: z.string().optional(),
  PAYFAST_SANDBOX: bool.default(true),
  TRIAL_DAYS: z.coerce.number().int().min(0).max(90).default(14),

  // Short-lived signed download links for private files (32+ bytes, base64). Required in production.
  FILE_SIGNING_KEY: z.string().optional(),
  // Malware scanning: a clamd daemon (host:port). When set, every upload is scanned and uploads fail closed if it is down.
  CLAMAV_HOST: z.string().optional(),
  CLAMAV_PORT: z.coerce.number().int().default(3310),

  // SMS and WhatsApp (optional channels). "none" = not configured: messages for those channels are recorded as skipped.
  SMS_DRIVER: z.enum(['none', 'twilio', 'memory']).default('none'),
  WHATSAPP_DRIVER: z.enum(['none', 'twilio', 'memory']).default('none'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_SMS_FROM: z.string().optional(),
  TWILIO_WHATSAPP_FROM: z.string().optional(),

  // Background jobs
  JOBS_INLINE_WORKER: bool.default(false),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  const e = parsed.data;
  assertProductionSafety(e);
  cached = e;
  return e;
}

/** Fail fast on configurations that must never reach production. */
function assertProductionSafety(e: Env) {
  if (e.NODE_ENV !== 'production') return;
  const problems: string[] = [];
  if (!e.MFA_ENCRYPTION_KEY || Buffer.from(e.MFA_ENCRYPTION_KEY, 'base64').length !== 32)
    problems.push('MFA_ENCRYPTION_KEY (32 bytes, base64) is required in production');
  if (!e.APP_URL.startsWith('https://')) problems.push('APP_URL must be https in production');
  if (!e.FILE_SIGNING_KEY || Buffer.from(e.FILE_SIGNING_KEY, 'base64').length < 32) problems.push('FILE_SIGNING_KEY (at least 32 bytes, base64) is required in production');
  if ((e.SMS_DRIVER === 'twilio' || e.WHATSAPP_DRIVER === 'twilio') && (!e.TWILIO_ACCOUNT_SID || !e.TWILIO_AUTH_TOKEN)) problems.push('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required for the Twilio driver');
  if (e.SMS_DRIVER === 'twilio' && !e.TWILIO_SMS_FROM) problems.push('TWILIO_SMS_FROM is required for SMS');
  if (e.WHATSAPP_DRIVER === 'twilio' && !e.TWILIO_WHATSAPP_FROM) problems.push('TWILIO_WHATSAPP_FROM is required for WhatsApp');
  if (e.SMS_DRIVER === 'memory' || e.WHATSAPP_DRIVER === 'memory') problems.push('The memory SMS/WhatsApp drivers are for tests only');
  if (e.EMAIL_DRIVER !== 'smtp') problems.push('EMAIL_DRIVER must be "smtp" in production');
  if (e.EMAIL_DRIVER === 'smtp' && (!e.SMTP_HOST || !e.SMTP_PORT))
    problems.push('SMTP_HOST and SMTP_PORT are required');
  if (e.STORAGE_DRIVER === 's3' && (!e.S3_BUCKET || !e.S3_ACCESS_KEY_ID || !e.S3_SECRET_ACCESS_KEY))
    problems.push('S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required for s3 storage');
  if (e.BILLING_PROVIDER === 'payfast') {
    if (!e.PAYFAST_MERCHANT_ID || !e.PAYFAST_MERCHANT_KEY || !e.PAYFAST_PASSPHRASE)
      problems.push('PayFast merchant id, key and passphrase are required');
    if (e.PAYFAST_SANDBOX) problems.push('PAYFAST_SANDBOX must be false in production');
  }
  if (problems.length) {
    throw new Error(`Unsafe production configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
}

export function resetEnvForTests() {
  cached = null;
}

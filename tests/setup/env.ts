import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runs in every test worker before any app code reads the environment.
const env = process.env as Record<string, string>;
env.NODE_ENV = 'test';
env.DATABASE_URL = env.TEST_APP_DATABASE_URL ?? '';
env.MIGRATE_DATABASE_URL = env.TEST_OWNER_DATABASE_URL ?? '';
env.APP_URL = 'http://localhost:3000';
env.EMAIL_DRIVER = 'memory';
env.SMS_DRIVER = 'memory';
env.WHATSAPP_DRIVER = 'memory';
env.STORAGE_DRIVER = 'local';
env.STORAGE_LOCAL_DIR = mkdtempSync(join(tmpdir(), 'tfme-auto-files-'));
env.LOG_LEVEL = 'silent';
env.BILLING_PROVIDER = 'none';
env.TRIAL_DAYS = '14';
env.TRUST_PROXY = 'true';
env.MAX_UPLOAD_MB = '2';

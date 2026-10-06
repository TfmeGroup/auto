import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env, resetEnvForTests } from '@/lib/env';

const KEYS = ['FILE_SIGNING_KEY', 'SMS_DRIVER', 'WHATSAPP_DRIVER', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_SMS_FROM', 'MFA_ENCRYPTION_KEY', 'NODE_ENV', 'APP_URL', 'EMAIL_DRIVER', 'SMTP_HOST', 'SMTP_PORT', 'STORAGE_DRIVER', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'BILLING_PROVIDER', 'PAYFAST_MERCHANT_ID', 'PAYFAST_MERCHANT_KEY', 'PAYFAST_PASSPHRASE', 'PAYFAST_SANDBOX', 'DATABASE_URL', 'TRIAL_DAYS'] as const;
const saved: Record<string, string | undefined> = {};
const e = process.env as Record<string, string | undefined>;

beforeEach(() => {
  for (const k of KEYS) saved[k] = e[k];
  resetEnvForTests();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete e[k];
    else e[k] = saved[k];
  }
  resetEnvForTests();
});

const productionBase = () => {
  e.NODE_ENV = 'production';
  e.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  e.FILE_SIGNING_KEY = Buffer.alloc(32, 9).toString('base64');
  e.SMS_DRIVER = 'none';
  e.WHATSAPP_DRIVER = 'none';
  e.APP_URL = 'https://auto.example.com';
  e.EMAIL_DRIVER = 'smtp';
  e.SMTP_HOST = 'smtp.example.com';
  e.SMTP_PORT = '587';
  e.STORAGE_DRIVER = 'local';
  e.BILLING_PROVIDER = 'none';
};

describe('environment configuration', () => {
  it('applies safe defaults and coerces types', () => {
    e.NODE_ENV = 'test';
    e.TRIAL_DAYS = '21';
    expect(env().TRIAL_DAYS).toBe(21);
    expect(env().STORAGE_DRIVER).toBe('local');
  });

  it('fails fast, naming the problem, when required config is missing or invalid', () => {
    delete e.DATABASE_URL;
    expect(() => env()).toThrow(/DATABASE_URL/);
    e.DATABASE_URL = 'postgresql://x';
    resetEnvForTests();
    e.TRIAL_DAYS = '9999';
    expect(() => env()).toThrow(/TRIAL_DAYS/);
  });

  it('accepts a correct production configuration', () => {
    productionBase();
    expect(() => env()).not.toThrow();
  });

  it('refuses unsafe production settings', () => {
    productionBase();
    e.APP_URL = 'http://auto.example.com';
    expect(() => env()).toThrow(/https/);

    resetEnvForTests();
    productionBase();
    e.EMAIL_DRIVER = 'console';
    expect(() => env()).toThrow(/EMAIL_DRIVER/);

    resetEnvForTests();
    productionBase();
    e.STORAGE_DRIVER = 's3';
    expect(() => env()).toThrow(/S3_BUCKET/);

    resetEnvForTests();
    productionBase();
    e.BILLING_PROVIDER = 'payfast';
    expect(() => env()).toThrow(/PayFast/);
    e.PAYFAST_MERCHANT_ID = '1';
    e.PAYFAST_MERCHANT_KEY = 'k';
    e.PAYFAST_PASSPHRASE = 'p';
    e.PAYFAST_SANDBOX = 'true';
    resetEnvForTests();
    expect(() => env()).toThrow(/SANDBOX/);
    e.PAYFAST_SANDBOX = 'false';
    resetEnvForTests();
    expect(() => env()).not.toThrow();
  });
});

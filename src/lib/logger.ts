import pino from 'pino';

/**
 * Structured JSON logging. Secrets and personal data are redacted by path, and
 * callers must never log request bodies, tokens, passwords or file contents.
 * The list is exported so a test can prove each path really is censored.
 */
export const LOG_REDACT_PATHS = [
  'password',
  '*.password',
  'newPassword',
  '*.newPassword',
  'currentPassword',
  '*.currentPassword',
  'passwordHash',
  '*.passwordHash',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'authToken',
  '*.authToken',
  'authorization',
  'headers.authorization',
  'headers.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'cookie',
  'secret',
  '*.secret',
  'credentials',
  '*.credentials',
  'merchant_key',
  'merchantKey',
  '*.merchantKey',
  'passphrase',
  '*.passphrase',
  'apiKey',
  '*.apiKey',
  'mfaSecret',
  '*.mfaSecret',
  'signature',
];

export const LOG_CENSOR = '[redacted]';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  base: { app: 'tfme-auto' },
  redact: { paths: LOG_REDACT_PATHS, censor: LOG_CENSOR },
});

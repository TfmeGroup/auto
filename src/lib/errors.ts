/**
 * Application error types. Anything thrown as an AppError is safe to show to
 * the user (message) — everything else is treated as an internal failure and
 * is logged but never leaked.
 */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'EMAIL_NOT_VERIFIED'
  | 'NO_BUSINESS'
  | 'SUBSCRIPTION_INACTIVE'
  | 'PLAN_LIMIT_REACHED'
  | 'FEATURE_NOT_IN_PLAN'
  | 'MFA_REQUIRED'
  | 'MFA_CHALLENGE'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA'
  | 'CSRF_REJECTED'
  | 'BAD_REQUEST'
  | 'INTERNAL';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  validation: (details: unknown, message = 'Some fields are invalid.') =>
    new AppError('VALIDATION_ERROR', 422, message, details),
  unauthenticated: (message = 'Please sign in to continue.') =>
    new AppError('UNAUTHENTICATED', 401, message),
  forbidden: (message = 'You do not have permission to do that.') =>
    new AppError('FORBIDDEN', 403, message),
  notFound: (what = 'Record') => new AppError('NOT_FOUND', 404, `${what} not found.`),
  conflict: (message: string, details?: unknown) => new AppError('CONFLICT', 409, message, details),
  rateLimited: (retryAfterSec: number) =>
    new AppError('RATE_LIMITED', 429, 'Too many attempts. Please try again later.', { retryAfterSec }),
  emailNotVerified: () =>
    new AppError('EMAIL_NOT_VERIFIED', 403, 'Please verify your email address first.'),
  noBusiness: () =>
    new AppError('NO_BUSINESS', 403, 'Create a business or accept an invitation to continue.'),
  subscriptionInactive: () =>
    new AppError(
      'SUBSCRIPTION_INACTIVE',
      402,
      'Your subscription is inactive. Renew it to make changes; your data is safe and still viewable.',
    ),
  planLimit: (what: string, limit: number) =>
    new AppError('PLAN_LIMIT_REACHED', 402, `Your plan allows up to ${limit} ${what}. Upgrade to add more.`, {
      what,
      limit,
    }),
  tooLarge: (maxMb: number) =>
    new AppError('PAYLOAD_TOO_LARGE', 413, `File is too large (maximum ${maxMb} MB).`),
  unsupportedMedia: (message = 'This file type is not allowed.') =>
    new AppError('UNSUPPORTED_MEDIA', 415, message),
  mfaRequired: () =>
    new AppError('MFA_REQUIRED', 403, 'This business requires two-factor authentication. Turn it on in your account security settings to continue.'),
  csrf: () => new AppError('CSRF_REJECTED', 403, 'Request origin not allowed.'),
  badRequest: (message: string) => new AppError('BAD_REQUEST', 400, message),
};

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

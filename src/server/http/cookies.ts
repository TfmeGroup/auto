import { SESSION_COOKIE, sessionCookieOptions } from '@/server/auth/session';
import type { CookieSpec } from './route';

export const setSessionCookie = (token: string, expires: Date): CookieSpec => ({
  name: SESSION_COOKIE,
  value: token,
  options: sessionCookieOptions(expires),
});

export const clearSessionCookie = (): CookieSpec => ({
  name: SESSION_COOKIE,
  value: '',
  options: sessionCookieOptions(new Date(0)),
});

import { env } from './env';

/** Absolute URL on this app, for links in emails. Path must start with "/". */
export function appUrl(path: string): string {
  return new URL(path, env().APP_URL).toString();
}

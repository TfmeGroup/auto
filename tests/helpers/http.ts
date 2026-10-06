import { SESSION_COOKIE } from '@/server/auth/session';
import { randomIp } from './factory';

type Handler = (req: Request, extra: { params: Promise<Record<string, string>> }) => Promise<Response>;

export interface CallOptions {
  method?: string;
  query?: Record<string, string | number>;
  body?: unknown;
  form?: FormData;
  token?: string;
  params?: Record<string, string>;
  headers?: Record<string, string>;
  /** Defaults to the app's own origin, as a browser would send. Pass null to omit. */
  origin?: string | null;
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
  raw: Response;
}

/** Invoke a real route handler exactly as Next would: Request in, Response out. */
export async function call(handler: Handler, opts: CallOptions = {}): Promise<ApiResponse> {
  const url = new URL('http://localhost:3000/api/test');
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));
  const headers = new Headers(opts.headers);
  if (!headers.has('x-real-ip')) headers.set('x-real-ip', randomIp());
  if (opts.token) headers.set('cookie', `${SESSION_COOKIE}=${opts.token}`);
  if (opts.origin !== null) headers.set('origin', opts.origin ?? 'http://localhost:3000');
  let body: BodyInit | undefined;
  if (opts.form) {
    body = opts.form;
  } else if (opts.body !== undefined) {
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    headers.set('content-type', 'application/json');
  }
  const method = opts.method ?? (body ? 'POST' : 'GET');
  const res = await handler(new Request(url, { method, headers, body }), { params: Promise.resolve(opts.params ?? {}) });
  const text = await res.clone().text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON (file download, plain text)
  }
  return { status: res.status, body: parsed, headers: res.headers, raw: res };
}

/** Pull the session cookie value out of a Set-Cookie header. */
export function sessionTokenFrom(res: ApiResponse): string | undefined {
  const setCookie = res.headers.get('set-cookie') ?? '';
  const m = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(setCookie);
  return m?.[1] || undefined;
}

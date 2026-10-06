/** Browser-side helper for the JSON API. Understands the server's error envelope. */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fields: Record<string, string> = {},
  ) {
    super(message);
  }
}

interface Envelope<T> {
  data?: T;
  meta?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<{ data: T; meta?: unknown }> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  let json: Envelope<T> = {};
  try {
    json = (await res.json()) as Envelope<T>;
  } catch {
    // non-JSON error page
  }
  if (!res.ok) {
    const e = json.error;
    const fields = e?.code === 'VALIDATION_ERROR' && e.details && typeof e.details === 'object' ? (e.details as Record<string, string>) : {};
    throw new ApiError(res.status, e?.code ?? 'ERROR', e?.message ?? 'Something went wrong. Please try again.', fields);
  }
  return { data: json.data as T, meta: json.meta };
}

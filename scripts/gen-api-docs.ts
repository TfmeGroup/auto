/**
 * `npm run docs:api` — regenerate docs/API.md from the route table. Every API handler is declared with route({...}) (see
 * src/server/http/route.ts), so the access rule, permission, plan feature, write-gate and extra rate limit of each endpoint are read
 * straight from the code: the reference cannot claim a protection the code does not have. A test fails if the file is out of date.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = 'src/app/api';

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (f === 'route.ts') out.push(p);
  }
  return out;
}

/** The text of the first {...} object after `from`, honouring nesting and strings. */
function objectAt(text: string, from: number): string {
  const start = text.indexOf('{', from);
  let depth = 0;
  let quote = '';
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start + 1, i);
  }
  return '';
}

export interface Endpoint { method: string; path: string; access: string; permission: string; feature: string; write: boolean; limit: string }

export function endpoints(): Endpoint[] {
  const out: Endpoint[] = [];
  for (const file of walk(ROOT).sort()) {
    const text = readFileSync(file, 'utf8');
    const path = '/' + relative('src/app', file).split(sep).slice(0, -1).join('/').replace(/\[([^\]]+)\]/g, '{$1}');
    for (const m of text.matchAll(/export const (GET|POST|PATCH|PUT|DELETE) = route\(/g)) {
      const opts = objectAt(text, m.index! + m[0].length);
      const get = (re: RegExp) => re.exec(opts)?.[1] ?? '';
      // Both quote styles occur in the route files.
      const access = get(/access:\s*['"](\w+)['"]/);
      const permRaw = /permission:\s*(\[[^\]]*\]|'[^']*'|"[^"]*"|null)/.exec(opts)?.[1] ?? '';
      const permission = access === 'business' ? (permRaw === 'null' ? 'any member' : permRaw.replace(/[[\]'"]/g, '').replace(/,\s*/g, ' or ')) : '';
      const rl = /rateLimit:\s*\{([^}]*)\}/.exec(opts)?.[1] ?? '';
      const by = /by:\s*['"](\w+)['"]/.exec(rl)?.[1];
      const limit = rl ? `${/limit:\s*(\d+)/.exec(rl)?.[1]}/${/windowSec:\s*(\d+)/.exec(rl)?.[1]}s${by ? ` per ${by}` : ''}` : '';
      out.push({ method: m[1]!, path, access, permission, feature: get(/feature:\s*['"](\w+)['"]/), write: /write:\s*true/.test(opts), limit });
    }
  }
  return out;
}

const HEADER = `# API reference

Generated from the route table by \`npm run docs:api\` (a test fails if this file is out of date). It lists every endpoint with the protection the code
applies; it is not a hand-written description of what an endpoint is supposed to do.

## Conventions

* **Base path:** \`/api/v1\` for the application, \`/api/public\` for the customer pages (quote, invoice, job link, receipt, opt-out) and \`/api/webhooks\` for provider callbacks.
* **Authentication:** an HTTP-only session cookie set by sign-in. There are no API keys. \`public\` endpoints need no session: the secret in the link (or the provider's signature) is the credential.
* **Request checks, in order:** request id -> cross-site check (state-changing requests must come from this site) -> session -> email verification -> business membership -> permission -> plan feature -> subscription (writes) -> rate limit. A handler cannot skip a step.
* **Business context:** the active business comes from the session, never from the request. A business id, role, price, balance or status sent in a body is ignored or refused.
* **Responses:** \`{ "data": ..., "meta": ... }\` on success; \`{ "error": { "code", "message", "details" } }\` on failure. Error codes include \`UNAUTHENTICATED\` (401), \`FORBIDDEN\` (403), \`NOT_FOUND\` (404, also used for another business's records), \`VALIDATION_ERROR\` (422, with per-field \`details\`), \`CONFLICT\` (409), \`FEATURE_NOT_IN_PLAN\` and \`PLAN_LIMIT_REACHED\` (402), \`SUBSCRIPTION_INACTIVE\` (402, read-only mode) and \`RATE_LIMITED\` (429 with \`Retry-After\`). Errors never carry stack traces, SQL or file paths; the \`x-request-id\` response header identifies the request in the logs.
* **Pagination:** list endpoints take \`page\` and \`pageSize\` (capped) and return \`meta: { page, pageSize, total, totalPages }\`. Search is ordinary database matching with wildcards treated literally.
* **Idempotency:** endpoints that move money or stock (payments, refunds, goods receipts, stock adjustments, timers) accept an \`idempotencyKey\`; repeating a request with the same key returns the first result and changes nothing. Webhooks are de-duplicated by the provider's event id.
* **Audit:** every state change in a business writes an audit entry (who, what, before/after); the audit log is append-only.

## Columns

* **Access** - \`public\` (link or signature), \`user\` (any signed-in person), \`business\` (a member of the active business), \`platform\` (TFME staff only).
* **Permission** - what the member needs (any one of the listed); \`any member\` means every active member.
* **Plan feature** - the plan entitlement the endpoint requires (402 otherwise).
* **Write** - blocked while the subscription is read-only (expired or suspended).
* **Rate limit** - an additional limit on top of the general per-user and per-address limits.

`;

export function buildApiDocs(): string {
  const all = endpoints();
  const groups = new Map<string, Endpoint[]>();
  for (const e of all) {
    const parts = e.path.split('/').filter(Boolean); // api, v1, resource ...
    const key = parts[1] === 'v1' ? parts[2] ?? 'root' : `${parts[1]}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(e);
  }
  let md = HEADER + `${all.length} endpoints.\n`;
  for (const [key, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    md += `\n## ${key}\n\n| Method | Path | Access | Permission | Plan feature | Write | Rate limit |\n| --- | --- | --- | --- | --- | --- | --- |\n`;
    for (const e of list) md += `| ${e.method} | \`${e.path}\` | ${e.access} | ${e.permission || '-'} | ${e.feature || '-'} | ${e.write ? 'yes' : '-'} | ${e.limit || '-'} |\n`;
  }
  return md;
}

if (process.argv[1] && /gen-api-docs/.test(process.argv[1])) {
  writeFileSync('docs/API.md', buildApiDocs());
  console.log(`docs/API.md written (${endpoints().length} endpoints)`);
}

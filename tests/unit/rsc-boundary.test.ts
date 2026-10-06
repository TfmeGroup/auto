import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A server component (any file without a "use client" directive) must not CALL a function that a "use client" module exports:
 * Next only allows a client module's exports to be rendered as components or passed as props. Calling one fails when the page
 * renders, not at build time and not in a unit test, so the whole page returns a 500. (This is exactly how the Parts list broke.)
 */
const isClient = (text: string) => /^\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/.test(text);

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(f)) out.push(p);
  }
  return out;
}

function resolveModule(from: string, spec: string): string | null {
  const base = spec.startsWith('@/') ? join('src', spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(from), spec) : null;
  if (!base) return null;
  for (const c of [`${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]) if (existsSync(c)) return c;
  return null;
}

/** Violations in one server file: lower-case (non-component) names imported from a client module and then called. */
export function clientCallsInServerFile(file: string, text: string, readTarget: (path: string) => string | null): string[] {
  if (isClient(text)) return [];
  const found: string[] = [];
  const imports = [...text.matchAll(/import\s+(?!type\b)\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g)];
  const body = text.replace(/import[^;]*;/g, '');
  for (const m of imports) {
    const target = resolveModule(file, m[2]!);
    const targetText = target ? readTarget(target) : null;
    if (!targetText || !isClient(targetText)) continue;
    for (const raw of m[1]!.split(',')) {
      const spec = raw.trim();
      if (!spec || spec.startsWith('type ')) continue;
      const local = spec.split(/\s+as\s+/).pop()!.trim();
      // A client module's export may only be RENDERED (<Name ...>). Calling it, mapping with it, reading it as a value or passing it to a
      // function all execute it on the server, which Next refuses when the page renders.
      const uses = [...body.matchAll(new RegExp(`(^|[^\\w.$])${local}(?![\\w$])`, 'g'))];
      const nonJsx = uses.filter((u) => body[u.index! + u[1]!.length - 1] !== '<' && !/<\/?$/.test(body.slice(Math.max(0, u.index! + u[1]!.length - 2), u.index! + u[1]!.length)));
      if (nonJsx.length) found.push(`${file}: uses ${local} as a value, but it is exported by the client module ${m[2]}`);
    }
  }
  return found;
}

describe('server components never call functions exported by client modules', () => {
  it('detects the failure it exists to prevent (a fixture shaped like the original Parts page bug)', () => {
    const client = "'use client';\nexport function categoryOptions() { return []; }\nexport function PartForm() { return null; }\n";
    const page = "import { categoryOptions, PartForm } from '@/components/inventory/PartForm';\nexport default function P() { return <div>{categoryOptions([]).map(() => null)}<PartForm /></div>; }\n";
    const hits = clientCallsInServerFile('src/app/x/page.tsx', page, () => client);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('categoryOptions');
    // passing the function by reference is just as bad as calling it
    const byRef = "import { lineToState } from '@/components/finance/DocumentForm';\nexport default function P({ q }) { return <div>{q.lines.map(lineToState).length}</div>; }\n";
    expect(clientCallsInServerFile('src/app/x/page.tsx', byRef, () => "'use client';\nexport const lineToState = () => 1;\n")).toHaveLength(1);
    // rendering a client component, and calling helpers from a NON-client module, are both fine
    expect(clientCallsInServerFile('src/app/x/page.tsx', "import { PartForm } from '@/components/inventory/PartForm';\nexport default () => <PartForm />;\n", () => client)).toEqual([]);
    expect(clientCallsInServerFile('src/app/x/page.tsx', page, () => "export function categoryOptions() { return []; }")).toEqual([]);
  });

  it('holds for every page, layout, route and component in the application', () => {
    const cache = new Map<string, string>();
    const read = (p: string) => (cache.has(p) ? cache.get(p)! : (cache.set(p, readFileSync(p, 'utf8')), cache.get(p)!));
    const violations = walk('src').flatMap((f) => clientCallsInServerFile(f, read(f), read));
    expect(violations).toEqual([]);
  });
});

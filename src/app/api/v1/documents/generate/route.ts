import { created, ok, readBody, route } from '@/server/http/route';
import { Errors } from '@/lib/errors';
import { ensureDocument, isDocKind } from '@/server/documents/generator';
import { toView } from '@/server/files/service';

export const dynamic = 'force-dynamic';

/** { kind, id, regenerate?, reason?, quoteVersion? } — returns the stored document, making it first if needed. */
export const POST = route({ access: 'business', permission: 'document.view', rateLimit: { name: 'doc-generate', limit: 60, windowSec: 60 } }, async ({ req, ctx }) => {
  const b = (await readBody(req)) as { kind?: string; id?: string; regenerate?: boolean; reason?: string; quoteVersion?: number };
  if (!b.kind || !isDocKind(b.kind)) throw Errors.validation({ kind: 'Choose a document type.' });
  const g = await ensureDocument(ctx, b.kind, b.id ?? '', { regenerate: b.regenerate, reason: b.reason, quoteVersion: b.quoteVersion });
  const out = { file: toView(g.file), created: g.created };
  return g.created ? created(out) : ok(out);
});

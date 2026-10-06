import { logger } from '@/lib/logger';
import { withTenant } from '@/server/db/client';
import { getStorage } from '@/server/storage';
import { generateDocument, KINDS, type DocKind } from './generator';

/**
 * The stored copy of a generated document, as bytes. A quote, receipt or credit note is rendered ONCE, filed, and served from the
 * store after that, so reprinting it years later shows what it showed the day it was made, not today's business details.
 * Returns null if there is no stored copy and one cannot be made (the caller then renders it live, which is always possible).
 */
export async function storedPdf(businessId: string, actorId: string | null, kind: DocKind, entityId: string, opts: { quoteVersion?: number; createIfMissing: boolean }): Promise<{ pdf: Buffer; filename: string } | null> {
  try {
    const def = KINDS[kind];
    let file;
    if (opts.createIfMissing) {
      file = (await generateDocument(businessId, actorId, kind, entityId, { quoteVersion: opts.quoteVersion })).file;
    } else {
      file = await withTenant(businessId, (tx) =>
        tx.file.findFirst({
          where: { businessId, resourceType: def.resourceType, resourceId: entityId, source: 'GENERATED', generatedKind: kind, isCurrent: true, status: { in: ['ACTIVE', 'ARCHIVED'] }, ...(kind === 'quote' && opts.quoteVersion ? { generatedRef: `v${opts.quoteVersion}` } : {}) },
          orderBy: { version: 'desc' },
        }),
      );
    }
    if (!file) return null;
    const { stream } = await getStorage().get(file.storageKey);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    return { pdf: Buffer.concat(chunks), filename: file.originalName };
  } catch (err) {
    logger.warn({ businessId, kind, entityId, err: String(err) }, 'stored document unavailable; rendering live');
    return null;
  }
}

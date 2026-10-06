import { setTenant, withTx, type Tx } from '@/server/db/client';
import { AppError } from '@/lib/errors';
import { generateToken, hashToken } from '@/server/security/crypto';
import { appUrl } from '@/lib/url';

/**
 * Customer links. A customer opens a quote or invoice from an emailed link without signing in. The link carries a
 * 256-bit random token; only its SHA-256 hash is stored, so a database leak cannot be turned into working links.
 * One link opens one document and nothing else. Lookups happen BEFORE the business is known, so they run under a narrow
 * row-level-security rule that lets a request see only the single row whose hash it presents (see migration 0006).
 */

export type LinkKind = 'QUOTE' | 'INVOICE' | 'JOB';
const TTL_DAYS: Record<LinkKind, number> = { QUOTE: 90, INVOICE: 365, JOB: 120 };
const PATH: Record<LinkKind, string> = { QUOTE: 'q', INVOICE: 'i', JOB: 'j' };

/** Create a link for a document. Must run inside withTenant(). Returns the raw token (shown once, in the email). */
export async function createDocumentLink(tx: Tx, businessId: string, kind: LinkKind, documentId: string, createdById: string | null): Promise<{ token: string; url: string }> {
  const token = generateToken(32);
  await tx.documentLink.create({
    data: { businessId, kind, documentId, tokenHash: hashToken(token), createdById, expiresAt: new Date(Date.now() + TTL_DAYS[kind] * 86_400_000) },
  });
  return { token, url: appUrl(`/${PATH[kind]}/${token}`) };
}

/** The same answer for a malformed, unknown, expired or revoked link: it never says which. */
const invalidLink = () => new AppError('NOT_FOUND', 404, 'This link is not valid or is no longer available.');

export type LinkRow = Awaited<ReturnType<Tx['documentLink']['findFirstOrThrow']>>;

/**
 * Run `fn` for the document a link opens, inside a transaction scoped to that document's business. A malformed,
 * unknown, revoked or expired link is simply "not found": the page never says which.
 */
export async function withLink<T>(rawToken: string, kind: LinkKind, fn: (tx: Tx, link: LinkRow) => Promise<T>): Promise<T> {
  if (!/^[A-Za-z0-9_-]{30,80}$/.test(rawToken)) throw invalidLink();
  const hash = hashToken(rawToken);
  return withTx(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.link_hash', ${hash}, true)`;
    const link = await tx.documentLink.findFirst({ where: { tokenHash: hash, kind } });
    if (!link || link.revokedAt || link.expiresAt <= new Date()) throw invalidLink();
    await setTenant(tx, link.businessId);
    const result = await fn(tx, link);
    await tx.documentLink.update({ where: { id: link.id }, data: { lastViewedAt: new Date(), viewCount: { increment: 1 } } });
    return result;
  });
}

/** Revoke every open link for a document (used when it is cancelled). Inside withTenant(). */
export async function revokeDocumentLinks(tx: Tx, businessId: string, kind: LinkKind, documentId: string): Promise<void> {
  await tx.documentLink.updateMany({ where: { businessId, kind, documentId, revokedAt: null }, data: { revokedAt: new Date() } });
}

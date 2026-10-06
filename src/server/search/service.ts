import { z } from 'zod';
import { withTenant } from '@/server/db/client';
import { parseOrThrow } from '@/lib/validation';
import { can } from '@/server/permissions/authorize';
import type { BusinessContext } from '@/server/context';
import { searchProviders, type SearchHit } from './registry';

export const searchQuerySchema = z.object({
  q: z.string().trim().min(2, 'Type at least 2 characters').max(100),
  limit: z.coerce.number().int().min(1).max(10).default(5),
});

export interface SearchGroup {
  key: string;
  label: string;
  items: SearchHit[];
}

/**
 * Search across every module the caller may see. Providers the user lacks
 * permission for are never invoked, and all queries run in the caller's tenant
 * transaction, so results can only come from their own business.
 */
export async function globalSearch(ctx: BusinessContext, query: unknown): Promise<SearchGroup[]> {
  const { q, limit } = parseOrThrow(searchQuerySchema, query);
  const allowed = searchProviders.filter((p) => can(ctx, p.permission));
  if (allowed.length === 0) return [];

  return withTenant(ctx.business.id, async (tx) => {
    const groups: SearchGroup[] = [];
    for (const p of allowed) {
      const items = await p.search(tx, ctx.business.id, q, limit);
      if (items.length > 0) groups.push({ key: p.key, label: p.label, items });
    }
    return groups;
  });
}

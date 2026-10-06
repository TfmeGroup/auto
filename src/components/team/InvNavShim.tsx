import { InventoryNav } from '@/components/inventory/shared';
import { teamTabs } from './nav';
import type { BusinessContext } from '@/server/context';

/** The team area's tab strip (same look as the stock area's). */
export function InvNavShim({ ctx, active }: { ctx: BusinessContext; active: string }) {
  return <InventoryNav tabs={teamTabs(ctx)} active={active} />;
}

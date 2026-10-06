import type { Tx } from '@/server/db/client';
import type { Permission } from '@/server/permissions/catalog';
import { customerSearchProvider } from '@/server/customers/search';
import { vehicleSearchProvider } from '@/server/vehicles/search';
import { bookingSearchProvider } from '@/server/bookings/search';
import { jobSearchProvider } from '@/server/jobcards/search';
import { FINANCE_SEARCH_PROVIDERS } from '@/server/finance/search';
import { INVENTORY_SEARCH_PROVIDERS } from '@/server/inventory/search';

/**
 * Global search is a registry of per-module providers. A module adds itself
 * here (Part 2+: vehicles, jobs, quotes, invoices, payments, parts, suppliers,
 * employees, documents) and the search service takes care of permissions,
 * business isolation, grouping and limits.
 */
export interface SearchHit {
  id: string;
  title: string;
  subtitle?: string;
  href: string;
}

export interface SearchProvider {
  /** Machine key, also the group id in the response. */
  key: string;
  /** Group heading, e.g. "Customers". */
  label: string;
  /** Caller must hold this permission or the provider is skipped entirely. */
  permission: Permission;
  /** Runs inside withTenant(), so RLS already scopes every query to the business. */
  search(tx: Tx, businessId: string, query: string, limit: number): Promise<SearchHit[]>;
}

export const searchProviders: SearchProvider[] = [customerSearchProvider, vehicleSearchProvider, jobSearchProvider, bookingSearchProvider, ...FINANCE_SEARCH_PROVIDERS, ...INVENTORY_SEARCH_PROVIDERS];

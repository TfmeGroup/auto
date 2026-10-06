import type { Prisma, Tx } from '@/server/db/client';
import type { FeatureKey } from '@/server/billing/features';
import type { Permission } from '@/server/permissions/catalog';
import type { BusinessContext } from '@/server/context';

/**
 * Reports are DEFINITIONS: a key, who may run it, which filters it accepts, and one function that reads the real
 * transactional tables. The framework (run.ts) does everything else: permissions, plan, validation of filters, removing columns
 * the caller may not see, pagination limits, auditing and export. A report never stores a summary row.
 */

export type ColType = 'text' | 'int' | 'money' | 'pct' | 'date' | 'datetime' | 'hours' | 'status';

export interface Column {
  key: string;
  label: string;
  type: ColType;
  /** Held permission needed to see this column; the framework removes the column (and any metric with the same key) otherwise. */
  needs?: Permission;
  /** Link the cell to a record page: `/customers/{value of idKey}`. */
  link?: { path: string; idKey: string };
}

export interface Metric {
  key: string;
  label: string;
  value: number | string | null;
  type: ColType;
  hint?: string;
  needs?: Permission;
  /** Set only when the number is a warning (e.g. overdue). Text is always shown too; colour is never the only signal. */
  tone?: 'warn' | 'danger' | 'ok';
}

export interface ChartSpec {
  kind: 'bar' | 'line';
  title: string;
  unit: 'money' | 'int' | 'pct' | 'hours';
  x: string[];
  series: { name: string; values: (number | null)[]; needs?: Permission }[];
}

export interface ReportResult {
  key: string;
  title: string;
  category: ReportCategory;
  range: { preset: string; from: string; to: string; timezone: string } | null;
  columns: Column[];
  rows: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
  paged: boolean;
  summary: Metric[];
  charts: ChartSpec[];
  notes: string[];
  appliedFilters: Record<string, string | number | string[]>;
  generatedAt: string;
  currency: string;
  locale: string;
}

export type ReportCategory = 'financial' | 'jobs' | 'bookings' | 'customers' | 'vehicles' | 'technicians' | 'inventory' | 'suppliers' | 'profitability' | 'vat';

export const CATEGORY_LABEL: Record<ReportCategory, string> = {
  financial: 'Financial', jobs: 'Jobs', bookings: 'Bookings', customers: 'Customers', vehicles: 'Vehicles', technicians: 'Technicians and labour',
  inventory: 'Inventory', suppliers: 'Suppliers and purchasing', profitability: 'Profitability', vat: 'VAT and accounting exports',
};

export type FilterKey =
  | 'range' | 'location' | 'customer' | 'technician' | 'vehicle' | 'serviceType' | 'jobStatus' | 'bookingStatus' | 'quoteStatus' | 'invoiceStatus'
  | 'paymentMethod' | 'supplier' | 'part' | 'category' | 'make' | 'model' | 'year' | 'vehicleStatus' | 'customerStatus' | 'stockStatus' | 'movementType' | 'poStatus' | 'bucket' | 'search' | 'docType';

/** Every query-string parameter a report may receive, already validated. A definition only sees the ones it lists in `filters`. */
export interface Params {
  preset: string;
  from?: string;
  to?: string;
  locationIds: string[];
  customerId?: string;
  technicianId?: string;
  vehicleId?: string;
  serviceTypeId?: string;
  jobStatus?: string;
  bookingStatus?: string;
  quoteStatus?: string;
  invoiceStatus?: string;
  paymentMethod?: string;
  supplierId?: string;
  partId?: string;
  categoryId?: string;
  make?: string;
  model?: string;
  year?: number;
  vehicleStatus?: string;
  customerStatus?: string;
  stockStatus?: string;
  movementType?: string;
  poStatus?: string;
  bucket?: string;
  search?: string;
  docType?: string;
  groupBy?: string;
  page: number;
  pageSize: number;
}

export interface Range {
  preset: string;
  from: string;
  to: string;
  /** [start, end) as instants in the business time zone. */
  start: Date;
  end: Date;
}

export interface RunEnv {
  tx: Tx;
  ctx: BusinessContext;
  params: Params;
  range: Range;
  /** `AND (alias.location_id IS NULL OR alias.location_id = ANY(visible)) AND alias.location_id = ANY(selected)`; empty when unrestricted. */
  loc(alias: string, opts?: { column?: string; includeNull?: boolean }): Prisma.Sql;
  /** Locations the caller may use (null = all). */
  scope: string[] | null;
  config: { slowMovingDays: number; lapsedCustomerDays: number };
  can(p: Permission): boolean;
  /** SQL fragment helpers that return an empty clause when the value is absent. */
  eq(column: string, value: string | number | undefined, cast?: string): Prisma.Sql;
  today: string;
}

export interface RunOutput {
  columns: Column[];
  rows: Record<string, unknown>[];
  /** Rows matching before pagination (for a paged report). Defaults to rows.length. */
  total?: number;
  summary?: Metric[];
  charts?: ChartSpec[];
  notes?: string[];
}

export interface ReportDef {
  key: string;
  title: string;
  description: string;
  category: ReportCategory;
  /** All must be held. */
  permissions: Permission[];
  feature?: FeatureKey;
  filters: FilterKey[];
  groupBys?: { key: string; label: string }[];
  /** Server paginates; the run function receives page/pageSize through env.params. */
  paged?: boolean;
  /** Takes a date range. */
  dated: boolean;
  /** Which report a "financial" export is allowed for (audited as sensitive). */
  sensitive?: boolean;
  /** Hide from CSV/Excel/PDF export (never the case today; kept so a report can opt out). */
  noExport?: boolean;
  /** Extra permission needed to EXPORT (custom reports derive it from their data source); null = none beyond report.export. */
  exportNeeds?: Permission | null;
  run(env: RunEnv): Promise<RunOutput>;
}

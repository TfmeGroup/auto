import { Prisma } from '@/server/db/client';
import type { FeatureKey } from '@/server/billing/features';
import type { Permission } from '@/server/permissions/catalog';
import { localDate } from '../defs/util';
import type { ColType } from '../types';

/**
 * THE approved reporting schema. A custom report can only choose from what is listed here: a data source, its fields, and the
 * operators that make sense for each field's type. Nothing a person types ever becomes SQL: the compiler writes SQL from these
 * definitions and passes every value as a bound parameter.
 *
 * Deliberately NOT here (so no custom report can read them, whatever the permissions): passwords, sessions, tokens, MFA data,
 * provider credentials, security events, customers' contact details, and private employee data.
 * A field with `needs` is hidden from, and refused to, anyone without that permission. Sources apply the same rule at source level.
 */

export interface SchemaCtx {
  today: string;
  tz: string;
  bid: string;
  /** Locations the caller may use (null = all); stock quantities are summed over these only. */
  scope: string[] | null;
}

export type FieldType = ColType | 'bool';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  /** Expression over the source's aliases. */
  sql: (c: SchemaCtx) => Prisma.Sql;
  /** Allowed values (a fixed pick-list); the cast tells Postgres the enum type when filtering. */
  values?: { value: string; label: string }[];
  cast?: string;
  needs?: Permission;
  /** Can be summed / averaged. */
  numeric?: boolean;
  /** Can be grouped by (not free text like notes). */
  groupable?: boolean;
}

export interface SourceDef {
  key: string;
  label: string;
  description: string;
  permissions: Permission[];
  feature?: FeatureKey;
  /** FROM + joins. Every table is joined on business_id as well as id. */
  from: (c: SchemaCtx) => Prisma.Sql;
  /** Always-on predicates (tenant, archived, finalised ...). */
  where: (c: SchemaCtx) => Prisma.Sql;
  /** The date field the report's date range applies to. */
  dateField: string;
  /** Alias of the table whose location_id limits rows, and whether rows with no location stay visible. */
  location?: { alias: string; includeNull: boolean };
  fields: FieldDef[];
}

const raw = Prisma.raw;
const f = (key: string, label: string, type: FieldType, sql: (c: SchemaCtx) => Prisma.Sql, extra: Partial<FieldDef> = {}): FieldDef => ({ key, label, type, sql, ...extra });
const col = (expr: string) => () => raw(expr);
const text = (key: string, label: string, expr: string, extra: Partial<FieldDef> = {}) => f(key, label, 'text', col(expr), { groupable: true, ...extra });
const int = (key: string, label: string, expr: string, extra: Partial<FieldDef> = {}) => f(key, label, 'int', col(expr), { numeric: true, ...extra });
const money = (key: string, label: string, expr: string, extra: Partial<FieldDef> = {}) => f(key, label, 'money', col(expr), { numeric: true, ...extra });
const date = (key: string, label: string, expr: string, extra: Partial<FieldDef> = {}) => f(key, label, 'date', (c) => localDate(expr, c.tz), { groupable: true, ...extra });
const dateCol = (key: string, label: string, expr: string, extra: Partial<FieldDef> = {}) => f(key, label, 'date', col(expr), { groupable: true, ...extra });
const status = (key: string, label: string, expr: string, cast: string, values: string[], extra: Partial<FieldDef> = {}) =>
  f(key, label, 'status', () => raw(`${expr}::text`), { groupable: true, cast, values: values.map((v) => ({ value: v, label: v.replace(/_/g, ' ').toLowerCase().replace(/^./, (s) => s.toUpperCase()) })), ...extra });

const JOB_STATUS = ['BOOKED', 'CHECKED_IN', 'INSPECTION', 'DIAGNOSIS', 'AWAITING_APPROVAL', 'APPROVED', 'AWAITING_PARTS', 'IN_PROGRESS', 'QUALITY_CHECK', 'READY_FOR_COLLECTION', 'COMPLETED', 'CANCELLED', 'ON_HOLD'];
const BOOKING_STATUS = ['REQUESTED', 'CONFIRMED', 'REMINDER_SENT', 'CHECKED_IN', 'NO_SHOW', 'CANCELLED', 'RESCHEDULED', 'COMPLETED'];
const QUOTE_STATUS = ['DRAFT', 'SENT', 'VIEWED', 'APPROVED', 'DECLINED', 'EXPIRED', 'CONVERTED', 'CANCELLED'];
const METHODS = ['ONLINE', 'CARD', 'EFT', 'CASH', 'OTHER'];
const PRIORITY = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const PO_STATUS = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'];
const MOVEMENT = ['RECEIVED', 'SOLD', 'USED', 'RESERVED', 'UNRESERVED', 'RETURNED', 'ADJUSTED', 'DAMAGED', 'LOST', 'TRANSFER_IN', 'TRANSFER_OUT', 'SUPPLIER_RETURN'];
const VEHICLE_STATUS = ['ACTIVE', 'AWAITING_SERVICE', 'IN_WORKSHOP', 'AWAITING_PARTS', 'REPAIR_REQUIRED', 'INACTIVE'];

/** Per-invoice status, one word: cancelled > written off > paid > overdue > partially paid > unpaid. */
const invoiceStatus = (c: SchemaCtx) => Prisma.sql`(CASE WHEN i.cancelled_at IS NOT NULL THEN 'CANCELLED' WHEN i.written_off_at IS NOT NULL THEN 'WRITTEN_OFF' WHEN i.outstanding_cents <= 0 THEN 'PAID'
  WHEN i.due_date IS NOT NULL AND i.due_date < ${c.today}::date THEN 'OVERDUE' WHEN i.outstanding_cents < i.total_cents THEN 'PARTIALLY_PAID' ELSE 'UNPAID' END)`;

const stockSum = (c: SchemaCtx, column: 'on_hand' | 'reserved') =>
  Prisma.sql`(SELECT COALESCE(SUM(sl.${raw(column)}),0)::int FROM stock_levels sl WHERE sl.part_id = p.id AND sl.business_id = p.business_id ${c.scope ? Prisma.sql`AND sl.location_id = ANY(${c.scope}::uuid[])` : Prisma.empty})`;

export const SOURCES: SourceDef[] = [
  {
    key: 'jobs', label: 'Jobs', description: 'Job cards: status, customer, vehicle, technician and (with permission) invoiced value.', permissions: ['job.view'], dateField: 'opened', location: { alias: 'jc', includeNull: true },
    from: () => Prisma.sql`job_cards jc JOIN customers c ON c.id = jc.customer_id AND c.business_id = jc.business_id JOIN vehicles v ON v.id = jc.vehicle_id AND v.business_id = jc.business_id
      LEFT JOIN memberships m ON m.id = jc.primary_technician_membership_id LEFT JOIN users u ON u.id = m.user_id LEFT JOIN locations l ON l.id = jc.location_id`,
    where: (c) => Prisma.sql`jc.business_id = ${c.bid}::uuid`,
    fields: [
      text('jobNumber', 'Job number', 'jc.job_number'), date('opened', 'Opened', 'jc.opened_at'), date('completed', 'Completed', 'jc.completed_at'),
      status('status', 'Status', 'jc.status', 'job_card_status', JOB_STATUS), status('priority', 'Priority', 'jc.priority', 'job_priority', PRIORITY),
      text('service', 'Service', 'jc.service_label'), text('customer', 'Customer', 'c.name'), text('customerNumber', 'Customer number', 'c.customer_number'),
      text('registration', 'Vehicle registration', 'v.registration'), text('make', 'Vehicle make', 'v.make'), text('model', 'Vehicle model', 'v.model'), int('year', 'Vehicle year', 'v.year', { groupable: true, numeric: false }),
      text('technician', 'Technician', 'u.name'), text('location', 'Location', 'l.name'), int('mileageIn', 'Mileage in (km)', 'jc.mileage_in_km'), int('mileageOut', 'Mileage out (km)', 'jc.mileage_out_km'),
      f('walkIn', 'Walk-in', 'bool', col('jc.is_walk_in'), { groupable: true }),
      f('invoiced', 'Invoiced (ex VAT)', 'money', () => Prisma.sql`(SELECT COALESCE(SUM(i.taxable_cents),0)::bigint FROM invoices i WHERE i.job_id = jc.id AND i.business_id = jc.business_id AND i.finalised_at IS NOT NULL AND i.cancelled_at IS NULL)`, { numeric: true, needs: 'finance.view_reports' }),
    ],
  },
  {
    key: 'bookings', label: 'Bookings', description: 'Appointments: time, service, status, technician and duration.', permissions: ['booking.view'], dateField: 'startDate', location: { alias: 'b', includeNull: true },
    from: () => Prisma.sql`bookings b JOIN customers c ON c.id = b.customer_id AND c.business_id = b.business_id JOIN vehicles v ON v.id = b.vehicle_id AND v.business_id = b.business_id
      LEFT JOIN memberships m ON m.id = b.technician_membership_id LEFT JOIN users u ON u.id = m.user_id LEFT JOIN locations l ON l.id = b.location_id`,
    where: (c) => Prisma.sql`b.business_id = ${c.bid}::uuid`,
    fields: [
      text('bookingNumber', 'Booking number', 'b.booking_number'), date('startDate', 'Appointment day', 'b.starts_at'), f('startHour', 'Appointment hour', 'int', (c) => Prisma.sql`EXTRACT(HOUR FROM (b.starts_at AT TIME ZONE ${c.tz}))::int`, { groupable: true }),
      status('status', 'Status', 'b.status', 'booking_status', BOOKING_STATUS), text('service', 'Service', 'b.service_label'), text('customer', 'Customer', 'c.name'),
      text('registration', 'Vehicle registration', 'v.registration'), text('technician', 'Technician', 'u.name'), text('location', 'Location', 'l.name'),
      int('durationMin', 'Duration (minutes)', 'b.duration_min'), f('walkIn', 'Walk-in', 'bool', col('b.is_walk_in'), { groupable: true }), date('created', 'Booked on', 'b.created_at'),
    ],
  },
  {
    key: 'customers', label: 'Customers', description: 'Customer records (no contact details), with job counts and spend.', permissions: ['customer.view'], dateField: 'created',
    from: () => Prisma.sql`customers c`, where: (c) => Prisma.sql`c.business_id = ${c.bid}::uuid AND c.status <> 'ARCHIVED'`,
    fields: [
      text('customerNumber', 'Customer number', 'c.customer_number'), text('name', 'Name', 'c.name'), status('type', 'Type', 'c.type', 'customer_type', ['INDIVIDUAL', 'BUSINESS']),
      status('status', 'Status', 'c.status', 'customer_status', ['ACTIVE', 'INACTIVE']), text('city', 'City', 'c.city'), text('province', 'Province', 'c.province'), date('created', 'Customer since', 'c.created_at'),
      f('jobs', 'Jobs', 'int', () => Prisma.sql`(SELECT COUNT(*)::int FROM job_cards j WHERE j.customer_id = c.id AND j.business_id = c.business_id AND j.status <> 'CANCELLED')`, { numeric: true }),
      f('vehicles', 'Vehicles', 'int', () => Prisma.sql`(SELECT COUNT(*)::int FROM vehicles v WHERE v.customer_id = c.id AND v.business_id = c.business_id AND v.archived_at IS NULL)`, { numeric: true }),
      f('lastVisit', 'Last visit', 'date', (c) => Prisma.sql`(SELECT MAX(${localDate('j.opened_at', c.tz)}) FROM job_cards j WHERE j.customer_id = c.id AND j.business_id = c.business_id AND j.status <> 'CANCELLED')`, { groupable: true }),
      f('spend', 'Spend (ex VAT)', 'money', () => Prisma.sql`(SELECT COALESCE(SUM(i.taxable_cents),0)::bigint FROM invoices i WHERE i.customer_id = c.id AND i.business_id = c.business_id AND i.finalised_at IS NOT NULL AND i.cancelled_at IS NULL)`, { numeric: true, needs: 'finance.view_reports' }),
      f('owing', 'Owes now', 'money', () => Prisma.sql`(SELECT COALESCE(SUM(i.outstanding_cents),0)::bigint FROM invoices i WHERE i.customer_id = c.id AND i.business_id = c.business_id AND i.finalised_at IS NOT NULL AND i.cancelled_at IS NULL AND i.written_off_at IS NULL)`, { numeric: true, needs: 'finance.view_reports' }),
    ],
  },
  {
    key: 'vehicles', label: 'Vehicles', description: 'Vehicles with owner, status, mileage and job counts.', permissions: ['vehicle.view'], dateField: 'created',
    from: () => Prisma.sql`vehicles v JOIN customers c ON c.id = v.customer_id AND c.business_id = v.business_id`, where: (c) => Prisma.sql`v.business_id = ${c.bid}::uuid AND v.archived_at IS NULL`,
    fields: [
      text('registration', 'Registration', 'v.registration'), text('vin', 'VIN', 'v.vin'), text('make', 'Make', 'v.make'), text('model', 'Model', 'v.model'), int('year', 'Year', 'v.year', { groupable: true, numeric: false }),
      text('colour', 'Colour', 'v.colour'), status('status', 'Status', 'v.status', 'vehicle_status', VEHICLE_STATUS), int('mileage', 'Mileage (km)', 'v.mileage_km'), text('owner', 'Owner', 'c.name'), date('created', 'Added', 'v.created_at'),
      f('jobs', 'Jobs', 'int', () => Prisma.sql`(SELECT COUNT(*)::int FROM job_cards j WHERE j.vehicle_id = v.id AND j.business_id = v.business_id AND j.status <> 'CANCELLED')`, { numeric: true }),
    ],
  },
  {
    key: 'quotes', label: 'Quotes', description: 'Quotes with status, customer and value.', permissions: ['quote.view', 'finance.view_reports'], dateField: 'quoteDate', location: { alias: 'q', includeNull: true },
    from: () => Prisma.sql`quotes q JOIN customers c ON c.id = q.customer_id AND c.business_id = q.business_id LEFT JOIN locations l ON l.id = q.location_id`, where: (c) => Prisma.sql`q.business_id = ${c.bid}::uuid`,
    fields: [
      text('number', 'Quote number', 'q.number'), dateCol('quoteDate', 'Quote date', 'q.quote_date'), dateCol('validUntil', 'Valid until', 'q.valid_until'), status('status', 'Status', 'q.status', 'quote_status', QUOTE_STATUS),
      text('customer', 'Customer', 'c.name'), text('location', 'Location', 'l.name'), money('total', 'Total (incl. VAT)', 'q.total_cents'),
    ],
  },
  {
    key: 'invoices', label: 'Invoices', description: 'Issued invoices with status, amounts and what is still owed.', permissions: ['invoice.view', 'finance.view_reports'], dateField: 'invoiceDate', location: { alias: 'i', includeNull: true },
    from: () => Prisma.sql`invoices i JOIN customers c ON c.id = i.customer_id AND c.business_id = i.business_id LEFT JOIN vehicles v ON v.id = i.vehicle_id AND v.business_id = i.business_id LEFT JOIN locations l ON l.id = i.location_id`,
    where: (c) => Prisma.sql`i.business_id = ${c.bid}::uuid AND i.finalised_at IS NOT NULL`,
    fields: [
      text('number', 'Invoice number', 'i.number'), dateCol('invoiceDate', 'Invoice date', 'i.invoice_date'), dateCol('dueDate', 'Due date', 'i.due_date'),
      f('status', 'Status', 'status', invoiceStatus, { groupable: true, values: ['PAID', 'PARTIALLY_PAID', 'UNPAID', 'OVERDUE', 'CANCELLED', 'WRITTEN_OFF'].map((v) => ({ value: v, label: v.replace(/_/g, ' ').toLowerCase().replace(/^./, (s) => s.toUpperCase()) })) }),
      text('customer', 'Customer', 'c.name'), text('registration', 'Vehicle registration', 'v.registration'), text('location', 'Location', 'l.name'),
      money('taxable', 'Amount ex VAT', 'i.taxable_cents'), money('vat', 'VAT', 'i.vat_cents'), money('total', 'Total (incl. VAT)', 'i.total_cents'), money('outstanding', 'Outstanding', 'i.outstanding_cents'),
    ],
  },
  {
    key: 'payments', label: 'Payments', description: 'Payments received with method, amount and the invoice they paid.', permissions: ['payment.view', 'finance.view_reports'], dateField: 'paidDate', location: { alias: 'i', includeNull: true },
    from: () => Prisma.sql`payments p JOIN customers c ON c.id = p.customer_id AND c.business_id = p.business_id LEFT JOIN invoices i ON i.id = p.invoice_id AND i.business_id = p.business_id`,
    where: (c) => Prisma.sql`p.business_id = ${c.bid}::uuid AND p.status IN ('COMPLETED','PARTIALLY_REFUNDED','REFUNDED')`,
    fields: [
      text('number', 'Payment number', 'p.number'), date('paidDate', 'Date paid', 'p.paid_at'), status('method', 'Method', 'p.method', 'payment_method', METHODS), text('customer', 'Customer', 'c.name'), text('invoice', 'Invoice', 'i.number'),
      money('amount', 'Amount', 'p.amount_cents'), money('applied', 'Against invoice', 'p.applied_cents'), money('credited', 'To customer credit', 'p.credited_cents'),
    ],
  },
  {
    key: 'parts', label: 'Parts', description: 'The parts catalogue with stock levels (for the locations you may use).', permissions: ['inventory.view'], dateField: 'created',
    from: () => Prisma.sql`parts p LEFT JOIN part_categories cat ON cat.id = p.category_id AND cat.business_id = p.business_id LEFT JOIN suppliers s ON s.id = p.primary_supplier_id AND s.business_id = p.business_id`,
    where: (c) => Prisma.sql`p.business_id = ${c.bid}::uuid AND p.status <> 'ARCHIVED'`,
    fields: [
      text('sku', 'SKU', 'p.sku'), text('name', 'Name', 'p.name'), text('partNumber', 'Part number', 'p.part_number'), text('brand', 'Brand', 'p.brand'), text('category', 'Category', 'cat.name'), text('supplier', 'Primary supplier', 's.name'),
      status('status', 'Status', 'p.status', 'inventory_status', ['ACTIVE', 'INACTIVE']), date('created', 'Added', 'p.created_at'), int('minStock', 'Minimum stock', 'p.min_stock'), int('reorderLevel', 'Reorder level', 'p.reorder_level'),
      f('onHand', 'On hand', 'int', (c) => stockSum(c, 'on_hand'), { numeric: true }), f('reserved', 'Reserved', 'int', (c) => stockSum(c, 'reserved'), { numeric: true }),
      f('available', 'Available', 'int', (c) => Prisma.sql`(${stockSum(c, 'on_hand')} - ${stockSum(c, 'reserved')})`, { numeric: true }),
      money('sellPrice', 'Sell price', 'p.sell_price_cents'), money('cost', 'Cost price', 'p.cost_cents', { needs: 'inventory.view_costs' }),
      f('stockValue', 'Stock value (at cost)', 'money', (c) => Prisma.sql`(${stockSum(c, 'on_hand')}::bigint * COALESCE(p.cost_cents, 0))`, { numeric: true, needs: 'inventory.view_costs' }),
    ],
  },
  {
    key: 'stock_movements', label: 'Stock movements', description: 'The stock ledger: every change to stock.', permissions: ['inventory.view'], feature: 'inventory_reports', dateField: 'date', location: { alias: 'm', includeNull: false },
    from: () => Prisma.sql`stock_movements m JOIN parts p ON p.id = m.part_id AND p.business_id = m.business_id LEFT JOIN locations l ON l.id = m.location_id LEFT JOIN job_cards j ON j.id = m.job_id AND j.business_id = m.business_id`,
    where: (c) => Prisma.sql`m.business_id = ${c.bid}::uuid`,
    fields: [
      date('date', 'Date', 'm.created_at'), text('sku', 'SKU', 'p.sku'), text('part', 'Part', 'p.name'), status('type', 'Movement', 'm.type', 'stock_movement_type', MOVEMENT), int('change', 'Change in stock', 'm.on_hand_delta'),
      text('location', 'Location', 'l.name'), text('reason', 'Reason', 'm.reason'), text('job', 'Job', 'j.job_number'), money('unitCost', 'Unit cost', 'm.unit_cost_cents', { needs: 'inventory.view_costs' }),
    ],
  },
  {
    key: 'purchase_orders', label: 'Purchase orders', description: 'Purchase orders with supplier, status and value.', permissions: ['inventory.purchase'], feature: 'purchase_orders', dateField: 'poDate', location: { alias: 'po', includeNull: false },
    from: () => Prisma.sql`purchase_orders po JOIN suppliers s ON s.id = po.supplier_id AND s.business_id = po.business_id LEFT JOIN locations l ON l.id = po.location_id`,
    where: (c) => Prisma.sql`po.business_id = ${c.bid}::uuid`,
    fields: [
      text('number', 'Order number', 'po.number'), dateCol('poDate', 'Order date', 'po.po_date'), dateCol('expected', 'Expected', 'po.expected_date'), text('supplier', 'Supplier', 's.name'),
      status('status', 'Status', 'po.status', 'purchase_order_status', PO_STATUS), text('location', 'Location', 'l.name'), money('total', 'Total (incl. VAT)', 'po.total_cents', { needs: 'inventory.view_costs' }),
    ],
  },
  {
    key: 'time_entries', label: 'Time entries', description: 'Recorded work time by technician and job.', permissions: ['time.view_all'], dateField: 'date', location: { alias: 'j', includeNull: true },
    from: () => Prisma.sql`time_entries te JOIN job_cards j ON j.id = te.job_id AND j.business_id = te.business_id LEFT JOIN memberships m ON m.id = te.membership_id LEFT JOIN users u ON u.id = m.user_id`,
    where: (c) => Prisma.sql`te.business_id = ${c.bid}::uuid AND te.status = 'COMPLETED'`,
    fields: [
      date('date', 'Date', 'te.started_at'), text('technician', 'Technician', 'u.name'), text('job', 'Job', 'j.job_number'), text('service', 'Service', 'j.service_label'),
      f('hours', 'Hours', 'hours', () => Prisma.sql`ROUND(te.duration_minutes / 60.0, 2)`, { numeric: true }), f('billable', 'Billable', 'bool', col('te.billable'), { groupable: true }),
    ],
  },
  {
    key: 'employees', label: 'Team members', description: 'Names, roles, status and join dates. No contact details or personal data.', permissions: ['employee.view'], dateField: 'joined', feature: 'advanced_reports',
    from: () => Prisma.sql`memberships m JOIN users u ON u.id = m.user_id JOIN roles r ON r.id = m.role_id`, where: (c) => Prisma.sql`m.business_id = ${c.bid}::uuid AND m.user_id IS NOT NULL`,
    fields: [
      text('name', 'Name', 'u.name'), text('role', 'Role', 'r.name'), status('status', 'Status', 'm.status', 'membership_status', ['ACTIVE', 'SUSPENDED']), date('joined', 'Joined', 'm.joined_at'),
      money('labourCost', 'Labour cost per hour', 'm.labour_cost_cents_per_hour', { needs: 'labour.view_costs' }),
    ],
  },
];

export const sourceDef = (key: string) => SOURCES.find((s) => s.key === key);

/** What the builder UI may show this person: only sources and fields they are allowed to use. */
export function schemaFor(has: (p: Permission) => boolean, features: ReadonlySet<FeatureKey>) {
  return SOURCES.filter((s) => s.permissions.every(has)).map((s) => ({
    key: s.key, label: s.label, description: s.description, dateField: s.dateField, locked: s.feature ? !features.has(s.feature) : false, hasLocation: !!s.location,
    fields: s.fields.filter((f) => !f.needs || has(f.needs)).map((f) => ({ key: f.key, label: f.label, type: f.type, values: f.values ?? null, numeric: !!f.numeric, groupable: !!f.groupable })),
  }));
}

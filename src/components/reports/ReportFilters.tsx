import Link from 'next/link';
import { Button, Card, Field, Input, Select } from '@/components/ui';
import { PRESETS, PRESET_LABEL } from '@/server/reports/range';
import type { FilterOptions } from '@/server/reports/options';
import type { FilterKey } from '@/server/reports/types';

const enumOptions = {
  jobStatus: ['BOOKED', 'CHECKED_IN', 'INSPECTION', 'DIAGNOSIS', 'AWAITING_APPROVAL', 'APPROVED', 'AWAITING_PARTS', 'IN_PROGRESS', 'QUALITY_CHECK', 'READY_FOR_COLLECTION', 'COMPLETED', 'CANCELLED', 'ON_HOLD'],
  bookingStatus: ['REQUESTED', 'CONFIRMED', 'REMINDER_SENT', 'CHECKED_IN', 'NO_SHOW', 'CANCELLED', 'RESCHEDULED', 'COMPLETED'],
  quoteStatus: ['DRAFT', 'SENT', 'VIEWED', 'APPROVED', 'DECLINED', 'EXPIRED', 'CONVERTED', 'CANCELLED'],
  invoiceStatus: ['UNPAID', 'PARTIALLY_PAID', 'OVERDUE', 'PAID', 'CANCELLED', 'WRITTEN_OFF'],
  paymentMethod: ['ONLINE', 'CARD', 'EFT', 'CASH', 'OTHER'],
  vehicleStatus: ['ACTIVE', 'AWAITING_SERVICE', 'IN_WORKSHOP', 'AWAITING_PARTS', 'REPAIR_REQUIRED', 'INACTIVE'],
  customerStatus: ['ACTIVE', 'INACTIVE'],
  stockStatus: ['OK', 'LOW', 'OUT'],
  movementType: ['RECEIVED', 'SOLD', 'USED', 'RESERVED', 'UNRESERVED', 'RETURNED', 'ADJUSTED', 'DAMAGED', 'LOST', 'TRANSFER_IN', 'TRANSFER_OUT', 'SUPPLIER_RETURN'],
  poStatus: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'],
  bucket: ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'],
  docType: ['INVOICE', 'CREDIT_NOTE', 'PAYMENT', 'REFUND'],
} as const;
const nice = (s: string) => ({ d1_30: '1–30 days overdue', d31_60: '31–60 days overdue', d61_90: '61–90 days overdue', d90_plus: '90+ days overdue', current: 'Current' } as Record<string, string>)[s] ?? s.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
const LABEL: Partial<Record<FilterKey, string>> = {
  jobStatus: 'Job status', bookingStatus: 'Booking status', quoteStatus: 'Quote status', invoiceStatus: 'Invoice status', paymentMethod: 'Payment method', vehicleStatus: 'Vehicle status',
  customerStatus: 'Customer status', stockStatus: 'Stock level', movementType: 'Movement', poStatus: 'Order status', bucket: 'Age', docType: 'Record type',
};
const PARAM: Partial<Record<FilterKey, string>> = { jobStatus: 'jobStatus', bookingStatus: 'bookingStatus', quoteStatus: 'quoteStatus', invoiceStatus: 'invoiceStatus', paymentMethod: 'paymentMethod', vehicleStatus: 'vehicleStatus', customerStatus: 'customerStatus', stockStatus: 'stockStatus', movementType: 'movementType', poStatus: 'poStatus', bucket: 'bucket', docType: 'docType' };

/**
 * The filter form for one report. Only the filters that report declares are drawn (nothing irrelevant), every control has a visible label, and
 * the form is a plain GET: the URL holds the filters, so a view can be bookmarked, shared or saved.
 */
export function ReportFilters({ reportKey, filters, groupBys, options, query, basePath }: {
  reportKey: string;
  filters: FilterKey[];
  groupBys: { key: string; label: string }[];
  options: FilterOptions;
  query: Record<string, string | undefined>;
  basePath?: string;
}) {
  const has = (k: FilterKey) => filters.includes(k);
  const sel = (id: string, label: string, name: string, opts: { value: string; label: string }[], blank = 'All') => (
    <Field key={id} label={label} htmlFor={id}>
      <Select id={id} name={name} defaultValue={query[name] ?? ''}><option value="">{blank}</option>{opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
    </Field>
  );
  const chosen = ['customerId', 'vehicleId', 'partId'].filter((k) => query[k]);
  return (
    <Card>
      <form method="get" action={basePath ?? `/reports/${reportKey}`} className="space-y-3" aria-label="Report filters">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {has('range') && (
            <>
              <Field label="Period" htmlFor="preset">
                <Select id="preset" name="preset" defaultValue={query.preset ?? ''}>
                  <option value="">Your default period</option>
                  {PRESETS.map((p) => <option key={p} value={p}>{PRESET_LABEL[p]}</option>)}
                </Select>
              </Field>
              <Field label="From (custom range)" htmlFor="from"><Input id="from" name="from" type="date" defaultValue={query.from ?? ''} /></Field>
              <Field label="To (custom range)" htmlFor="to"><Input id="to" name="to" type="date" defaultValue={query.to ?? ''} /></Field>
            </>
          )}
          {has('location') && options.locations.length > 1 && sel('locationIds', 'Location', 'locationIds', options.locations, 'All my locations')}
          {has('technician') && sel('technicianId', 'Technician', 'technicianId', options.technicians)}
          {has('serviceType') && sel('serviceTypeId', 'Service type', 'serviceTypeId', options.services)}
          {has('supplier') && sel('supplierId', 'Supplier', 'supplierId', options.suppliers)}
          {has('category') && sel('categoryId', 'Category', 'categoryId', options.categories)}
          {(Object.keys(enumOptions) as (keyof typeof enumOptions)[]).filter((k) => has(k)).map((k) => sel(PARAM[k]!, LABEL[k]!, PARAM[k]!, enumOptions[k].map((v) => ({ value: v, label: nice(v) }))))}
          {has('make') && <Field label="Make" htmlFor="make"><Input id="make" name="make" defaultValue={query.make ?? ''} maxLength={60} /></Field>}
          {has('model') && <Field label="Model" htmlFor="model"><Input id="model" name="model" defaultValue={query.model ?? ''} maxLength={60} /></Field>}
          {has('year') && <Field label="Year" htmlFor="year"><Input id="year" name="year" type="number" min={1900} max={2100} defaultValue={query.year ?? ''} /></Field>}
          {has('search') && <Field label="Search" htmlFor="search"><Input id="search" name="search" type="search" defaultValue={query.search ?? ''} maxLength={80} /></Field>}
          {groupBys.length > 0 && <Field label="Show" htmlFor="groupBy"><Select id="groupBy" name="groupBy" defaultValue={query.groupBy ?? ''}><option value="">Default view</option>{groupBys.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}</Select></Field>}
        </div>
        {chosen.map((k) => <input key={k} type="hidden" name={k} value={query[k]!} />)}
        {chosen.length > 0 && <p className="text-sm text-muted">Narrowed to one {chosen.map((k) => ({ customerId: 'customer', vehicleId: 'vehicle', partId: 'part' } as Record<string, string>)[k]).join(' and ')}. <Link className="font-medium text-brand-700 underline" href={basePath ?? `/reports/${reportKey}`}>Clear</Link></p>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit">Show report</Button>
          <Link href={basePath ?? `/reports/${reportKey}`} className="inline-flex min-h-11 items-center rounded-lg px-4 text-sm font-semibold text-brand-600 hover:bg-brand-50 md:min-h-10">Reset</Link>
        </div>
      </form>
    </Card>
  );
}

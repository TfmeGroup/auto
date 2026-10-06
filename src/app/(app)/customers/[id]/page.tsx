import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, Card, EmptyState, LinkButton, PageHeader, Pagination } from '@/components/ui';
import { ActionButton } from '@/components/forms/RowActions';
import { ActivityTimeline, Row, Stat, Tabs, qs } from '@/components/workshop/layout';
import { BookingList, JobList, VehicleList } from '@/components/workshop/Lists';
import { FilesPanel } from '@/components/workshop/FilesPanel';
import { CustomerCommPanel } from '@/components/notifications/CustomerCommPanel';
import { CustomerStatusBadge } from '@/components/workshop/badges';
import { getCustomerOverview } from '@/server/customers/service';
import { listVehicles } from '@/server/vehicles/service';
import { listJobs } from '@/server/jobcards/service';
import { listBookings } from '@/server/bookings/service';
import { requireBusiness, assertCan } from '@/server/web/session';
import { formatDate, formatDateTime } from '@/lib/format';
import { isAppError } from '@/lib/errors';
import { CustomerFinancialTab, InvoicesTab, PaymentsTab, QuotesTab } from '@/components/finance/FinanceTabs';
import { money } from '@/components/finance/shared';
import { getCustomerFinancials } from '@/server/finance/insights';

export const metadata: Metadata = { title: 'Customer' };
export const dynamic = 'force-dynamic';

const CONTACT: Record<string, string> = { PHONE: 'Phone call', SMS: 'SMS', WHATSAPP: 'WhatsApp', EMAIL: 'Email' };

interface TabProps {
  ctx: Awaited<ReturnType<typeof requireBusiness>>;
  c: { id: string };
  page: number;
  hrefTab: (key: string) => string;
  can: (p: Parameters<Awaited<ReturnType<typeof requireBusiness>>['permissions']['has']>[0]) => boolean;
  archived: boolean;
  fmt: { tz: string; locale: string };
}

async function VehiclesTab({ ctx, c, page, hrefTab, can, archived }: TabProps) {
        const { items, meta } = await listVehicles(ctx, { customerId: c.id, page, pageSize: 20, sort: 'registration', dir: 'asc' });
        return items.length === 0 ? (
          <EmptyState title="No vehicles yet" action={can('vehicle.create') && !archived ? <LinkButton href={`/vehicles/new?customerId=${c.id}`}>Add a vehicle</LinkButton> : undefined}>Add the vehicles this customer brings in.</EmptyState>
        ) : (
          <>
            <VehicleList items={items as never} showOwner={false} />
            <Pagination page={meta.page} totalPages={meta.totalPages} total={meta.total} hrefFor={(p) => hrefTab('vehicles') + `&page=${p}`} />
          </>
        );
      }

async function JobsTab({ ctx, c, page, hrefTab, can, archived, fmt }: TabProps) {
        const { items, meta } = await listJobs(ctx, { customerId: c.id, page, pageSize: 20 });
        return items.length === 0 ? (
          <EmptyState title="No jobs yet" action={can('job.create') && !archived ? <LinkButton href={`/jobs/new?customerId=${c.id}`}>Create a job</LinkButton> : undefined}>Jobs for this customer’s vehicles will appear here.</EmptyState>
        ) : (
          <>
            <JobList items={items as never} fmt={fmt} showCustomer={false} />
            <Pagination page={meta.page} totalPages={meta.totalPages} total={meta.total} hrefFor={(p) => hrefTab('jobs') + `&page=${p}`} />
          </>
        );
      }

async function BookingsTab({ ctx, c, page, hrefTab, can, archived, fmt }: TabProps) {
        const { items, meta } = await listBookings(ctx, { customerId: c.id, page, pageSize: 20, dir: 'desc' });
        return items.length === 0 ? (
          <EmptyState title="No bookings" action={can('booking.create') && !archived ? <LinkButton href={`/bookings/new?customerId=${c.id}`}>Create a booking</LinkButton> : undefined}>Appointments for this customer will appear here.</EmptyState>
        ) : (
          <>
            <BookingList items={items as never} fmt={fmt} showCustomer={false} />
            <Pagination page={meta.page} totalPages={meta.totalPages} total={meta.total} hrefFor={(p) => hrefTab('bookings') + `&page=${p}`} />
          </>
        );
      }

export default async function CustomerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; page?: string; from?: string; to?: string }> }) {
  const ctx = await requireBusiness();
  assertCan(ctx, 'customer.view');
  const { id } = await params;
  const sp = await searchParams;
  const can = (p: Parameters<typeof ctx.permissions.has>[0]) => ctx.permissions.has(p);
  const fmt = { tz: ctx.business.timezone, locale: ctx.business.locale };

  let o;
  try {
    o = await getCustomerOverview(ctx, id);
  } catch (e) {
    if (isAppError(e) && (e.status === 404 || e.status === 422)) notFound();
    throw e;
  }
  const c = o.customer;
  // Money, from the invoice and payment records themselves (never stored on the customer).
  const finRaw = can('invoice.view') ? ((await getCustomerFinancials(ctx, c.id).catch(() => null)) as { totals?: { outstandingCents: number; overdueCents: number }; creditBalanceCents?: number } | null) : null;
  const fin = finRaw?.totals ? { outstandingCents: finRaw.totals.outstandingCents, overdueCents: finRaw.totals.overdueCents, creditCents: finRaw.creditBalanceCents ?? 0 } : null;
  const archived = c.status === 'ARCHIVED';
  const tabs = [
    { key: 'overview', label: 'Overview', show: true },
    { key: 'vehicles', label: 'Vehicles', show: can('vehicle.view') },
    { key: 'jobs', label: 'Jobs', show: can('job.view') },
    { key: 'bookings', label: 'Bookings', show: can('booking.view') },
    { key: 'quotes', label: 'Quotes', show: can('quote.view') },
    { key: 'invoices', label: 'Invoices', show: can('invoice.view') },
    { key: 'payments', label: 'Payments', show: can('payment.view') },
    { key: 'financial', label: 'Financial', show: can('invoice.view') || can('payment.view') },
    { key: 'documents', label: 'Documents', show: can('document.view') },
    { key: 'messages', label: 'Messages', show: can('notification.view_history') || can('notification.manage_preferences') },
    { key: 'activity', label: 'Activity', show: true },
  ].filter((t) => t.show);
  const tab = tabs.find((t) => t.key === sp.tab)?.key ?? 'overview';
  const page = Math.max(1, Number(sp.page) || 1);
  const hrefTab = (key: string) => `/customers/${c.id}${qs({ tab: key === 'overview' ? undefined : key })}`;

  return (
    <>
      <PageHeader
        title={c.name}
        description={`${c.customerNumber}${c.companyName ? ` · ${c.companyName}` : ''}`}
        actions={
          <>
            {can('vehicle.create') && !archived && <LinkButton href={`/vehicles/new?customerId=${c.id}`} variant="secondary">Add vehicle</LinkButton>}
            {can('booking.create') && !archived && <LinkButton href={`/bookings/new?customerId=${c.id}`} variant="secondary">New booking</LinkButton>}
            {can('job.create') && !archived && <LinkButton href={`/jobs/new?customerId=${c.id}`}>New job</LinkButton>}
          </>
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <CustomerStatusBadge status={c.status} />
        <Badge>{c.type === 'BUSINESS' ? 'Business' : 'Individual'}</Badge>
        {can('customer.edit') && !archived && <Link href={`/customers/${c.id}/edit`} className="text-sm font-medium text-brand-700 hover:underline">Edit</Link>}
        {can('customer.edit') && !archived && (
          <ActionButton label={c.status === 'INACTIVE' ? 'Mark active' : 'Mark inactive'} variant="ghost" path={`/api/v1/customers/${c.id}/status`} body={{ status: c.status === 'INACTIVE' ? 'ACTIVE' : 'INACTIVE' }} />
        )}
        {can('customer.archive') && (
          <ActionButton
            label={archived ? 'Restore' : 'Archive'} variant="ghost" path={`/api/v1/customers/${c.id}/archive`} body={{ archived: !archived }}
            confirm={archived ? undefined : 'Archive this customer? They are hidden from lists, but every job, booking and record is kept, and you can restore them any time.'}
          />
        )}
      </div>

      <Tabs tabs={tabs} active={tab} hrefFor={hrefTab} />

      {tab === 'overview' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="Vehicles" value={o.vehicleCount} />
            <Stat label="Total jobs" value={o.totalJobs} hint={o.activeJobs ? `${o.activeJobs} active` : undefined} />
            <Stat label="Last visit" value={o.lastVisit ? formatDate(o.lastVisit, fmt.tz, fmt.locale) : '—'} />
            <Stat label="Next booking" value={o.nextBooking ? formatDateTime(o.nextBooking.startsAt, fmt.tz, fmt.locale) : '—'} />
            {fin ? <Stat label="Owes" value={money(fin.outstandingCents, { currency: ctx.business.currency, locale: ctx.business.locale })} hint={fin.overdueCents > 0 ? `${money(fin.overdueCents, { currency: ctx.business.currency, locale: ctx.business.locale })} overdue` : fin.creditCents > 0 ? `${money(fin.creditCents, { currency: ctx.business.currency, locale: ctx.business.locale })} credit` : undefined} /> : <Stat label="Balance" value="—" hint="You do not have access to invoices" />}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <h2 className="mb-1 text-base font-semibold">Details</h2>
              <dl className="divide-y divide-line">
                <Row label="Mobile">{c.mobile && <a className="text-brand-700 hover:underline" href={`tel:${c.mobile.replace(/[^\d+]/g, '')}`}>{c.mobile}</a>}</Row>
                <Row label="Email">{c.email && <a className="text-brand-700 hover:underline" href={`mailto:${c.email}`}>{c.email}</a>}</Row>
                <Row label="Alt. phone">{c.altPhone}</Row>
                <Row label="Preferred contact">{c.preferredContact && CONTACT[c.preferredContact]}</Row>
                <Row label="Marketing">{c.marketingConsent ? 'Agreed to marketing messages' : 'No marketing consent'}</Row>
                {c.type === 'BUSINESS' && <Row label="Registration no.">{c.companyRegNumber}</Row>}
                <Row label="Address">{[c.addressLine1, c.addressLine2, c.city, c.province, c.postalCode].filter(Boolean).join(', ')}</Row>
                {(c.emergencyName || c.emergencyPhone) && <Row label="Emergency contact">{[c.emergencyName, c.emergencyPhone].filter(Boolean).join(' · ')}</Row>}
                <Row label="Notes"><span className="whitespace-pre-wrap">{c.notes}</span></Row>
                <Row label="Customer since">{formatDate(c.createdAt, fmt.tz, fmt.locale)}</Row>
              </dl>
            </Card>
            <Card>
              <h2 className="mb-1 text-base font-semibold">Latest activity</h2>
              {o.latestActivity ? (
                <p className="text-sm">{o.latestActivity.summary}<span className="block text-xs text-muted">{formatDateTime(o.latestActivity.at, fmt.tz, fmt.locale)}</span></p>
              ) : <p className="text-sm text-muted">Nothing yet.</p>}
              <Link href={hrefTab('activity')} className="mt-2 inline-block text-sm font-medium text-brand-700 hover:underline">See all activity</Link>
            </Card>
          </div>
        </div>
      )}

      {tab === 'vehicles' && <VehiclesTab ctx={ctx} c={c} page={page} hrefTab={hrefTab} can={can} archived={archived} fmt={fmt} />}

      {tab === 'jobs' && <JobsTab ctx={ctx} c={c} page={page} hrefTab={hrefTab} can={can} archived={archived} fmt={fmt} />}

      {tab === 'bookings' && <BookingsTab ctx={ctx} c={c} page={page} hrefTab={hrefTab} can={can} archived={archived} fmt={fmt} />}

      {tab === 'quotes' && <QuotesTab ctx={ctx} scope={{ customerId: c.id }} page={page} hrefFor={(p) => hrefTab('quotes') + `&page=${p}`} canCreate={can('quote.create') && !archived} />}
      {tab === 'invoices' && <InvoicesTab ctx={ctx} scope={{ customerId: c.id }} page={page} hrefFor={(p) => hrefTab('invoices') + `&page=${p}`} canCreate={can('invoice.create') && !archived} />}
      {tab === 'payments' && <PaymentsTab ctx={ctx} customerId={c.id} page={page} hrefFor={(p) => hrefTab('payments') + `&page=${p}`} canRecord={can('payment.create') && !archived} />}
      {tab === 'financial' && <CustomerFinancialTab ctx={ctx} customerId={c.id} from={sp.from} to={sp.to} />}
      {tab === 'documents' && <FilesPanel ctx={ctx} resourceType="customer" resourceId={c.id} archived={archived} />}
      {tab === 'messages' && <CustomerCommPanel ctx={ctx} customerId={c.id} page={page} hrefFor={(p) => hrefTab('messages') + `&page=${p}`} archived={archived} />}
      {tab === 'activity' && <ActivityTimeline ctx={ctx} scope={{ customerId: c.id }} page={page} hrefFor={(p) => hrefTab('activity') + `&page=${p}`} />}
    </>
  );
}

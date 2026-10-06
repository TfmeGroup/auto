import Link from 'next/link';
import { Card } from '@/components/ui';
import { formatDate, formatDateTime } from '@/lib/format';
import { BookingStatusBadge, JobStatusBadge, PriorityBadge, VehicleStatusBadge } from './badges';

/** Shared list renderers: phones get cards, tablets and up get a table. Used by the main lists and every profile tab. */

interface Fmt { tz: string; locale: string }

const vehicleLine = (v: { registration?: string | null; make?: string | null; model?: string | null }) =>
  [v.registration, [v.make, v.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ') || 'Vehicle';

export interface JobListItem {
  id: string; jobNumber: string; status: string; priority: string; openedAt: Date; serviceLabel: string | null; complaint?: string | null;
  customer: { name: string }; vehicle: { registration: string | null; make: string | null; model: string | null }; technicianName: string | null;
}

export function JobList({ items, fmt, showCustomer = true }: { items: JobListItem[]; fmt: Fmt; showCustomer?: boolean }) {
  return (
    <>
      <ul className="grid gap-2 md:hidden">
        {items.map((j) => (
          <li key={j.id}>
            <Link href={`/jobs/${j.id}`}>
              <Card className="transition-colors hover:border-brand-500">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold">{j.jobNumber}</p>
                  <JobStatusBadge status={j.status} />
                </div>
                <p className="mt-0.5 text-sm">{vehicleLine(j.vehicle)}</p>
                {showCustomer && <p className="text-sm text-muted">{j.customer.name}</p>}
                {j.complaint && <p className="mt-1 line-clamp-2 text-sm text-muted">{j.complaint}</p>}
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                  <PriorityBadge priority={j.priority} />
                  <span>{j.technicianName ?? 'Unassigned'}</span>
                  <span>· {formatDate(j.openedAt, fmt.tz, fmt.locale)}</span>
                </div>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto rounded-xl border border-line bg-surface md:block">
        <table className="w-full min-w-[44rem] text-left text-sm">
          <thead className="border-b border-line bg-canvas text-xs uppercase tracking-wide text-muted">
            <tr>
              <th scope="col" className="px-4 py-2.5 font-medium">Job</th>
              {showCustomer && <th scope="col" className="px-4 py-2.5 font-medium">Customer</th>}
              <th scope="col" className="px-4 py-2.5 font-medium">Vehicle</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Technician</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Opened</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {items.map((j) => (
              <tr key={j.id} className="hover:bg-canvas/60">
                <td className="px-4 py-3 font-medium">
                  <Link href={`/jobs/${j.id}`} className="text-brand-700 hover:underline">{j.jobNumber}</Link>
                  {j.serviceLabel && <span className="block text-xs font-normal text-muted">{j.serviceLabel}</span>}
                </td>
                {showCustomer && <td className="px-4 py-3">{j.customer.name}</td>}
                <td className="px-4 py-3">{vehicleLine(j.vehicle)}</td>
                <td className="px-4 py-3"><div className="flex items-center gap-1.5"><JobStatusBadge status={j.status} /><PriorityBadge priority={j.priority} /></div></td>
                <td className="px-4 py-3">{j.technicianName ?? <span className="text-muted">Unassigned</span>}</td>
                <td className="px-4 py-3 text-muted">{formatDate(j.openedAt, fmt.tz, fmt.locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export interface VehicleListItem {
  id: string; registration: string | null; make: string | null; model: string | null; year: number | null; colour: string | null; mileageKm: number | null; status: string;
  customer?: { id: string; name: string };
}

export function VehicleList({ items, showOwner = true }: { items: VehicleListItem[]; showOwner?: boolean }) {
  return (
    <>
      <ul className="grid gap-2 md:hidden">
        {items.map((v) => (
          <li key={v.id}>
            <Link href={`/vehicles/${v.id}`}>
              <Card className="transition-colors hover:border-brand-500">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold">{v.registration ?? 'No registration'}</p>
                  <VehicleStatusBadge status={v.status} />
                </div>
                <p className="text-sm">{[v.year, v.make, v.model].filter(Boolean).join(' ') || '—'}{v.colour ? ` · ${v.colour}` : ''}</p>
                {showOwner && v.customer && <p className="text-sm text-muted">{v.customer.name}</p>}
                {v.mileageKm !== null && <p className="text-xs text-muted">{v.mileageKm.toLocaleString('en-ZA')} km</p>}
              </Card>
            </Link>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto rounded-xl border border-line bg-surface md:block">
        <table className="w-full min-w-[40rem] text-left text-sm">
          <thead className="border-b border-line bg-canvas text-xs uppercase tracking-wide text-muted">
            <tr>
              <th scope="col" className="px-4 py-2.5 font-medium">Registration</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Vehicle</th>
              {showOwner && <th scope="col" className="px-4 py-2.5 font-medium">Owner</th>}
              <th scope="col" className="px-4 py-2.5 font-medium">Mileage</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {items.map((v) => (
              <tr key={v.id} className="hover:bg-canvas/60">
                <td className="px-4 py-3 font-medium"><Link href={`/vehicles/${v.id}`} className="text-brand-700 hover:underline">{v.registration ?? 'No registration'}</Link></td>
                <td className="px-4 py-3">{[v.year, v.make, v.model].filter(Boolean).join(' ') || '—'}{v.colour ? <span className="text-muted"> · {v.colour}</span> : null}</td>
                {showOwner && <td className="px-4 py-3">{v.customer ? <Link href={`/customers/${v.customer.id}`} className="hover:underline">{v.customer.name}</Link> : '—'}</td>}
                <td className="px-4 py-3">{v.mileageKm !== null ? `${v.mileageKm.toLocaleString('en-ZA')} km` : '—'}</td>
                <td className="px-4 py-3"><VehicleStatusBadge status={v.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export interface BookingListItem {
  id: string; bookingNumber: string; startsAt: Date; durationMin: number; status: string; serviceLabel: string; technicianName: string | null; bayName: string | null;
  customer: { name: string }; vehicle: { registration: string | null; make: string | null; model: string | null };
}

export function BookingList({ items, fmt, showCustomer = true }: { items: BookingListItem[]; fmt: Fmt; showCustomer?: boolean }) {
  return (
    <>
      <ul className="grid gap-2 md:hidden">
        {items.map((b) => (
          <li key={b.id}>
            <Link href={`/bookings/${b.id}`}>
              <Card className="transition-colors hover:border-brand-500">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold">{formatDateTime(b.startsAt, fmt.tz, fmt.locale)}</p>
                  <BookingStatusBadge status={b.status} />
                </div>
                <p className="text-sm">{b.serviceLabel} · {b.durationMin} min</p>
                <p className="text-sm text-muted">{[showCustomer ? b.customer.name : null, vehicleLine(b.vehicle)].filter(Boolean).join(' · ')}</p>
                <p className="text-xs text-muted">{[b.technicianName, b.bayName].filter(Boolean).join(' · ') || 'No technician assigned'}</p>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto rounded-xl border border-line bg-surface md:block">
        <table className="w-full min-w-[46rem] text-left text-sm">
          <thead className="border-b border-line bg-canvas text-xs uppercase tracking-wide text-muted">
            <tr>
              <th scope="col" className="px-4 py-2.5 font-medium">When</th>
              {showCustomer && <th scope="col" className="px-4 py-2.5 font-medium">Customer</th>}
              <th scope="col" className="px-4 py-2.5 font-medium">Vehicle</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Service</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Technician</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {items.map((b) => (
              <tr key={b.id} className="hover:bg-canvas/60">
                <td className="px-4 py-3 font-medium"><Link href={`/bookings/${b.id}`} className="text-brand-700 hover:underline">{formatDateTime(b.startsAt, fmt.tz, fmt.locale)}</Link><span className="block text-xs font-normal text-muted">{b.bookingNumber}</span></td>
                {showCustomer && <td className="px-4 py-3">{b.customer.name}</td>}
                <td className="px-4 py-3">{vehicleLine(b.vehicle)}</td>
                <td className="px-4 py-3">{b.serviceLabel}<span className="block text-xs text-muted">{b.durationMin} min</span></td>
                <td className="px-4 py-3">{[b.technicianName, b.bayName].filter(Boolean).join(' · ') || <span className="text-muted">—</span>}</td>
                <td className="px-4 py-3"><BookingStatusBadge status={b.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

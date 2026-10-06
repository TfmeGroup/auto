import type { Tx } from '@/server/db/client';
import { sendCustomerMessage } from '@/server/notifications/comms';
import type { EventKey } from '@/server/notifications/events';
import { NotificationTypes } from '@/server/notifications/events';
import { notifyInternal } from '@/server/notifications/internal';

/** Booking messages, built on the shared communication service. A booking never contains internal notes in anything it sends. */
interface BusinessLike {
  id: string;
  timezone: string;
  locale: string;
}

interface BookingLike {
  id: string;
  bookingNumber?: string;
  customerId: string;
  vehicleId: string;
  locationId: string | null;
  serviceLabel: string;
  startsAt: Date;
  technicianMembershipId?: string | null;
}

export const bookingDay = (d: Date, b: BusinessLike) => new Intl.DateTimeFormat(b.locale, { timeZone: b.timezone, weekday: 'long', day: 'numeric', month: 'long' }).format(d);
export const bookingTime = (d: Date, b: BusinessLike) => new Intl.DateTimeFormat(b.locale, { timeZone: b.timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

export async function messageBooking(tx: Tx, business: BusinessLike, event: Extract<EventKey, 'BOOKING_CONFIRMED' | 'BOOKING_RESCHEDULED' | 'BOOKING_CANCELLED' | 'BOOKING_NO_SHOW'>, b: BookingLike, dedupeKey: string, previous?: Date) {
  return sendCustomerMessage(tx, business.id, {
    event, customerId: b.customerId, vehicleId: b.vehicleId, entity: { type: 'booking', id: b.id }, locationId: b.locationId, dedupeKey,
    vars: {
      service_name: b.serviceLabel, appointment_date: bookingDay(b.startsAt, business), appointment_time: bookingTime(b.startsAt, business),
      ...(previous ? { previous_appointment: `${bookingDay(previous, business)}, ${bookingTime(previous, business)}` } : {}),
    },
  });
}

/** Tell the workshop: the assigned technician always hears; the people who manage bookings hear by the business's rule. */
export async function notifyBookingInternal(tx: Tx, businessId: string, type: 'BOOKING_CREATED' | 'BOOKING_CHANGED' | 'BOOKING_CANCELLED', b: BookingLike, by: string | null, title: string) {
  const techUser = b.technicianMembershipId ? (await tx.membership.findFirst({ where: { id: b.technicianMembershipId, businessId }, select: { userId: true } }))?.userId : null;
  await notifyInternal(tx, businessId, NotificationTypes[type], {
    title, body: b.bookingNumber ? `Booking ${b.bookingNumber}` : undefined, linkUrl: `/bookings/${b.id}`, entity: { type: 'booking', id: b.id },
    alsoUserIds: techUser ? [techUser] : [], excludeUserIds: by ? [by] : [],
  });
}

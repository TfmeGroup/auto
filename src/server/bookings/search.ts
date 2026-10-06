import { formatDateTime } from '@/lib/format';
import type { SearchProvider } from '@/server/search/registry';

export const bookingSearchProvider: SearchProvider = {
  key: 'bookings',
  label: 'Bookings',
  permission: 'booking.view',
  async search(tx, businessId, query, limit) {
    const words = query.split(/\s+/).filter(Boolean).slice(0, 4);
    const rows = await tx.booking.findMany({
      where: {
        businessId,
        AND: words.map((w) => ({
          OR: [
            { bookingNumber: { contains: w, mode: 'insensitive' as const } },
            { customer: { name: { contains: w, mode: 'insensitive' as const } } },
            { vehicle: { registrationNorm: { contains: w.toUpperCase().replace(/[^A-Z0-9]/g, '') || w, mode: 'insensitive' as const } } },
          ],
        })),
      },
      orderBy: { startsAt: 'desc' },
      take: limit,
      include: { customer: { select: { name: true } }, vehicle: { select: { registration: true } } },
    });
    const biz = await tx.business.findUniqueOrThrow({ where: { id: businessId }, select: { timezone: true, locale: true } });
    return rows.map((b) => ({
      id: b.id,
      title: `${b.bookingNumber} · ${b.customer.name}`,
      subtitle: [b.vehicle.registration, b.serviceLabel, formatDateTime(b.startsAt, biz.timezone, biz.locale)].filter(Boolean).join(' · '),
      href: `/bookings/${b.id}`,
    }));
  },
};

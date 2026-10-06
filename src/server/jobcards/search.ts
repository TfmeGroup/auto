import { escapeLike } from '@/lib/validation';
import { JOB_STATUS_LABEL, type JobStatus } from './transitions';
import type { SearchProvider } from '@/server/search/registry';

export const jobSearchProvider: SearchProvider = {
  key: 'jobs',
  label: 'Jobs',
  permission: 'job.view',
  async search(tx, businessId, query, limit) {
    const words = query.split(/\s+/).filter(Boolean).slice(0, 4);
    const rows = await tx.jobCard.findMany({
      where: {
        businessId,
        AND: words.map((w) => {
          const norm = w.toUpperCase().replace(/[^A-Z0-9]/g, '') || escapeLike(w);
          return {
            OR: [
              { jobNumber: { contains: w, mode: 'insensitive' as const } },
              { customer: { name: { contains: w, mode: 'insensitive' as const } } },
              { vehicle: { registrationNorm: { contains: norm, mode: 'insensitive' as const } } },
              { vehicle: { vin: { contains: norm, mode: 'insensitive' as const } } },
            ],
          };
        }),
      },
      orderBy: { openedAt: 'desc' },
      take: limit,
      include: { customer: { select: { name: true } }, vehicle: { select: { registration: true, make: true, model: true } } },
    });
    return rows.map((j) => ({
      id: j.id,
      title: `${j.jobNumber} · ${j.customer.name}`,
      subtitle: [j.vehicle.registration, [j.vehicle.make, j.vehicle.model].filter(Boolean).join(' '), JOB_STATUS_LABEL[j.status as JobStatus]].filter(Boolean).join(' · '),
      href: `/jobs/${j.id}`,
    }));
  },
};

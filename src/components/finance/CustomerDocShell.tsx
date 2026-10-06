import type { ReactNode } from 'react';
import { Card } from '@/components/ui';

/** The business's name, logo and contact details at the top of a customer's quote or invoice page. */
export function BusinessHeader({
  business, logoSrc,
}: {
  business: { name: string; phone: string | null; email: string | null; address: string | null; vatNumber?: string | null; registrationNumber?: string | null; hasLogo: boolean };
  logoSrc: string;
}) {
  return (
    <header className="mb-4 flex items-start gap-3">
      {business.hasLogo && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoSrc} alt={`${business.name} logo`} className="size-14 shrink-0 rounded-lg border border-line bg-surface object-contain p-1" />
      )}
      <div className="min-w-0">
        <h1 className="text-lg font-bold leading-tight">{business.name}</h1>
        <p className="text-xs text-muted">
          {[business.address, business.phone, business.email].filter(Boolean).join(' · ')}
          {business.vatNumber ? ` · VAT ${business.vatNumber}` : ''}{business.registrationNumber ? ` · Reg ${business.registrationNumber}` : ''}
        </p>
      </div>
    </header>
  );
}

export function InvalidLink() {
  return (
    <Card className="mx-auto mt-10 max-w-md text-center">
      <h1 className="text-lg font-bold">This link is not available</h1>
      <p className="mt-2 text-sm text-muted">It may have expired, or a newer one may have been sent to you. Please use the most recent email from the workshop, or contact them directly.</p>
    </Card>
  );
}

export function Meta({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">{children}</dl>;
}
export function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt className="text-xs uppercase tracking-wide text-muted">{label}</dt><dd className="font-medium">{children || '—'}</dd></div>;
}

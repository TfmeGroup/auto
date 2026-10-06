'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/account', label: 'Profile' },
  { href: '/account/security', label: 'Security' },
];

export function AccountNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Account" className="flex gap-1 border-b border-line">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={pathname === t.href ? 'page' : undefined}
          className={clsx('-mb-px inline-flex min-h-11 items-center border-b-2 px-4 text-sm font-medium', pathname === t.href ? 'border-brand-600 text-brand-700' : 'border-transparent text-muted hover:text-ink')}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

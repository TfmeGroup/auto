'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface SettingsTab {
  href: string;
  label: string;
}

/** Tabs across the business-administration area. Which tabs appear is decided on the server by permission. */
export function SettingsNav({ tabs }: { tabs: SettingsTab[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Business administration" className="-mx-3 mb-4 flex gap-1 overflow-x-auto border-b border-line px-3 sm:mx-0 sm:px-0">
      {tabs.map((t) => {
        const active = t.href === '/settings' ? pathname === '/settings' : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? 'page' : undefined}
            className={clsx('-mb-px inline-flex min-h-11 shrink-0 items-center border-b-2 px-3 text-sm font-medium', active ? 'border-brand-600 text-brand-700' : 'border-transparent text-muted hover:text-ink')}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

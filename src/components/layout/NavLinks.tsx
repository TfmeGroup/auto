'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from './icons';
import type { NavItem } from './nav-config';

function isActive(pathname: string, href: string, all: NavItem[]): boolean {
  if (pathname === href) return true;
  if (!pathname.startsWith(`${href}/`)) return false;
  // Don't highlight /settings when a more specific item (/settings/team) matches.
  return !all.some((o) => o.href !== href && o.href.startsWith(href) && (pathname === o.href || pathname.startsWith(`${o.href}/`)));
}

export function SidebarLinks({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-1">
      {items.map((i) => {
        const active = isActive(pathname, i.href, items);
        return (
          <Link
            key={i.href}
            href={i.href}
            aria-current={active ? 'page' : undefined}
            className={clsx(
              'flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors',
              active ? 'bg-brand-50 text-brand-700' : 'text-muted hover:bg-canvas hover:text-ink',
            )}
          >
            <Icon name={i.icon} />
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function BottomLinks({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <>
      {items.map((i) => {
        const active = isActive(pathname, i.href, items);
        return (
          <Link
            key={i.href}
            href={i.href}
            aria-current={active ? 'page' : undefined}
            className={clsx('flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium', active ? 'text-brand-600' : 'text-muted')}
          >
            <Icon name={i.icon} className="size-6" />
            {i.label}
          </Link>
        );
      })}
    </>
  );
}

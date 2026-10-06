'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icon } from './icons';
import type { NavItem } from './nav-config';

/** "More" sheet for the mobile bottom bar: everything that doesn't fit in four slots. */
export function MobileMore({ items }: { items: NavItem[] }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open]);

  if (items.length === 0) return null;

  return (
    <>
      <button type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} className="flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-muted">
        <Icon name="more" className="size-6" />
        More
      </button>
      {open && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="More navigation">
          <button type="button" aria-label="Close menu" className="absolute inset-0 bg-ink/40" onClick={() => setOpen(false)} />
          <div className="safe-bottom absolute inset-x-0 bottom-0 rounded-t-2xl bg-surface p-3 shadow-xl">
            <div className="mb-2 flex items-center justify-between px-2">
              <p className="text-sm font-semibold">More</p>
              <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="grid size-11 place-items-center rounded-lg hover:bg-canvas">
                <Icon name="close" />
              </button>
            </div>
            <ul>
              {items.map((i) => (
                <li key={i.href}>
                  <Link href={i.href} onClick={() => setOpen(false)} className="flex min-h-12 items-center gap-3 rounded-lg px-3 text-base hover:bg-canvas">
                    <Icon name={i.icon} />
                    {i.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}

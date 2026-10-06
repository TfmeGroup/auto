'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api-client';
import { Icon } from './icons';

interface Props {
  userName: string;
  userEmail: string;
  businessName: string;
  businesses: { id: string; name: string }[];
  currentBusinessId: string;
}

export function AccountMenu({ userName, userEmail, businessName, businesses, currentBusinessId }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, []);

  async function logout() {
    setBusy(true);
    try {
      await api('/api/v1/auth/logout', { method: 'POST', body: {} });
    } finally {
      router.replace('/login');
      router.refresh();
    }
  }

  async function switchTo(id: string) {
    setBusy(true);
    try {
      await api('/api/v1/businesses/switch', { body: { businessId: id } });
      setOpen(false);
      router.push('/dashboard');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const initials = userName.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-11 items-center gap-2 rounded-lg px-1.5 hover:bg-canvas md:min-h-10"
      >
        <span className="grid size-8 place-items-center rounded-full bg-brand-600 text-xs font-bold text-white">{initials}</span>
        <Icon name="chevron" className="hidden size-4 text-muted sm:block" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-30 mt-1 w-72 rounded-xl border border-line bg-surface p-1 shadow-lg">
          <div className="border-b border-line px-3 py-2">
            <p className="truncate text-sm font-semibold">{userName}</p>
            <p className="truncate text-xs text-muted">{userEmail}</p>
          </div>
          <div className="border-b border-line py-1">
            <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Business</p>
            {businesses.map((b) => (
              <button
                key={b.id}
                role="menuitemradio"
                aria-checked={b.id === currentBusinessId}
                disabled={busy || b.id === currentBusinessId}
                onClick={() => switchTo(b.id)}
                className="flex min-h-11 w-full items-center justify-between rounded-lg px-3 text-left text-sm hover:bg-canvas disabled:cursor-default"
              >
                <span className="truncate">{b.name}</span>
                {b.id === currentBusinessId && <span className="text-xs font-medium text-brand-600">Current</span>}
              </button>
            ))}
            <a role="menuitem" href="/onboarding?new=1" className="flex min-h-11 items-center rounded-lg px-3 text-sm text-brand-600 hover:bg-canvas">
              + Create another business
            </a>
          </div>
          <a role="menuitem" href="/account" className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm hover:bg-canvas">
            <Icon name="customers" className="size-4" /> My account
          </a>
          <a role="menuitem" href="/account/security" className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm hover:bg-canvas">
            <Icon name="lock" className="size-4" /> Security
          </a>
          <button role="menuitem" disabled={busy} onClick={logout} className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm hover:bg-canvas">
            <Icon name="logout" className="size-4" /> Sign out
          </button>
          <p className="px-3 pb-2 pt-1 text-[11px] text-muted">Working in {businessName}</p>
        </div>
      )}
    </div>
  );
}

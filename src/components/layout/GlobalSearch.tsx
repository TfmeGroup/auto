'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api-client';
import { Icon } from './icons';

interface Hit {
  id: string;
  title: string;
  subtitle?: string;
  href: string;
}
interface Group {
  key: string;
  label: string;
  items: Hit[];
}

/**
 * Server-side global search. The browser never receives more than a handful of
 * hits per group, and the server decides what this user is allowed to see.
 */
export function GlobalSearch() {
  const router = useRouter();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  const [groups, setGroups] = useState<Group[]>([]);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [active, setActive] = useState(0);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setGroups([]);
      setState('idle');
      return;
    }
    setState('loading');
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await api<Group[]>(`/api/v1/search?q=${encodeURIComponent(term)}`);
        if (ctl.signal.aborted) return;
        setGroups(res.data);
        setActive(0);
        setState('idle');
      } catch {
        if (!ctl.signal.aborted) setState('error');
      }
    }, 250);
    return () => {
      ctl.abort();
      clearTimeout(t);
    };
  }, [q]);

  // "/" focuses search; click outside closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (e.key === '/' && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, []);

  function go(hit: Hit) {
    setOpen(false);
    setQ('');
    router.push(hit.href);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, flat.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter' && flat[active]) {
      e.preventDefault();
      go(flat[active]!);
    }
  }

  const showPanel = open && q.trim().length >= 2;
  let index = -1;

  return (
    <div ref={boxRef} className="relative min-w-0 flex-1">
      <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-expanded={showPanel}
        aria-controls={listId}
        aria-label="Search customers, vehicles, jobs, invoices and more"
        placeholder="Search…  ( / )"
        autoComplete="off"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className="block min-h-11 w-full rounded-lg border border-line bg-canvas py-2 pl-9 pr-3 text-sm placeholder:text-muted/70 focus:border-brand-500 focus:bg-surface md:min-h-10"
      />
      {showPanel && (
        <div id={listId} role="listbox" className="absolute left-0 right-0 top-full z-30 mt-1 max-h-[70dvh] overflow-auto rounded-xl border border-line bg-surface p-1 shadow-lg">
          {state === 'loading' && <p className="px-3 py-3 text-sm text-muted">Searching…</p>}
          {state === 'error' && <p className="px-3 py-3 text-sm text-danger">Search is unavailable right now.</p>}
          {state === 'idle' && groups.length === 0 && <p className="px-3 py-3 text-sm text-muted">No matches for “{q.trim()}”.</p>}
          {groups.map((g) => (
            <div key={g.key} className="py-1">
              <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{g.label}</p>
              {g.items.map((hit) => {
                index += 1;
                const i = index;
                return (
                  <button
                    key={hit.id}
                    role="option"
                    aria-selected={i === active}
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(hit)}
                    className={`flex min-h-11 w-full flex-col items-start justify-center rounded-lg px-3 py-1.5 text-left ${i === active ? 'bg-brand-50' : ''}`}
                  >
                    <span className="text-sm font-medium">{hit.title}</span>
                    {hit.subtitle && <span className="text-xs text-muted">{hit.subtitle}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

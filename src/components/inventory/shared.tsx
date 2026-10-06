import clsx from 'clsx';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui';
import { formatMoney } from '@/lib/money';

/** Small presentational pieces shared by the inventory, purchasing and team screens. */

export interface MoneyFmt { currency: string; locale: string }
export const money = (cents: number | null | undefined, f: MoneyFmt) => (cents === null || cents === undefined ? '—' : formatMoney(cents, f.currency, f.locale));

const STOCK: Record<string, [string, 'ok' | 'warn' | 'danger']> = { NORMAL: ['In stock', 'ok'], LOW: ['Low stock', 'warn'], OUT: ['Out of stock', 'danger'] };
export const StockBadge = ({ state }: { state: string }) => <Badge tone={STOCK[state]?.[1] ?? 'neutral'}>{STOCK[state]?.[0] ?? state}</Badge>;

const STATUS: Record<string, 'ok' | 'warn' | 'neutral'> = { ACTIVE: 'ok', INACTIVE: 'warn', ARCHIVED: 'neutral' };
export const RecordStatusBadge = ({ status }: { status: string }) => <Badge tone={STATUS[status] ?? 'neutral'}>{status.charAt(0) + status.slice(1).toLowerCase()}</Badge>;

const PO: Record<string, [string, 'ok' | 'warn' | 'danger' | 'neutral' | 'brand']> = {
  DRAFT: ['Draft', 'neutral'], PENDING_APPROVAL: ['Awaiting approval', 'warn'], APPROVED: ['Approved', 'brand'], ORDERED: ['Ordered', 'brand'],
  PARTIALLY_RECEIVED: ['Partially received', 'warn'], RECEIVED: ['Received', 'ok'], CANCELLED: ['Cancelled', 'danger'],
};
export const PoStatusBadge = ({ status }: { status: string }) => <Badge tone={PO[status]?.[1] ?? 'neutral'}>{PO[status]?.[0] ?? status}</Badge>;

const TR: Record<string, [string, 'ok' | 'warn' | 'danger' | 'neutral' | 'brand']> = {
  DRAFT: ['Draft', 'neutral'], REQUESTED: ['Requested', 'warn'], APPROVED: ['Approved', 'brand'], IN_TRANSIT: ['In transit', 'warn'], RECEIVED: ['Received', 'ok'], CANCELLED: ['Cancelled', 'danger'],
};
export const TransferStatusBadge = ({ status }: { status: string }) => <Badge tone={TR[status]?.[1] ?? 'neutral'}>{TR[status]?.[0] ?? status}</Badge>;

export const MOVEMENT_LABEL: Record<string, string> = {
  RECEIVED: 'Received', SOLD: 'Sold', USED: 'Used on a job', RESERVED: 'Reserved', UNRESERVED: 'Reservation released', RETURNED: 'Returned to stock', ADJUSTED: 'Adjusted',
  DAMAGED: 'Damaged', LOST: 'Lost / missing', TRANSFER_IN: 'Transferred in', TRANSFER_OUT: 'Transferred out', SUPPLIER_RETURN: 'Returned to supplier',
};
const MOVE_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'neutral' | 'brand'> = { RECEIVED: 'ok', RETURNED: 'ok', TRANSFER_IN: 'ok', RESERVED: 'brand', UNRESERVED: 'neutral', USED: 'neutral', SOLD: 'neutral', ADJUSTED: 'warn', DAMAGED: 'danger', LOST: 'danger', TRANSFER_OUT: 'neutral', SUPPLIER_RETURN: 'warn' };
export const MovementBadge = ({ type }: { type: string }) => <Badge tone={MOVE_TONE[type] ?? 'neutral'}>{MOVEMENT_LABEL[type] ?? type}</Badge>;

export const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

/** On hand / reserved / available, always together, so a screen can never imply that reserved stock is free. */
export function StockNumbers({ onHand, reserved, available, unit, compact }: { onHand: number; reserved: number; available: number; unit?: string; compact?: boolean }) {
  return (
    <dl className={clsx('grid grid-cols-3 gap-2 text-center', compact ? 'text-xs' : 'text-sm')}>
      <div className="rounded-lg border border-line bg-canvas px-2 py-1.5"><dt className="text-muted">On hand</dt><dd className="text-base font-bold tabular-nums">{onHand}</dd></div>
      <div className="rounded-lg border border-line bg-canvas px-2 py-1.5"><dt className="text-muted">Reserved</dt><dd className="text-base font-bold tabular-nums">{reserved}</dd></div>
      <div className={clsx('rounded-lg border px-2 py-1.5', available <= 0 ? 'border-danger/30 bg-danger-bg' : 'border-ok/30 bg-ok-bg')}><dt className="text-muted">Available</dt><dd className="text-base font-bold tabular-nums">{available}{unit && !compact ? <span className="ml-1 text-xs font-normal text-muted">{unit}</span> : null}</dd></div>
    </dl>
  );
}

export interface InvTab { key: string; label: string; href: string; show: boolean }

/** Link tabs across the stock area. Which tabs appear is decided by permission and plan on the server. */
export function InventoryNav({ tabs, active }: { tabs: InvTab[]; active: string }) {
  return (
    <nav aria-label="Stock sections" className="-mx-3 mb-4 flex gap-1 overflow-x-auto border-b border-line px-3 sm:mx-0 sm:px-0">
      {tabs.filter((t) => t.show).map((t) => (
        <Link key={t.key} href={t.href} aria-current={t.key === active ? 'page' : undefined}
          className={clsx('-mb-px inline-flex min-h-11 shrink-0 items-center border-b-2 px-3 text-sm font-medium', t.key === active ? 'border-brand-600 text-brand-700' : 'border-transparent text-muted hover:text-ink')}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

export function Kpi({ label, value, hint, tone, href }: { label: string; value: ReactNode; hint?: string; tone?: 'danger' | 'warn' | 'ok'; href?: string }) {
  const body = (
    <div className={clsx('rounded-xl border bg-surface px-3 py-3', tone === 'danger' ? 'border-danger/30' : tone === 'warn' ? 'border-warn/30' : 'border-line')}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className={clsx('mt-0.5 text-2xl font-bold tabular-nums', tone === 'danger' && 'text-danger', tone === 'warn' && 'text-warn', tone === 'ok' && 'text-ok')}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
  return href ? <Link href={href} className="block hover:opacity-90">{body}</Link> : body;
}

/** Parse a rand amount typed in a form ("450", "450.5", "R 450,50") to cents; null when empty. */
export function randToCentsOrNull(raw: string): number | null | undefined {
  const t = raw.replace(/[Rr\s]/g, '').replace(',', '.');
  if (t === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return undefined;
  return Math.round(Number(t) * 100);
}
export const centsToRand = (c: number | null | undefined) => (c === null || c === undefined ? '' : (c / 100).toFixed(2));

export interface CategoryOption { id: string; name: string; parentId: string | null }

/** Categories in tree order with sub-categories indented, so a flat <select> still shows the structure. */
export function categoryOptions(cats: CategoryOption[]): { value: string; label: string }[] {
  const tops = cats.filter((c) => !c.parentId);
  const out: { value: string; label: string }[] = [];
  for (const t of tops) {
    out.push({ value: t.id, label: t.name });
    for (const c of cats.filter((x) => x.parentId === t.id)) out.push({ value: c.id, label: `  — ${c.name}` });
  }
  return out;
}

/** A key for a line being edited in a form. Lives here (not in the client form) so server pages can pre-fill lines too. */
let lineCounter = 0;
export const newLineKey = () => `l${++lineCounter}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

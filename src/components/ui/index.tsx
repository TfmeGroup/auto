import clsx from 'clsx';
import Link from 'next/link';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

/* Presentational building blocks. Touch targets are >= 44px on phones (WCAG 2.5.5 / Apple HIG). */

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const buttonBase =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 md:min-h-10';
const buttonVariants: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700',
  secondary: 'border border-line bg-surface text-ink hover:bg-canvas',
  danger: 'bg-danger text-white hover:opacity-90',
  ghost: 'text-brand-600 hover:bg-brand-50',
};

export function Button({
  variant = 'primary',
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean }) {
  return (
    <button className={clsx(buttonBase, buttonVariants[variant], className)} disabled={disabled || loading} {...rest}>
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function LinkButton({ href, variant = 'primary', className, children }: { href: string; variant?: Variant; className?: string; children: ReactNode }) {
  return (
    <Link href={href} className={clsx(buttonBase, buttonVariants[variant], className)}>
      {children}
    </Link>
  );
}

export function Spinner() {
  return <span aria-hidden className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />;
}

const control =
  'block w-full min-h-11 rounded-lg border border-line bg-surface px-3 py-2 text-ink placeholder:text-muted/70 focus:border-brand-500 md:min-h-10 aria-[invalid=true]:border-danger';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={clsx(control, props.className)} />;
}
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={3} {...props} className={clsx(control, props.className)} />;
}
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={clsx(control, props.className)} />;
}

/** Label + control + error, wired for assistive tech. */
export function Field({
  label,
  error,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-muted">{hint}</p>}
      {error && (
        <p id={`${htmlFor}-error`} role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={clsx('rounded-xl border border-line bg-surface p-4 shadow-sm sm:p-5', className)}>{children}</section>;
}

const badgeTone = {
  neutral: 'bg-canvas text-muted border-line',
  ok: 'bg-ok-bg text-ok border-ok/20',
  warn: 'bg-warn-bg text-warn border-warn/20',
  danger: 'bg-danger-bg text-danger border-danger/20',
  brand: 'bg-brand-50 text-brand-700 border-brand-100',
} as const;

export function Badge({ tone = 'neutral', children }: { tone?: keyof typeof badgeTone; children: ReactNode }) {
  return <span className={clsx('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium', badgeTone[tone])}>{children}</span>;
}

export function Alert({ tone = 'danger', children }: { tone?: 'danger' | 'ok' | 'warn'; children: ReactNode }) {
  const t = { danger: 'bg-danger-bg text-danger border-danger/20', ok: 'bg-ok-bg text-ok border-ok/20', warn: 'bg-warn-bg text-warn border-warn/20' }[tone];
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={clsx('rounded-lg border px-3 py-2.5 text-sm', t)}>
      {children}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line bg-surface px-6 py-12 text-center">
      <h3 className="text-base font-semibold">{title}</h3>
      {children && <p className="max-w-sm text-sm text-muted">{children}</p>}
      {action}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="truncate text-xl font-bold tracking-tight sm:text-2xl">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

export function Pagination({
  page,
  totalPages,
  total,
  hrefFor,
}: {
  page: number;
  totalPages: number;
  total: number;
  hrefFor: (page: number) => string;
}) {
  if (totalPages <= 1) return <p className="mt-3 text-xs text-muted">{total} result{total === 1 ? '' : 's'}</p>;
  return (
    <nav aria-label="Pagination" className="mt-4 flex items-center justify-between gap-3">
      <p className="text-xs text-muted">
        Page {page} of {totalPages} · {total} results
      </p>
      <div className="flex gap-2">
        {page > 1 ? <LinkButton href={hrefFor(page - 1)} variant="secondary">Previous</LinkButton> : null}
        {page < totalPages ? <LinkButton href={hrefFor(page + 1)} variant="secondary">Next</LinkButton> : null}
      </div>
    </nav>
  );
}

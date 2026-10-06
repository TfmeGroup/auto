'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import clsx from 'clsx';
import { Alert, Button, Field, Input, Select, Textarea } from '@/components/ui';
import { useSubmit } from '@/components/forms/use-submit';
import { api } from '@/lib/api-client';
import { randToCents, splitCodes } from '@/components/workshop/money-input';

/**
 * One small form for the many "add a thing to this record" actions (record mileage, add a part, log labour, write a
 * note…). It posts JSON to an API route, shows field-level errors from the server's validation, and refreshes the page
 * on success. Validation always happens on the server; the browser's `required` is only a convenience.
 */

export interface FieldDef {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'date' | 'time' | 'datetime-local' | 'tel' | 'email' | 'select' | 'textarea' | 'checkbox';
  options?: { value: string; label: string }[];
  required?: boolean;
  placeholder?: string;
  hint?: string;
  defaultValue?: string | boolean;
  inputMode?: 'numeric' | 'decimal' | 'text' | 'tel';
  /** How the raw text becomes the value sent to the API. A name rather than a function, so server pages can pass it to this client component. */
  parse?: 'cents' | 'codes' | 'iso';
  span?: 'full' | 'half';
  rows?: number;
}

const PARSERS: Record<NonNullable<FieldDef['parse']>, (raw: string) => unknown> = {
  cents: randToCents,
  codes: splitCodes,
  iso: (r) => (r ? new Date(r).toISOString() : ''),
};

export function InlineForm({
  endpoint, method = 'POST', fields, submitLabel, extra = {}, resetOnSuccess = true, onDone, refresh = true, variant = 'primary', compact = false, className,
}: {
  endpoint: string;
  method?: 'POST' | 'PATCH' | 'PUT';
  fields: FieldDef[];
  submitLabel: string;
  extra?: Record<string, unknown>;
  resetOnSuccess?: boolean;
  onDone?: (data: unknown) => void;
  /** Refresh the current page after saving (turn off when onDone navigates elsewhere). */
  refresh?: boolean;
  variant?: 'primary' | 'secondary' | 'danger';
  compact?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const { pending, ready, error, fields: errors, run } = useSubmit();
  const [saved, setSaved] = useState(false);

  return (
    <form
      ref={formRef}
      method="post"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const body: Record<string, unknown> = { ...extra };
        for (const f of fields) {
          const el = form.elements.namedItem(f.name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
          if (!el) continue;
          const raw = f.type === 'checkbox' ? '' : el.value;
          body[f.name] = f.type === 'checkbox' ? (el as HTMLInputElement).checked : f.parse ? PARSERS[f.parse](raw) : raw;
        }
        setSaved(false);
        void run(async () => {
          const res = await api(endpoint, { method, body });
          if (resetOnSuccess) form.reset();
          setSaved(true);
          onDone?.(res.data);
          if (refresh) router.refresh();
        });
      }}
      className={clsx('space-y-3', className)}
    >
      {error && <Alert>{error}</Alert>}
      <div className={clsx('grid gap-3', !compact && 'sm:grid-cols-2')}>
        {fields.map((f) => {
          const id = `${endpoint}-${f.name}`.replace(/[^a-z0-9]+/gi, '-');
          const wide = f.span === 'full' || f.type === 'textarea' || f.type === 'checkbox';
          if (f.type === 'checkbox') {
            return (
              <label key={f.name} className={clsx('flex min-h-11 items-center gap-2 text-sm', 'sm:col-span-2')}>
                <input type="checkbox" name={f.name} defaultChecked={!!f.defaultValue} className="size-5" />
                {f.label}
              </label>
            );
          }
          return (
            <div key={f.name} className={clsx(wide && 'sm:col-span-2')}>
              <Field label={f.label} htmlFor={id} error={errors[f.name]} hint={f.hint}>
                {f.type === 'select' ? (
                  <Select id={id} name={f.name} defaultValue={typeof f.defaultValue === 'string' ? f.defaultValue : ''} required={f.required} aria-invalid={!!errors[f.name]}>
                    {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </Select>
                ) : f.type === 'textarea' ? (
                  <Textarea id={id} name={f.name} rows={f.rows ?? 3} placeholder={f.placeholder} defaultValue={typeof f.defaultValue === 'string' ? f.defaultValue : ''} required={f.required} aria-invalid={!!errors[f.name]} />
                ) : (
                  <Input
                    id={id} name={f.name} type={f.type === 'number' ? 'text' : (f.type ?? 'text')} inputMode={f.inputMode ?? (f.type === 'number' ? 'numeric' : undefined)}
                    placeholder={f.placeholder} defaultValue={typeof f.defaultValue === 'string' ? f.defaultValue : ''} required={f.required} aria-invalid={!!errors[f.name]} autoComplete="off"
                  />
                )}
              </Field>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" variant={variant} loading={pending || !ready}>{submitLabel}</Button>
        {saved && !pending && !error && <span role="status" className="text-sm font-medium text-ok">Saved</span>}
      </div>
    </form>
  );
}

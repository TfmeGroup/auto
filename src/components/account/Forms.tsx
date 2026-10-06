'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { formValue, useSubmit } from '@/components/forms/use-submit';
import { api, ApiError } from '@/lib/api-client';

/* Account-level forms. Every one posts to the same API anyone could call; the server validates again. */

export function ProfileForm({ initial }: { initial: { firstName: string; lastName: string; mobile: string | null } }) {
  const router = useRouter();
  const { pending, ready, error, fields, run } = useSubmit();
  const [saved, setSaved] = useState(false);
  return (
    <form
      method="post"
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const f = e.currentTarget;
        setSaved(false);
        void run(async () => {
          await api('/api/v1/account', { method: 'PATCH', body: { firstName: formValue(f, 'firstName'), lastName: formValue(f, 'lastName'), mobile: formValue(f, 'mobile') } });
          setSaved(true);
          router.refresh();
        });
      }}
    >
      {error && <Alert>{error}</Alert>}
      {saved && <Alert tone="ok">Profile saved.</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First name" htmlFor="firstName" error={fields.firstName}><Input id="firstName" name="firstName" defaultValue={initial.firstName} autoComplete="given-name" required /></Field>
        <Field label="Last name" htmlFor="lastName" error={fields.lastName}><Input id="lastName" name="lastName" defaultValue={initial.lastName} autoComplete="family-name" required /></Field>
      </div>
      <Field label="Mobile number" htmlFor="mobile" error={fields.mobile}><Input id="mobile" name="mobile" type="tel" inputMode="tel" defaultValue={initial.mobile ?? ''} autoComplete="tel" /></Field>
      <Button type="submit" loading={pending || !ready}>Save profile</Button>
    </form>
  );
}

export function PhotoUploader({ hasPhoto, initials }: { hasPhoto: boolean; initials: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set('photo', file);
      const res = await fetch('/api/v1/account/photo', { method: 'POST', body: form, credentials: 'same-origin' });
      if (!res.ok) throw new ApiError(res.status, 'UPLOAD', ((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? 'Upload failed.');
      setVersion((v) => v + 1);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Upload failed. Check your connection.');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api('/api/v1/account/photo', { method: 'DELETE', body: {} });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-4">
      {hasPhoto ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/v1/account/photo?v=${version}`} alt="Your profile photo" className="size-20 rounded-full border border-line object-cover" />
      ) : (
        <span aria-hidden className="grid size-20 place-items-center rounded-full bg-brand-600 text-xl font-bold text-white">{initials}</span>
      )}
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" loading={busy} onClick={() => input.current?.click()}>{hasPhoto ? 'Change photo' : 'Add photo'}</Button>
          {hasPhoto && <Button type="button" variant="ghost" disabled={busy} onClick={remove}>Remove</Button>}
        </div>
        <p className="text-xs text-muted">JPG, PNG or WebP, up to 2 MB.</p>
        {error && <Alert>{error}</Alert>}
      </div>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => void upload(e.target.files?.[0])} />
    </div>
  );
}

export function NotificationPrefs({ optional, alwaysOn }: { optional: { key: string; label: string; emailEnabled: boolean }[]; alwaysOn: string[] }) {
  const [state, setState] = useState(Object.fromEntries(optional.map((o) => [o.key, o.emailEnabled])));
  const [error, setError] = useState<string | null>(null);

  async function toggle(key: string, value: boolean) {
    setState((s) => ({ ...s, [key]: value }));
    setError(null);
    try {
      await api('/api/v1/account/notifications', { method: 'PUT', body: { preferences: { [key]: value } } });
    } catch {
      setState((s) => ({ ...s, [key]: !value }));
      setError('Could not save that change.');
    }
  }

  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      {optional.map((o) => (
        <label key={o.key} className="flex min-h-11 items-start gap-3 text-sm">
          <input type="checkbox" checked={state[o.key] ?? true} onChange={(e) => void toggle(o.key, e.target.checked)} className="mt-0.5 size-5 rounded border-line" />
          <span>{o.label}</span>
        </label>
      ))}
      <div className="rounded-lg bg-canvas p-3 text-xs text-muted">
        <p className="mb-1 font-medium text-ink">Always on</p>
        <ul className="list-disc pl-4">{alwaysOn.map((a) => <li key={a}>{a}</li>)}</ul>
      </div>
    </div>
  );
}

export function EmailChangeForm({ currentEmail, verified }: { currentEmail: string; verified: boolean }) {
  const { pending, ready, error, fields, run } = useSubmit();
  const [sent, setSent] = useState(false);
  if (!verified) return <p className="text-sm text-muted">Verify your current address before changing it.</p>;
  return (
    <form
      method="post"
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const f = e.currentTarget;
        setSent(false);
        void run(async () => {
          await api('/api/v1/account/email', { body: { newEmail: formValue(f, 'newEmail'), password: formValue(f, 'password') } });
          f.reset();
          setSent(true);
        });
      }}
    >
      <p className="text-sm text-muted">Current address: <strong className="text-ink">{currentEmail}</strong>. We email a confirmation link to the new address; nothing changes until you open it.</p>
      {error && <Alert>{error}</Alert>}
      {sent && <Alert tone="ok">If that address can be used, a confirmation link is on its way.</Alert>}
      <Field label="New email address" htmlFor="newEmail" error={fields.newEmail}><Input id="newEmail" name="newEmail" type="email" inputMode="email" required autoComplete="off" /></Field>
      <Field label="Your password" htmlFor="emailPw" error={fields.password}><Input id="emailPw" name="password" type="password" autoComplete="current-password" required /></Field>
      <Button type="submit" loading={pending || !ready}>Send confirmation</Button>
    </form>
  );
}

export function PasswordForm() {
  const { pending, ready, error, fields, run } = useSubmit();
  const [done, setDone] = useState(false);
  return (
    <form
      method="post"
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const f = e.currentTarget;
        setDone(false);
        void run(async () => {
          await api('/api/v1/auth/change-password', {
            body: { currentPassword: formValue(f, 'currentPassword'), newPassword: formValue(f, 'newPassword'), confirmPassword: formValue(f, 'confirmPassword') },
          });
          f.reset();
          setDone(true);
        });
      }}
    >
      {error && <Alert>{error}</Alert>}
      {done && <Alert tone="ok">Password changed. Your other devices were signed out and we emailed you a notice.</Alert>}
      <Field label="Current password" htmlFor="currentPassword" error={fields.currentPassword}><Input id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" required /></Field>
      <Field label="New password" htmlFor="newPassword" error={fields.newPassword} hint="At least 10 characters."><Input id="newPassword" name="newPassword" type="password" autoComplete="new-password" required /></Field>
      <Field label="Confirm new password" htmlFor="confirmPassword" error={fields.confirmPassword}><Input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" required /></Field>
      <Button type="submit" loading={pending || !ready}>Change password</Button>
    </form>
  );
}

export function DeactivatePanel({ mfaEnabled }: { mfaEnabled: boolean }) {
  const router = useRouter();
  const { pending, ready, error, fields, run } = useSubmit();
  const [open, setOpen] = useState(false);
  if (!open) return <Button variant="danger" onClick={() => setOpen(true)}>Deactivate my account…</Button>;
  return (
    <form
      method="post"
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const f = e.currentTarget;
        void run(async () => {
          await api('/api/v1/account/deactivate', { body: { password: formValue(f, 'password'), mfaCode: formValue(f, 'mfaCode') || undefined } });
          router.replace('/login');
          router.refresh();
        });
      }}
    >
      <Alert tone="warn">You will be signed out everywhere and will not be able to sign in. Your history in any business you worked in is kept. You cannot do this while you are the Owner of a business.</Alert>
      {error && <Alert>{error}</Alert>}
      <Field label="Your password" htmlFor="deactPw" error={fields.password}><Input id="deactPw" name="password" type="password" autoComplete="current-password" required /></Field>
      {mfaEnabled && <Field label="Authenticator code" htmlFor="deactCode" error={fields.mfaCode}><Input id="deactCode" name="mfaCode" inputMode="numeric" autoComplete="one-time-code" /></Field>}
      <div className="flex gap-2">
        <Button type="submit" variant="danger" loading={pending || !ready}>Deactivate account</Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}

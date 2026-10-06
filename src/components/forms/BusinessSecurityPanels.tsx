'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Badge, Button, Field, Input, Select } from '@/components/ui';
import { formValue, useSubmit } from '@/components/forms/use-submit';
import { api } from '@/lib/api-client';

export function MfaRequirement({ required, available, ownMfa }: { required: boolean; available: boolean; ownMfa: boolean }) {
  const router = useRouter();
  const { pending, ready, error, run } = useSubmit();
  if (!available) return <Alert tone="warn">Requiring two-factor authentication for your team is not included in your plan. Upgrade to turn it on.</Alert>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2"><Badge tone={required ? 'ok' : 'neutral'}>{required ? 'Required for everyone' : 'Optional'}</Badge></div>
      <p className="text-sm text-muted">When required, team members must turn on two-factor authentication before they can use this business. Anyone without it is asked to set it up on their next visit.</p>
      {!ownMfa && !required && <Alert tone="warn">Turn on two-factor authentication for your own account first (My account → Security), so you are not locked out.</Alert>}
      {error && <Alert>{error}</Alert>}
      <Button variant={required ? 'secondary' : 'primary'} loading={pending || !ready} disabled={!required && !ownMfa} onClick={() => void run(async () => { await api('/api/v1/business/mfa-requirement', { body: { required: !required } }); router.refresh(); })}>
        {required ? 'Stop requiring' : 'Require two-factor authentication'}
      </Button>
    </div>
  );
}

export function TransferOwnership({ candidates, mfaEnabled }: { candidates: { id: string; label: string }[]; mfaEnabled: boolean }) {
  const router = useRouter();
  const { pending, ready, error, fields, run } = useSubmit();
  const [open, setOpen] = useState(false);
  if (candidates.length === 0) return <p className="text-sm text-muted">Invite someone and have them join before you can transfer ownership to them.</p>;
  if (!open) return <Button variant="secondary" onClick={() => setOpen(true)}>Transfer ownership…</Button>;
  return (
    <form
      method="post"
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const f = e.currentTarget;
        void run(async () => {
          await api('/api/v1/business/transfer-ownership', {
            body: { targetMembershipId: formValue(f, 'target'), confirm: formValue(f, 'confirm'), password: formValue(f, 'password'), mfaCode: formValue(f, 'mfaCode') || undefined },
          });
          router.refresh();
          setOpen(false);
        });
      }}
    >
      <Alert tone="warn">The new Owner gets full control, including billing, and you become an Admin. Only they can transfer it back.</Alert>
      {error && <Alert>{error}</Alert>}
      <Field label="New owner" htmlFor="target" error={fields.targetMembershipId}>
        <Select id="target" name="target" required>{candidates.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select>
      </Field>
      <Field label="Type TRANSFER to confirm" htmlFor="confirm" error={fields.confirm}><Input id="confirm" name="confirm" autoComplete="off" /></Field>
      <Field label="Your password" htmlFor="tpw" error={fields.password}><Input id="tpw" name="password" type="password" autoComplete="current-password" required /></Field>
      {mfaEnabled && <Field label="Authenticator code" htmlFor="tcode" error={fields.mfaCode}><Input id="tcode" name="mfaCode" inputMode="numeric" autoComplete="one-time-code" /></Field>}
      <div className="flex gap-2"><Button type="submit" variant="danger" loading={pending || !ready}>Transfer ownership</Button><Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button></div>
    </form>
  );
}

export function CloseBusiness({ businessName, mfaEnabled }: { businessName: string; mfaEnabled: boolean }) {
  const router = useRouter();
  const { pending, ready, error, fields, run } = useSubmit();
  const [open, setOpen] = useState(false);
  if (!open) return <Button variant="danger" onClick={() => setOpen(true)}>Close this business…</Button>;
  return (
    <form
      method="post"
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const f = e.currentTarget;
        void run(async () => {
          await api('/api/v1/business/close', { body: { confirmName: formValue(f, 'confirmName'), reason: formValue(f, 'reason'), password: formValue(f, 'password'), mfaCode: formValue(f, 'mfaCode') || undefined } });
          router.replace('/onboarding?new=1');
          router.refresh();
        });
      }}
    >
      <Alert tone="warn">
        Closing <strong>{businessName}</strong> signs everyone out of it immediately and stops billing. Nothing is deleted: your data is retained under our retention policy, but you will not be able to use the business any more.
      </Alert>
      {error && <Alert>{error}</Alert>}
      <Field label={`Type “${businessName}” to confirm`} htmlFor="confirmName" error={fields.confirmName}><Input id="confirmName" name="confirmName" autoComplete="off" /></Field>
      <Field label="Reason (optional)" htmlFor="reason"><Input id="reason" name="reason" /></Field>
      <Field label="Your password" htmlFor="cpw" error={fields.password}><Input id="cpw" name="password" type="password" autoComplete="current-password" required /></Field>
      {mfaEnabled && <Field label="Authenticator code" htmlFor="ccode" error={fields.mfaCode}><Input id="ccode" name="mfaCode" inputMode="numeric" autoComplete="one-time-code" /></Field>}
      <div className="flex gap-2"><Button type="submit" variant="danger" loading={pending || !ready}>Close business</Button><Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button></div>
    </form>
  );
}

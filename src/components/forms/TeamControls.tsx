'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, Input, Select } from '@/components/ui';
import { ActionButton } from '@/components/forms/RowActions';
import { formValue, useSubmit } from '@/components/forms/use-submit';
import { api, ApiError } from '@/lib/api-client';

interface RoleOption {
  id: string;
  name: string;
  key?: string;
}

export function InviteForm({ roles, locations }: { roles: RoleOption[]; locations: { id: string; name: string }[] }) {
  const router = useRouter();
  const { pending, ready, error, fields, run } = useSubmit();
  const [sent, setSent] = useState<string | null>(null);
  const [restrict, setRestrict] = useState(false);

  return (
    <form
      method="post"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const email = formValue(form, 'email');
        const locationIds = restrict ? [...new FormData(form).getAll('locationIds')].map(String) : undefined;
        setSent(null);
        void run(async () => {
          await api('/api/v1/members', { body: { email, roleId: formValue(form, 'roleId'), ...(locationIds ? { locationIds } : {}) } });
          setSent(email);
          form.reset();
          setRestrict(false);
          router.refresh();
        });
      }}
      className="space-y-3"
    >
      {error && <Alert>{error}</Alert>}
      {sent && <Alert tone="ok">Invitation sent to {sent}.</Alert>}
      <div className="grid gap-3 sm:grid-cols-[1fr_14rem_auto] sm:items-end">
        <Field label="Email" htmlFor="invite-email" error={fields.email}>
          <Input id="invite-email" name="email" type="email" inputMode="email" required aria-invalid={!!fields.email} />
        </Field>
        <Field label="Role" htmlFor="invite-role" error={fields.roleId}>
          <Select id="invite-role" name="roleId" defaultValue={(roles.find((r) => r.key === 'technician') ?? roles[roles.length - 1])?.id}>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
        </Field>
        <Button type="submit" loading={pending || !ready}>Send invite</Button>
      </div>
      {locations.length > 1 && (
        <div>
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <input type="checkbox" checked={restrict} onChange={(e) => setRestrict(e.target.checked)} className="size-5 rounded border-line" />
            Limit to specific locations
          </label>
          {restrict && (
            <div className="mt-1 grid gap-1 sm:grid-cols-2">
              {locations.map((l) => (
                <label key={l.id} className="flex min-h-11 items-center gap-3 text-sm">
                  <input type="checkbox" name="locationIds" value={l.id} className="size-5 rounded border-line" /> {l.name}
                </label>
              ))}
            </div>
          )}
          {fields.locationIds && <p role="alert" className="text-xs font-medium text-danger">{fields.locationIds}</p>}
        </div>
      )}
    </form>
  );
}

export function RoleSelect({ membershipId, currentRoleId, roles }: { membershipId: string; currentRoleId: string; roles: RoleOption[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      <Select
        aria-label="Change role"
        defaultValue={currentRoleId}
        disabled={busy}
        onChange={async (e) => {
          setBusy(true);
          setError(null);
          try {
            await api(`/api/v1/members/${membershipId}`, { method: 'PATCH', body: { roleId: e.target.value } });
            router.refresh();
          } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Could not change role.');
            e.target.value = currentRoleId;
          } finally {
            setBusy(false);
          }
        }}
      >
        {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        {!roles.some((r) => r.id === currentRoleId) && <option value={currentRoleId}>Current role</option>}
      </Select>
      {error && <p role="alert" className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

export function MemberActions({ id, status, isSelf, isOwner, canSuspend, canInvite }: { id: string; status: string; isSelf: boolean; isOwner: boolean; canSuspend: boolean; canInvite: boolean }) {
  if (status === 'INVITED') {
    return canInvite ? (
      <div className="flex flex-wrap gap-1">
        <ActionButton label="Resend" variant="ghost" path={`/api/v1/members/${id}/resend`} />
        <ActionButton label="Revoke" variant="ghost" path={`/api/v1/members/${id}`} method="DELETE" confirm="Revoke this invitation?" />
      </div>
    ) : null;
  }
  if (isSelf || isOwner || !canSuspend) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {status === 'ACTIVE' && <ActionButton label="Suspend" variant="ghost" path={`/api/v1/members/${id}/status`} body={{ action: 'suspend' }} confirm="Suspend this person? They lose access immediately; their history is kept." />}
      {status === 'SUSPENDED' && <ActionButton label="Reactivate" variant="ghost" path={`/api/v1/members/${id}/status`} body={{ action: 'reactivate' }} />}
      {(status === 'ACTIVE' || status === 'SUSPENDED') && <ActionButton label="Remove" variant="ghost" path={`/api/v1/members/${id}/status`} body={{ action: 'remove' }} confirm="Remove this person from the business? Their past work stays on record." />}
    </div>
  );
}

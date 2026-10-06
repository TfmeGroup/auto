'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, Input, Select } from '@/components/ui';
import { useSubmit } from '@/components/forms/use-submit';
import { api } from '@/lib/api-client';

/** Remember a report with its current filters (a "view"), privately or for the whole business. The saved report is only a recipe: whoever runs it sees only what their own role allows. */
export function SaveViewForm({ reportKey, config, canShare, defaultName }: { reportKey: string; config: Record<string, unknown>; canShare: boolean; defaultName: string }) {
  const router = useRouter();
  const { pending, ready, error, fields, run } = useSubmit();
  const [done, setDone] = useState<string | null>(null);
  return (
    <details className="rounded-xl border border-line bg-surface">
      <summary className="min-h-11 cursor-pointer px-4 text-sm font-semibold leading-[2.75rem]">Save this view</summary>
      <form
        method="post" noValidate className="space-y-3 border-t border-line p-4"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void run(async () => {
            const res = await api<{ id: string }>('/api/v1/reports/saved', { body: { kind: 'STANDARD', reportKey, name: f.get('name'), config, visibility: f.get('visibility') ?? 'PRIVATE' } });
            setDone(res.data.id);
            router.refresh();
          });
        }}
      >
        {error && <Alert>{error}</Alert>}
        {done && <Alert tone="ok">Saved. Find it under Saved reports.</Alert>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="svName" error={fields.name}><Input id="svName" name="name" required maxLength={80} defaultValue={defaultName} /></Field>
          {canShare && <Field label="Who can use it" htmlFor="svVis"><Select id="svVis" name="visibility" defaultValue="PRIVATE"><option value="PRIVATE">Only me</option><option value="BUSINESS">Everyone in the business</option></Select></Field>}
        </div>
        <Button type="submit" loading={pending || !ready}>Save</Button>
      </form>
    </details>
  );
}

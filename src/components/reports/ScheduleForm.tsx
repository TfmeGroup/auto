'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Card, Field, Select } from '@/components/ui';
import { useSubmit } from '@/components/forms/use-submit';
import { api } from '@/lib/api-client';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Schedule a saved report by email. Each recipient receives their own copy, made with their own permissions; people who could not see the report cannot be chosen. */
export function ScheduleForm({ reports, members, selfId }: { reports: { value: string; label: string }[]; members: { value: string; label: string }[]; selfId: string }) {
  const router = useRouter();
  const { pending, ready, error, fields, run } = useSubmit();
  const [frequency, setFrequency] = useState('WEEKLY');
  const [recipients, setRecipients] = useState<string[]>([selfId]);
  return (
    <Card>
      <h2 className="mb-3 text-base font-semibold">New schedule</h2>
      {reports.length === 0 ? <p className="text-sm text-muted">Save a report first (open any report and choose “Save this view”), then schedule it here.</p> : (
        <form
          method="post" noValidate className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void run(async () => {
              await api('/api/v1/reports/schedules', { body: { savedReportId: f.get('report'), frequency, weekday: frequency === 'WEEKLY' ? Number(f.get('weekday')) : undefined, monthDay: frequency === 'MONTHLY' ? Number(f.get('monthDay')) : undefined, hour: Number(f.get('hour')), format: f.get('format'), recipientMembershipIds: recipients } });
              router.refresh();
            });
          }}
        >
          {error && <Alert>{error}</Alert>}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Report" htmlFor="sc-report" error={fields.savedReportId}><Select id="sc-report" name="report">{reports.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</Select></Field>
            <Field label="How often" htmlFor="sc-freq"><Select id="sc-freq" value={frequency} onChange={(e) => setFrequency(e.target.value)}><option value="DAILY">Every day</option><option value="WEEKLY">Every week</option><option value="MONTHLY">Every month</option></Select></Field>
            {frequency === 'WEEKLY' && <Field label="On" htmlFor="sc-day" error={fields.weekday}><Select id="sc-day" name="weekday" defaultValue="1">{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</Select></Field>}
            {frequency === 'MONTHLY' && <Field label="On day" htmlFor="sc-md" error={fields.monthDay} hint="1 to 28, so it exists in every month."><Select id="sc-md" name="monthDay" defaultValue="1">{Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}</Select></Field>}
            <Field label="At (your time zone)" htmlFor="sc-hour"><Select id="sc-hour" name="hour" defaultValue="7">{Array.from({ length: 24 }, (_, h) => h).map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</Select></Field>
            <Field label="File" htmlFor="sc-format"><Select id="sc-format" name="format" defaultValue="CSV"><option value="CSV">CSV</option><option value="XLSX">Excel</option><option value="PDF">PDF</option></Select></Field>
          </div>
          <fieldset>
            <legend className="mb-1 text-sm font-medium">Send to</legend>
            {fields.recipients && <p role="alert" className="mb-1 text-xs font-medium text-danger">{fields.recipients}</p>}
            <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
              {members.map((m) => <label key={m.value} className="flex min-h-11 items-center gap-2 rounded-lg border border-line px-3 text-sm"><input type="checkbox" className="size-5" checked={recipients.includes(m.value)} onChange={() => setRecipients(recipients.includes(m.value) ? recipients.filter((x) => x !== m.value) : [...recipients, m.value])} />{m.label}</label>)}
            </div>
          </fieldset>
          <Button type="submit" loading={pending || !ready} disabled={recipients.length === 0}>Schedule</Button>
        </form>
      )}
    </Card>
  );
}

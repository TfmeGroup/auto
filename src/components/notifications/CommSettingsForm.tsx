'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Input, Select, Textarea } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';

interface Rule { enabled: boolean; permission: string; inApp: boolean; email: boolean }
export interface SettingsData {
  senderName: string | null;
  replyTo: string | null;
  signature: string | null;
  smsEnabled: boolean;
  whatsappEnabled: boolean;
  jobUpdateEvents: string[];
  bookingReminderHours: number;
  serviceReminderDays: number;
  serviceReminderKm: number;
  serviceRemindersOn: boolean;
  bookingRemindersOn: boolean;
  maxPerHour: number;
  internalRules: Record<string, Rule>;
}

const WHO: [string, string][] = [
  ['inventory.edit', 'People who edit stock'], ['inventory.purchase', 'People who buy stock'], ['booking.manage', 'People who manage bookings'], ['quote.view', 'People who see quotes'],
  ['payment.view', 'People who see payments'], ['job.assign', 'People who assign jobs'], ['notification.view_history', 'People who see message history'], ['settings.view', 'People who see settings'],
];

/** How this business's messages behave. These cannot switch off security alerts or account emails, and the sending address is always the platform's. */
export function CommSettingsForm({ initial, jobUpdates, internalEvents, canEdit, can }: {
  initial: SettingsData;
  jobUpdates: { key: string; label: string }[];
  internalEvents: { type: string; label: string; permission: string }[];
  canEdit: boolean;
  can: { sms: boolean; whatsapp: boolean; smsProvider: boolean; whatsappProvider: boolean; advanced: boolean; serviceReminders: boolean };
}) {
  const router = useRouter();
  const [s, setS] = useState(initial);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const ruleOf = (type: string, perm: string): Rule => s.internalRules[type] ?? { enabled: type !== 'JOB_STATUS_CHANGED', permission: perm, inApp: true, email: false };

  async function save() {
    setBusy(true); setMsg(null);
    try {
      await api('/api/v1/communication/settings', { method: 'PUT', body: {
        senderName: s.senderName || null, replyTo: s.replyTo || null, signature: s.signature || null, smsEnabled: s.smsEnabled, whatsappEnabled: s.whatsappEnabled,
        bookingReminderHours: s.bookingReminderHours, serviceReminderDays: s.serviceReminderDays, serviceReminderKm: s.serviceReminderKm, serviceRemindersOn: s.serviceRemindersOn,
        bookingRemindersOn: s.bookingRemindersOn, maxPerHour: s.maxPerHour,
        ...(can.advanced ? { jobUpdateEvents: s.jobUpdateEvents, internalRules: s.internalRules } : {}),
      } });
      setMsg({ tone: 'ok', text: 'Settings saved.' });
      router.refresh();
    } catch (e) { setMsg({ tone: 'danger', text: e instanceof ApiError ? e.message : 'Could not save.' }); } finally { setBusy(false); }
  }

  const check = (id: string, label: string, hint: string, value: boolean, onChange: (v: boolean) => void, disabled = false) => (
    <label key={id} className="flex min-h-11 items-start gap-3 rounded-lg border border-line px-3 py-2">
      <input type="checkbox" className="mt-1 size-5" checked={value} disabled={disabled || !canEdit} onChange={(e) => onChange(e.target.checked)} />
      <span><span className="block text-sm font-medium">{label}</span><span className="block text-xs text-muted">{hint}</span></span>
    </label>
  );

  return (
    <div className="space-y-6">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}

      <section className="space-y-3" aria-labelledby="ident">
        <h3 id="ident" className="text-sm font-semibold">How your emails appear</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label htmlFor="sender" className="mb-1 block text-sm font-medium">Sender name</label><Input id="sender" value={s.senderName ?? ''} maxLength={80} disabled={!canEdit} placeholder="Your business name" onChange={(e) => setS({ ...s, senderName: e.target.value })} /><p className="mt-1 text-xs text-muted">The name customers see. The sending address itself is always the platform&apos;s.</p></div>
          <div><label htmlFor="reply" className="mb-1 block text-sm font-medium">Replies go to</label><Input id="reply" type="email" value={s.replyTo ?? ''} disabled={!canEdit} placeholder="Your business email" onChange={(e) => setS({ ...s, replyTo: e.target.value })} /></div>
        </div>
        <div><label htmlFor="sig" className="mb-1 block text-sm font-medium">Signature</label><Textarea id="sig" rows={3} maxLength={500} value={s.signature ?? ''} disabled={!canEdit} placeholder="Added to the end of every email" onChange={(e) => setS({ ...s, signature: e.target.value })} /></div>
      </section>

      <section className="space-y-2" aria-labelledby="channels">
        <h3 id="channels" className="text-sm font-semibold">Text messages</h3>
        {check('sms', 'Send SMS messages', can.sms ? (can.smsProvider ? 'Only to customers who agreed to SMS.' : 'No SMS provider is connected on this system yet, so messages are recorded as not sent.') : 'SMS is included from the Team plan.', s.smsEnabled, (v) => setS({ ...s, smsEnabled: v }), !can.sms)}
        {check('wa', 'Send WhatsApp messages', can.whatsapp ? (can.whatsappProvider ? 'Only to customers who agreed to WhatsApp.' : 'No WhatsApp provider is connected on this system yet, so messages are recorded as not sent.') : 'WhatsApp is included from the Business plan.', s.whatsappEnabled, (v) => setS({ ...s, whatsappEnabled: v }), !can.whatsapp)}
      </section>

      <section className="space-y-2" aria-labelledby="jobupd">
        <h3 id="jobupd" className="text-sm font-semibold">Job updates to customers</h3>
        {!can.advanced && <Alert tone="warn">Customer job updates are included from the Team plan.</Alert>}
        <div className="grid gap-2 sm:grid-cols-2">
          {jobUpdates.map((j) => check(j.key, j.label, 'Sent when the job reaches this stage.', s.jobUpdateEvents.includes(j.key), (v) => setS({ ...s, jobUpdateEvents: v ? [...s.jobUpdateEvents, j.key] : s.jobUpdateEvents.filter((k) => k !== j.key) }), !can.advanced))}
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="rem">
        <h3 id="rem" className="text-sm font-semibold">Reminders</h3>
        {check('brem', 'Remind customers before an appointment', 'Sent once, to customers who have not opted out.', s.bookingRemindersOn, (v) => setS({ ...s, bookingRemindersOn: v }))}
        <div className="max-w-xs"><label htmlFor="bh" className="mb-1 block text-sm font-medium">How many hours before</label><Input id="bh" type="number" min={1} max={336} value={s.bookingReminderHours} disabled={!canEdit} onChange={(e) => setS({ ...s, bookingReminderHours: Number(e.target.value) })} /></div>
        {check('srem', 'Remind customers when a service is due', can.serviceReminders ? 'From each vehicle\'s service intervals (by date or mileage), once per due point.' : 'Service reminders are included from the Team plan.', s.serviceRemindersOn, (v) => setS({ ...s, serviceRemindersOn: v }), !can.serviceReminders)}
        <div className="grid max-w-md gap-3 sm:grid-cols-2">
          <div><label htmlFor="sd" className="mb-1 block text-sm font-medium">Days before the due date</label><Input id="sd" type="number" min={0} max={120} value={s.serviceReminderDays} disabled={!canEdit} onChange={(e) => setS({ ...s, serviceReminderDays: Number(e.target.value) })} /></div>
          <div><label htmlFor="sk" className="mb-1 block text-sm font-medium">Km before the due mileage</label><Input id="sk" type="number" min={0} max={20000} value={s.serviceReminderKm} disabled={!canEdit} onChange={(e) => setS({ ...s, serviceReminderKm: Number(e.target.value) })} /></div>
        </div>
      </section>

      <section className="space-y-2" aria-labelledby="limit">
        <h3 id="limit" className="text-sm font-semibold">Safety limit</h3>
        <div className="max-w-xs"><label htmlFor="mph" className="mb-1 block text-sm font-medium">Most messages per hour</label><Input id="mph" type="number" min={1} max={100000} value={s.maxPerHour} disabled={!canEdit} onChange={(e) => setS({ ...s, maxPerHour: Number(e.target.value) })} /><p className="mt-1 text-xs text-muted">A guard against a mistake sending a flood of messages. Above it, messages wait and are sent as the hour allows.</p></div>
      </section>

      <section className="space-y-2" aria-labelledby="internal">
        <h3 id="internal" className="text-sm font-semibold">Who is told inside the business</h3>
        <p className="text-xs text-muted">Security alerts and billing notices always go to the people concerned and cannot be switched off here.</p>
        {!can.advanced && <Alert tone="warn">Changing who is notified is included from the Team plan.</Alert>}
        <ul className="divide-y divide-line rounded-lg border border-line">
          {internalEvents.map((ev) => {
            const r = ruleOf(ev.type, ev.permission);
            const set = (patch: Partial<Rule>) => setS({ ...s, internalRules: { ...s.internalRules, [ev.type]: { ...r, ...patch } } });
            return (
              <li key={ev.type} className="grid gap-2 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:items-center">
                <div className="min-w-0"><p className="text-sm font-medium">{ev.label}</p>
                  <label className="sr-only" htmlFor={`who-${ev.type}`}>Who is told about {ev.label}</label>
                  <Select id={`who-${ev.type}`} value={r.permission} disabled={!canEdit || !can.advanced} onChange={(e) => set({ permission: e.target.value })}>
                    {[...new Map([...WHO, [ev.permission, ev.permission]]).entries()].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </Select>
                </div>
                <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="size-5" checked={r.enabled} disabled={!canEdit || !can.advanced} onChange={(e) => set({ enabled: e.target.checked })} />On</label>
                <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="size-5" checked={r.inApp} disabled={!canEdit || !can.advanced || !r.enabled} onChange={(e) => set({ inApp: e.target.checked })} />In the app</label>
                <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="size-5" checked={r.email} disabled={!canEdit || !can.advanced || !r.enabled} onChange={(e) => set({ email: e.target.checked })} />Email</label>
              </li>
            );
          })}
        </ul>
      </section>

      {canEdit && <Button type="button" loading={busy} onClick={save}>Save settings</Button>}
    </div>
  );
}

'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Select } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';

interface Prefs {
  preferredChannel: 'EMAIL' | 'SMS' | 'WHATSAPP' | null;
  bookingReminders: boolean;
  jobUpdates: boolean;
  paymentReminders: boolean;
  serviceReminders: boolean;
  smsOk: boolean;
  whatsappOk: boolean;
}

const SWITCHES: [keyof Prefs, string, string][] = [
  ['bookingReminders', 'Booking reminders', 'A reminder before an appointment.'],
  ['jobUpdates', 'Job updates', 'Progress messages about their vehicle, if the business sends them.'],
  ['paymentReminders', 'Payment reminders', 'Reminders about an invoice that is due or overdue.'],
  ['serviceReminders', 'Service reminders', 'When a service is due by date or mileage.'],
];

/** The customer's communication choices, and their agreement to text messages. Their own quotes, invoices, receipts and booking changes are always sent: those cannot be switched off. */
export function PrefsForm({ customerId, initial, canEdit, smsAvailable, whatsappAvailable }: { customerId: string; initial: Prefs; canEdit: boolean; smsAvailable: boolean; whatsappAvailable: boolean }) {
  const router = useRouter();
  const [p, setP] = useState(initial);
  const [source, setSource] = useState('in_person');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true); setMsg(null);
    try {
      await api(`/api/v1/customers/${customerId}/communication`, { method: 'PUT', body: { preferredChannel: p.preferredChannel, bookingReminders: p.bookingReminders, jobUpdates: p.jobUpdates, paymentReminders: p.paymentReminders, serviceReminders: p.serviceReminders } });
      setMsg({ tone: 'ok', text: 'Preferences saved.' });
      router.refresh();
    } catch (e) { setMsg({ tone: 'danger', text: e instanceof ApiError ? e.message : 'Could not save.' }); } finally { setBusy(false); }
  }

  async function consent(type: 'SMS' | 'WHATSAPP', status: 'GRANTED' | 'WITHDRAWN') {
    setBusy(true); setMsg(null);
    try {
      await api(`/api/v1/customers/${customerId}/consent`, { body: { type, status, source } });
      setP((cur) => ({ ...cur, ...(type === 'SMS' ? { smsOk: status === 'GRANTED' } : { whatsappOk: status === 'GRANTED' }) }));
      setMsg({ tone: 'ok', text: `${type === 'SMS' ? 'SMS' : 'WhatsApp'} consent ${status === 'GRANTED' ? 'recorded' : 'withdrawn'}.` });
      router.refresh();
    } catch (e) { setMsg({ tone: 'danger', text: e instanceof ApiError ? e.message : 'Could not record that.' }); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <p className="text-sm text-muted">Quotes, invoices, receipts and changes to a booking are always sent: they are the customer&apos;s own records and cannot be switched off. The choices below apply to optional messages.</p>
      <fieldset className="space-y-2" disabled={!canEdit}>
        <legend className="mb-1 text-sm font-semibold">Optional messages</legend>
        {SWITCHES.map(([key, label, hint]) => (
          <label key={key} className="flex min-h-11 items-start gap-3 rounded-lg border border-line px-3 py-2">
            <input type="checkbox" className="mt-1 size-5" checked={p[key] as boolean} onChange={(e) => setP({ ...p, [key]: e.target.checked })} />
            <span><span className="block text-sm font-medium">{label}</span><span className="block text-xs text-muted">{hint}</span></span>
          </label>
        ))}
        <div>
          <label htmlFor="pref-channel" className="mb-1 block text-sm font-medium">Preferred way to be reached</label>
          <Select id="pref-channel" value={p.preferredChannel ?? ''} onChange={(e) => setP({ ...p, preferredChannel: (e.target.value || null) as Prefs['preferredChannel'] })}>
            <option value="">No preference (email)</option>
            <option value="EMAIL">Email</option>
            <option value="SMS">SMS</option>
            <option value="WHATSAPP">WhatsApp</option>
          </Select>
        </div>
        {canEdit && <Button type="button" variant="secondary" loading={busy} onClick={save}>Save preferences</Button>}
      </fieldset>

      <fieldset className="space-y-3 rounded-lg border border-line p-3" disabled={!canEdit}>
        <legend className="px-1 text-sm font-semibold">Text messages (need the customer&apos;s agreement)</legend>
        <div>
          <label htmlFor="consent-source" className="mb-1 block text-xs font-medium">How did they agree?</label>
          <Select id="consent-source" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="in_person">In person</option><option value="phone">By phone</option><option value="written_form">On a signed form</option><option value="customer_request">They asked us to</option>
          </Select>
        </div>
        {([['SMS', p.smsOk, smsAvailable], ['WHATSAPP', p.whatsappOk, whatsappAvailable]] as const).map(([type, ok, available]) => (
          <div key={type} className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm"><span className="font-medium">{type === 'SMS' ? 'SMS' : 'WhatsApp'}:</span> {ok ? 'agreed' : 'not agreed'}{!available ? ' (this system has no provider set up for it yet)' : ''}</p>
            {canEdit && (ok
              ? <Button type="button" variant="secondary" loading={busy} onClick={() => void consent(type, 'WITHDRAWN')}>Record withdrawal</Button>
              : <Button type="button" variant="secondary" loading={busy} onClick={() => void consent(type, 'GRANTED')}>Record agreement</Button>)}
          </div>
        ))}
        <p className="text-xs text-muted">Marketing consent is separate and is never used for these messages.</p>
      </fieldset>
    </div>
  );
}

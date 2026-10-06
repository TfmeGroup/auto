'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Input, Textarea } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';

/** Write one message to this customer. It goes out by their preferred channel, is recorded in their history, and cannot be sent to a list. */
export function ManualMessageForm({ customerId, entityType, entityId }: { customerId: string; entityType?: string; entityId?: string }) {
  const router = useRouter();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);

  async function send() {
    setBusy(true); setMsg(null);
    try {
      await api('/api/v1/communications/send', { body: { customerId, subject: subject || undefined, body, entityType, entityId } });
      setBody(''); setSubject('');
      setMsg({ tone: 'ok', text: 'Message queued. You can follow it in the history.' });
      router.refresh();
    } catch (e) { setMsg({ tone: 'danger', text: e instanceof ApiError ? e.message : 'The message could not be sent.' }); } finally { setBusy(false); }
  }

  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <h3 className="text-sm font-semibold">Send a message</h3>
      <div>
        <label htmlFor="mm-subject" className="mb-1 block text-xs font-medium">Subject (email only)</label>
        <Input id="mm-subject" value={subject} maxLength={150} onChange={(e) => setSubject(e.target.value)} />
      </div>
      <div>
        <label htmlFor="mm-body" className="mb-1 block text-xs font-medium">Message</label>
        <Textarea id="mm-body" rows={4} value={body} maxLength={1000} onChange={(e) => setBody(e.target.value)} required />
        <p className="mt-1 text-xs text-muted">{body.length}/1000. Do not include prices you would not want the customer to see. Internal notes are never added.</p>
      </div>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <Button type="submit" loading={busy} disabled={body.trim().length < 2}>Send message</Button>
    </form>
  );
}

'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Alert, Badge, Button, Input } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';

interface Props {
  event: string;
  label: string;
  channel: 'EMAIL' | 'SMS' | 'WHATSAPP';
  mandatory: boolean;
  system: { subject: string | null; body: string };
  custom: { subject: string | null; body: string; active: boolean; version: number } | null;
  variables: string[];
  descriptions: Record<string, string>;
  canEdit: boolean;
  canCustomise: boolean;
}

const CH: Record<string, string> = { EMAIL: 'Email', SMS: 'SMS', WHATSAPP: 'WhatsApp' };

/**
 * One message template. Only {{placeholders}} from the list can be used: a template is plain text and cannot run anything or reach any
 * data. Previews use made-up sample values, never a real customer. The system wording is always there as the fallback.
 */
export function TemplateEditor({ event, label, channel, mandatory, system, custom, variables, descriptions, canEdit, canCustomise }: Props) {
  const router = useRouter();
  const start = custom?.active ? custom : system;
  const [subject, setSubject] = useState(start.subject ?? '');
  const [body, setBody] = useState(start.body);
  const [preview, setPreview] = useState<{ subject: string | null; text: string; characters: number; parts?: number } | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const editable = canEdit && canCustomise;

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key); setMsg(null);
    try { await fn(); } catch (e) {
      const fields = e instanceof ApiError ? Object.values(e.fields) : [];
      setMsg({ tone: 'danger', text: fields.length ? fields.join(' ') : e instanceof ApiError ? e.message : 'That did not work.' });
    } finally { setBusy(null); }
  }

  const payload = { event, channel, subject: channel === 'EMAIL' ? subject : null, body };
  const insert = (v: string) => {
    const el = bodyRef.current;
    const token = `{{${v}}}`;
    if (!el) return setBody(body + token);
    const a = el.selectionStart ?? body.length;
    const b = el.selectionEnd ?? body.length;
    setBody(body.slice(0, a) + token + body.slice(b));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + token.length, a + token.length); });
  };

  return (
    <details className="rounded-lg border border-line bg-surface">
      <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-sm font-medium">
        <span>{label}</span><Badge>{CH[channel]}</Badge>
        {custom?.active ? <Badge tone="brand">Your wording</Badge> : <Badge>Standard wording</Badge>}
        {mandatory && <Badge tone="warn">Always sent</Badge>}
      </summary>
      <div className="space-y-3 border-t border-line p-3">
        {mandatory && <p className="text-xs text-muted">Customers always receive this message; it is part of their own records. You can change the wording but not switch it off.</p>}
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        {channel === 'EMAIL' && (
          <div><label htmlFor={`s-${event}-${channel}`} className="mb-1 block text-xs font-medium">Subject</label><Input id={`s-${event}-${channel}`} value={subject} maxLength={150} disabled={!editable} onChange={(e) => setSubject(e.target.value)} /></div>
        )}
        <div>
          <label htmlFor={`b-${event}-${channel}`} className="mb-1 block text-xs font-medium">Message</label>
          <textarea className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm disabled:opacity-60" id={`b-${event}-${channel}`} ref={bodyRef} rows={channel === 'EMAIL' ? 8 : 4} value={body} maxLength={channel === 'EMAIL' ? 4000 : 480} disabled={!editable} onChange={(e) => setBody(e.target.value)} />
          <p className="mt-1 text-xs text-muted">{body.length} characters{channel !== 'EMAIL' ? ` · about ${Math.max(1, Math.ceil(body.length / 160))} text message part${Math.ceil(body.length / 160) > 1 ? 's' : ''}` : ''}</p>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium">Placeholders you can use{editable ? ' (tap to add)' : ''}</p>
          <div className="flex flex-wrap gap-1.5">
            {variables.map((v) => (
              <button key={v} type="button" disabled={!editable} onClick={() => insert(v)} title={descriptions[v]} className="min-h-9 rounded-full border border-line bg-canvas px-2.5 font-mono text-xs hover:bg-brand-50 disabled:opacity-60">{`{{${v}}}`}</button>
            ))}
          </div>
        </div>
        {preview && (
          <div className="rounded-lg border border-line bg-canvas p-3 text-sm" aria-live="polite">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Preview with sample values</p>
            {preview.subject !== null && <p className="font-semibold">{preview.subject}</p>}
            <pre className="mt-1 whitespace-pre-wrap break-words font-sans">{preview.text}</pre>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" loading={busy === 'preview'} onClick={() => run('preview', async () => { const r = await api<{ subject: string | null; text: string; characters: number; parts?: number }>('/api/v1/communication/templates/preview', { body: payload }); setPreview(r.data); })}>Preview</Button>
          {editable && <Button type="button" loading={busy === 'save'} onClick={() => run('save', async () => { await api('/api/v1/communication/templates', { method: 'PUT', body: payload }); setMsg({ tone: 'ok', text: 'Saved. New messages use this wording.' }); router.refresh(); })}>Save my wording</Button>}
          {editable && (
            <Button type="button" variant="ghost" onClick={() => { setSubject(system.subject ?? ''); setBody(system.body); setPreview(null); }}>Start from the standard wording</Button>
          )}
          {canEdit && custom?.active && <Button type="button" variant="ghost" loading={busy === 'off'} onClick={() => run('off', async () => { await api('/api/v1/communication/templates/active', { body: { event, channel, active: false } }); router.refresh(); })}>Go back to standard wording</Button>}
          {canEdit && custom && !custom.active && canCustomise && <Button type="button" variant="ghost" loading={busy === 'on'} onClick={() => run('on', async () => { await api('/api/v1/communication/templates/active', { body: { event, channel, active: true } }); router.refresh(); })}>Use my saved wording again</Button>}
        </div>
      </div>
    </details>
  );
}

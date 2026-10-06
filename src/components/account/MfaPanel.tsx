'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Badge, Button, Field, Input } from '@/components/ui';
import { formValue, useSubmit } from '@/components/forms/use-submit';
import { api } from '@/lib/api-client';

interface Setup {
  secret: string;
  otpauthUri: string;
  qrSvg: string;
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const text = codes.join('\n');
  return (
    <div className="space-y-3">
      <Alert tone="warn">Save these recovery codes somewhere safe. Each works once if you lose your phone. They are shown only now.</Alert>
      <ul className="grid grid-cols-2 gap-2 rounded-lg bg-canvas p-3 font-mono text-sm">{codes.map((c) => <li key={c}>{c}</li>)}</ul>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={() => void navigator.clipboard?.writeText(text)}>Copy</Button>
        <a className="inline-flex min-h-11 items-center rounded-lg border border-line px-4 text-sm font-semibold md:min-h-10" href={`data:text/plain;charset=utf-8,${encodeURIComponent(`TFME Auto recovery codes\n\n${text}\n`)}`} download="tfme-auto-recovery-codes.txt">Download</a>
        <Button type="button" onClick={onDone}>I have saved them</Button>
      </div>
    </div>
  );
}

export function MfaPanel({ enabled, recoveryCodesRemaining, required }: { enabled: boolean; recoveryCodesRemaining: number; required: boolean }) {
  const router = useRouter();
  const start = useSubmit();
  const enable = useSubmit();
  const disable = useSubmit();
  const regen = useSubmit();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [mode, setMode] = useState<'idle' | 'disable' | 'regen'>('idle');

  if (codes) return <RecoveryCodes codes={codes} onDone={() => { setCodes(null); setSetup(null); router.refresh(); }} />;

  if (!enabled && !setup) {
    return (
      <div className="space-y-3">
        {required && <Alert tone="warn">Your business requires two-factor authentication. Turn it on to keep using the business.</Alert>}
        <p className="text-sm text-muted">Add a second step at sign-in with an authenticator app (Google Authenticator, Microsoft Authenticator, Authy, 1Password…). Even if your password is stolen, your account stays safe.</p>
        {start.error && <Alert>{start.error}</Alert>}
        <Button loading={start.pending || !start.ready} onClick={() => void start.run(async () => setSetup((await api<Setup>('/api/v1/account/mfa/setup', { body: {} })).data))}>Set up two-factor authentication</Button>
      </div>
    );
  }

  if (!enabled && setup) {
    return (
      <form
        method="post"
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          const f = e.currentTarget;
          void enable.run(async () => setCodes((await api<{ recoveryCodes: string[] }>('/api/v1/account/mfa/enable', { body: { code: formValue(f, 'code') } })).data.recoveryCodes));
        }}
      >
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>Scan the QR code with your authenticator app (or enter the key by hand).</li>
          <li>Type the 6-digit code the app shows.</li>
        </ol>
        {/* Rendered as an <img> data URL so the SVG can never execute script. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img alt="QR code for your authenticator app" width={200} height={200} className="rounded-lg border border-line bg-white p-2" src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.qrSvg)}`} />
        <p className="break-all text-sm">Key: <code className="rounded bg-canvas px-1.5 py-0.5 font-mono">{setup.secret}</code></p>
        {enable.error && <Alert>{enable.error}</Alert>}
        <Field label="6-digit code" htmlFor="mfaCode" error={enable.fields.code}><Input id="mfaCode" name="code" inputMode="numeric" autoComplete="one-time-code" required autoFocus /></Field>
        <div className="flex gap-2">
          <Button type="submit" loading={enable.pending || !enable.ready}>Turn on</Button>
          <Button type="button" variant="secondary" onClick={() => setSetup(null)}>Cancel</Button>
        </div>
      </form>
    );
  }

  // enabled
  const reauthFields = (s: ReturnType<typeof useSubmit>, p: string) => (
    <>
      <Field label="Your password" htmlFor={`${p}Pw`} error={s.fields.password}><Input id={`${p}Pw`} name="password" type="password" autoComplete="current-password" required /></Field>
      <Field label="Authenticator or recovery code" htmlFor={`${p}Code`} error={s.fields.code}><Input id={`${p}Code`} name="code" autoComplete="one-time-code" required /></Field>
    </>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="ok">On</Badge>
        <span className="text-sm text-muted">{recoveryCodesRemaining} recovery code{recoveryCodesRemaining === 1 ? '' : 's'} left</span>
      </div>
      {recoveryCodesRemaining <= 2 && <Alert tone="warn">You are running low on recovery codes. Generate new ones.</Alert>}
      {mode === 'idle' && (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setMode('regen')}>New recovery codes</Button>
          <Button variant="danger" onClick={() => setMode('disable')}>Turn off…</Button>
        </div>
      )}
      {mode === 'regen' && (
        <form method="post" noValidate className="space-y-4" onSubmit={(e) => { e.preventDefault(); const f = e.currentTarget; void regen.run(async () => setCodes((await api<{ recoveryCodes: string[] }>('/api/v1/account/mfa/recovery-codes', { body: { password: formValue(f, 'password'), code: formValue(f, 'code') } })).data.recoveryCodes)); }}>
          <p className="text-sm text-muted">This replaces all your existing recovery codes.</p>
          {regen.error && <Alert>{regen.error}</Alert>}
          {reauthFields(regen, 'regen')}
          <div className="flex gap-2"><Button type="submit" loading={regen.pending || !regen.ready}>Generate</Button><Button type="button" variant="secondary" onClick={() => setMode('idle')}>Cancel</Button></div>
        </form>
      )}
      {mode === 'disable' && (
        <form method="post" noValidate className="space-y-4" onSubmit={(e) => { e.preventDefault(); const f = e.currentTarget; void disable.run(async () => { await api('/api/v1/account/mfa/disable', { body: { password: formValue(f, 'password'), code: formValue(f, 'code') } }); setMode('idle'); router.refresh(); }); }}>
          <Alert tone="warn">Your account will be protected by your password alone.</Alert>
          {disable.error && <Alert>{disable.error}</Alert>}
          {reauthFields(disable, 'dis')}
          <div className="flex gap-2"><Button type="submit" variant="danger" loading={disable.pending || !disable.ready}>Turn off</Button><Button type="button" variant="secondary" onClick={() => setMode('idle')}>Cancel</Button></div>
        </form>
      )}
    </div>
  );
}

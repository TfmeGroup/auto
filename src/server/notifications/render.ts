import { VARIABLES, allowedVariables, type EventKey } from './events';

/**
 * Safe template rendering. A template is plain text with {{variable}} placeholders and NOTHING else: there are no expressions,
 * conditionals, loops, function calls or lookups, so a template cannot run code or reach data. A placeholder is replaced by the value
 * the system supplies for it in ONE pass (a value that happens to contain braces is not expanded again), and a name that is not on
 * the event's allowed list is rejected when the template is saved.
 */
const TOKEN = /\{\{\s*([A-Za-z0-9_.-]*)\s*\}\}/g;
export const MAX_SUBJECT = 150;
export const MAX_BODY = 4000;

export interface TemplateProblem {
  field: 'subject' | 'body';
  message: string;
}

export function validateTemplate(event: EventKey, subject: string | null | undefined, body: string, channel: 'EMAIL' | 'SMS' | 'WHATSAPP' = 'EMAIL'): TemplateProblem[] {
  const allowed = new Set(allowedVariables(event));
  const problems: TemplateProblem[] = [];
  const check = (field: 'subject' | 'body', text: string) => {
    for (const m of text.matchAll(TOKEN)) {
      const name = m[1]!;
      if (!/^[a-z_]+$/.test(name)) problems.push({ field, message: `"{{${name}}}" is not a valid placeholder.` });
      else if (!allowed.has(name)) problems.push({ field, message: `"{{${name}}}" cannot be used in this message. Available: ${[...allowed].map((a) => `{{${a}}}`).join(', ')}.` });
    }
    // A stray single or unbalanced brace pair is almost always a typo; say so rather than send "{{customer_name" to a customer.
    const stripped = text.replace(TOKEN, '');
    if (/\{\{|\}\}/.test(stripped)) problems.push({ field, message: 'There is an unfinished placeholder: every {{ needs a matching }}.' });
  };
  if (!body.trim()) problems.push({ field: 'body', message: 'The message cannot be empty.' });
  if (body.length > (channel === 'EMAIL' ? MAX_BODY : 480)) problems.push({ field: 'body', message: channel === 'EMAIL' ? `The message is too long (${MAX_BODY} characters at most).` : 'Text messages are limited to 480 characters.' });
  if (channel === 'EMAIL') {
    if (!subject?.trim()) problems.push({ field: 'subject', message: 'Give the email a subject.' });
    else if (subject.length > MAX_SUBJECT) problems.push({ field: 'subject', message: `The subject is too long (${MAX_SUBJECT} characters at most).` });
    else if (/[\r\n]/.test(subject)) problems.push({ field: 'subject', message: 'The subject must be one line.' });
  }
  check('body', body);
  if (subject) check('subject', subject);
  return problems;
}

/** Substitute values. Anything without a value renders as nothing (never as the raw placeholder). */
export function renderText(template: string, vars: Record<string, string | undefined>): string {
  // Own properties only: a name like "constructor" must never reach something inherited from the object prototype.
  return template.replace(TOKEN, (_m, name: string) => (Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] ?? '' : ''));
}

/** Sample values for a preview: representative placeholders, never real customer data. */
export function sampleVars(event: EventKey): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of allowedVariables(event)) out[name] = VARIABLES[name]?.sample ?? name;
  return out;
}

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Escaped text with web addresses made clickable. Escaping comes first, so a value can never inject markup. */
function linkify(escaped: string): string {
  return escaped.replace(/https?:\/\/[^\s<]+/g, (url) => {
    const clean = url.replace(/[.,;:)]+$/, '');
    const tail = url.slice(clean.length);
    return `<a href="${clean}" style="color:#0f4c81">${clean}</a>${tail}`;
  });
}

export interface EmailLayout {
  businessName: string;
  signature?: string | null;
  /** The primary link, shown as a button as well as in the text. */
  cta?: { label: string; url: string } | null;
  /** A way to stop this kind of optional message. */
  optOut?: { label: string; url: string } | null;
}

export function emailHtml(body: string, layout: EmailLayout): string {
  const paras = body.split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px;line-height:1.5">${linkify(esc(p)).replace(/\n/g, '<br>')}</p>`).join('');
  const cta = layout.cta
    ? `<p style="margin:22px 0"><a href="${esc(layout.cta.url)}" style="background:#0f4c81;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">${esc(layout.cta.label)}</a></p>`
    : '';
  const stop = layout.optOut ? `<p style="margin:18px 0 0;font-size:12px;color:#777">To stop receiving ${esc(layout.optOut.label)}: <a href="${esc(layout.optOut.url)}" style="color:#777">turn them off</a></p>` : '';
  const sig = layout.signature ? `<p style="margin:18px 0 0;white-space:pre-line;color:#333">${esc(layout.signature)}</p>` : '';
  return `<!doctype html><html><body style="font-family:system-ui,Segoe UI,Arial,sans-serif;color:#1a1a1a;max-width:560px;margin:0 auto;padding:24px">${paras}${cta}${sig}${stop}<hr style="border:none;border-top:1px solid #e5e5e5;margin:28px 0 12px"><p style="color:#777;font-size:12px">${esc(layout.businessName)} · sent with TFME Auto</p></body></html>`;
}

/**
 * What the history keeps. A customer's private link is a credential: only its hash is stored in the database, so the message text
 * kept for the history must not put the live token back. Links are shortened to their kind.
 */
export function redactLinks(text: string): string {
  return text
    .replace(/(https?:\/\/[^\s/]+)?\/(q|i|j|optout)\/[A-Za-z0-9_.-]{20,}/g, (_m, host: string | undefined, kind: string) => `${host ?? ''}/${kind}/[private link]`)
    .replace(/\/api\/public\/files\/[A-Za-z0-9_.-]{20,}/g, '/api/public/files/[private link]');
}

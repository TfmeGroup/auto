import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';
import { ProviderError, type DeliveryReport, type TextMessage, type TextProvider, type TextSendResult } from './types';

/**
 * Twilio driver for SMS and WhatsApp (they share one API; WhatsApp numbers are prefixed "whatsapp:"). Only this file knows
 * Twilio's API shape. It sends transactional text and nothing else: there is no campaign, list or bulk-send feature here.
 */
const API = 'https://api.twilio.com/2010-04-01';

export function twilioProvider(channel: 'sms' | 'whatsapp', fetchImpl: typeof fetch = fetch): TextProvider {
  const e = env();
  const sid = e.TWILIO_ACCOUNT_SID;
  const token = e.TWILIO_AUTH_TOKEN;
  const from = channel === 'sms' ? e.TWILIO_SMS_FROM : e.TWILIO_WHATSAPP_FROM;
  return {
    name: 'twilio',
    async send(m: TextMessage): Promise<TextSendResult> {
      if (!sid || !token || !from) throw new ProviderError('not_configured', `Twilio ${channel} is not configured.`);
      const prefix = channel === 'whatsapp' ? 'whatsapp:' : '';
      const params = new URLSearchParams({ To: `${prefix}${m.to}`, From: from.startsWith(prefix) || !prefix ? from : `${prefix}${from}`, Body: m.body });
      if (m.statusCallbackUrl) params.set('StatusCallback', m.statusCallbackUrl);
      let res: Response;
      try {
        res = await fetchImpl(`${API}/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
          method: 'POST',
          headers: { authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
          body: params,
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new ProviderError('transient', 'The messaging provider could not be reached.');
      }
      if (res.ok) {
        const j = (await res.json().catch(() => ({}))) as { sid?: string };
        if (!j.sid) throw new ProviderError('transient', 'The messaging provider gave no message id.');
        return { providerRef: j.sid };
      }
      const j = (await res.json().catch(() => ({}))) as { code?: number };
      // 429 and 5xx are the provider's trouble and may pass; any other 4xx is about this message (bad number, not allowed) and will not.
      if (res.status === 429 || res.status >= 500) throw new ProviderError('transient', 'The messaging provider is busy or unavailable.', String(j.code ?? res.status));
      throw new ProviderError('permanent', safeReason(j.code), String(j.code ?? res.status));
    },
  };
}

/** Customer-safe wording for the codes that matter; nothing from the provider's response is shown verbatim. */
function safeReason(code?: number): string {
  if (code === 21211 || code === 21614 || code === 21217) return 'The phone number is not valid.';
  if (code === 21610) return 'The recipient has opted out of messages from this number.';
  if (code === 63016 || code === 63018) return 'The recipient cannot receive WhatsApp messages from this business.';
  return 'The messaging provider refused the message.';
}

/**
 * Twilio signs each status callback: base64(HMAC-SHA1(authToken, url + each POST parameter name and value, sorted by name)).
 * A callback that does not verify is ignored, so nobody can mark a message "delivered" by guessing the endpoint.
 */
export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string): boolean {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expected = createHmac('sha1', authToken).update(data).digest();
  let given: Buffer;
  try { given = Buffer.from(signature, 'base64'); } catch { return false; }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function parseTwilioStatus(params: Record<string, string>): DeliveryReport | null {
  const providerRef = params.MessageSid ?? params.SmsSid;
  const status = params.MessageStatus ?? params.SmsStatus;
  if (!providerRef || !status) return null;
  const map: Record<string, DeliveryReport['state'] | undefined> = { queued: 'sent', accepted: 'sent', sending: 'sent', sent: 'sent', delivered: 'delivered', read: 'viewed', failed: 'failed', undelivered: 'failed' };
  const state = map[status];
  if (!state) return null;
  return { providerRef, state, ...(state === 'failed' ? { reason: params.ErrorCode ? `The provider reported error ${params.ErrorCode}.` : 'The message could not be delivered.' } : {}) };
}

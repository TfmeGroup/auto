import { randomUUID } from 'node:crypto';
import { env } from '@/lib/env';
import { twilioProvider } from './twilio';
import { ProviderError, type TextMessage, type TextProvider, type TextSendResult } from './types';

/** SmsProviderInterface and WhatsAppProviderInterface: the same shape, kept as two names so each channel can diverge later. */
export type SmsProviderInterface = TextProvider;
export type WhatsAppProviderInterface = TextProvider;

/** Not configured: sending says so plainly (the message is recorded as skipped, not lost and not "sent"). */
const none = (what: string): TextProvider => ({
  name: 'none',
  async send(): Promise<TextSendResult> {
    throw new ProviderError('not_configured', `${what} messaging is not set up on this system.`);
  },
});

/** Tests: collects messages so they can be asserted on, and can be told to fail. */
export class MemoryTextProvider implements TextProvider {
  readonly name = 'memory';
  static sent: { channel: 'sms' | 'whatsapp'; message: TextMessage; providerRef: string }[] = [];
  static failNext: ProviderError | null = null;
  constructor(private channel: 'sms' | 'whatsapp') {}
  async send(m: TextMessage): Promise<TextSendResult> {
    if (MemoryTextProvider.failNext) {
      const e = MemoryTextProvider.failNext;
      MemoryTextProvider.failNext = null;
      throw e;
    }
    const providerRef = `mem-${randomUUID()}`;
    MemoryTextProvider.sent.push({ channel: this.channel, message: m, providerRef });
    return { providerRef };
  }
  static reset() {
    MemoryTextProvider.sent = [];
    MemoryTextProvider.failNext = null;
  }
}

const cache: Partial<Record<'sms' | 'whatsapp', TextProvider>> = {};

function build(channel: 'sms' | 'whatsapp'): TextProvider {
  const driver = channel === 'sms' ? env().SMS_DRIVER : env().WHATSAPP_DRIVER;
  if (driver === 'twilio') return twilioProvider(channel);
  if (driver === 'memory') return new MemoryTextProvider(channel);
  return none(channel === 'sms' ? 'SMS' : 'WhatsApp');
}

export function getSmsProvider(): SmsProviderInterface {
  return (cache.sms ??= build('sms'));
}
export function getWhatsAppProvider(): WhatsAppProviderInterface {
  return (cache.whatsapp ??= build('whatsapp'));
}
/** Is a real provider behind this channel? (A screen can say "not set up" instead of offering it.) */
export const isChannelConfigured = (channel: 'sms' | 'whatsapp') => (channel === 'sms' ? env().SMS_DRIVER : env().WHATSAPP_DRIVER) !== 'none';
export function resetTextProvidersForTests() {
  delete cache.sms;
  delete cache.whatsapp;
}

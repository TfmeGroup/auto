import nodemailer from 'nodemailer';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

export interface EmailAttachment {
  filename: string;
  contentType: string;
  /** The file, base64 encoded, so the message can travel through the job queue as JSON. */
  contentBase64: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: EmailAttachment[];
  /** Display name for the sender (a business's own name). The sending ADDRESS is always the platform's. */
  fromName?: string;
  /** Where replies go (a business's own address). */
  replyTo?: string;
}

export interface EmailSendResult {
  /** The provider's id for the message, when it gives one. */
  providerRef?: string;
}

/** Integration boundary for outbound email. Swap drivers via EMAIL_DRIVER. */
export interface EmailTransport {
  send(message: EmailMessage): Promise<EmailSendResult | void>;
}
/** Named for the provider-abstraction: every email driver implements this one interface. */
export type EmailProviderInterface = EmailTransport;

/** The platform's sending address, with a business's own display name when it has one: "Smith Auto <no-reply@platform>". */
export function fromAddress(displayName?: string): string {
  const base = env().EMAIL_FROM;
  if (!displayName) return base;
  const m = /<([^>]+)>/.exec(base);
  const addr = m?.[1] ?? base;
  const safeName = displayName.replace(/[\r\n"<>]/g, ' ').trim().slice(0, 80);
  return safeName ? `"${safeName}" <${addr}>` : base;
}

/** Development: prints the email (including one-time links) to the server console. */
class ConsoleTransport implements EmailTransport {
  async send(m: EmailMessage) {
    // eslint-disable-next-line no-console
    console.log(`\n──── EMAIL (console driver) ────\nTo: ${m.to}\nSubject: ${m.subject}\n\n${m.text}\n────────────────────────────────\n`);
  }
}

/** Tests: collects messages so they can be asserted on. */
export class MemoryTransport implements EmailTransport {
  static sent: EmailMessage[] = [];
  async send(m: EmailMessage) {
    MemoryTransport.sent.push(m);
  }
  static reset() {
    MemoryTransport.sent = [];
  }
}

class SmtpTransport implements EmailTransport {
  private transporter = nodemailer.createTransport({
    host: env().SMTP_HOST,
    port: env().SMTP_PORT,
    secure: env().SMTP_SECURE,
    auth: env().SMTP_USER ? { user: env().SMTP_USER, pass: env().SMTP_PASSWORD } : undefined,
  });
  async send(m: EmailMessage) {
    const { attachments, fromName, replyTo, ...rest } = m;
    const info = await this.transporter.sendMail({
      from: fromAddress(fromName), ...(replyTo ? { replyTo } : {}), ...rest,
      ...(attachments?.length ? { attachments: attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, content: Buffer.from(a.contentBase64, 'base64') })) } : {}),
    });
    logger.info({ messageId: info.messageId }, 'email sent');
    return { providerRef: info.messageId };
  }
}

let transport: EmailTransport | null = null;

export function getEmailTransport(): EmailTransport {
  if (transport) return transport;
  switch (env().EMAIL_DRIVER) {
    case 'smtp':
      transport = new SmtpTransport();
      break;
    case 'memory':
      transport = new MemoryTransport();
      break;
    default:
      transport = new ConsoleTransport();
  }
  return transport;
}

export function resetEmailTransportForTests() {
  transport = null;
}

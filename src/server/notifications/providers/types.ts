/**
 * Message providers. Each channel has ONE small interface; every provider-specific detail (an HTTP API, credentials, how a status
 * callback is signed) lives in its own driver file and nowhere else. Swapping a provider means writing a driver and changing one
 * environment variable: no workflow, template or screen knows which provider is behind a channel.
 */
export type ProviderErrorKind = 'transient' | 'permanent' | 'not_configured';

/** A failure a provider reported. `transient` is worth retrying later; `permanent` is not; `not_configured` means no provider is set up. */
export class ProviderError extends Error {
  constructor(readonly kind: ProviderErrorKind, message: string, readonly code?: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface TextMessage {
  /** E.164 phone number. */
  to: string;
  body: string;
  /** A stable id for this message, for providers that can de-duplicate on it. */
  idempotencyKey: string;
  /** Where the provider should report delivery status, when it supports that. */
  statusCallbackUrl?: string;
}

export interface TextSendResult {
  /** The provider's id for the message; delivery reports refer to it. */
  providerRef: string;
}

export interface TextProvider {
  readonly name: string;
  send(message: TextMessage): Promise<TextSendResult>;
}

/** What a delivery report says. A provider that only confirms submission never reports "delivered". */
export type DeliveryReport = { providerRef: string; state: 'sent' | 'delivered' | 'viewed' | 'failed'; reason?: string };

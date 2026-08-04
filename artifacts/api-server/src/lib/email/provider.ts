// Provider-agnostic email contract (Phase 2.5). Business logic depends ONLY on this
// interface; concrete transports (SMTP today; SendGrid/SES/Mailgun/Postmark/M365/
// Gmail later) implement it without changes upstream.

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  // Optional delivery-tracking metadata (Batch 3). Never sent to the provider; the
  // worker uses it to record the delivery outcome on the owning record. Must never
  // contain tokens or secrets.
  meta?: { invitationId?: number };
}

export interface SendResult {
  // false when the provider is not configured (no-op) — callers must treat this as a
  // soft outcome, never an error.
  sent: boolean;
  // true when the message was enqueued for async delivery — enqueueing is NOT
  // delivery; the worker records the final outcome.
  queued?: boolean;
  messageId?: string;
  skippedReason?: string;
}

export interface EmailProvider {
  readonly name: string;
  // Returns true when the provider has the configuration it needs to actually send.
  isConfigured(): boolean;
  send(message: EmailMessage): Promise<SendResult>;
}

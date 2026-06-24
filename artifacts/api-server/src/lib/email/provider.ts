// Provider-agnostic email contract (Phase 2.5). Business logic depends ONLY on this
// interface; concrete transports (SMTP today; SendGrid/SES/Mailgun/Postmark/M365/
// Gmail later) implement it without changes upstream.

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendResult {
  // false when the provider is not configured (no-op) — callers must treat this as a
  // soft outcome, never an error.
  sent: boolean;
  messageId?: string;
  skippedReason?: string;
}

export interface EmailProvider {
  readonly name: string;
  // Returns true when the provider has the configuration it needs to actually send.
  isConfigured(): boolean;
  send(message: EmailMessage): Promise<SendResult>;
}

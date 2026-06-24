import { config } from "../../config.js";
import { logger } from "../logger.js";
import { SmtpProvider } from "./smtp.js";
import type { EmailMessage, EmailProvider, SendResult } from "./provider.js";
import * as templates from "./templates.js";

export type { EmailMessage, EmailProvider, SendResult } from "./provider.js";

// Provider selection (Phase 2.5). SMTP is the only built-in transport today; the
// switch is the single extension point for SendGrid/SES/Mailgun/etc. Selection is
// lazy + memoized so importing this module never touches the network.
let provider: EmailProvider | null = null;
let warnedNoConfig = false;

export function getEmailProvider(): EmailProvider {
  if (provider) return provider;
  switch (config.email.provider) {
    case "smtp":
    default:
      provider = new SmtpProvider();
      break;
  }
  if (!provider.isConfigured() && !warnedNoConfig) {
    warnedNoConfig = true;
    logger.warn(
      { provider: provider.name },
      "Email provider is not configured — transactional emails (reset, verification, invitations) will be skipped. Set SMTP_HOST, SMTP_USER, and SMTP_PASS to enable delivery.",
    );
  }
  return provider;
}

export function isEmailConfigured(): boolean {
  return getEmailProvider().isConfigured();
}

// Central send wrapper. NEVER throws to the caller — a transport failure is logged
// and reported as `sent:false` so a flaky mail server can never 500 a request or
// break a flow (password reset, invite, etc.). Synchronous send is acceptable for
// Phase 2.5; Phase 2.6 moves this behind a queue.
async function safeSend(message: EmailMessage): Promise<SendResult> {
  try {
    return await getEmailProvider().send(message);
  } catch (err) {
    logger.error({ err, to: message.to, subject: message.subject }, "Email send failed");
    return { sent: false, skippedReason: "send_error" };
  }
}

export function sendPasswordResetEmail(params: { to: string; name?: string | null; link: string }): Promise<SendResult> {
  return safeSend(templates.passwordResetEmail({ ...params, ttlMinutes: config.tokens.passwordResetTtlMinutes }));
}

export function sendEmailVerificationEmail(params: { to: string; name?: string | null; link: string }): Promise<SendResult> {
  return safeSend(templates.emailVerificationEmail({ ...params, ttlHours: config.tokens.emailVerifyTtlHours }));
}

export function sendInvitationEmail(params: {
  to: string;
  inviterName?: string | null;
  companyName: string;
  link: string;
  expiresAt: Date;
}): Promise<SendResult> {
  return safeSend(templates.invitationEmail(params));
}

export function sendWelcomeEmail(params: { to: string; name?: string | null; companyName?: string | null }): Promise<SendResult> {
  return safeSend(templates.welcomeEmail(params));
}

export function sendNotificationEmail(params: { to: string; title: string; body?: string | null; link?: string | null }): Promise<SendResult> {
  return safeSend(templates.notificationEmail(params));
}

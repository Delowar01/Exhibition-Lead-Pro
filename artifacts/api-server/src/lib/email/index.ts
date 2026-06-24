import { config } from "../../config.js";
import { logger } from "../logger.js";
import { getQueue } from "../jobs/queue.js";
import { SmtpProvider } from "./smtp.js";
import type { EmailMessage, EmailProvider, SendResult } from "./provider.js";
import * as templates from "./templates.js";

export type { EmailMessage, EmailProvider, SendResult } from "./provider.js";

// Job name for queued email delivery (Phase 2.6). The handler is registered in
// lib/jobs/handlers.ts and runs deliverEmailViaWorker.
export const EMAIL_SEND_JOB = "email.send";

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

// Synchronous send wrapper (Phase 2.5 path / Phase 2.6 rollback). NEVER throws to the
// caller — a transport failure is logged and reported as `sent:false` so a flaky mail
// server can never 500 a request or break a flow (password reset, invite, etc.). Used
// directly when async delivery is disabled (`config.jobs.asyncEmail=false`).
async function safeSend(message: EmailMessage): Promise<SendResult> {
  try {
    return await getEmailProvider().send(message);
  } catch (err) {
    logger.error({ err, to: message.to, subject: message.subject }, "Email send failed");
    return { sent: false, skippedReason: "send_error" };
  }
}

// Worker-side delivery (Phase 2.6). Unlike safeSend, this DOES throw on a real
// transport error so the job queue can retry with backoff. A missing provider config
// is NOT an error — it returns a skip result so an unconfigured environment never
// produces a retry storm or a dead-letter flood.
export async function deliverEmailViaWorker(message: EmailMessage): Promise<SendResult> {
  const p = getEmailProvider();
  if (!p.isConfigured()) {
    return { sent: false, skippedReason: "not_configured" };
  }
  return await p.send(message);
}

// Producer entry point. Enqueues delivery when async is enabled (returns immediately,
// keeping it off the request path), otherwise sends synchronously (rollback). Enqueue
// failures degrade gracefully to a synchronous send so a queue problem never silently
// drops a transactional email.
function dispatch(message: EmailMessage): Promise<SendResult> {
  if (!config.jobs.asyncEmail) {
    return safeSend(message);
  }
  return getQueue()
    .enqueue(EMAIL_SEND_JOB, message)
    .then(() => ({ sent: true }) as SendResult)
    .catch((err) => {
      logger.error({ err, to: message.to, subject: message.subject }, "Email enqueue failed; sending synchronously");
      return safeSend(message);
    });
}

export function sendPasswordResetEmail(params: { to: string; name?: string | null; link: string }): Promise<SendResult> {
  return dispatch(templates.passwordResetEmail({ ...params, ttlMinutes: config.tokens.passwordResetTtlMinutes }));
}

export function sendEmailVerificationEmail(params: { to: string; name?: string | null; link: string }): Promise<SendResult> {
  return dispatch(templates.emailVerificationEmail({ ...params, ttlHours: config.tokens.emailVerifyTtlHours }));
}

export function sendInvitationEmail(params: {
  to: string;
  inviterName?: string | null;
  companyName: string;
  link: string;
  expiresAt: Date;
}): Promise<SendResult> {
  return dispatch(templates.invitationEmail(params));
}

export function sendWelcomeEmail(params: { to: string; name?: string | null; companyName?: string | null }): Promise<SendResult> {
  return dispatch(templates.welcomeEmail(params));
}

export function sendNotificationEmail(params: { to: string; title: string; body?: string | null; link?: string | null }): Promise<SendResult> {
  return dispatch(templates.notificationEmail(params));
}

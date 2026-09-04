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
  // Misconfiguration guard: email IS configured but link building fell back to
  // the localhost default (APP_BASE_URL and REPLIT_DOMAINS both unset in
  // production) — reset/invite links in outgoing mail would point at localhost.
  if (
    provider.isConfigured() &&
    config.isProduction &&
    config.email.appBaseUrl.includes("localhost")
  ) {
    logger.warn(
      { appBaseUrl: config.email.appBaseUrl },
      "APP_BASE_URL is not set in production — links in outgoing emails (password reset, invitations, verification) will point at localhost. Set APP_BASE_URL to the public web application URL.",
    );
  }
  return provider;
}

export function isEmailConfigured(): boolean {
  return getEmailProvider().isConfigured();
}

// Test-only escape hatch: swaps the memoized provider so the worker/retry/outcome
// paths can be exercised with a stub transport. Pass null to restore lazy selection.
export function __setEmailProviderForTests(p: EmailProvider | null): void {
  provider = p;
}

// Synchronous send wrapper (Phase 2.5 path / Phase 2.6 rollback). NEVER throws to the
// caller — a transport failure is logged and reported as `sent:false` so a flaky mail
// server can never 500 a request or break a flow (password reset, invite, etc.). Used
// directly when async delivery is disabled (`config.jobs.asyncEmail=false`).
async function safeSend(message: EmailMessage): Promise<SendResult> {
  try {
    return await getEmailProvider().send(message);
  } catch (err) {
    logger.error({ err, invitationId: message.meta?.invitationId ?? null }, "Email send failed");
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

// Records the outcome of a synchronous send on the owning record (invitations only
// today). The async path records outcomes in the worker (lib/jobs/handlers.ts).
async function recordSyncOutcome(message: EmailMessage, result: SendResult): Promise<SendResult> {
  const invitationId = message.meta?.invitationId;
  if (invitationId != null) {
    const { recordEmailOutcome } = await import("../../repositories/invitations.repository.js");
    const status = result.sent ? "sent" : result.skippedReason?.includes("not_configured") || result.skippedReason?.includes("smtp") ? "skipped" : "failed";
    await recordEmailOutcome(invitationId, status, result.sent ? null : result.skippedReason ?? "send_failed").catch(() => {});
  }
  return result;
}

// Producer entry point. Enqueues delivery when async is enabled (returns immediately,
// keeping it off the request path), otherwise sends synchronously (rollback). Enqueue
// failures degrade gracefully to a synchronous send so a queue problem never silently
// drops a transactional email. IMPORTANT (Batch 3): an enqueue is reported as
// `{ sent:false, queued:true }` — queueing is NOT delivery; the worker records the
// real outcome.
// `dedupeKey` (Batch 16): a stable idempotency key for the queued delivery — the
// durable queue drops a second enqueue with the same key, so a retried workflow
// action can never queue the same email twice.
function dispatch(message: EmailMessage, opts?: { dedupeKey?: string }): Promise<SendResult> {
  if (!config.jobs.asyncEmail) {
    return safeSend(message).then((r) => recordSyncOutcome(message, r));
  }
  return getQueue()
    .enqueue(EMAIL_SEND_JOB, message, opts?.dedupeKey ? { dedupeKey: opts.dedupeKey } : undefined)
    .then(() => ({ sent: false, queued: true }) as SendResult)
    .catch((err) => {
      logger.error({ err, invitationId: message.meta?.invitationId ?? null }, "Email enqueue failed; sending synchronously");
      return safeSend(message).then((r) => recordSyncOutcome(message, r));
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
  invitationId?: number;
}): Promise<SendResult> {
  const { invitationId, ...tpl } = params;
  const message = templates.invitationEmail(tpl);
  if (invitationId != null) message.meta = { invitationId };
  return dispatch(message);
}

export function sendWelcomeEmail(params: { to: string; name?: string | null; companyName?: string | null }): Promise<SendResult> {
  return dispatch(templates.welcomeEmail(params));
}

export function sendNotificationEmail(
  params: { to: string; title: string; body?: string | null; link?: string | null },
  opts?: { dedupeKey?: string },
): Promise<SendResult> {
  return dispatch(templates.notificationEmail(params), opts);
}

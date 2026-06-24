import { config } from "../../config.js";
import type { EmailMessage } from "./provider.js";

// Brandable HTML + plain-text email templates (Phase 2.5). A single `layout` wraps
// every message so future white-label theming changes one place. All copy is plain,
// transactional, and link-driven. Templates return both an HTML and a text body so
// every send is multipart (deliverability + accessibility).

function brand(): string {
  return config.email.brandName;
}

// Minimal, email-client-safe HTML shell. Inline styles only (no <style> blocks) so
// it renders consistently across clients. Footer carries the white-label line.
function layout(opts: { heading: string; bodyHtml: string }): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 0;">
      <tr><td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e6e8eb;">
          <tr><td style="background:#0f172a;padding:20px 32px;">
            <span style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:.2px;">${brand()}</span>
          </td></tr>
          <tr><td style="padding:32px;">
            <h1 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#0f172a;">${opts.heading}</h1>
            ${opts.bodyHtml}
          </td></tr>
          <tr><td style="padding:20px 32px;border-top:1px solid #eef0f2;">
            <p style="margin:0;font-size:12px;color:#8a94a6;">Powered by Elite Marcom</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

function button(href: string, label: string): string {
  return `<a href="${href}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;">${label}</a>`;
}

function p(text: string): string {
  return `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#334155;">${text}</p>`;
}

function fallbackLink(href: string): string {
  return `<p style="margin:16px 0 0;font-size:12px;line-height:1.6;color:#8a94a6;word-break:break-all;">If the button does not work, copy this link into your browser:<br/>${href}</p>`;
}

export function passwordResetEmail(params: { to: string; name?: string | null; link: string; ttlMinutes: number }): EmailMessage {
  const greeting = params.name ? `Hi ${params.name},` : "Hi,";
  const bodyHtml = `${p(greeting)}${p(
    `We received a request to reset your ${brand()} password. Click the button below to choose a new password. This link expires in ${params.ttlMinutes} minutes.`,
  )}<p style="margin:0 0 8px;">${button(params.link, "Reset password")}</p>${p(
    "If you did not request this, you can safely ignore this email — your password will not change.",
  )}${fallbackLink(params.link)}`;
  const text = `${greeting}\n\nWe received a request to reset your ${brand()} password. Open this link to choose a new password (expires in ${params.ttlMinutes} minutes):\n${params.link}\n\nIf you did not request this, ignore this email.\n\nPowered by Elite Marcom`;
  return { to: params.to, subject: `Reset your ${brand()} password`, html: layout({ heading: "Reset your password", bodyHtml }), text };
}

export function emailVerificationEmail(params: { to: string; name?: string | null; link: string; ttlHours: number }): EmailMessage {
  const greeting = params.name ? `Hi ${params.name},` : "Hi,";
  const bodyHtml = `${p(greeting)}${p(
    `Please confirm your email address to finish setting up your ${brand()} account. This link expires in ${params.ttlHours} hours.`,
  )}<p style="margin:0 0 8px;">${button(params.link, "Verify email")}</p>${fallbackLink(params.link)}`;
  const text = `${greeting}\n\nPlease confirm your email address to finish setting up your ${brand()} account (link expires in ${params.ttlHours} hours):\n${params.link}\n\nPowered by Elite Marcom`;
  return { to: params.to, subject: `Verify your ${brand()} email`, html: layout({ heading: "Verify your email", bodyHtml }), text };
}

export function invitationEmail(params: {
  to: string;
  inviterName?: string | null;
  companyName: string;
  link: string;
  expiresAt: Date;
}): EmailMessage {
  const inviter = params.inviterName ? `${params.inviterName} has` : "You have been";
  const bodyHtml = `${p(`${inviter} invited you to join <strong>${params.companyName}</strong> on ${brand()}.`)}${p(
    `Accept the invitation to create your account. This invitation expires on ${params.expiresAt.toUTCString()}.`,
  )}<p style="margin:0 0 8px;">${button(params.link, "Accept invitation")}</p>${fallbackLink(params.link)}`;
  const text = `${inviter} invited you to join ${params.companyName} on ${brand()}.\n\nAccept the invitation (expires ${params.expiresAt.toUTCString()}):\n${params.link}\n\nPowered by Elite Marcom`;
  return { to: params.to, subject: `You're invited to join ${params.companyName}`, html: layout({ heading: "You're invited", bodyHtml }), text };
}

export function welcomeEmail(params: { to: string; name?: string | null; companyName?: string | null }): EmailMessage {
  const greeting = params.name ? `Welcome, ${params.name}!` : "Welcome!";
  const where = params.companyName ? ` to <strong>${params.companyName}</strong>` : "";
  const bodyHtml = `${p(`Your ${brand()} account is ready${where}. You can now sign in and start scanning cards, managing contacts, and qualifying leads.`)}<p style="margin:0 0 8px;">${button(
    config.email.appBaseUrl,
    "Open " + brand(),
  )}</p>`;
  const text = `${greeting}\n\nYour ${brand()} account is ready. Sign in to get started:\n${config.email.appBaseUrl}\n\nPowered by Elite Marcom`;
  return { to: params.to, subject: `Welcome to ${brand()}`, html: layout({ heading: greeting, bodyHtml }), text };
}

export function notificationEmail(params: { to: string; title: string; body?: string | null; link?: string | null }): EmailMessage {
  const bodyHtml = `${p(params.body ?? params.title)}${params.link ? `<p style="margin:0 0 8px;">${button(params.link, "View in " + brand())}</p>` : ""}`;
  const text = `${params.title}\n\n${params.body ?? ""}${params.link ? `\n\n${params.link}` : ""}\n\nPowered by Elite Marcom`;
  return { to: params.to, subject: params.title, html: layout({ heading: params.title, bodyHtml }), text };
}

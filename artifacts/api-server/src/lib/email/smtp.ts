import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../../config.js";
import { logger } from "../logger.js";
import type { EmailMessage, EmailProvider, SendResult } from "./provider.js";

// SMTP transport (Phase 2.5 default). Configured entirely from env. When the host/
// user/pass are not all present the provider reports `isConfigured() === false` and
// `send()` is a logged no-op — the app never crashes on a missing mail config.
export class SmtpProvider implements EmailProvider {
  readonly name = "smtp";
  private transporter: Transporter | null = null;

  isConfigured(): boolean {
    const { smtpHost, smtpUser, smtpPass } = config.email;
    return Boolean(smtpHost && smtpUser && smtpPass);
  }

  private getTransporter(): Transporter {
    if (this.transporter) return this.transporter;
    this.transporter = nodemailer.createTransport({
      host: config.email.smtpHost,
      port: config.email.smtpPort,
      secure: config.email.smtpSecure,
      auth: { user: config.email.smtpUser, pass: config.email.smtpPass },
    });
    return this.transporter;
  }

  async send(message: EmailMessage): Promise<SendResult> {
    if (!this.isConfigured()) {
      logger.warn(
        { to: message.to, subject: message.subject },
        "Email not sent: SMTP is not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS). Skipping send.",
      );
      return { sent: false, skippedReason: "smtp_not_configured" };
    }
    const from = `"${config.email.fromName}" <${config.email.fromAddress}>`;
    const info = await this.getTransporter().sendMail({
      from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    logger.info({ to: message.to, subject: message.subject, messageId: info.messageId }, "Email sent");
    return { sent: true, messageId: info.messageId };
  }
}

import type { Request, Response, NextFunction } from "express";
import { processStripeWebhook, WebhookRejected } from "../services/billing-webhook.service.js";
import { logger } from "../lib/logger.js";

// Batch 20 — public Stripe webhook endpoint (mounted in app.ts BEFORE the JSON
// body parser with a strict raw-body parser). Responses are deliberately terse:
//   400 missing/invalid signature or malformed event   413 oversized body (parser)
//   503 provider not configured                          200 processed / duplicate / ignored
//   500 temporary failure — Stripe retries (nothing acknowledged before the durable result)
export async function stripeWebhookHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const raw = req.body;
    if (!Buffer.isBuffer(raw) || raw.length === 0) {
      res.status(400).json({ error: "Invalid webhook body", code: "BODY_INVALID" });
      return;
    }
    const sig = req.headers["stripe-signature"];
    const signature = Array.isArray(sig) ? sig[0] : sig;
    const result = await processStripeWebhook(raw, signature);
    res.status(result.httpStatus).json({ received: result.httpStatus === 200, outcome: result.outcome });
  } catch (err) {
    if (err instanceof WebhookRejected) {
      logger.warn({ code: err.code }, "Stripe webhook rejected");
      res.status(err.httpStatus).json({ error: "Webhook rejected", code: err.code });
      return;
    }
    next(err);
  }
}

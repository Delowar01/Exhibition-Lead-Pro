import { db } from "@workspace/db";
import { logger } from "../logger.js";
import * as repo from "../../repositories/subscriptions.repository.js";
import { expireElapsedTrial } from "../../services/subscription-lifecycle.service.js";
import { SYSTEM_ACTOR } from "../billing/audit.js";

// Batch 20 — subscription lifecycle sweep. Runs on the existing durable queue
// (scheduler.ts dispatches it as a `recurring.sweep` job with a cadence-bucket
// dedupe key, so two API processes or a duplicate delivery collapse onto one job).
//
// It transitions MANUAL subscriptions whose trial end has passed from `trialing`
// to `expired`, one row per transaction, under FOR UPDATE SKIP LOCKED — so a
// concurrent sweep can never process the same row twice and the audit row for a
// transition is written exactly once (the transition predicate is no longer true
// on the second pass). Stripe-managed subscriptions are NEVER touched here: the
// provider owns their lifecycle. Nothing is ever deleted.

const BATCH = 200;

export interface SweepSummary {
  examined: number;
  expired: number;
}

export async function runSubscriptionSweep(now = new Date()): Promise<SweepSummary> {
  const summary: SweepSummary = { examined: 0, expired: 0 };
  // Bounded loop: each iteration locks up to BATCH candidates.
  for (let round = 0; round < 50; round++) {
    const processed = await db.transaction(async (tx) => {
      const rows = await repo.lockElapsedManualTrials(now, BATCH, tx);
      let n = 0;
      for (const sub of rows) {
        summary.examined += 1;
        const after = await expireElapsedTrial(tx, sub, SYSTEM_ACTOR);
        if (after) {
          n += 1;
          logger.info({ subscriptionId: sub.id, companyId: sub.companyId, from: sub.status, to: after.status, sweep: "subscription" }, "Manual trial expired by lifecycle sweep");
        }
      }
      summary.expired += n;
      return rows.length;
    });
    if (processed < BATCH) break;
  }
  if (summary.examined > 0) logger.info({ ...summary, sweep: "subscription" }, "Subscription lifecycle sweep finished");
  return summary;
}

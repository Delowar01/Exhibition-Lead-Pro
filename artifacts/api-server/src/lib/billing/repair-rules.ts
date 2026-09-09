import { PLAN_IDS, SUBSCRIPTION_STATUSES, normalizeLegacyStatus, type SubscriptionStatus } from "./lifecycle.js";

// Batch 20 — PURE repair rules shared by scripts/repair-subscriptions.ts and its
// unit tests (test/b20-lifecycle-unit.test.ts). No database access here.
//
//   legacy company status 'trial'/'trialing'
//     + trial end (company.trial_ends_at ?? subscription.trial_ends_at)
//         future → trialing (same end)              rule: trial_future
//         past   → trialing (same end; blocked until the sweep expires it)  rule: trial_lapsed
//     + NO end  → active (never expired before Batch 20; no new trial is invented)
//                                                   rule: trial_without_end_to_active
//   any other legacy status → the same canonical state  rule: legacy_<status>

export const LEGACY_STATUSES: ReadonlySet<string> = new Set(["trial", "active", "suspended", "expired", "cancelled"]);

export interface LegacyCompanyShape {
  id: number;
  plan: string;
  status: string;
  trialEndsAt: Date | null;
}

export interface CanonicalTarget {
  status: SubscriptionStatus;
  trialExpiresAt: Date | null;
  rule: string;
}

export function canonicalFromLegacy(c: LegacyCompanyShape, existingTrialEnd: Date | null, now: Date = new Date()): CanonicalTarget {
  const legacy = c.status;
  const trialEnd = c.trialEndsAt ?? existingTrialEnd;
  if (legacy === "trial" || legacy === "trialing") {
    if (trialEnd) return { status: "trialing", trialExpiresAt: trialEnd, rule: trialEnd.getTime() > now.getTime() ? "trial_future" : "trial_lapsed" };
    return { status: "active", trialExpiresAt: null, rule: "trial_without_end_to_active" };
  }
  const st = normalizeLegacyStatus(legacy);
  if (!st) throw new Error(`unknown legacy status "${legacy}" on company ${c.id}`);
  return { status: st, trialExpiresAt: trialEnd, rule: `legacy_${legacy}` };
}

// Conflict detection (R4): anything here aborts the repair BEFORE any write.
export interface LegacySubscriptionShape {
  plan: string;
  status: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
}

export function detectConflicts(company: LegacyCompanyShape, subs: LegacySubscriptionShape[]): string[] {
  const out: string[] = [];
  if (subs.length > 1) out.push(`company ${company.id}: ${subs.length} subscriptions`);
  if (!(PLAN_IDS as readonly string[]).includes(company.plan)) out.push(`company ${company.id}: plan "${company.plan}" is not in the stable catalog`);
  if (!LEGACY_STATUSES.has(company.status) && !(SUBSCRIPTION_STATUSES as readonly string[]).includes(company.status)) out.push(`company ${company.id}: status "${company.status}" unknown`);
  const s = subs[0];
  if (s && (s.stripeCustomerId || s.stripeSubscriptionId)) out.push(`company ${company.id}: provider ids populated — manual reconciliation required`);
  if (s && !(PLAN_IDS as readonly string[]).includes(s.plan)) out.push(`company ${company.id}: subscription plan "${s.plan}" is not in the stable catalog`);
  if (s && !LEGACY_STATUSES.has(s.status) && !(SUBSCRIPTION_STATUSES as readonly string[]).includes(s.status)) out.push(`company ${company.id}: subscription status "${s.status}" unknown`);
  return out;
}

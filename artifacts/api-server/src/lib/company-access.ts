import { db, subscriptionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { resolveEntitlement, normalizeLegacyStatus, type AccessMode, type Entitlement, type EntitlementReason } from "./billing/lifecycle.js";

// Batch 20 — tenant access is decided EXCLUSIVELY from the canonical
// `subscriptions` row through the shared entitlement resolver. This module is
// the ONLY reader used by the login path (services/auth.service.ts), the
// per-request gate (middlewares/requireAuth.ts) and the refresh-token rotation
// (lib/sessions.ts). The legacy companies.status / companies.trial_ends_at
// columns are never consulted (test/b20-structural.test.ts proves it).

export type CompanyAccess = { blocked: true; reason: string; reasonCode: EntitlementReason } | { blocked: false; readOnly: boolean; reasonCode: EntitlementReason | null };

export interface SubscriptionSummary {
  plan: string;
  status: string;
  billingSource: string;
  accessMode: AccessMode;
  reasonCode: EntitlementReason | null;
  message: string | null;
  trialExpiresAt: string | null;
  currentPeriodEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface TenantAccess {
  access: CompanyAccess;
  entitlement: Entitlement;
  summary: SubscriptionSummary | null;
}

export function accessFromEntitlement(e: Entitlement): CompanyAccess {
  if (e.accessMode === "blocked") return { blocked: true, reason: e.message ?? "Access is blocked.", reasonCode: e.reasonCode ?? "UNKNOWN_STATUS" };
  return { blocked: false, readOnly: e.accessMode === "read_only", reasonCode: e.reasonCode };
}

export function summarizeSubscription(sub: typeof subscriptionsTable.$inferSelect, e: Entitlement): SubscriptionSummary {
  return {
    plan: sub.plan,
    status: normalizeLegacyStatus(sub.status) ?? sub.status,
    billingSource: sub.billingSource,
    accessMode: e.accessMode,
    reasonCode: e.reasonCode,
    message: e.message,
    trialExpiresAt: sub.trialExpiresAt ? sub.trialExpiresAt.toISOString() : null,
    currentPeriodEndsAt: sub.currentPeriodEndsAt ? sub.currentPeriodEndsAt.toISOString() : null,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
  };
}

// Loads the company's canonical subscription and resolves its entitlement.
// A company without a subscription row resolves to BLOCKED (fail closed): the
// repair command (scripts/repair-subscriptions.ts) guarantees a row for every
// existing company before the Batch 20 API serves traffic, and every creation
// path inserts the row in the same transaction as the company.
export async function loadTenantAccess(companyId: number, now: Date = new Date()): Promise<TenantAccess> {
  const [sub] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.companyId, companyId)).limit(1);
  const entitlement = resolveEntitlement(sub ?? null, now);
  return { access: accessFromEntitlement(entitlement), entitlement, summary: sub ? summarizeSubscription(sub, entitlement) : null };
}

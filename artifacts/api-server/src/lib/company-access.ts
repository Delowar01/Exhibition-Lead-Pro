import { db, subscriptionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { resolveEntitlement, normalizeLegacyStatus, type AccessMode, type Entitlement, type EntitlementReason } from "./billing/lifecycle.js";
import { AppError } from "../middlewares/errorHandler.js";

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

// ── Background-work gate (B20 Correction 1) ──────────────────────────────────
// Every scheduler sweep / queue handler that performs a side effect on a tenant's
// behalf (email, push, notification, CRM write, AI provider call, export artifact)
// re-reads the CANONICAL entitlement first — never the legacy companies.status
// mirror, never a principal captured at enqueue time. Anything but `full` means
// the work is not performed and the caller records a deterministic
// SUBSCRIPTION_NOT_WRITABLE outcome (no retry, no replay).

export interface TenantWritable {
  writable: boolean;
  accessMode: AccessMode;
  reasonCode: EntitlementReason | null;
}

export async function tenantWritable(companyId: number, now: Date = new Date()): Promise<TenantWritable> {
  const { entitlement } = await loadTenantAccess(companyId, now);
  return { writable: entitlement.accessMode === "full", accessMode: entitlement.accessMode, reasonCode: entitlement.reasonCode };
}

export class TenantNotWritableError extends AppError {
  readonly accessMode: AccessMode;
  readonly reasonCode: EntitlementReason | null;
  constructor(companyId: number, gate: TenantWritable) {
    super(403, `The company's subscription is ${gate.accessMode === "blocked" ? "blocked" : "read-only"}; background work was not performed.`, {
      code: "SUBSCRIPTION_NOT_WRITABLE",
      details: { companyId, accessMode: gate.accessMode, reasonCode: gate.reasonCode },
    });
    this.accessMode = gate.accessMode;
    this.reasonCode = gate.reasonCode;
    Object.setPrototypeOf(this, TenantNotWritableError.prototype);
  }
}

export async function assertTenantWritable(companyId: number, now: Date = new Date()): Promise<void> {
  const gate = await tenantWritable(companyId, now);
  if (!gate.writable) throw new TenantNotWritableError(companyId, gate);
}

// One query for global sweeps: the ids of every company whose canonical
// entitlement is `full` right now. Companies without a subscription row are
// absent (fail closed).
export async function writableCompanyIds(now: Date = new Date()): Promise<Set<number>> {
  const rows = await db.select().from(subscriptionsTable);
  const out = new Set<number>();
  for (const sub of rows) if (resolveEntitlement(sub, now).accessMode === "full") out.add(sub.companyId);
  return out;
}

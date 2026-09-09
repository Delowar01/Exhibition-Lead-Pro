import { auditLogsTable } from "@workspace/db";
import type { Executor } from "../../repositories/base.js";
import type { SubscriptionRow } from "../../repositories/subscriptions.repository.js";

// Batch 20 — audit rows for subscription lifecycle changes are written INSIDE the
// same transaction as the change (commit or roll back together). Only safe
// summaries are recorded: before/after lifecycle state + plan, the changed field
// names, actor, company and (for provider events) the event type + opaque id.
// Never: secrets, raw payloads, URLs, payment methods, addresses, provider
// responses, customer PII.

export interface AuditActor {
  userId: number | null;
  userName: string | null; // the actor's login identity as stored in audit rows today
  ipAddress: string | null;
}

export const SYSTEM_ACTOR: AuditActor = { userId: null, userName: "system:subscription-sweep", ipAddress: null };
export const PROVIDER_ACTOR: AuditActor = { userId: null, userName: "system:stripe-webhook", ipAddress: null };

const SAFE_FIELDS = new Set([
  "plan",
  "status",
  "billingSource",
  "trialStartedAt",
  "trialExpiresAt",
  "currentPeriodStartsAt",
  "currentPeriodEndsAt",
  "cancelAtPeriodEnd",
  "canceledAt",
  "endedAt",
  "pastDueSince",
  "suspendedAt",
  "suspendedReason",
  "statusBeforeSuspension",
  "limitOverrides",
  "providerStatus",
  "stripePriceId",
]);

// Names of the fields that differ (values themselves are not recorded except the
// lifecycle pair below, so a suspension reason typed by an operator is the only
// free text that can ever reach the audit trail — and it is length-capped).
export function changedFields(before: Partial<SubscriptionRow> | null, after: Partial<SubscriptionRow>): string[] {
  const out: string[] = [];
  for (const k of SAFE_FIELDS) {
    const a = before ? (before as Record<string, unknown>)[k] : undefined;
    const b = (after as Record<string, unknown>)[k];
    const av = a instanceof Date ? a.getTime() : typeof a === "object" && a !== null ? JSON.stringify(a) : a;
    const bv = b instanceof Date ? b.getTime() : typeof b === "object" && b !== null ? JSON.stringify(b) : b;
    if (av !== bv) out.push(k);
  }
  return out;
}

export interface SubscriptionAuditInput {
  action: string; // e.g. subscription.activate
  companyId: number;
  subscriptionId: number | null;
  before: Partial<SubscriptionRow> | null;
  after: Partial<SubscriptionRow>;
  actor: AuditActor;
  extra?: Record<string, string | number | boolean | null>;
}

export async function writeSubscriptionAudit(tx: Executor, input: SubscriptionAuditInput): Promise<void> {
  const metadata: Record<string, unknown> = {
    before: input.before ? { status: input.before.status ?? null, plan: input.before.plan ?? null, billingSource: input.before.billingSource ?? null } : null,
    after: { status: input.after.status ?? null, plan: input.after.plan ?? null, billingSource: input.after.billingSource ?? null },
    changed: changedFields(input.before, input.after),
    ...(input.extra ?? {}),
  };
  await tx.insert(auditLogsTable).values({
    companyId: input.companyId,
    userId: input.actor.userId,
    userName: input.actor.userName,
    action: input.action,
    entityType: "subscription",
    entityId: input.subscriptionId != null ? String(input.subscriptionId) : String(input.companyId),
    metadata,
    ipAddress: input.actor.ipAddress,
  });
}

// Bounded, single-line, non-secret operator text (suspension reasons).
export function sanitizeReason(raw: unknown, max = 200): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/[\r\n\t]+/g, " ").trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

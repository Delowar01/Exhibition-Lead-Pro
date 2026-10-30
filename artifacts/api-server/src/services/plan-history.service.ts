import { AppError } from "../middlewares/errorHandler.js";
import * as repo from "../repositories/subscriptions.repository.js";
import type { AuditRow, PlanVersionRow } from "../repositories/subscriptions.repository.js";
import { normalizeLegacyStatus } from "../lib/billing/lifecycle.js";

// Batch 42 (PB-4.6) — a tenant's plan / version history, PROJECTED from the
// append-only audit trail (no new table): every subscription audit row whose
// plan or version reference changed (creation, owner change, migration,
// provider price reconciliation, version-1 backfill pin, repair) in order, with
// the actor, the reason, the limit / feature comparison the change recorded
// and the migration or dry-run reference it belongs to. Platform-owner only
// (the route sits behind the platform firewall); the company id scopes the read
// and the response never carries another tenant's rows.

const HISTORY_LIMIT = 500;

export type PlanHistoryKind = "created" | "direct_change" | "version_change" | "repair" | "migration" | "provider_sync" | "backfill_pin" | "other";

interface Meta {
  before?: { plan?: string | null; planVersionId?: number | null; billingSource?: string | null; status?: string | null } | null;
  after?: { plan?: string | null; planVersionId?: number | null; billingSource?: string | null; status?: string | null } | null;
  changed?: string[];
  [k: string]: unknown;
}

function metaOf(row: AuditRow): Meta {
  return (row.metadata && typeof row.metadata === "object" ? row.metadata : {}) as Meta;
}

function kindOf(row: AuditRow, m: Meta): PlanHistoryKind {
  switch (row.action) {
    case "subscription.create":
    case "subscription.repair_create":
      return "created";
    case "subscription.pin_version":
      return "backfill_pin";
    case "subscription.migrate_version":
      return "migration";
    case "subscription.set_plan":
      return m.changeKind === "repair" || m.repairedInvalidReference === true ? "repair" : m.changeKind === "version_change" ? "version_change" : "direct_change";
    case "subscription.provider_sync":
    case "subscription.provider_replaced":
      return "provider_sync";
    default:
      return "other";
  }
}

function relevant(row: AuditRow, m: Meta): boolean {
  if (["subscription.create", "subscription.repair_create", "subscription.pin_version", "subscription.migrate_version", "subscription.set_plan"].includes(row.action)) return true;
  const changed = Array.isArray(m.changed) ? m.changed : [];
  return changed.includes("plan") || changed.includes("planVersionId");
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const limitMap = (v: unknown): Record<string, number | null> | null => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, number | null> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = x === null ? null : typeof x === "number" ? x : null;
  return out;
};

export async function planHistory(companyId: number) {
  const sub = await repo.findByCompanyId(companyId);
  if (!sub) throw new AppError(404, "Subscription not found", { code: "SUBSCRIPTION_NOT_FOUND" });
  const company = await repo.findCompany(companyId);
  const [rows, versions] = await Promise.all([repo.listSubscriptionAuditRows(companyId, HISTORY_LIMIT + 1), repo.listAllPlanVersions()]);
  const byId = new Map<number, PlanVersionRow>(versions.map((v) => [v.id, v]));
  const versionNumber = (id: number | null) => (id != null ? (byId.get(id)?.version ?? null) : null);
  const versionState = (id: number | null) => {
    const v = id != null ? byId.get(id) : undefined;
    return !v ? null : !v.publishedAt ? "draft" : v.retiredAt ? "retired" : "published";
  };
  const truncated = rows.length > HISTORY_LIMIT;
  const entries = rows
    .slice(0, HISTORY_LIMIT)
    .map((row) => ({ row, m: metaOf(row) }))
    .filter(({ row, m }) => relevant(row, m))
    .map(({ row, m }) => {
      const fromPlan = str(m.before?.plan) ?? str(m.previousPlan);
      const toPlan = str(m.after?.plan);
      const fromVersionId = num(m.before?.planVersionId) ?? num(m.previousPlanVersionId);
      const toVersionId = num(m.after?.planVersionId);
      const before = limitMap(m.limitsBefore);
      const after = limitMap(m.limitsAfter);
      const changedLimits = before && after ? Object.keys(after).filter((k) => (before[k] ?? null) !== (after[k] ?? null)) : [];
      return {
        auditId: row.id,
        at: row.createdAt.toISOString(),
        action: row.action,
        kind: kindOf(row, m),
        actor: { userId: row.userId ?? null, name: row.userName ?? null },
        reason: str(m.reason),
        fromPlan,
        toPlan,
        fromVersionId,
        fromVersion: versionNumber(fromVersionId),
        toVersionId,
        toVersion: versionNumber(toVersionId),
        billingSource: str(m.after?.billingSource) ?? str(m.before?.billingSource) ?? null,
        changedFields: strList(m.changed),
        source: str(m.planChangeSource) ?? (row.action === "subscription.migrate_version" ? "migration" : row.action === "subscription.set_plan" ? "direct_change" : null),
        migrationId: str(m.migrationId),
        dryRunDigest: str(m.dryRunDigest),
        limitsBefore: before,
        limitsAfter: after,
        changedLimits,
        tightenedLimits: strList(m.tightenedLimits),
        loosenedLimits: strList(m.loosenedLimits),
        lostFeatures: strList(m.lostFeatures),
        gainedFeatures: strList(m.gainedFeatures),
        featureEnforcementBefore: str(m.featureEnforcementBefore),
        featureEnforcementAfter: str(m.featureEnforcementAfter),
        confirmFeatureDowngrade: typeof m.confirmFeatureDowngrade === "boolean" ? m.confirmFeatureDowngrade : null,
        repairedInvalidReference: m.repairedInvalidReference === true,
      };
    });
  const first = entries[0] ?? null;
  const original = first ? { plan: first.toPlan ?? first.fromPlan ?? sub.plan, planVersionId: first.kind === "created" ? first.toVersionId : (first.fromVersionId ?? first.toVersionId), at: first.at } : { plan: sub.plan, planVersionId: sub.planVersionId ?? null, at: null };
  return {
    companyId,
    companyName: company?.name ?? null,
    original: { ...original, version: versionNumber(original.planVersionId) },
    current: {
      plan: sub.plan,
      planVersionId: sub.planVersionId ?? null,
      version: versionNumber(sub.planVersionId ?? null),
      versionState: versionState(sub.planVersionId ?? null),
      billingSource: sub.billingSource,
      status: normalizeLegacyStatus(sub.status) ?? sub.status,
    },
    entries,
    total: entries.length,
    truncated,
    generatedAt: new Date().toISOString(),
  };
}

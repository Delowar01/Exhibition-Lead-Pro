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
//
// Batch 43 (PB-5, Task 1C) — stable server-side cursor pagination: the relevant
// rows are selected in SQL (never a fixed window of the raw trail), ordered by
// the keyset (created_at, id), paged by an opaque cursor that names the last
// entry of the previous page, in chronological (asc) or newest-first (desc)
// order. `total` counts every relevant event of the tenant, `original` is always
// the oldest relevant event (whatever page is requested) and `current` the live
// subscription; the full chronology is reachable page by page.

export const HISTORY_PAGE_DEFAULT = 50;
export const HISTORY_PAGE_MAX = 200;

export type PlanHistoryKind = "created" | "direct_change" | "version_change" | "repair" | "migration" | "provider_sync" | "backfill_pin" | "other";
export type PlanHistoryOrder = "asc" | "desc";
export interface PlanHistoryQuery {
  limit?: number;
  cursor?: string;
  order?: PlanHistoryOrder;
}

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

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const limitMap = (v: unknown): Record<string, number | null> | null => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, number | null> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = x === null ? null : typeof x === "number" ? x : null;
  return out;
};

// Opaque cursor = the audit id of the entry it names (base64url JSON, versioned).
export function encodeHistoryCursor(auditId: number): string {
  return Buffer.from(JSON.stringify({ v: 1, id: auditId }), "utf8").toString("base64url");
}
export function decodeHistoryCursor(cursor: string): number | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown; id?: unknown };
    return parsed && parsed.v === 1 && typeof parsed.id === "number" && Number.isInteger(parsed.id) && parsed.id > 0 ? parsed.id : null;
  } catch {
    return null;
  }
}

function parseQuery(q: PlanHistoryQuery): { limit: number; order: PlanHistoryOrder; anchorId: number | null } {
  const limit = q.limit == null ? HISTORY_PAGE_DEFAULT : q.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_PAGE_MAX) throw new AppError(400, `limit must be an integer between 1 and ${HISTORY_PAGE_MAX}`, { code: "INVALID_LIMIT" });
  const order = q.order ?? "asc";
  if (order !== "asc" && order !== "desc") throw new AppError(400, "order must be asc or desc", { code: "INVALID_ORDER" });
  let anchorId: number | null = null;
  if (q.cursor != null && q.cursor !== "") {
    anchorId = decodeHistoryCursor(q.cursor);
    if (anchorId == null) throw new AppError(400, "cursor is not a plan-history cursor", { code: "INVALID_CURSOR" });
  }
  return { limit, order, anchorId };
}

function projectEntry(row: AuditRow, byId: Map<number, PlanVersionRow>) {
  const m = metaOf(row);
  const versionNumber = (id: number | null) => (id != null ? (byId.get(id)?.version ?? null) : null);
  const fromPlan = str(m.before?.plan) ?? str(m.previousPlan);
  const toPlan = str(m.after?.plan);
  const fromVersionId = num(m.before?.planVersionId) ?? num(m.previousPlanVersionId);
  const toVersionId = num(m.after?.planVersionId);
  const before = limitMap(m.limitsBefore);
  const after = limitMap(m.limitsAfter);
  const changedLimits = before && after ? Object.keys(after).filter((k) => (before[k] ?? null) !== (after[k] ?? null)) : [];
  return {
    auditId: row.id,
    cursor: encodeHistoryCursor(row.id),
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
}

export async function planHistory(companyId: number, query: PlanHistoryQuery = {}) {
  const { limit, order, anchorId } = parseQuery(query);
  const sub = await repo.findByCompanyId(companyId);
  if (!sub) throw new AppError(404, "Subscription not found", { code: "SUBSCRIPTION_NOT_FOUND" });
  if (anchorId != null && !(await repo.findPlanHistoryRow(companyId, anchorId))) throw new AppError(400, "cursor does not belong to this tenant's plan history", { code: "INVALID_CURSOR" });
  const [company, versions, total, first, rows] = await Promise.all([
    repo.findCompany(companyId),
    repo.listAllPlanVersions(),
    repo.countPlanHistoryRows(companyId),
    repo.firstPlanHistoryRow(companyId),
    repo.listPlanHistoryRows(companyId, { order, limit: limit + 1, afterId: anchorId }),
  ]);
  const byId = new Map<number, PlanVersionRow>(versions.map((v) => [v.id, v]));
  const versionNumber = (id: number | null) => (id != null ? (byId.get(id)?.version ?? null) : null);
  const versionState = (id: number | null) => {
    const v = id != null ? byId.get(id) : undefined;
    return !v ? null : !v.publishedAt ? "draft" : v.retiredAt ? "retired" : "published";
  };
  const hasMore = rows.length > limit;
  const entries = rows.slice(0, limit).map((row) => projectEntry(row, byId));
  const oldest = first ? projectEntry(first, byId) : null;
  const original = oldest
    ? { plan: oldest.toPlan ?? oldest.fromPlan ?? sub.plan, planVersionId: oldest.kind === "created" ? oldest.toVersionId : (oldest.fromVersionId ?? oldest.toVersionId), at: oldest.at }
    : { plan: sub.plan, planVersionId: sub.planVersionId ?? null, at: null };
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
    total,
    truncated: hasMore,
    pageSize: limit,
    order,
    nextCursor: hasMore && entries.length > 0 ? entries[entries.length - 1].cursor : null,
    hasMore,
    generatedAt: new Date().toISOString(),
  };
}

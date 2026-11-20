import { db, platformSettingsTable, auditLogsTable, aiInvocationsTable, companiesTable, usersTable, notificationsTable, type PlatformSetting } from "@workspace/db";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { AuditActor } from "../lib/billing/audit.js";

// Platform-wide settings (platform_settings: a key and a JSON document) and the
// platform-wide AI figures the AI provider policy needs. Nothing here is tenant data
// read through a tenant route: every caller is a platform-owner-only service or the AI
// execution seam itself, which is why no tenantScope applies.

/** PostgreSQL "undefined_table": the reviewed schema change has not been applied to this database. */
export function isUndefinedTable(err: unknown): boolean {
  let e: unknown = err;
  while (e && typeof e === "object") {
    if ((e as { code?: unknown }).code === "42P01") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export async function readSetting(key: string): Promise<{ available: boolean; row: PlatformSetting | null }> {
  try {
    const [row] = await db.select().from(platformSettingsTable).where(eq(platformSettingsTable.key, key)).limit(1);
    return { available: true, row: row ?? null };
  } catch (err) {
    if (isUndefinedTable(err)) return { available: false, row: null };
    throw err;
  }
}

export type WriteSettingResult =
  | { status: "ok"; row: PlatformSetting }
  | { status: "conflict"; currentVersion: number }
  | { status: "unavailable" };

// One transaction: the setting and its audit row are written together or not at all.
// `expectedVersion` is the version the caller read (0 = no row yet); a different stored
// version means someone else changed the setting in between, and nothing is written.
export async function writeSetting(params: {
  key: string;
  value: Record<string, unknown>;
  expectedVersion: number;
  actor: AuditActor;
  audit: { action: string; metadata: Record<string, unknown> };
}): Promise<WriteSettingResult> {
  try {
    return await db.transaction(async (tx) => {
      const [current] = await tx.select().from(platformSettingsTable).where(eq(platformSettingsTable.key, params.key)).for("update").limit(1);
      const currentVersion = current?.version ?? 0;
      if (currentVersion !== params.expectedVersion) return { status: "conflict" as const, currentVersion };

      let row: PlatformSetting | undefined;
      if (current) {
        [row] = await tx
          .update(platformSettingsTable)
          .set({ value: params.value, version: currentVersion + 1, updatedBy: params.actor.userId, updatedAt: new Date() })
          .where(and(eq(platformSettingsTable.key, params.key), eq(platformSettingsTable.version, currentVersion)))
          .returning();
      } else {
        [row] = await tx
          .insert(platformSettingsTable)
          .values({ key: params.key, value: params.value, version: 1, updatedBy: params.actor.userId })
          .onConflictDoNothing()
          .returning();
      }
      // A concurrent first write (or a lost update) leaves no row to return.
      if (!row) return { status: "conflict" as const, currentVersion: currentVersion + 1 };

      await tx.insert(auditLogsTable).values({
        companyId: null,
        userId: params.actor.userId,
        userName: params.actor.userName,
        action: params.audit.action,
        entityType: "platform_setting",
        entityId: params.key,
        metadata: { ...params.audit.metadata, version: row.version },
        ipAddress: params.actor.ipAddress,
      });
      return { status: "ok" as const, row };
    });
  } catch (err) {
    if (isUndefinedTable(err)) return { status: "unavailable" };
    throw err;
  }
}

export async function userNames(ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(inArray(usersTable.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function companyNames(ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: companiesTable.id, name: companiesTable.name }).from(companiesTable).where(inArray(companiesTable.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ── Platform-wide AI figures (all tenants and system calls), from the ledger ────────────

export interface ProviderMonthUsage {
  provider: string;
  model: string;
  /** Rows that reached a provider (success, error, timeout). */
  providerCalls: number;
  succeeded: number;
  failed: number;
  /** Successful calls made as the fallback after another provider failed. */
  servedAsFallback: number;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
}

// The fallback attempt of a request is recorded under "<request id>-fb1" (lib/ai.ts).
const IS_FALLBACK = sql`${aiInvocationsTable.requestId} like '%-fb1'`;
const REACHED_PROVIDER = sql`${aiInvocationsTable.status} in ('success','error','timeout')`;

export async function monthUsageByProvider(from: Date): Promise<ProviderMonthUsage[]> {
  const rows = await db
    .select({
      provider: aiInvocationsTable.provider,
      model: aiInvocationsTable.model,
      providerCalls: sql<number>`count(*) filter (where ${REACHED_PROVIDER})`,
      succeeded: sql<number>`count(*) filter (where ${aiInvocationsTable.status} = 'success')`,
      failed: sql<number>`count(*) filter (where ${aiInvocationsTable.status} in ('error','timeout'))`,
      servedAsFallback: sql<number>`count(*) filter (where ${aiInvocationsTable.status} = 'success' and ${IS_FALLBACK})`,
      inputTokens: sql<number>`coalesce(sum(${aiInvocationsTable.inputTokens}),0)`,
      outputTokens: sql<number>`coalesce(sum(${aiInvocationsTable.outputTokens}),0)`,
      costMicroUsd: sql<number>`coalesce(sum(${aiInvocationsTable.estimatedCostMicroUsd}),0)`,
    })
    .from(aiInvocationsTable)
    .where(gte(aiInvocationsTable.createdAt, from))
    .groupBy(aiInvocationsTable.provider, aiInvocationsTable.model);
  return rows.map((r) => ({
    provider: r.provider,
    model: r.model,
    providerCalls: Number(r.providerCalls),
    succeeded: Number(r.succeeded),
    failed: Number(r.failed),
    servedAsFallback: Number(r.servedAsFallback),
    inputTokens: Number(r.inputTokens),
    outputTokens: Number(r.outputTokens),
    costMicroUsd: Number(r.costMicroUsd),
  }));
}

/** Month-to-date estimated spend of one provider across the whole platform. */
export async function monthSpendOfProvider(provider: string, from: Date): Promise<number> {
  const [row] = await db
    .select({ costMicroUsd: sql<number>`coalesce(sum(${aiInvocationsTable.estimatedCostMicroUsd}),0)` })
    .from(aiInvocationsTable)
    .where(and(eq(aiInvocationsTable.provider, provider), gte(aiInvocationsTable.createdAt, from)));
  return Number(row?.costMicroUsd ?? 0);
}

export async function activePlatformOwnerIds(): Promise<number[]> {
  const rows = await db.select({ id: usersTable.id }).from(usersTable).where(and(eq(usersTable.isActive, true), eq(usersTable.role, "platform_owner")));
  return rows.map((r) => r.id);
}

/** Was this platform AI alert (kind + subkind + provider) already sent, to anyone, since `since`? */
export async function platformAlertSent(kind: string, subkind: string, provider: string, since: Date): Promise<boolean> {
  const rows = await db
    .select({ id: notificationsTable.id })
    .from(notificationsTable)
    .where(
      and(
        gte(notificationsTable.createdAt, since),
        sql`${notificationsTable.metadata} ->> 'kind' = ${kind}`,
        sql`${notificationsTable.metadata} ->> 'subkind' = ${subkind}`,
        sql`${notificationsTable.metadata} ->> 'provider' = ${provider}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

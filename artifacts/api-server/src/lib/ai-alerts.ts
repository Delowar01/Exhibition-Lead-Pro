import { db, usersTable, notificationsTable, aiSettingsTable, aiInvocationsTable } from "@workspace/db";
import { and, eq, gte, isNotNull, or, sql } from "drizzle-orm";
import { config } from "../config.js";
import { logger } from "./logger.js";
import { createNotification } from "../services/notifications.service.js";
import { writableCompanyIds } from "./company-access.js";
import {
  resolveSettings,
  monthStart,
  nextMonthStart,
  ledgerWriteFailureCount,
  resetLedgerWriteFailureCount,
  microToUsd,
} from "../services/ai.service.js";

// Batch 6 — AI usage alerts, delivered through the EXISTING notification system
// (category "ai", same in-app/email preference handling as every other alert).
// Threshold policy lives in ONE place: config.ai.alerts.
//
// Kinds (deduped to one per kind per tenant per LOCAL day, marker in metadata):
//   ai_budget_approaching — usage crossed approachingBudgetPct of a set month budget
//   ai_budget_reached     — a set month budget is exhausted
//   ai_usage_spike        — today's provider requests far exceed the trailing average
//   ai_failure_rate       — high provider failure rate over the last hour
//   ai_ledger_failures    — ledger writes failed since the last sweep (operator alert)
//
// Recipients: tenant primary_admins + admins for tenant alerts; platform owners for
// the ledger-failure operator alert. Notifications only — never blocks the AI path.

const ALERT_KIND = "ai_usage";
const ALERT_LOCK_NS = 74032; // advisory-lock ns for per-tenant alert dispatch

type AlertSubkind =
  | "ai_budget_approaching"
  | "ai_budget_reached"
  | "ai_usage_spike"
  | "ai_failure_rate"
  | "ai_ledger_failures";

function localDayStart(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function localDateStr(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

// Was THIS alert kind already sent for this tenant today? (Any recipient counts —
// alerts are per-tenant-per-kind-per-day, not per-user.)
async function alreadySentToday(companyId: number | null, subkind: AlertSubkind): Promise<boolean> {
  const conditions = [
    gte(notificationsTable.createdAt, localDayStart()),
    sql`${notificationsTable.metadata} ->> 'kind' = ${ALERT_KIND}`,
    sql`${notificationsTable.metadata} ->> 'subkind' = ${subkind}`,
  ];
  if (companyId != null) conditions.push(eq(notificationsTable.companyId, companyId));
  const rows = await db
    .select({ id: notificationsTable.id })
    .from(notificationsTable)
    .where(and(...conditions))
    .limit(1);
  return rows.length > 0;
}

async function tenantAdmins(companyId: number): Promise<number[]> {
  const rows = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.companyId, companyId),
        eq(usersTable.isActive, true),
        or(eq(usersTable.role, "primary_admin"), eq(usersTable.role, "admin")),
      ),
    );
  return rows.map((r) => r.id);
}

async function platformOwners(): Promise<number[]> {
  const rows = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(and(eq(usersTable.isActive, true), eq(usersTable.role, "platform_owner")));
  return rows.map((r) => r.id);
}

// Serialized (advisory lock) send of one tenant alert kind: re-checks the daily
// marker inside the critical section so concurrent triggers can't double-send.
async function sendTenantAlert(
  companyId: number,
  subkind: AlertSubkind,
  title: string,
  body: string,
  extra: Record<string, unknown>,
): Promise<boolean> {
  const admins = await tenantAdmins(companyId);
  if (admins.length === 0) return false;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ALERT_LOCK_NS}, ${companyId})`);
    if (await alreadySentToday(companyId, subkind)) return false;
    for (const userId of admins) {
      await createNotification({
        userId,
        companyId,
        category: "ai",
        title,
        body,
        link: "/admin/ai",
        metadata: { kind: ALERT_KIND, subkind, date: localDateStr(), ...extra },
      });
    }
    return true;
  });
}

// ---- Budget thresholds (checked inline after each budgeted invocation) -------------

// Called (fire-and-forget) after a successful provider call for a tenant WITH budgets
// configured. Reuses the ledger month sums; sends "approaching" at the configured pct
// and "reached" at 100%, each at most once per tenant per day.
export async function checkBudgetThresholds(companyId: number): Promise<void> {
  const s = await resolveSettings(companyId);
  if (s.monthlyTokenBudget == null && s.monthlyCostBudgetMicroUsd == null) return;

  const [row] = await db
    .select({
      totalTokens: sql<number>`coalesce(sum(${aiInvocationsTable.totalTokens}),0)`,
      costMicroUsd: sql<number>`coalesce(sum(${aiInvocationsTable.estimatedCostMicroUsd}),0)`,
    })
    .from(aiInvocationsTable)
    .where(and(eq(aiInvocationsTable.companyId, companyId), gte(aiInvocationsTable.createdAt, monthStart())));
  const usedTokens = Number(row?.totalTokens ?? 0);
  const usedCost = Number(row?.costMicroUsd ?? 0);

  const pcts: number[] = [];
  if (s.monthlyTokenBudget != null && s.monthlyTokenBudget > 0) pcts.push((usedTokens / s.monthlyTokenBudget) * 100);
  if (s.monthlyCostBudgetMicroUsd != null && s.monthlyCostBudgetMicroUsd > 0) {
    pcts.push((usedCost / s.monthlyCostBudgetMicroUsd) * 100);
  }
  if (pcts.length === 0) return;
  const pct = Math.max(...pcts);
  const resetAt = nextMonthStart().toISOString().slice(0, 10);

  if (pct >= 100) {
    await sendTenantAlert(
      companyId,
      "ai_budget_reached",
      "AI monthly budget reached",
      `Your organization has used 100% of its monthly AI budget. AI requests are paused until the budget resets on ${resetAt} or an admin raises the budget in AI Settings.`,
      { pct: Math.round(pct), usedTokens, usedCostUsd: microToUsd(usedCost) },
    );
  } else if (pct >= config.ai.alerts.approachingBudgetPct) {
    await sendTenantAlert(
      companyId,
      "ai_budget_approaching",
      `AI budget at ${Math.round(pct)}%`,
      `Your organization has used ${Math.round(pct)}% of its monthly AI budget (resets ${resetAt}). Consider reviewing usage in AI Settings.`,
      { pct: Math.round(pct), usedTokens, usedCostUsd: microToUsd(usedCost) },
    );
  }
}

// ---- Recurring sweep: spikes, failure rates, ledger-write failures ------------------

const PROVIDER_STATUSES = ["success", "error", "timeout"] as const;

async function sweepCompany(companyId: number): Promise<void> {
  const a = config.ai.alerts;
  const now = new Date();

  // Spike: today's provider requests vs trailing 7-day daily average.
  const todayStart = localDayStart(now);
  const weekAgo = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000);
  const providerFilter = sql`${aiInvocationsTable.status} in ('success','error','timeout')`;
  const [today] = await db
    .select({ n: sql<number>`count(*)` })
    .from(aiInvocationsTable)
    .where(and(eq(aiInvocationsTable.companyId, companyId), gte(aiInvocationsTable.createdAt, todayStart), providerFilter));
  const todayCount = Number(today?.n ?? 0);
  if (todayCount >= a.spikeMinRequests) {
    const [prior] = await db
      .select({ n: sql<number>`count(*)` })
      .from(aiInvocationsTable)
      .where(
        and(
          eq(aiInvocationsTable.companyId, companyId),
          gte(aiInvocationsTable.createdAt, weekAgo),
          sql`${aiInvocationsTable.createdAt} < ${todayStart}`,
          providerFilter,
        ),
      );
    const dailyAvg = Number(prior?.n ?? 0) / 7;
    if (dailyAvg > 0 && todayCount > dailyAvg * a.spikeMultiplier) {
      await sendTenantAlert(
        companyId,
        "ai_usage_spike",
        "Unusual AI usage spike detected",
        `Your organization made ${todayCount} AI requests today — more than ${a.spikeMultiplier}× the recent daily average (${Math.round(dailyAvg)}). Review recent activity in AI Settings.`,
        { todayCount, dailyAvg: Math.round(dailyAvg) },
      );
    }
  }

  // Failure rate over the last hour.
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const [hour] = await db
    .select({
      total: sql<number>`count(*)`,
      failed: sql<number>`count(*) filter (where ${aiInvocationsTable.status} in ('error','timeout'))`,
    })
    .from(aiInvocationsTable)
    .where(and(eq(aiInvocationsTable.companyId, companyId), gte(aiInvocationsTable.createdAt, hourAgo), providerFilter));
  const total = Number(hour?.total ?? 0);
  const failed = Number(hour?.failed ?? 0);
  if (total >= a.failureMinRequests && (failed / total) * 100 >= a.failureRatePct) {
    await sendTenantAlert(
      companyId,
      "ai_failure_rate",
      "High AI failure rate",
      `${failed} of ${total} AI requests failed in the last hour (${Math.round((failed / total) * 100)}%). The AI provider may be degraded; recent requests may need to be retried.`,
      { failed, total },
    );
  }
}

// Global recurring sweep (registered with the jobs scheduler). Only tenants with AI
// activity today are examined, so the sweep stays cheap.
export async function runAiUsageAlerts(): Promise<{ companies: number }> {
  // Operator alert: ledger writes failed since the last sweep (usage may under-count
  // until queued retries land). Platform-owner notification, deduped per day.
  const failures = ledgerWriteFailureCount();
  if (failures > 0) {
    resetLedgerWriteFailureCount();
    if (!(await alreadySentToday(null, "ai_ledger_failures"))) {
      for (const ownerId of await platformOwners()) {
        await createNotification({
          userId: ownerId,
          companyId: null,
          category: "ai",
          title: "AI usage ledger writes failing",
          body: `${failures} AI invocation ledger write(s) failed since the last sweep. Retries are queued; check server logs and database health.`,
          link: "/platform/ai",
          metadata: { kind: ALERT_KIND, subkind: "ai_ledger_failures", date: localDateStr(), failures },
        });
      }
    }
  }

  const active = await db
    .selectDistinct({ companyId: aiInvocationsTable.companyId })
    .from(aiInvocationsTable)
    .where(and(gte(aiInvocationsTable.createdAt, localDayStart()), isNotNull(aiInvocationsTable.companyId)));

  // B20 Correction 1: tenant alerts (notification + mirrored email) only for
  // tenants whose CANONICAL entitlement is `full`.
  const writable = await writableCompanyIds();
  let companies = 0;
  for (const row of active) {
    if (row.companyId == null) continue;
    if (!writable.has(row.companyId)) continue;
    try {
      await sweepCompany(row.companyId);
      companies += 1;
    } catch (err) {
      logger.error({ err, companyId: row.companyId }, "AI usage alert sweep failed for company");
    }
  }
  return { companies };
}

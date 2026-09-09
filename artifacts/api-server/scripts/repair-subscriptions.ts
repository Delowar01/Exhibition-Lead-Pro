/**
 * Batch 20 — canonical subscription REPAIR (explicit operator command; never run
 * from a GET request or from normal API startup).
 *
 *   npx tsx scripts/repair-subscriptions.ts                 # dry-run (default): aggregate, non-PII report, NO writes
 *   npx tsx scripts/repair-subscriptions.ts --apply         # transactional apply; re-running afterwards changes nothing
 *   npx tsx scripts/repair-subscriptions.ts --company=<id>  # restrict either mode to ONE company (targeted repair / tests)
 *
 * Rules (derived from the hosted read-only inspection, docs/B20_SUBSCRIPTION_LIFECYCLE.md §repair):
 *   R1 plan catalog: the five stable plans are seeded (insert-if-missing).
 *   R2 company without subscription → ONE manual subscription is created.
 *        status/plan/trial come from the legacy company columns (the record that
 *        decided access before Batch 20), so nobody gains or loses access:
 *          trial + future trial_ends_at → trialing (same end)      trial + past end → trialing (same end; blocked, then swept to expired)
 *          trial + NULL end             → active (never expired before; NO new trial is invented)
 *          active/suspended/expired/cancelled → same canonical state
 *   R3 existing subscription: legacy 'trial' → 'trialing'; canonical status taken from
 *        companies.status (the access authority before Batch 20) when the two disagree;
 *        plan taken from companies.plan (platform-managed) when they disagree; trial
 *        end = companies.trial_ends_at ?? subscriptions.trial_ends_at; billing_source
 *        manual; limit_overrides untouched ({}); usage anchor = created_at.
 *   R4 conflict → ABORT before any write: populated stripe_* ids (would need provider
 *        reconciliation), a plan outside the stable catalog, a status outside the
 *        legacy/canonical sets, duplicate subscriptions per company.
 *   R5 idempotent: rows already canonical (status canonical, billing_source set,
 *        trial/anchor populated, mirror consistent) are skipped; a second apply reports 0 changes.
 */
import { and, eq, sql } from "drizzle-orm";
import { db, pool, companiesTable, subscriptionsTable, auditLogsTable } from "@workspace/db";
import { ensurePlanCatalog } from "../src/lib/billing/plan-catalog.js";
import { legacyCompanyStatus, normalizeLegacyStatus, type SubscriptionStatus } from "../src/lib/billing/lifecycle.js";
import { canonicalFromLegacy, detectConflicts } from "../src/lib/billing/repair-rules.js";

const APPLY = process.argv.includes("--apply");
const COMPANY_ARG = process.argv.find((a) => a.startsWith("--company="));
const ONLY_COMPANY = COMPANY_ARG ? Number.parseInt(COMPANY_ARG.slice("--company=".length), 10) : null;
if (COMPANY_ARG && (!Number.isInteger(ONLY_COMPANY) || (ONLY_COMPANY as number) <= 0)) {
  console.error("--company must be a positive integer id");
  process.exit(1);
}

type Company = typeof companiesTable.$inferSelect;
type Sub = typeof subscriptionsTable.$inferSelect;

interface PlannedCreate {
  kind: "create";
  companyId: number;
  status: SubscriptionStatus;
  plan: string;
  trialExpiresAt: Date | null;
  rule: string;
}
interface PlannedUpdate {
  kind: "update";
  companyId: number;
  subscriptionId: number;
  patch: Partial<typeof subscriptionsTable.$inferInsert>;
  changed: string[];
}
type Planned = PlannedCreate | PlannedUpdate;

interface Report {
  companies: number;
  subscriptions: number;
  missing: number;
  creates: PlannedCreate[];
  updates: PlannedUpdate[];
  alreadyCanonical: number;
  conflicts: string[];
  byRule: Record<string, number>;
}

async function plan(): Promise<Report> {
  const report: Report = { companies: 0, subscriptions: 0, missing: 0, creates: [], updates: [], alreadyCanonical: 0, conflicts: [], byRule: {} };
  const companies = ONLY_COMPANY == null ? await db.select().from(companiesTable) : await db.select().from(companiesTable).where(eq(companiesTable.id, ONLY_COMPANY));
  const subs = ONLY_COMPANY == null ? await db.select().from(subscriptionsTable) : await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.companyId, ONLY_COMPANY));
  report.companies = companies.length;
  report.subscriptions = subs.length;
  const byCompany = new Map<number, Sub[]>();
  for (const s of subs) byCompany.set(s.companyId, [...(byCompany.get(s.companyId) ?? []), s]);
  const bump = (rule: string) => (report.byRule[rule] = (report.byRule[rule] ?? 0) + 1);

  for (const c of companies) {
    const rows = byCompany.get(c.id) ?? [];
    const conflicts = detectConflicts(c, rows);
    if (conflicts.length) {
      report.conflicts.push(...conflicts);
      continue;
    }
    const s = rows.length === 1 ? rows[0] : undefined;

    if (!s) {
      report.missing += 1;
      const canon = canonicalFromLegacy(c, null);
      bump(`create:${canon.rule}`);
      report.creates.push({ kind: "create", companyId: c.id, status: canon.status, plan: c.plan, trialExpiresAt: canon.trialExpiresAt, rule: canon.rule });
      continue;
    }
    // Existing row: derive the canonical target and diff.
    const legacyTrialEnd = s.trialEndsAt ? new Date(`${s.trialEndsAt}T00:00:00.000Z`) : null;
    const canon = canonicalFromLegacy(c, legacyTrialEnd);
    const patch: Partial<typeof subscriptionsTable.$inferInsert> = {};
    const changed: string[] = [];
    if (normalizeLegacyStatus(s.status) !== canon.status || s.status !== canon.status) {
      patch.status = canon.status;
      changed.push("status");
    }
    if (s.plan !== c.plan) {
      patch.plan = c.plan;
      changed.push("plan");
    }
    if (!s.billingSource || s.billingSource !== "manual") {
      patch.billingSource = "manual";
      changed.push("billingSource");
    }
    const wantTrial = canon.trialExpiresAt?.getTime() ?? null;
    if ((s.trialExpiresAt?.getTime() ?? null) !== wantTrial) {
      patch.trialExpiresAt = canon.trialExpiresAt;
      changed.push("trialExpiresAt");
    }
    if (!s.trialStartedAt && canon.status === "trialing") {
      patch.trialStartedAt = s.createdAt;
      changed.push("trialStartedAt");
    }
    if (!s.usageAnchorAt) {
      patch.usageAnchorAt = s.createdAt;
      changed.push("usageAnchorAt");
    }
    const mirrorStatus = legacyCompanyStatus(canon.status);
    const mirrorTrial = canon.trialExpiresAt?.getTime() ?? null;
    const mirrorDrift = c.status !== mirrorStatus || (c.trialEndsAt?.getTime() ?? null) !== mirrorTrial;
    if (changed.length === 0 && !mirrorDrift) {
      report.alreadyCanonical += 1;
      continue;
    }
    if (mirrorDrift) changed.push("companyMirror");
    bump(`update:${canon.rule}`);
    report.updates.push({ kind: "update", companyId: c.id, subscriptionId: s.id, patch, changed });
  }
  return report;
}

async function apply(report: Report): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  await db.transaction(async (tx) => {
    await ensurePlanCatalog(tx);
    const now = new Date();
    for (const p of report.creates) {
      const [c] = await tx.select().from(companiesTable).where(eq(companiesTable.id, p.companyId)).for("update");
      if (!c) continue;
      const [exists] = await tx.select({ id: subscriptionsTable.id }).from(subscriptionsTable).where(eq(subscriptionsTable.companyId, p.companyId));
      if (exists) continue; // created concurrently — idempotent
      const [row] = await tx
        .insert(subscriptionsTable)
        .values({
          companyId: p.companyId,
          plan: p.plan,
          status: p.status,
          billingSource: "manual",
          trialStartedAt: p.status === "trialing" ? c.createdAt : null,
          trialExpiresAt: p.trialExpiresAt,
          usageAnchorAt: c.createdAt,
          statusChangedAt: now,
          limitOverrides: {},
          trialEndsAt: p.trialExpiresAt ? p.trialExpiresAt.toISOString().slice(0, 10) : null,
        })
        .returning();
      await tx.update(companiesTable).set({ plan: p.plan, status: legacyCompanyStatus(p.status), trialEndsAt: p.trialExpiresAt, updatedAt: now }).where(eq(companiesTable.id, p.companyId));
      await tx.insert(auditLogsTable).values({ companyId: p.companyId, userId: null, userName: "system:subscription-repair", action: "subscription.repair_create", entityType: "subscription", entityId: String(row.id), metadata: { rule: p.rule, after: { status: p.status, plan: p.plan, billingSource: "manual" } }, ipAddress: null });
      created += 1;
    }
    for (const u of report.updates) {
      const [s] = await tx.select().from(subscriptionsTable).where(eq(subscriptionsTable.id, u.subscriptionId)).for("update");
      if (!s) continue;
      const patch = { ...u.patch, statusChangedAt: u.patch.status && u.patch.status !== s.status ? now : s.statusChangedAt, updatedAt: now };
      const [after] = await tx.update(subscriptionsTable).set(patch).where(eq(subscriptionsTable.id, s.id)).returning();
      const st = normalizeLegacyStatus(after.status) ?? "trialing";
      await tx.update(companiesTable).set({ plan: after.plan, status: legacyCompanyStatus(st), trialEndsAt: after.trialExpiresAt, updatedAt: now }).where(eq(companiesTable.id, s.companyId));
      await tx.insert(auditLogsTable).values({ companyId: s.companyId, userId: null, userName: "system:subscription-repair", action: "subscription.repair_update", entityType: "subscription", entityId: String(s.id), metadata: { changed: u.changed, before: { status: s.status, plan: s.plan }, after: { status: after.status, plan: after.plan, billingSource: after.billingSource } }, ipAddress: null });
      updated += 1;
    }
  });
  return { created, updated };
}

async function main() {
  const report = await plan();
  const summary = {
    mode: APPLY ? "apply" : "dry-run",
    scope: ONLY_COMPANY == null ? "all" : `company:${ONLY_COMPANY}`,
    companies: report.companies,
    subscriptions: report.subscriptions,
    companiesWithoutSubscription: report.missing,
    plannedCreates: report.creates.length,
    plannedUpdates: report.updates.length,
    alreadyCanonical: report.alreadyCanonical,
    byRule: report.byRule,
    conflicts: report.conflicts.length,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (report.conflicts.length) {
    console.error("ABORT — conflicts must be resolved manually before repair:");
    for (const c of report.conflicts) console.error(`  - ${c}`);
    process.exitCode = 2;
    return;
  }
  if (!APPLY) {
    console.log("dry-run: no rows were written (re-run with --apply to repair).");
    return;
  }
  const result = await apply(report);
  console.log(JSON.stringify({ applied: result }, null, 2));
  // Prove idempotency: a second plan must be empty.
  const again = await plan();
  console.log(JSON.stringify({ verify: { plannedCreates: again.creates.length, plannedUpdates: again.updates.length, alreadyCanonical: again.alreadyCanonical, conflicts: again.conflicts.length } }, null, 2));
  if (again.creates.length || again.updates.length) process.exitCode = 3;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });

// `sql` is imported for future rule extensions; keep the import referenced.
void sql;
void and;

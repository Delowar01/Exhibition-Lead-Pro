import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db, plansTable, planVersionsTable } from "@workspace/db";
import { PLAN_IDS, type PlanId } from "./lifecycle.js";
import { PLAN_SLUG_RE } from "./plan-versions.js";

// Batch 20 — stable plan catalog. Seeds the five plan identities idempotently
// (INSERT … ON CONFLICT DO NOTHING): a plan that already exists — including one an
// operator edited — is never overwritten. Every seeded limit is NULL (unlimited /
// non-blocking) and no price is invented: prices live in `plan_prices` and are
// verified against the provider. Safe to run at every API start and from the
// repair command.

export interface PlanSeed {
  id: PlanId;
  name: string;
  description: string;
  sortOrder: number;
  trialDays: number;
}

export const PLAN_CATALOG: readonly PlanSeed[] = [
  { id: "free", name: "Free", description: "Entry plan.", sortOrder: 0, trialDays: 14 },
  { id: "starter", name: "Starter", description: "Starter plan.", sortOrder: 1, trialDays: 14 },
  { id: "professional", name: "Professional", description: "Professional plan.", sortOrder: 2, trialDays: 14 },
  { id: "business", name: "Business", description: "Business plan.", sortOrder: 3, trialDays: 14 },
  { id: "enterprise", name: "Enterprise", description: "Enterprise plan.", sortOrder: 4, trialDays: 14 },
];

export const DEFAULT_TRIAL_DAYS = 14;

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function ensurePlanCatalog(tx?: Executor): Promise<{ inserted: PlanId[] }> {
  const e = tx ?? db;
  const inserted: PlanId[] = [];
  for (const p of PLAN_CATALOG) {
    const rows = await e
      .insert(plansTable)
      .values({
        id: p.id,
        name: p.name,
        description: p.description,
        sortOrder: p.sortOrder,
        trialDays: p.trialDays,
        isActive: true,
        features: {},
        // All limits null = unlimited until commercial limits are approved.
        adminsLimit: null,
        employeesLimit: null,
        contactsLimit: null,
        eventsLimit: null,
        scansLimit: null,
        storageLimitMb: null,
        apiLimit: null,
      })
      .onConflictDoNothing({ target: plansTable.id })
      .returning({ id: plansTable.id });
    if (rows.length > 0) inserted.push(p.id);
  }
  return { inserted };
}

// Guard used by the services: a plan must be one of the stable identities AND
// exist in the catalog (seeded). Returns the row or null. (Kept for the fixed
// catalog; assignment paths use findAssignablePlan / resolvePlanAssignment.)
export async function findPlan(id: string, tx?: Executor) {
  if (!(PLAN_IDS as readonly string[]).includes(id)) return null;
  const e = tx ?? db;
  const [row] = await e.select().from(plansTable).where(sql`${plansTable.id} = ${id}`).limit(1);
  return row ?? null;
}

// Batch 40 — any plan row by slug (fixed or builder-created), whatever its status.
export async function findPlanRow(id: string, tx?: Executor) {
  if (!PLAN_SLUG_RE.test(id)) return null;
  const e = tx ?? db;
  const [row] = await e.select().from(plansTable).where(eq(plansTable.id, id)).limit(1);
  return row ?? null;
}

// Batch 40 — a plan that may be ASSIGNED to a tenant: exists and is published
// (drafts and archived plans are never assignable).
export async function findAssignablePlan(id: string, tx?: Executor) {
  const row = await findPlanRow(id, tx);
  return row && row.status === "published" ? row : null;
}

// Batch 40 — the version a NEW assignment pins to: the plan's current published,
// non-retired version, or null when the plan has no published version yet (legacy
// reference = the plan row, exactly as before versioning). Takes a SHARE lock on
// the plan row so a concurrent publish (FOR UPDATE) serializes with the assignment.
export async function resolvePlanAssignment(id: string, tx: Executor): Promise<{ plan: NonNullable<Awaited<ReturnType<typeof findPlanRow>>>; planVersionId: number | null } | null> {
  if (!PLAN_SLUG_RE.test(id)) return null;
  const [plan] = await tx.select().from(plansTable).where(eq(plansTable.id, id)).for("share");
  if (!plan || plan.status !== "published") return null;
  const [version] = await tx
    .select({ id: planVersionsTable.id })
    .from(planVersionsTable)
    .where(and(eq(planVersionsTable.planId, id), isNotNull(planVersionsTable.publishedAt), isNull(planVersionsTable.retiredAt)))
    .orderBy(desc(planVersionsTable.version))
    .limit(1);
  return { plan, planVersionId: version?.id ?? null };
}

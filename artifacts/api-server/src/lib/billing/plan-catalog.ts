import { sql } from "drizzle-orm";
import { db, plansTable } from "@workspace/db";
import { PLAN_IDS, type PlanId } from "./lifecycle.js";

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
// exist in the catalog (seeded). Returns the row or null.
export async function findPlan(id: string, tx?: Executor) {
  if (!(PLAN_IDS as readonly string[]).includes(id)) return null;
  const e = tx ?? db;
  const [row] = await e.select().from(plansTable).where(sql`${plansTable.id} = ${id}`).limit(1);
  return row ?? null;
}

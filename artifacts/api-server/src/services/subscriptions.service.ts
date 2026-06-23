import { db } from "@workspace/db";
import { subscriptionsTable, companiesTable, plansTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";

export async function getCurrentSubscription(user: AuthUser) {
  const companyId = user.companyId;
  if (!companyId) throw new AppError(400, "No company context");
  const [sub] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.companyId, companyId)).limit(1);
  if (sub) return sub;
  // Create a default free subscription seeded from the free plan defaults.
  const [freePlan] = await db.select().from(plansTable).where(eq(plansTable.id, "free")).limit(1);
  const [newSub] = await db
    .insert(subscriptionsTable)
    .values({
      companyId,
      plan: "free",
      status: "active",
      scansUsed: 0,
      scansLimit: 50,
      usersLimit: 1,
      adminsLimit: freePlan?.adminsLimit ?? 1,
      employeesLimit: freePlan?.employeesLimit ?? 0,
      contactsLimit: freePlan?.contactsLimit ?? 50,
      eventsLimit: freePlan?.eventsLimit ?? 1,
      storageLimitMb: freePlan?.storageLimitMb ?? 100,
      apiLimit: freePlan?.apiLimit ?? 0,
    })
    .returning();
  return newSub;
}

export async function listPlans() {
  const plans = await db.select().from(plansTable).where(eq(plansTable.isActive, true)).orderBy(asc(plansTable.sortOrder));
  return plans.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    priceMonthly: Number(p.priceMonthly),
    currency: p.currency,
    adminsLimit: p.adminsLimit,
    employeesLimit: p.employeesLimit,
    contactsLimit: p.contactsLimit,
    eventsLimit: p.eventsLimit,
    storageLimitMb: p.storageLimitMb,
    apiLimit: p.apiLimit,
    trialDays: p.trialDays,
    features: p.features,
    sortOrder: p.sortOrder,
    isActive: p.isActive,
  }));
}

export async function upgradeSubscription(user: AuthUser, body: { plan?: string }) {
  const companyId = user.companyId;
  if (!companyId) throw new AppError(400, "No company context");
  const { plan } = body;
  const [planConfig] = await db.select().from(plansTable).where(eq(plansTable.id, plan as string)).limit(1);
  if (!planConfig) throw new AppError(400, "Invalid plan");

  const renewalDate = new Date();
  renewalDate.setMonth(renewalDate.getMonth() + 1);

  const [sub] = await db
    .update(subscriptionsTable)
    .set({
      plan,
      status: "active",
      adminsLimit: planConfig.adminsLimit,
      employeesLimit: planConfig.employeesLimit,
      contactsLimit: planConfig.contactsLimit,
      eventsLimit: planConfig.eventsLimit,
      storageLimitMb: planConfig.storageLimitMb,
      apiLimit: planConfig.apiLimit,
      renewalDate: renewalDate.toISOString().slice(0, 10),
      updatedAt: new Date(),
    })
    .where(eq(subscriptionsTable.companyId, companyId))
    .returning();
  await db.update(companiesTable).set({ plan, status: "active", updatedAt: new Date() }).where(eq(companiesTable.id, companyId));
  return { sub, companyId, plan };
}

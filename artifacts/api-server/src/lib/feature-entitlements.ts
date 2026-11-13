import type { NextFunction, Response } from "express";
import { AppError } from "../middlewares/errorHandler.js";
import type { AuthRequest, AuthUser } from "../middlewares/requireAuth.js";
import { FEATURE_LABEL, type PlanFeatureKey } from "./billing/plan-versions.js";

// Batch 41 (PB-3) — the per-request FEATURE gate.
//
// `req.user.entitlements` is resolved by requireAuth from the canonical
// subscription + its pinned plan version (lib/company-access.ts), so the gate
// itself is a pure lookup: no second resolver, no extra query. It sits AFTER the
// existing tenant firewall and permission checks and never widens anything:
//   • platform operators carry no tenant entitlements (they are already refused
//     on every tenant CRM module by requireTenantUser) → the gate is a no-op
//     for them only when they have no company context at all;
//   • a tenant whose version reference is invalid is denied every feature
//     (enforcement "invalid", fail closed);
//   • a legacy / grandfathered version allows every catalog feature.
// The 403 is machine-readable: code FEATURE_NOT_ENTITLED + context
// { feature, planVersionId, enforcement } so clients can explain the denial.

export const FEATURE_NOT_ENTITLED = "FEATURE_NOT_ENTITLED";

export function featureDenialError(user: Pick<AuthUser, "entitlements">, feature: PlanFeatureKey): AppError {
  const e = user.entitlements;
  return new AppError(403, `${FEATURE_LABEL[feature]} is not included in your organization's plan.`, {
    code: FEATURE_NOT_ENTITLED,
    details: { feature, planVersionId: e?.planVersionId ?? null, enforcement: e?.featureEnforcement ?? "invalid" },
  });
}

export function featureAllowedFor(user: Pick<AuthUser, "role" | "companyId" | "entitlements"> | undefined, feature: PlanFeatureKey): boolean {
  if (!user) return false;
  // No tenant context (platform operator without a company) → nothing to gate here.
  if (user.companyId == null) return user.role === "platform_owner";
  return user.entitlements?.features?.[feature] === true;
}

export function assertFeatureEntitled(user: Pick<AuthUser, "role" | "companyId" | "entitlements"> | undefined, feature: PlanFeatureKey): void {
  if (!user) throw new AppError(401, "Unauthorized");
  if (!featureAllowedFor(user, feature)) throw featureDenialError(user, feature);
}

// Path-scoped middleware: `router.use("/documents", requireFeature("documents"))`.
export function requireFeature(feature: PlanFeatureKey) {
  return (req: AuthRequest, _res: Response, next: NextFunction) => {
    try {
      assertFeatureEntitled(req.user, feature);
      next();
    } catch (err) {
      next(err);
    }
  };
}

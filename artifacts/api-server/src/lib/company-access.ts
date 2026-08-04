import type { Company } from "@workspace/db";

export type CompanyAccess =
  | { blocked: true; reason: string }
  | { blocked: false; readOnly: boolean };

// Evaluates a company's subscription lifecycle to decide whether a user may sign in
// or operate. suspended/expired (incl. lapsed trial) block access; cancelled is read-only.
// Lives in lib (not middlewares) so BOTH the per-request gate (requireAuth) and the
// refresh-token rotation path (lib/sessions.ts) apply the SAME tenant-status policy —
// a suspended tenant must not be able to mint fresh access tokens via refresh.
export function evaluateCompanyAccess(company: Pick<Company, "status" | "trialEndsAt">): CompanyAccess {
  const status = company.status;
  if (status === "suspended") {
    return { blocked: true, reason: "Your company account has been suspended. Please contact support." };
  }
  if (status === "expired") {
    return { blocked: true, reason: "Your subscription has expired. Please renew to continue." };
  }
  if (status === "trial" && company.trialEndsAt && company.trialEndsAt.getTime() < Date.now()) {
    return { blocked: true, reason: "Your free trial has ended. Please choose a plan to continue." };
  }
  if (status === "cancelled") {
    return { blocked: false, readOnly: true };
  }
  return { blocked: false, readOnly: false };
}

import { useAuth } from "@/contexts/AuthContext";

/**
 * Client-side gate for tenant billing (Batch 20).
 *
 * Mirrors the server RBAC module `subscriptions` (view = read the current
 * subscription/usage/plans, manage = start Checkout / open the Billing Portal).
 * `primary_admin` bypasses the matrix exactly like the API does;
 * `platform_owner` is fenced out of every tenant CRM route (403) and therefore
 * never sees tenant billing. Server RBAC stays authoritative — this only decides
 * what to render.
 */
export function subscriptionAccess(
  user: { role?: string; permissions?: Record<string, string[] | undefined> } | null | undefined,
) {
  if (!user || user.role === "platform_owner") return { canView: false, canManage: false };
  const isFull = user.role === "primary_admin";
  const perms = (user.permissions?.subscriptions ?? []) as string[];
  const canView = isFull || perms.includes("view") || perms.includes("manage");
  const canManage = isFull || perms.includes("manage");
  return { canView, canManage };
}

export function useSubscriptionPermissions() {
  const { user } = useAuth();
  return subscriptionAccess(user as { role?: string; permissions?: Record<string, string[] | undefined> } | null);
}

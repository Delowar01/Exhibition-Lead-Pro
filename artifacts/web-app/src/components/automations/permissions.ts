import { useAuth } from "@/contexts/AuthContext";

/**
 * Client-side gate for the Automations workspace (Batch 17).
 *
 * Mirrors the server RBAC module `workflows` (view = read/validate/catalog/run
 * history, manage = create/update/lifecycle/delete). `primary_admin` bypasses
 * the matrix exactly like the API does; `platform_owner` is fenced out of every
 * tenant CRM route (403) and therefore never sees the workspace. Server RBAC
 * stays authoritative — this only decides what to render.
 */
export function workflowAccess(user: { role?: string; permissions?: Record<string, string[] | undefined> } | null | undefined) {
  if (!user || user.role === "platform_owner") return { canView: false, canManage: false };
  const isFull = user.role === "primary_admin";
  const perms = (user.permissions?.workflows ?? []) as string[];
  const canView = isFull || perms.includes("view") || perms.includes("manage");
  const canManage = isFull || perms.includes("manage");
  return { canView, canManage };
}

export function useWorkflowPermissions() {
  const { user } = useAuth();
  return workflowAccess(user as { role?: string; permissions?: Record<string, string[] | undefined> } | null);
}

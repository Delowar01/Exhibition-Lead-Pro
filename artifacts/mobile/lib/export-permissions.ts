import type { User } from "@workspace/api-client-react";

// Mirrors the server gating: primary_admin bypasses the tenant permission matrix;
// admin / employee need reports:view to export. platform_owner is intentionally
// EXCLUDED: the API blocks platform owners from tenant export (requireTenantUser),
// so showing the control would only produce a 403 — keep the client in lockstep.
export function canExport(user: User | null): boolean {
  if (!user) return false;
  if (user.role === "primary_admin") return true;
  const perms = (user.permissions ?? {}) as Record<string, string[] | undefined>;
  return (perms.reports ?? []).includes("view");
}

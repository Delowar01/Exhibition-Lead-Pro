import type { User } from "@workspace/api-client-react";

// Mirrors the server gating: primary_admin / platform_owner bypass all permission
// checks; admin / employee need reports:view to export.
export function canExport(user: User | null): boolean {
  if (!user) return false;
  if (user.role === "primary_admin" || user.role === "platform_owner") return true;
  const perms = (user.permissions ?? {}) as Record<string, string[] | undefined>;
  return (perms.reports ?? []).includes("view");
}

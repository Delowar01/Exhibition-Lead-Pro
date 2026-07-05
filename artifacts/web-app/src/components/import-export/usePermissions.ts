import { useAuth } from "@/contexts/AuthContext";

// Mirrors the server gating: primary_admin bypasses the tenant permission matrix;
// admin / employee are gated by the explicit permissions matrix. Exports are a
// reporting capability (reports:view); imports write contacts/leads (create).
// platform_owner is intentionally EXCLUDED: the API blocks platform owners from
// tenant import/export (requireTenantUser), so surfacing the controls would only
// produce a 403 — keep the client in lockstep with the server.
export function useImportExportPermissions() {
  const { user } = useAuth();
  const isFull = user?.role === "primary_admin";
  const perms = (user?.permissions ?? {}) as Record<string, string[] | undefined>;
  const has = (module: string, action: string) => isFull || (perms[module] ?? []).includes(action);
  return {
    canExport: has("reports", "view"),
    canImportContacts: has("contacts", "create"),
    canImportLeads: has("leads", "create"),
  };
}

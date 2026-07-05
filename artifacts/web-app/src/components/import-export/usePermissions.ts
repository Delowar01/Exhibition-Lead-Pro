import { useAuth } from "@/contexts/AuthContext";

// Mirrors the server gating: primary_admin / platform_owner bypass all permission
// checks; admin / employee are gated by the explicit permissions matrix. Exports are
// a reporting capability (reports:view); imports write contacts/leads (create).
export function useImportExportPermissions() {
  const { user } = useAuth();
  const isFull = user?.role === "primary_admin" || user?.role === "platform_owner";
  const perms = (user?.permissions ?? {}) as Record<string, string[] | undefined>;
  const has = (module: string, action: string) => isFull || (perms[module] ?? []).includes(action);
  return {
    canExport: has("reports", "view"),
    canImportContacts: has("contacts", "create"),
    canImportLeads: has("leads", "create"),
  };
}

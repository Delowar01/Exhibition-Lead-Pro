// Permission catalog — the single source of truth for every (module, action) pair
// the RBAC system recognizes. Roles grant a subset of these; requirePermission(module,
// action) checks the caller's EFFECTIVE permissions (legacy users.permissions JSON
// unioned with grants from assigned roles). platform_owner/primary_admin bypass all
// checks, so they are not represented here.
//
// Module/action names MUST match the strings passed to requirePermission across the
// route layer (e.g. requirePermission("contacts", "create")).

export const PERMISSION_CATALOG: Record<string, { label: string; actions: string[] }> = {
  contacts: { label: "Contacts", actions: ["view", "create", "edit", "delete", "export"] },
  leads: { label: "Leads", actions: ["view", "create", "edit", "delete"] },
  custom_fields: { label: "Custom Fields", actions: ["view", "create", "edit", "delete"] },
  territories: { label: "Territories", actions: ["view", "create", "edit", "delete"] },
  documents: { label: "Documents", actions: ["view", "create", "edit", "delete"] },
  events: { label: "Events", actions: ["view", "create", "edit", "delete"] },
  scans: { label: "Scans", actions: ["view", "create", "delete"] },
  reports: { label: "Reports", actions: ["view"] },
  team: { label: "Team & Users", actions: ["view", "create", "edit", "delete"] },
  departments: { label: "Departments", actions: ["view", "create", "edit", "delete"] },
  teams: { label: "Teams", actions: ["view", "create", "edit", "delete"] },
  roles: { label: "Roles & Permissions", actions: ["view", "create", "edit", "delete"] },
  organization: { label: "Organization", actions: ["view", "edit"] },
  security: { label: "Security Center", actions: ["view", "edit"] },
  subscriptions: { label: "Subscription & Billing", actions: ["view", "manage"] },
};

export type PermissionMatrix = Record<string, string[]>;

// Validates that every (module, action) in a grant list exists in the catalog.
// Returns the offending pair (for a 400) or null when all are valid.
export function findInvalidPermission(grants: Array<{ module: string; action: string }>): { module: string; action: string } | null {
  for (const g of grants) {
    const mod = PERMISSION_CATALOG[g.module];
    if (!mod || !mod.actions.includes(g.action)) return g;
  }
  return null;
}

// Merges two permission matrices (module -> actions) into a deduped union.
export function mergePermissions(a: PermissionMatrix, b: PermissionMatrix): PermissionMatrix {
  const out: PermissionMatrix = {};
  for (const src of [a, b]) {
    for (const [mod, actions] of Object.entries(src ?? {})) {
      const set = new Set(out[mod] ?? []);
      for (const action of actions) set.add(action);
      out[mod] = Array.from(set);
    }
  }
  return out;
}

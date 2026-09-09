import type { Request, Response, NextFunction } from "express";
import { db, usersTable, userCompanyAccessTable, userRolesTable, rolePermissionsTable } from "@workspace/db";
import { and, eq, inArray, isNull, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { verifyAccessToken } from "../lib/tokens.js";
import { validateSession } from "../lib/sessions.js";
import { mergePermissions, type PermissionMatrix } from "../lib/rbac.js";

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: string;
  companyId: number | null;
  permissions: Record<string, string[]>;
  contactVisibility: string;
  companyVisibility: string;
  selectedUserIds: number[];
  isActive: boolean;
  companyStatus: string | null;
  readOnly: boolean;
  accessibleCompanies: number[];
  // Server-side session id this request's token belongs to. Absent for legacy
  // tokens minted before sessions existed (still accepted for back-compat).
  sessionId: number | null;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

// Returns a tenant-isolation WHERE condition for the given company-id column.
// platform_owner sees everything (no filter); everyone else is restricted to the
// companies they can access. Never scope tenant reads by companyId alone.
export function tenantScope(user: AuthUser | undefined, column: PgColumn): SQL | undefined {
  if (!user || user.role === "platform_owner") return undefined;
  return inArray(column, user.accessibleCompanies);
}

// Legacy role names persisted in older databases (incl. production) that predate the
// Phase-0 role rename. Authorization recognizes only the canonical names, so every
// request normalizes the stored role at the auth boundary. Without this, a user still
// stored as `company_admin` is denied the `primary_admin` permission bypass and gets
// 403 on every permission-gated write (scans/OCR, contact edit/delete, team, etc.).
const LEGACY_ROLE_ALIASES: Record<string, string> = {
  company_admin: "primary_admin",
  team_member: "employee",
};

export function normalizeRole(role: string): string {
  return LEGACY_ROLE_ALIASES[role] ?? role;
}

// Batch 20: tenant access is resolved from the CANONICAL subscription row by
// lib/company-access.ts (shared with the login path and the refresh-rotation
// path so all three apply the same entitlement policy). The legacy company
// billing columns are never read here.
import { loadTenantAccess, type CompanyAccess } from "../lib/company-access.js";
export { type CompanyAccess };

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers["authorization"];
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const payload = verifyAccessToken(authHeader.slice(7));
    if (!payload) {
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }

    // Server-side session validation: every access token MUST carry a session id
    // and that session must still be live (not revoked/expired) so logout and
    // terminate take effect immediately. Legacy sid-less tokens (minted before
    // sessions existed) are no longer accepted — they bypassed session revocation
    // entirely; holders simply refresh or re-login and receive a sid-bearing token.
    if (typeof payload.sid !== "number") {
      res.status(401).json({ error: "Session expired. Please sign in again." });
      return;
    }
    const session = await validateSession(payload.sid);
    if (!session || session.userId !== payload.id) {
      res.status(401).json({ error: "Session expired. Please sign in again." });
      return;
    }
    const sessionId: number = session.id;

    const [user] = await db
      .select()
      .from(usersTable)
      .where(and(eq(usersTable.id, payload.id), isNull(usersTable.deletedAt)))
      .limit(1);
    if (!user || !user.isActive) {
      res.status(401).json({ error: "Account is disabled" });
      return;
    }

    let companyStatus: string | null = null;
    let readOnly = false;
    if (user.companyId) {
      const tenant = await loadTenantAccess(user.companyId);
      companyStatus = tenant.summary?.status ?? null;
      if (tenant.access.blocked) {
        res.status(403).json({ error: tenant.access.reason, code: tenant.access.reasonCode });
        return;
      }
      readOnly = tenant.access.readOnly;
    }

    const accessRows = await db
      .select({ companyId: userCompanyAccessTable.companyId })
      .from(userCompanyAccessTable)
      .where(eq(userCompanyAccessTable.userId, user.id));
    const accessibleCompanies = Array.from(
      new Set([...(user.companyId ? [user.companyId] : []), ...accessRows.map((r) => r.companyId)]),
    );

    // Tenant invariant: every non-platform user MUST be scoped to at least one company.
    // A null-tenant non-platform account would otherwise see unscoped (cross-tenant) data.
    if (user.role !== "platform_owner" && accessibleCompanies.length === 0) {
      res.status(403).json({ error: "Your account has no company access. Please contact support." });
      return;
    }

    // Effective permissions = legacy per-user JSON ∪ grants from assigned roles.
    // This keeps the RBAC model ADDITIVE: existing permission JSON still works and
    // requirePermission stays unchanged. platform_owner/primary_admin bypass anyway,
    // so the role join is skipped for them to save a round-trip.
    let permissions: PermissionMatrix = user.permissions ?? {};
    if (user.role !== "platform_owner" && user.role !== "primary_admin") {
      const grantRows = await db
        .select({ module: rolePermissionsTable.module, action: rolePermissionsTable.action })
        .from(userRolesTable)
        .innerJoin(rolePermissionsTable, eq(userRolesTable.roleId, rolePermissionsTable.roleId))
        .where(eq(userRolesTable.userId, user.id));
      if (grantRows.length > 0) {
        const roleMatrix: PermissionMatrix = {};
        for (const r of grantRows) {
          const set = new Set(roleMatrix[r.module] ?? []);
          set.add(r.action);
          roleMatrix[r.module] = Array.from(set);
        }
        permissions = mergePermissions(permissions, roleMatrix);
      }
    }

    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: normalizeRole(user.role),
      companyId: user.companyId,
      permissions,
      contactVisibility: user.contactVisibility,
      companyVisibility: user.companyVisibility,
      selectedUserIds: user.selectedUserIds ?? [],
      isActive: user.isActive,
      companyStatus,
      readOnly,
      accessibleCompanies,
      sessionId,
    };
    next();
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// Loads a full AuthUser for a given user id, OUTSIDE the request/response cycle.
// Background jobs (e.g. executive report export) run after the originating request
// has ended, so they cannot reuse req.user; they must rebuild a faithful AuthUser
// to keep tenant-scoped reads correctly isolated (accessibleCompanies, role,
// effective permissions). Mirrors the field-building in requireAuth. Returns null
// if the user is missing/deleted/disabled. Does not enforce the subscription
// lifecycle block (a job's originating request was already authorized).
export async function loadAuthUserById(userId: number): Promise<AuthUser | null> {
  const [user] = await db
    .select()
    .from(usersTable)
    .where(and(eq(usersTable.id, userId), isNull(usersTable.deletedAt)))
    .limit(1);
  if (!user || !user.isActive) return null;

  let companyStatus: string | null = null;
  let readOnly = false;
  if (user.companyId) {
    const tenant = await loadTenantAccess(user.companyId);
    companyStatus = tenant.summary?.status ?? null;
    readOnly = tenant.access.blocked ? true : tenant.access.readOnly;
  }

  const accessRows = await db
    .select({ companyId: userCompanyAccessTable.companyId })
    .from(userCompanyAccessTable)
    .where(eq(userCompanyAccessTable.userId, user.id));
  const accessibleCompanies = Array.from(
    new Set([...(user.companyId ? [user.companyId] : []), ...accessRows.map((r) => r.companyId)]),
  );

  let permissions: PermissionMatrix = user.permissions ?? {};
  if (user.role !== "platform_owner" && user.role !== "primary_admin") {
    const grantRows = await db
      .select({ module: rolePermissionsTable.module, action: rolePermissionsTable.action })
      .from(userRolesTable)
      .innerJoin(rolePermissionsTable, eq(userRolesTable.roleId, rolePermissionsTable.roleId))
      .where(eq(userRolesTable.userId, user.id));
    if (grantRows.length > 0) {
      const roleMatrix: PermissionMatrix = {};
      for (const r of grantRows) {
        const set = new Set(roleMatrix[r.module] ?? []);
        set.add(r.action);
        roleMatrix[r.module] = Array.from(set);
      }
      permissions = mergePermissions(permissions, roleMatrix);
    }
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: normalizeRole(user.role),
    companyId: user.companyId,
    permissions,
    contactVisibility: user.contactVisibility,
    companyVisibility: user.companyVisibility,
    selectedUserIds: user.selectedUserIds ?? [],
    isActive: user.isActive,
    companyStatus,
    readOnly,
    accessibleCompanies,
    sessionId: null,
  };
}

export function requireRole(...roles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  };
}

// Tenant-data firewall (Enterprise Privacy Model, Stage 2.11A): blocks the platform
// operator (platform_owner) from customer CRM/business-data endpoints. Platform Owner
// (Elite Marcom) manages the platform but must NOT have routine access to customer
// business data. This is the API-layer enforcement — UI hiding alone is insufficient.
//
// IMPORTANT: this is a TERMINATING guard. Sub-routers are mounted path-less on one
// shared parent (routes/index.ts), so a path-less `router.use(requireTenantUser)`
// would 403 EVERY request flowing through the parent (including platform routes).
// Always path-scope it to the module base, e.g. `router.use("/contacts", requireTenantUser)`.
export function requireTenantUser(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (req.user.role === "platform_owner") {
    res.status(403).json({ error: "Platform operators cannot access customer business data" });
    return;
  }
  next();
}

// platform_owner and primary_admin have full access within their scope; admin/employee
// are constrained by their explicit permission matrix (module -> [actions]).
export function requirePermission(module: string, action: string) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (req.user.role === "platform_owner" || req.user.role === "primary_admin") {
      next();
      return;
    }
    const granted = req.user.permissions?.[module] ?? [];
    if (!granted.includes(action)) {
      res.status(403).json({ error: `Missing permission: ${module}.${action}` });
      return;
    }
    next();
  };
}

// Blocks mutating requests when the account is read-only (cancelled subscription).
export function requireWritable(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.user?.readOnly) {
    res.status(403).json({ error: "Your account is read-only. Reactivate your subscription to make changes." });
    return;
  }
  next();
}

// Router-level guard: blocks any non-idempotent (mutating) request when the
// account is read-only. Read requests (GET/HEAD/OPTIONS) are always allowed.
export function blockReadOnlyMutations(req: AuthRequest, res: Response, next: NextFunction) {
  const method = req.method.toUpperCase();
  if (req.user?.readOnly && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    res.status(403).json({ error: "Your account is read-only. Reactivate your subscription to make changes." });
    return;
  }
  next();
}

// Tenant-isolation check: platform_owner may access any company; everyone else
// may only touch records belonging to a company they have access to.
export function canAccessCompany(user: AuthUser | undefined, companyId: number | null | undefined): boolean {
  if (!user) return false;
  if (user.role === "platform_owner") return true;
  if (companyId == null) return false;
  return user.accessibleCompanies.includes(companyId);
}

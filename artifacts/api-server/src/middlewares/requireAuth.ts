import type { Request, Response, NextFunction } from "express";
import { db, usersTable, companiesTable, userCompanyAccessTable, type Company } from "@workspace/db";
import { eq, inArray, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { verifyToken } from "../lib/auth.js";

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

export type CompanyAccess =
  | { blocked: true; reason: string }
  | { blocked: false; readOnly: boolean };

// Evaluates a company's subscription lifecycle to decide whether a user may sign in
// or operate. suspended/expired (incl. lapsed trial) block access; cancelled is read-only.
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

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers["authorization"];
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const payload = verifyToken(authHeader.slice(7));
    if (!payload) {
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, payload.id)).limit(1);
    if (!user || !user.isActive) {
      res.status(401).json({ error: "Account is disabled" });
      return;
    }

    let companyStatus: string | null = null;
    let readOnly = false;
    if (user.companyId) {
      const [company] = await db
        .select({ status: companiesTable.status, trialEndsAt: companiesTable.trialEndsAt })
        .from(companiesTable)
        .where(eq(companiesTable.id, user.companyId))
        .limit(1);
      if (company) {
        companyStatus = company.status;
        const access = evaluateCompanyAccess(company);
        if (access.blocked) {
          res.status(403).json({ error: access.reason });
          return;
        }
        readOnly = access.readOnly;
      }
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

    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      companyId: user.companyId,
      permissions: user.permissions ?? {},
      contactVisibility: user.contactVisibility,
      companyVisibility: user.companyVisibility,
      selectedUserIds: user.selectedUserIds ?? [],
      isActive: user.isActive,
      companyStatus,
      readOnly,
      accessibleCompanies,
    };
    next();
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
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

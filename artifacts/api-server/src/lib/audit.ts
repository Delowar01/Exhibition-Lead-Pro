import type { Request, Response, NextFunction } from "express";
import { db, auditLogsTable } from "@workspace/db";
import type { AuthRequest } from "../middlewares/requireAuth.js";

interface AuditParams {
  action: string;
  userId?: number | null;
  userName?: string | null;
  companyId?: number | null;
  entityType?: string | null;
  entityId?: string | number | null;
  metadata?: Record<string, unknown> | null;
}

// Appends an immutable audit-trail entry. Never throws — auditing must not break requests.
export async function writeAudit(req: Request, params: AuditParams): Promise<void> {
  const authUser = (req as AuthRequest).user;
  try {
    await db.insert(auditLogsTable).values({
      companyId: params.companyId ?? authUser?.companyId ?? null,
      userId: params.userId ?? authUser?.id ?? null,
      userName: params.userName ?? authUser?.email ?? null,
      action: params.action,
      entityType: params.entityType ?? null,
      entityId: params.entityId != null ? String(params.entityId) : null,
      metadata: params.metadata ?? null,
      ipAddress: req.ip ?? null,
    });
  } catch (err) {
    req.log.error(err);
  }
}

export interface AuditMutationsOptions {
  // Batch 21 Correction 1 — tenant attribution. Resolves the company the mutated
  // entity belongs to (from the VERIFIED target row, after the request succeeded)
  // so a platform-owner action on a tenant's user lands on that tenant's
  // administrative trail instead of the owner's null company. `undefined` (no
  // target, not accessible, or a lookup failure) keeps the actor's company.
  companyIdResolver?: (req: AuthRequest) => Promise<number | null | undefined>;
}

// Router-level middleware: records an immutable audit row for every successful
// mutating request (POST/PATCH/PUT/DELETE). Read requests are not audited.
export function auditMutations(module: string, options: AuditMutationsOptions = {}) {
  return (req: Request, res: Response, next: NextFunction) => {
    const method = req.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      next();
      return;
    }
    res.on("finish", () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        void (async () => {
          let companyId: number | null | undefined;
          if (options.companyIdResolver) {
            try {
              companyId = await options.companyIdResolver(req as AuthRequest);
            } catch (err) {
              req.log.error(err);
            }
          }
          await writeAudit(req, {
            action: `${module}.${method.toLowerCase()}`,
            entityType: module,
            entityId: (req.params as Record<string, string>).id ?? null,
            ...(companyId !== undefined ? { companyId } : {}),
            metadata: { path: req.originalUrl, method },
          });
        })();
      }
    });
    next();
  };
}

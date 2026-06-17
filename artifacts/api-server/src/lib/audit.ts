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

// Router-level middleware: records an immutable audit row for every successful
// mutating request (POST/PATCH/PUT/DELETE). Read requests are not audited.
export function auditMutations(module: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const method = req.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      next();
      return;
    }
    res.on("finish", () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        void writeAudit(req, {
          action: `${module}.${method.toLowerCase()}`,
          entityType: module,
          entityId: (req.params as Record<string, string>).id ?? null,
          metadata: { path: req.originalUrl, method },
        });
      }
    });
    next();
  };
}

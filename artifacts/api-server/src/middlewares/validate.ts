import type { Request, Response, NextFunction } from "express";

// Phase 2.7 — request validation + list-query standardization.
//
// The generated Zod schemas (@workspace/api-zod) are the contract source of truth,
// produced from the same OpenAPI spec the clients are generated from — so any payload
// a well-behaved generated client sends already conforms. Wiring those schemas in at
// the route layer closes tech-debt H1 (manual destructuring let empty/junk bodies
// through and created all-null rows). We validate WITHOUT mutating req.body: services
// keep reading the fields they already read; we only reject bad input early.

// Minimal structural shape of a generated Zod object schema. Typed structurally (not
// via a `zod` import) so we never depend on a specific installed zod instance/version.
interface ZodLike {
  safeParse: (data: unknown) => SafeParseResult;
  // ZodObject exposes `.shape`; used to know the set of recognized field names so a
  // body of ONLY unknown keys is treated as empty rather than silently stripped.
  shape?: Record<string, unknown>;
}

interface SafeParseResult {
  success: boolean;
  data?: unknown;
  error?: { issues?: Array<{ path: Array<string | number>; message: string }> };
}

export interface ValidateBodyOptions {
  // Reject a body that carries no recognized field (defaults to true). An empty `{}`
  // or a body of only-unknown keys is a client error, not an all-null row.
  requireNonEmpty?: boolean;
}

function requestId(req: Request): string | undefined {
  const id = (req as Request & { id?: unknown }).id;
  return id === undefined ? undefined : String(id);
}

/**
 * Body-validation middleware factory. Pass a generated Zod body schema; the request
 * is rejected with a standardized 400 (`{ error, details?, requestId }`) when the body
 * is not a JSON object, carries no recognized field, or fails schema validation.
 */
export function validateBody(schema: ZodLike, options: ValidateBodyOptions = {}) {
  const requireNonEmpty = options.requireNonEmpty ?? true;
  const knownKeys = schema.shape ? Object.keys(schema.shape) : null;

  return (req: Request, res: Response, next: NextFunction): void => {
    const raw = req.body;

    if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
      res.status(400).json({ error: "Request body must be a JSON object", requestId: requestId(req) });
      return;
    }

    if (requireNonEmpty) {
      const rawKeys = Object.keys(raw as Record<string, unknown>);
      const recognized = knownKeys ? rawKeys.filter((k) => knownKeys.includes(k)) : rawKeys;
      if (recognized.length === 0) {
        res.status(400).json({
          error: "Request body must include at least one valid field",
          requestId: requestId(req),
        });
        return;
      }
    }

    const result = schema.safeParse(raw);
    if (!result.success) {
      const details = (result.error?.issues ?? []).map((i) => ({
        field: i.path.length ? i.path.join(".") : "(body)",
        message: i.message,
      }));
      res.status(400).json({ error: "Validation failed", details, requestId: requestId(req) });
      return;
    }

    next();
  };
}

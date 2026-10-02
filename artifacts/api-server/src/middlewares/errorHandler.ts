import type { Request, Response, NextFunction } from "express";
import { StorageError, describeError } from "../storage/contract.js";

/**
 * Typed application error. Throw it (or pass it to `next`) to produce a JSON
 * error response with a specific status code via the global error handler.
 */
export class AppError extends Error {
  readonly statusCode: number;
  /** Optional machine-readable error code (e.g. AI_BUDGET_EXCEEDED, AI_RATE_LIMITED). */
  readonly code?: string;
  /** Optional safe, JSON-serializable metadata surfaced to the client (never content). */
  readonly details?: Record<string, unknown>;
  /** When set, the response carries a Retry-After header with this many seconds. */
  readonly retryAfterSeconds?: number;

  constructor(
    statusCode: number,
    message: string,
    opts?: { code?: string; details?: Record<string, unknown>; retryAfterSeconds?: number },
  ) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = opts?.code;
    this.details = opts?.details;
    this.retryAfterSeconds = opts?.retryAfterSeconds;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

function requestId(req: Request): string | undefined {
  const id = (req as Request & { id?: unknown }).id;
  return id === undefined ? undefined : String(id);
}

/** JSON 404 for any request that did not match a route. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: "Not Found", requestId: requestId(req) });
}

// Resolve the HTTP status carried by an error. AppError wins; otherwise honor the
// `statusCode`/`status` that framework errors set (e.g. body-parser's 413 for an
// oversized body, 400 for malformed JSON). Falls back to 500 for true unknowns.
const STORAGE_STATUS: Record<string, number> = { STORAGE_NOT_FOUND: 404, STORAGE_TOO_LARGE: 413, STORAGE_CONFLICT: 409 };

function statusOf(err: unknown): number {
  if (err instanceof AppError) return err.statusCode;
  if (err instanceof StorageError) return STORAGE_STATUS[err.code] ?? 503;
  if (typeof err === "object" && err !== null) {
    const e = err as { statusCode?: unknown; status?: unknown };
    if (typeof e.statusCode === "number" && e.statusCode >= 400 && e.statusCode <= 599) {
      return e.statusCode;
    }
    if (typeof e.status === "number" && e.status >= 400 && e.status <= 599) {
      return e.status;
    }
  }
  return 500;
}

/**
 * Global error handler — the single place unhandled route errors funnel
 * through. It emits the same `{ error }` shape used across the API, so existing
 * clients see no contract change. Routes keep their explicit `res.status(...)`
 * returns; this is the safety net for anything that throws or rejects (Express
 * 5 forwards async rejections here automatically).
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // B25 Correction 3: a storage-origin error is logged as its sanitized shape
  // only (it carries no raw cause, but it is never handed to the generic
  // serializer either); everything else keeps the full error for diagnostics.
  if (err instanceof StorageError) req.log?.error({ error: describeError(err), causeInfo: err.causeInfo }, "Unhandled storage error");
  else req.log?.error({ err }, "Unhandled request error");

  if (res.headersSent) {
    return;
  }

  const statusCode = statusOf(err);
  // Client errors (4xx) carry safe, caller-actionable messages (e.g. body-parser
  // "request entity too large" -> 413, malformed JSON -> 400) — preserve both
  // their status AND message. Server errors (5xx) and true unknowns get a
  // generic message so internal details never leak.
  let message = "Internal server error";
  if (err instanceof AppError) {
    message = err.message;
  } else if (err instanceof StorageError) {
    message = statusCode === 503 ? "File storage is temporarily unavailable. Please try again later." : err.message;
  } else if (statusCode < 500 && err instanceof Error && err.message) {
    message = err.message;
  }

  // Additive fields: machine-readable code + safe context (AppError only), so clients
  // can distinguish e.g. rate-limit vs budget-limit 429s. Existing consumers that only
  // read `error` are unaffected. NOTE: emitted as `context`, not `details` — `details`
  // is the established array-of-field-issues contract for 400 validation errors.
  const extra: Record<string, unknown> = {};
  if (err instanceof StorageError) extra.code = statusCode === 503 ? "STORAGE_UNAVAILABLE" : err.code;
  if (err instanceof AppError) {
    if (err.code) extra.code = err.code;
    if (err.details) extra.context = err.details;
    if (err.retryAfterSeconds != null && err.retryAfterSeconds > 0) {
      res.setHeader("Retry-After", String(Math.ceil(err.retryAfterSeconds)));
      extra.retryAfterSeconds = Math.ceil(err.retryAfterSeconds);
    }
  }

  res.status(statusCode).json({ error: message, requestId: requestId(req), ...extra });
}

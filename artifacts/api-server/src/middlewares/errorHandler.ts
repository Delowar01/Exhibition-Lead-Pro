import type { Request, Response, NextFunction } from "express";

/**
 * Typed application error. Throw it (or pass it to `next`) to produce a JSON
 * error response with a specific status code via the global error handler.
 */
export class AppError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/** JSON 404 for any request that did not match a route. */
export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: "Not Found" });
}

// Resolve the HTTP status carried by an error. AppError wins; otherwise honor the
// `statusCode`/`status` that framework errors set (e.g. body-parser's 413 for an
// oversized body, 400 for malformed JSON). Falls back to 500 for true unknowns.
function statusOf(err: unknown): number {
  if (err instanceof AppError) return err.statusCode;
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
  req.log?.error({ err }, "Unhandled request error");

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
  } else if (statusCode < 500 && err instanceof Error && err.message) {
    message = err.message;
  }

  res.status(statusCode).json({ error: message });
}

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

  const statusCode = err instanceof AppError ? err.statusCode : 500;
  const message =
    err instanceof AppError ? err.message : "Internal server error";

  res.status(statusCode).json({ error: message });
}

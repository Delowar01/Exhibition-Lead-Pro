// =============================================================================
// B25 Correction 2 — the ONE place a storage-path error is reduced to something
// safe to log, persist or return. Provider errors carry bucket / object names,
// response bodies and signed-request details; filesystem errors carry host
// paths; database errors carry SQL text and parameters; any of them may carry a
// stack through a sensitive path. None of that leaves this function: the
// result is a stable class, a stable code / status, an optional sanitized
// reason and a retryable hint — never a message, cause, stack, key, path,
// bucket, token or parameter.
// =============================================================================
import { AppError } from "../middlewares/errorHandler.js";
import { StorageError } from "./contract.js";
import { EnvelopeError } from "./envelope.js";

export interface SanitizedError {
  /** Stable error family: StorageError | AppError | EnvelopeError | ProviderError | DatabaseError | SystemError | Error | <typeof> */
  class: string;
  /** Stable code (StorageError / AppError code, SQLSTATE, errno name). */
  code?: string;
  /** HTTP-like status (AppError status, provider API status). */
  status?: number;
  /** Sanitized reason code carried by StorageError (e.g. NO_READABLE_COPY, GENERATION_MISMATCH). */
  reason?: string;
  retryable?: boolean;
}

const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,40}$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;

export function sanitizeStorageError(err: unknown): SanitizedError {
  if (err instanceof StorageError) {
    const out: SanitizedError = { class: "StorageError", code: err.code, retryable: err.code === "STORAGE_UNAVAILABLE" };
    if (err.reason && SAFE_CODE.test(err.reason)) out.reason = err.reason;
    return out;
  }
  if (err instanceof AppError) {
    const out: SanitizedError = { class: "AppError", status: err.statusCode };
    if (err.code && SAFE_CODE.test(err.code)) out.code = err.code;
    return out;
  }
  if (err instanceof EnvelopeError) {
    return { class: "EnvelopeError", code: err.code };
  }
  if (typeof err === "object" && err !== null) {
    const e = err as { code?: unknown; severity?: unknown; errno?: unknown; syscall?: unknown; name?: unknown };
    if (typeof e.code === "number" && Number.isFinite(e.code)) {
      // Google / HTTP API errors expose the status as a numeric `code`.
      return { class: "ProviderError", status: e.code, retryable: e.code === 429 || e.code >= 500 };
    }
    if (typeof e.code === "string") {
      if (SQLSTATE.test(e.code) && (typeof e.severity === "string" || /^[0-9]/.test(e.code))) {
        // node-postgres errors: SQLSTATE in `code`, `severity`, and the SQL / parameters we must never echo.
        return { class: "DatabaseError", code: e.code, retryable: e.code.startsWith("08") || e.code === "57P01" || e.code === "40001" || e.code === "40P01" };
      }
      if (SAFE_CODE.test(e.code)) {
        // Node system errors (ENOENT, EACCES, ECONNRESET …): the errno name only — never `path` / `dest` / message.
        const retryable = ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "EPIPE", "EBUSY", "EAGAIN"].includes(e.code);
        return { class: "SystemError", code: e.code, retryable };
      }
    }
    if (err instanceof Error) return { class: typeof e.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(e.name) ? e.name : "Error" };
    return { class: "object" };
  }
  return { class: err === null ? "null" : typeof err };
}

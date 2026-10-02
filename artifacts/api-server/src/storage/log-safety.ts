// =============================================================================
// B25 Correction 2 / 3 — the ONE place a storage-path error is reduced to
// something safe to log, persist or return. Provider errors carry bucket /
// object names, response bodies and signed-request details; filesystem errors
// carry host paths; database errors carry SQL text and parameters; any of them
// may carry a stack through a sensitive path. None of that leaves this
// function: the result is a stable class, a stable code / status, an optional
// sanitized reason and a retryable hint — never a message, cause, stack, key,
// path, bucket, token or parameter. The generic shape lives in
// storage/contract.ts (`describeError`) so StorageError itself, the global error
// handler and this helper share one implementation.
// =============================================================================
import { AppError } from "../middlewares/errorHandler.js";
import { describeError, StorageError, type ErrorShape } from "./contract.js";
import { EnvelopeError } from "./envelope.js";

export type SanitizedError = ErrorShape;

export function sanitizeStorageError(err: unknown): SanitizedError {
  // instanceof checks keep the dedicated classes recognizable even when a bundler renames them
  if (err instanceof StorageError) return describeError(err);
  if (err instanceof AppError) return { class: "AppError", status: err.statusCode, ...(err.code ? { code: err.code } : {}) };
  if (err instanceof EnvelopeError) return { class: "EnvelopeError", code: err.code };
  return describeError(err);
}

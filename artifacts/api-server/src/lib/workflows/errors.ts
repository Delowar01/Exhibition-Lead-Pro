import { AppError } from "../../middlewares/errorHandler.js";

// =============================================================================
// Workflow execution error model (Batch 16).
// =============================================================================
//   WorkflowSkip     the action cannot reasonably execute because contextual data is
//                    absent (no owner, no contact, no email …) → action `skipped`,
//                    the run continues. Deterministic, never retried.
//   WorkflowFailure  an explicit engine failure with a stable code. `retryable`
//                    decides whether the queue's retry/backoff applies.
//   AppError         thrown by the CRM services (404 entity, 400 invalid reference,
//                    409 business rule …) → deterministic failure: retrying cannot
//                    change the outcome, so no attempts are burned.
//   anything else    transient by default (transport/database/provider hiccups) →
//                    retried by the queue up to its attempt ceiling.
// Every classification is SANITIZED before persistence/logging: stable code, error
// class, short message only — never stacks, provider payloads or credentials.

export class WorkflowSkip extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "WorkflowSkip";
    this.reason = reason;
  }
}

export class WorkflowFailure extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "WorkflowFailure";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface ClassifiedError {
  retryable: boolean;
  code: string;
  errorClass: string;
  message: string;
}

// PostgreSQL / socket error codes that indicate a transient condition.
const TRANSIENT_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "EAI_AGAIN",
  "08000", "08003", "08006", "08001", "08004", // connection exceptions
  "40001", "40P01", // serialization failure / deadlock
  "53300", "53400", "57P01", "57P02", "57P03", // resource / admin shutdown
]);

function trim(msg: unknown): string {
  return typeof msg === "string" ? msg.replace(/\s+/g, " ").slice(0, 200) : "";
}

export function classifyError(err: unknown): ClassifiedError {
  if (err instanceof WorkflowFailure) {
    return { retryable: err.retryable, code: err.code, errorClass: "WorkflowFailure", message: trim(err.message) };
  }
  if (err instanceof AppError) {
    return { retryable: false, code: err.code ?? `APP_${err.statusCode}`, errorClass: "AppError", message: trim(err.message) };
  }
  if (err instanceof Error) {
    const code = (err as Error & { code?: unknown }).code;
    const codeStr = typeof code === "string" ? code : "";
    if (codeStr && TRANSIENT_CODES.has(codeStr)) {
      return { retryable: true, code: "TRANSIENT", errorClass: err.name || "Error", message: `transient error (${codeStr})` };
    }
    // Unknown runtime error: retry (bounded by the queue) but never echo its text —
    // it may contain provider/driver details.
    return { retryable: true, code: "UNEXPECTED", errorClass: err.name || "Error", message: "unexpected error" };
  }
  return { retryable: true, code: "UNEXPECTED", errorClass: typeof err, message: "unexpected error" };
}

import { ApiError } from "@workspace/api-client-react";

export interface AiErrorInfo {
  title: string;
  description: string;
  /** Whether "try again" is likely to help (network / transient AI outage). */
  retryable: boolean;
}

// Maps a failed AI request (assistant send, copilot generate, note save…) to a
// user-facing message. Distinguishes network failures, permission problems,
// validation errors, usage limits, and transient AI unavailability so the UI can
// say something more useful than a generic "failed".
export function describeAiError(err: unknown, fallbackTitle = "Something went wrong"): AiErrorInfo {
  if (err instanceof ApiError) {
    const body = (err.data && typeof err.data === "object" ? err.data : {}) as Record<string, unknown>;
    const serverMessage = typeof body.error === "string" ? body.error : "";
    const code = typeof body.code === "string" ? body.code : "";
    const retryAfter = typeof body.retryAfterSeconds === "number" ? body.retryAfterSeconds : null;
    if (err.status === 401 || err.status === 403) {
      return {
        title: "Not allowed",
        description: serverMessage || "You don't have permission for this action, or AI features are disabled for your organization.",
        retryable: false,
      };
    }
    if (err.status === 429) {
      // Batch 6: the server distinguishes rate limiting (transient — wait a bit)
      // from an exhausted monthly budget (hard until reset) via `code`.
      if (code === "AI_RATE_LIMITED") {
        const wait = retryAfter != null && retryAfter > 0 ? `Try again in ${retryAfter}s.` : "Try again in a moment.";
        return {
          title: "Too many AI requests",
          description: `You're sending AI requests too quickly. ${wait}`,
          retryable: true,
        };
      }
      if (code === "AI_BUDGET_EXCEEDED") {
        const ctx = (body.context && typeof body.context === "object" ? body.context : {}) as Record<string, unknown>;
        const resetAt = typeof ctx.resetAt === "string" ? new Date(ctx.resetAt) : null;
        const when = resetAt && !Number.isNaN(resetAt.getTime())
          ? ` AI features resume on ${resetAt.toLocaleDateString(undefined, { month: "short", day: "numeric" })}.`
          : "";
        return {
          title: "Monthly AI budget reached",
          description: `Your organization's monthly AI budget is used up.${when} An admin can raise the budget in AI Settings.`,
          retryable: false,
        };
      }
      return {
        title: "Limit reached",
        description: serverMessage || "The AI usage limit has been reached. Try again later.",
        retryable: false,
      };
    }
    if (err.status >= 400 && err.status < 500) {
      return {
        title: "Request rejected",
        description: serverMessage || "The request was invalid. Adjust it and try again.",
        retryable: false,
      };
    }
    return {
      title: "AI temporarily unavailable",
      description: serverMessage || "The server could not complete the request. Try again in a moment.",
      retryable: true,
    };
  }
  // fetch() throws TypeError on network failure (offline, DNS, CORS…).
  if (err instanceof TypeError) {
    return {
      title: "Network error",
      description: "Could not reach the server. Check your connection and try again.",
      retryable: true,
    };
  }
  return {
    title: fallbackTitle,
    description: err instanceof Error && err.message ? err.message : "Please try again.",
    retryable: true,
  };
}

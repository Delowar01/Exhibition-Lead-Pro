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
    const serverMessage =
      err.data && typeof err.data === "object" && typeof (err.data as Record<string, unknown>).error === "string"
        ? String((err.data as Record<string, unknown>).error)
        : "";
    if (err.status === 401 || err.status === 403) {
      return {
        title: "Not allowed",
        description: serverMessage || "You don't have permission for this action, or AI features are disabled for your organization.",
        retryable: false,
      };
    }
    if (err.status === 429) {
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

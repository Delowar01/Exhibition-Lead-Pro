// =============================================================================
// Request-log redaction (B25 Correction 1). The pino request serializer logs
// method + path ONLY: the query string is stripped (a legacy `?t=` credential
// could otherwise land in logs), headers are never serialized (bearer tokens,
// cookies and the X-Storage-Capability upload capability live there), and
// bearer-style path segments are masked. Pure; unit-tested without a server.
// =============================================================================
export const SENSITIVE_HEADERS = ["authorization", "cookie", "set-cookie", "x-storage-capability"] as const;

export interface LoggedRequest {
  id: unknown;
  method: string | undefined;
  url: string | undefined;
}

export function redactPath(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  // Strip the query string AND redact secret path segments (e.g. the raw
  // invitation token in GET /invitations/token/:token) so bearer-style
  // secrets never persist in request logs.
  return path.split("?")[0].replace(/(\/token\/)[^/]+/gi, "$1[REDACTED]");
}

export function serializeRequestForLog(req: { id?: unknown; method?: string; url?: string }): LoggedRequest {
  return { id: req.id, method: req.method, url: redactPath(req.url) };
}

// B25 Correction 1 — request logs (application pino serializer and an
// nginx-"combined"-compatible access-log fixture) never contain an upload
// capability, a bearer token or a legacy query credential. No server.
import { describe, it, expect } from "vitest";
import { serializeRequestForLog, SENSITIVE_HEADERS } from "../src/lib/log-redaction.js";

const CAP = "eyJ2IjoxfQ.CAPABILITY-SECRET-abcdef";
const BEARER = "BEARER-SECRET-123456";
const QUERY = "QUERY-SECRET-xyz";

function fakeReq(url: string, headers: Record<string, string>) {
  return { id: "req-1", method: "PUT", url, headers } as unknown as Parameters<typeof serializeRequestForLog>[0];
}

/** nginx `combined` format: $remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent "$http_referer" "$http_user_agent" */
function nginxCombined(req: { method: string; path: string; referer?: string; userAgent?: string }): string {
  return `127.0.0.1 - - [02/Oct/2026:12:00:00 +0000] "${req.method} ${req.path} HTTP/1.1" 200 12 "${req.referer ?? "-"}" "${req.userAgent ?? "-"}"`;
}

describe("request log redaction", () => {
  it("the application request serializer logs method + path only (no query string, no headers)", () => {
    const out = serializeRequestForLog(fakeReq(`/api/files/uploads/0f3c9a1e-1111-4222-8333-444455556666?t=${QUERY}`, { authorization: `Bearer ${BEARER}`, "x-storage-capability": CAP, cookie: "a=b" }));
    const text = JSON.stringify(out);
    expect(out.url).toBe("/api/files/uploads/0f3c9a1e-1111-4222-8333-444455556666");
    expect(text).not.toContain(QUERY);
    expect(text).not.toContain(BEARER);
    expect(text).not.toContain(CAP);
    expect(text).not.toContain("cookie");
    expect(text).not.toContain("headers");
  });

  it("the invitation token path segment stays redacted", () => {
    const out = serializeRequestForLog(fakeReq("/api/invitations/token/RAW-INVITE-TOKEN", {}));
    expect(out.url).toBe("/api/invitations/token/[REDACTED]");
  });

  it("the sensitive header list covers the capability and bearer headers", () => {
    expect(SENSITIVE_HEADERS).toContain("x-storage-capability");
    expect(SENSITIVE_HEADERS).toContain("authorization");
  });

  it("an nginx combined access-log line for the corrected flow carries no credential (they travel only in headers)", () => {
    // The corrected clients send the capability in X-Storage-Capability and the
    // session in Authorization; the request line has no query string.
    const line = nginxCombined({ method: "PUT", path: "/api/files/uploads/0f3c9a1e-1111-4222-8333-444455556666", referer: "https://dev.kaptnow.com/admin/documents", userAgent: "Mozilla/5.0" });
    expect(line).not.toContain(CAP);
    expect(line).not.toContain(BEARER);
    expect(line).not.toContain("?t=");
    // The legacy query form WOULD have been logged — which is why the API now rejects it.
    const legacy = nginxCombined({ method: "GET", path: `/api/files/0f3c9a1e-1111-4222-8333-444455556666?t=${QUERY}` });
    expect(legacy).toContain(QUERY);
  });
});

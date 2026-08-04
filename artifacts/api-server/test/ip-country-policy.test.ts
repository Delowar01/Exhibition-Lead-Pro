// Batch 4 — IP & country login policy under the trusted-proxy model.
// The server trusts exactly ONE proxy hop (app.set("trust proxy", 1)), so the
// client IP is the LAST X-Forwarded-For entry — the one appended by the trusted
// proxy. These tests connect directly (acting as the trusted hop) and set XFF
// deterministically. Country comes from CDN headers (cf-ipcountry et al.);
// production verification of real proxy geo-headers remains a documented step.
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { and, eq, desc } from "drizzle-orm";
import { db, securityEventsTable, loginAttemptsTable } from "@workspace/db";

// These tests talk to the API server's own port DIRECTLY (bypassing the shared
// dev proxy on :80): the test client then IS the single trusted proxy hop, so
// the last X-Forwarded-For entry it sets is the attributed client IP. Through
// the shared proxy the attributed IP is always the proxy's view (127.0.0.1),
// which is precisely the anti-spoofing behavior — but it makes IP simulation
// impossible, hence the direct connection here.
const BASE = `http://localhost:${process.env.API_DIRECT_PORT ?? "8080"}/api`;
const PASSWORD = "IpPolicy#2026!";

const ALLOWED_IP = "203.0.113.7";
const BLOCKED_IP = "198.51.100.9";

let email = "";
let companyId = 0;
let adminToken = "";

async function loginWith(extraHeaders: Record<string, string>) {
  return fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
}

async function setPolicy(patch: Record<string, unknown>) {
  const res = await fetch(`${BASE}/security/policy`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify(patch),
  });
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  email = `ip-policy-${Date.now()}@example.test`;
  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: PASSWORD,
      name: "IP Policy",
      companyName: `IP Policy Co ${Date.now()}`,
    }),
  });
  expect(reg.status).toBeLessThan(300);
  const body = await reg.json();
  companyId = body.user.companyId;
  adminToken = body.token;
}, 20000);

// The intentional policy-blocked logins below are recorded as failed attempts;
// purge them between tests so the email+IP brute-force lockout (a separate,
// already-tested guard) never interferes with policy assertions.
beforeEach(async () => {
  await db.delete(loginAttemptsTable).where(eq(loginAttemptsTable.email, email));
});

describe("IP allow-list", () => {
  it("allows login from an allowed IP (XFF appended by the trusted hop)", async () => {
    await setPolicy({ allowedIps: [ALLOWED_IP] });
    const res = await loginWith({ "X-Forwarded-For": ALLOWED_IP });
    expect(res.status).toBe(200);
    expect((await res.json()).token).toBeTruthy();
  });

  it("blocks login from a non-allowed IP with a generic message and a security event", async () => {
    const res = await loginWith({ "X-Forwarded-For": BLOCKED_IP });
    expect(res.status).toBe(403);
    const body = await res.json();
    // Safe, non-revealing message: no policy details, no account existence hints.
    expect(body.error).toBe("Sign-in is not permitted from your network.");

    const [event] = await db
      .select()
      .from(securityEventsTable)
      .where(and(eq(securityEventsTable.companyId, companyId), eq(securityEventsTable.type, "login_policy_blocked")))
      .orderBy(desc(securityEventsTable.id))
      .limit(1);
    expect(event).toBeDefined();
    expect(event.ipAddress).toBe(BLOCKED_IP);
  });

  it("ignores client-forged left-most XFF entries (spoofed allowed IP is still blocked)", async () => {
    // A malicious client prepends the allowed IP; the trusted hop appends the
    // real (blocked) address last. Only the last entry may be trusted.
    const res = await loginWith({ "X-Forwarded-For": `${ALLOWED_IP}, ${BLOCKED_IP}` });
    expect(res.status).toBe(403);
  });

  it("blocks the bare socket address when it is not allow-listed (no XFF at all)", async () => {
    // Without any forwarded header the attributed IP is the socket address
    // (loopback here). It is not in the allow-list → blocked. NOTE: this login
    // lands in the shared 127.0.0.1 rate-limit bucket, so assert 403 or 429 —
    // both prove it never signs in.
    const res = await loginWith({});
    expect([403, 429]).toContain(res.status);
  });
});

describe("country allow-list", () => {
  it("allows from an allowed country and blocks others with a generic message", async () => {
    await setPolicy({ allowedIps: [], allowedCountries: ["AE"] });

    // Unique XFF IPs keep these logins out of the shared loopback
    // rate-limit bucket that the rest of the suite fills up.
    const ok = await loginWith({ "cf-ipcountry": "AE", "X-Forwarded-For": "192.0.2.10" });
    expect(ok.status).toBe(200);

    const blocked = await loginWith({ "cf-ipcountry": "US", "X-Forwarded-For": "192.0.2.11" });
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).error).toBe("Sign-in is not permitted from your location.");
  });

  it("blocks when country cannot be determined and an allow-list is active", async () => {
    const res = await loginWith({ "X-Forwarded-For": "192.0.2.12" });
    expect(res.status).toBe(403);
  });

  it("clearing the policy restores access", async () => {
    await setPolicy({ allowedCountries: [] });
    const res = await loginWith({ "X-Forwarded-For": "192.0.2.13" });
    expect(res.status).toBe(200);
  });
});

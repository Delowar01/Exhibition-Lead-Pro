// Split-portal login enforcement (routes/auth.ts completeLogin +
// lib/portal-host.ts): a role/host mismatch — and ANY login on the retired
// dev.kaptnow.com host — is refused BEFORE any session is created. Hostname is
// UX separation only — requireRole/requireTenantUser remain the security
// boundary (covered elsewhere).
//
// Live API via the DIRECT port with an explicit Host header (node:http —
// fetch forbids overriding Host). Mixed hosts (localhost and tests) accept all
// roles, which is also why the rest of the suite is unaffected.
import { describe, it, expect, beforeAll } from "vitest";
import http from "node:http";
import { db, usersTable, sessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { resolvePortalHost, portalLoginRefusal } from "../src/lib/portal-host.js";

const PORT = Number(process.env.API_DIRECT_PORT ?? 8080);
const TENANT = { email: "admin@techcorp.com", password: "Admin123!" };
const OWNER = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const RETIRED_REFUSAL = "Please sign in at admin.kaptnow.com or elite.kaptnow.com";

function requestWithHost(host: string, path: string, method: "GET" | "POST", payload?: string) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        path,
        method,
        headers: {
          ...(payload ? { "Content-Type": "application/json" } : {}),
          Host: host,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

function loginWithHost(host: string, creds: { email: string; password: string }) {
  return requestWithHost(host, "/api/auth/login", "POST", JSON.stringify(creds));
}

async function sessionCount(email: string): Promise<number> {
  const [user] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email));
  if (!user) throw new Error(`missing test user ${email}`);
  return (await db.select({ id: sessionsTable.id }).from(sessionsTable).where(eq(sessionsTable.userId, user.id))).length;
}

describe("resolver + refusal truth table (pure)", () => {
  it("maps hostnames to portals", () => {
    expect(resolvePortalHost("admin.kaptnow.com")).toBe("customer");
    expect(resolvePortalHost("elite.kaptnow.com")).toBe("platform");
    expect(resolvePortalHost("dev.kaptnow.com")).toBe("retired");
    expect(resolvePortalHost("localhost")).toBe("mixed");
    expect(resolvePortalHost(undefined)).toBe("mixed");
  });
  it("retired refuses every role; portal hosts refuse only mismatches; mixed allows all", () => {
    expect(portalLoginRefusal("retired", true)).toBe(RETIRED_REFUSAL);
    expect(portalLoginRefusal("retired", false)).toBe(RETIRED_REFUSAL);
    expect(portalLoginRefusal("customer", true)).toContain("elite.kaptnow.com");
    expect(portalLoginRefusal("platform", false)).toContain("admin.kaptnow.com");
    expect(portalLoginRefusal("customer", false)).toBeNull();
    expect(portalLoginRefusal("platform", true)).toBeNull();
    expect(portalLoginRefusal("mixed", true)).toBeNull();
    expect(portalLoginRefusal("mixed", false)).toBeNull();
  });
});

describe("live login enforcement by Host header", () => {
  beforeAll(async () => {
    const health = await loginWithHost("localhost", { email: "", password: "" }).catch(() => null);
    if (!health) throw new Error("API not reachable on the direct port — start the stack first");
  });

  it("admin.kaptnow.com + tenant user → allowed (200, session issued)", async () => {
    const res = await loginWithHost("admin.kaptnow.com", TENANT);
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.role).toBe("primary_admin");
  });

  it("admin.kaptnow.com + platform_owner → refused, no session created", async () => {
    const before = await sessionCount(OWNER.email);
    const res = await loginWithHost("admin.kaptnow.com", OWNER);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Platform Owner access is available at elite.kaptnow.com");
    expect(res.body.token).toBeUndefined();
    expect(await sessionCount(OWNER.email)).toBe(before);
  });

  it("elite.kaptnow.com + platform_owner → allowed (200)", async () => {
    const res = await loginWithHost("elite.kaptnow.com", OWNER);
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("platform_owner");
  });

  it("elite.kaptnow.com + tenant user → refused, no session created", async () => {
    const before = await sessionCount(TENANT.email);
    const res = await loginWithHost("elite.kaptnow.com", TENANT);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Customer access is available at admin.kaptnow.com");
    expect(await sessionCount(TENANT.email)).toBe(before);
  });

  it("dev.kaptnow.com (retired) + tenant user → refused, no session, no token", async () => {
    const before = await sessionCount(TENANT.email);
    const res = await loginWithHost("dev.kaptnow.com", TENANT);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(RETIRED_REFUSAL);
    expect(res.body.token).toBeUndefined();
    expect(await sessionCount(TENANT.email)).toBe(before);
  });

  it("dev.kaptnow.com (retired) + platform_owner → refused, no session, no token", async () => {
    const before = await sessionCount(OWNER.email);
    const res = await loginWithHost("dev.kaptnow.com", OWNER);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(RETIRED_REFUSAL);
    expect(res.body.token).toBeUndefined();
    expect(await sessionCount(OWNER.email)).toBe(before);
  });

  it("localhost keeps mixed development behavior: both roles allowed", async () => {
    expect((await loginWithHost("localhost", TENANT)).status).toBe(200);
    expect((await loginWithHost("localhost", OWNER)).status).toBe(200);
  });

  it("/api/readyz is unaffected by the retired host", async () => {
    const viaDev = await requestWithHost("dev.kaptnow.com", "/api/readyz", "GET");
    const viaLocal = await requestWithHost("localhost", "/api/readyz", "GET");
    expect(viaDev.status).toBe(viaLocal.status);
    expect(viaDev.body).toEqual(viaLocal.body);
    expect(viaDev.body.checks.database).toBe("ok");
  });
});

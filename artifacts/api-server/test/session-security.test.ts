// Batch 4 — Session & token lifecycle closure.
// Proves: logout and Security-Center termination kill both access AND refresh,
// disabled users cannot refresh back in, a suspended tenant cannot mint fresh
// tokens via refresh (but recovers when re-activated), and legacy sid-less
// access tokens are no longer accepted.
import { describe, it, expect, beforeAll } from "vitest";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";

const BASE = "http://localhost:80/api";
const SECRET = process.env.SESSION_SECRET as string;
const ISSUER = "card-scanner-pro";
const PASSWORD = "SessionSec#2026!";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };

const headers = (token?: string) => ({
  "Content-Type": "application/json",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});
const post = (path: string, body: unknown, token?: string) =>
  fetch(`${BASE}${path}`, { method: "POST", headers: headers(token), body: JSON.stringify(body) });
const get = (path: string, token?: string) => fetch(`${BASE}${path}`, { headers: headers(token) });
const del = (path: string, token?: string) =>
  fetch(`${BASE}${path}`, { method: "DELETE", headers: headers(token) });

interface Creds {
  email: string;
  userId: number;
  companyId: number;
  token: string;
  refreshToken: string;
}

async function registerTenant(prefix: string): Promise<Creds> {
  const email = `${prefix}-${Date.now()}@example.test`;
  const res = await post("/auth/register", {
    email,
    password: PASSWORD,
    name: "Session Sec",
    companyName: `${prefix} Co ${Date.now()}`,
  });
  expect(res.status).toBeLessThan(300);
  const body = await res.json();
  return {
    email,
    userId: body.user.id,
    companyId: body.user.companyId,
    token: body.token,
    refreshToken: body.refreshToken,
  };
}

async function loginRaw(email: string) {
  const res = await post("/auth/login", { email, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.json();
}

let platformToken = "";

beforeAll(async () => {
  const res = await post("/auth/login", PLATFORM);
  expect(res.status).toBe(200);
  platformToken = (await res.json()).token;
}, 20000);

describe("logout kills access and refresh", () => {
  it("after logout, the old access token and refresh token are both dead", async () => {
    const u = await registerTenant("sess-logout");
    expect((await get("/auth/me", u.token)).status).toBe(200);

    expect((await post("/auth/logout", {}, u.token)).status).toBeLessThan(300);
    expect((await get("/auth/me", u.token)).status).toBe(401);
    expect((await post("/auth/refresh", { refreshToken: u.refreshToken })).status).toBe(401);
  });
});

describe("Security-Center termination", () => {
  it("terminating another session invalidates that session's access token", async () => {
    const u = await registerTenant("sess-term");
    const second = await loginRaw(u.email); // second session
    expect((await get("/auth/me", second.token)).status).toBe(200);

    const list = await get("/auth/sessions", u.token);
    expect(list.status).toBe(200);
    const sessions = (await list.json()).sessions ?? (await Promise.resolve([]));
    const other = (sessions as Array<{ id: number; current: boolean }>).find((s) => !s.current);
    expect(other).toBeDefined();

    expect((await del(`/auth/sessions/${other!.id}`, u.token)).status).toBeLessThan(300);
    expect((await get("/auth/me", second.token)).status).toBe(401);
    expect((await post("/auth/refresh", { refreshToken: second.refreshToken })).status).toBe(401);
    // The terminating session itself still works.
    expect((await get("/auth/me", u.token)).status).toBe(200);
  });
});

describe("disabled users cannot refresh back in", () => {
  it("refresh for a disabled account is rejected and the family revoked", async () => {
    const u = await registerTenant("sess-disabled");
    await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, u.userId));

    expect((await get("/auth/me", u.token)).status).toBe(401);
    expect((await post("/auth/refresh", { refreshToken: u.refreshToken })).status).toBe(401);

    // Re-enabling does not resurrect the revoked family.
    await db.update(usersTable).set({ isActive: true }).where(eq(usersTable.id, u.userId));
    expect((await post("/auth/refresh", { refreshToken: u.refreshToken })).status).toBe(401);
  });
});

describe("suspended tenant cannot mint tokens via refresh", () => {
  it("refresh is blocked while suspended and works again after re-activation", async () => {
    const u = await registerTenant("sess-suspend");

    const sus = await post(`/companies/${u.companyId}/suspend`, {}, platformToken);
    expect(sus.status).toBeLessThan(300);

    expect((await get("/auth/me", u.token)).status).toBe(403);
    const blocked = await post("/auth/refresh", { refreshToken: u.refreshToken });
    expect(blocked.status).toBe(403);

    const act = await post(`/companies/${u.companyId}/activate`, {}, platformToken);
    expect(act.status).toBeLessThan(300);

    // Suspension did NOT revoke the family — lifting it restores the session.
    const ok = await post("/auth/refresh", { refreshToken: u.refreshToken });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.token).toBeTruthy();
    expect((await get("/auth/me", body.token)).status).toBe(200);
  });
});

describe("legacy sid-less access tokens are rejected", () => {
  it("a validly-signed access token without a session id gets 401", async () => {
    const u = await registerTenant("sess-legacy");
    const legacy = jwt.sign(
      { id: u.userId, email: u.email, role: "primary_admin", companyId: u.companyId, typ: "access" },
      SECRET,
      { expiresIn: "1h", issuer: ISSUER },
    );
    const res = await get("/auth/me", legacy);
    expect(res.status).toBe(401);
  });

  it("refresh-rotated tokens carry a live session id", async () => {
    const u = await registerTenant("sess-rotated");
    const rot = await post("/auth/refresh", { refreshToken: u.refreshToken });
    expect(rot.status).toBe(200);
    const body = await rot.json();
    const decoded = jwt.decode(body.token) as { sid?: number };
    expect(typeof decoded.sid).toBe("number");
    expect((await get("/auth/me", body.token)).status).toBe(200);
  });
});

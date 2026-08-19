// Public-registration lockdown (product scope: NO public self-registration).
//
// Coverage:
//   1. production                              => disabled
//   2. production + AUTH_ENABLE_REGISTRATION=true  => STILL disabled (no override)
//   3. development default                     => enabled
//   4. development + AUTH_ENABLE_REGISTRATION=false => disabled
//   5. disabled route => 404 (indistinguishable from an unmatched path),
//      answered BEFORE validation, with zero provisioning side effects
//   6. normal dev registration stays available on BOTH mount paths
//   7. login is unaffected
//
// 1–5 run in-process (no live server needed); 6–7 hit the LIVE API at
// localhost:80 like the rest of the integration suite.
import { describe, it, expect, afterAll } from "vitest";
import express from "express";
import request from "node:http";
import { db, usersTable, companiesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { resolveEnableRegistration, config } from "../src/config.js";
import authRouter from "../src/routes/auth.js";

const BASE = "http://localhost:80/api";
const PROBE_EMAIL = "lockdown-probe@lockdown.test";

// ── 1–4: pure truth table ────────────────────────────────────────────────────
describe("resolveEnableRegistration truth table", () => {
  it("production => disabled", () => {
    expect(resolveEnableRegistration("production", undefined)).toBe(false);
  });
  it("production + AUTH_ENABLE_REGISTRATION=true => STILL disabled", () => {
    expect(resolveEnableRegistration("production", "true")).toBe(false);
  });
  it("development default => enabled", () => {
    expect(resolveEnableRegistration("development", undefined)).toBe(true);
  });
  it("development + AUTH_ENABLE_REGISTRATION=false => disabled", () => {
    expect(resolveEnableRegistration("development", "false")).toBe(false);
  });
});

// ── 5: disabled route behavior, in-process, both mount paths ────────────────
// Mirrors app.ts mounting (same router under /api/v1 and /api).
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", authRouter);
  app.use("/api", authRouter);
  return app;
}

async function post(app: express.Express, path: string, body: unknown) {
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const payload = JSON.stringify(body);
    return await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request.request(
        { host: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json" } },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
  } finally {
    server.close();
  }
}

const authConfig = config.auth as { enableRegistration: boolean };
const originalFlag = authConfig.enableRegistration;
afterAll(() => {
  authConfig.enableRegistration = originalFlag;
});

describe("disabled /auth/register answers 404 with no side effects", () => {
  const valid = { email: PROBE_EMAIL, password: "Str0ng!Passw0rd", name: "Probe", companyName: "Lockdown Probe Co" };

  it("404 on /api/auth/register and /api/v1/auth/register, even for a fully valid body", async () => {
    authConfig.enableRegistration = false;
    const app = buildApp();
    for (const path of ["/api/auth/register", "/api/v1/auth/register"]) {
      const res = await post(app, path, valid);
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body).error).toBe("Not Found");
    }
    // Zero provisioning: neither the user nor the company was created.
    const users = await db.select().from(usersTable).where(eq(usersTable.email, PROBE_EMAIL));
    expect(users).toHaveLength(0);
    const companies = await db.select().from(companiesTable).where(eq(companiesTable.name, "Lockdown Probe Co"));
    expect(companies).toHaveLength(0);
  });

  it("guard precedes validation: an INVALID body also gets 404, not 400", async () => {
    authConfig.enableRegistration = false;
    const res = await post(buildApp(), "/api/auth/register", {});
    expect(res.status).toBe(404);
  });
});

// ── 6–7: live API (dev mode — registration enabled, login untouched) ────────
describe("live dev API keeps registration and login working", () => {
  it("register route is reachable on both mounts (400 validation, not 404)", async () => {
    for (const url of [`${BASE}/auth/register`, `http://localhost:80/api/v1/auth/register`]) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400); // enabled: validation rejects, route exists
    }
  });

  it("login is unaffected", async () => {
    const res = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@techcorp.com", password: "Admin123!" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user?.role).toBe("primary_admin");
  });
});

// Batch 4 — MFA login closure.
// Proves: the password-verified challenge (mfaToken) is single-use (no replay),
// expires, cannot be used as an access or refresh token, wrong codes do not burn
// the challenge, backup codes are single-use, and company-required MFA blocks
// unenrolled users without issuing any operational token.
import { describe, it, expect, beforeAll } from "vitest";
import jwt from "jsonwebtoken";
import { generate } from "otplib";
import { and, eq, desc } from "drizzle-orm";
import { db, loginAttemptsTable } from "@workspace/db";

// Talk to the API server's own port directly and attribute a dedicated test IP
// via XFF (we are the single trusted proxy hop). This keeps the intentional
// MFA failures below out of the shared loopback login-rate-limit bucket that
// the rest of the suite fills up.
const BASE = `http://localhost:${process.env.API_DIRECT_PORT ?? "8080"}/api`;
const TEST_IP = "192.0.2.77";
const SECRET = process.env.SESSION_SECRET as string;
const ISSUER = "card-scanner-pro";
const PASSWORD = "MfaClosure#2026!";

const headers = (token?: string) => ({
  "Content-Type": "application/json",
  "X-Forwarded-For": TEST_IP,
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});
const post = (path: string, body: unknown, token?: string) =>
  fetch(`${BASE}${path}`, { method: "POST", headers: headers(token), body: JSON.stringify(body) });
const get = (path: string, token?: string) => fetch(`${BASE}${path}`, { headers: headers(token) });

const totp = (secret: string) => generate({ secret, strategy: "totp" });

let email = "";
let userId = 0;
let mfaSecret = "";
let backupCodes: string[] = [];

async function loginChallenge(): Promise<string> {
  const res = await post("/auth/login", { email, password: PASSWORD });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.mfaRequired).toBe(true);
  expect(body.mfaToken).toBeTruthy();
  expect(body.token).toBeUndefined();
  expect(body.refreshToken).toBeUndefined();
  return body.mfaToken as string;
}

beforeAll(async () => {
  // Fresh, isolated tenant so MFA state never touches seeded demo accounts.
  email = `mfa-closure-${Date.now()}@example.test`;
  const reg = await post("/auth/register", {
    email,
    password: PASSWORD,
    name: "MFA Closure",
    companyName: `MFA Closure Co ${Date.now()}`,
  });
  expect(reg.status).toBeLessThan(300);
  const regBody = await reg.json();
  userId = regBody.user.id;
  const token = regBody.token as string;

  // Enroll TOTP via the real API flow.
  const setup = await post("/auth/mfa/setup", {}, token);
  expect(setup.status).toBe(200);
  mfaSecret = (await setup.json()).secret;
  const enable = await post("/auth/mfa/enable", { code: await totp(mfaSecret) }, token);
  expect(enable.status).toBe(200);
  backupCodes = (await enable.json()).backupCodes;
  expect(backupCodes.length).toBeGreaterThan(0);
}, 30000);

describe("challenge token is not an operational token", () => {
  it("mfaToken is rejected as a Bearer access token", async () => {
    const mfaToken = await loginChallenge();
    expect((await get("/auth/me", mfaToken)).status).toBe(401);
    expect((await get("/contacts", mfaToken)).status).toBe(401);
  });

  it("mfaToken is rejected as a refresh token", async () => {
    const mfaToken = await loginChallenge();
    const res = await post("/auth/refresh", { refreshToken: mfaToken });
    expect(res.status).toBe(401);
  });
});

describe("challenge verification", () => {
  it("wrong code fails (and is recorded) without burning the challenge; valid code then succeeds", async () => {
    const mfaToken = await loginChallenge();

    const bad = await post("/auth/mfa/verify-login", { mfaToken, code: "000000" });
    expect(bad.status).toBe(401);
    const [attempt] = await db
      .select()
      .from(loginAttemptsTable)
      .where(and(eq(loginAttemptsTable.userId, userId), eq(loginAttemptsTable.reason, "mfa_failed")))
      .orderBy(desc(loginAttemptsTable.id))
      .limit(1);
    expect(attempt).toBeDefined();

    const ok = await post("/auth/mfa/verify-login", { mfaToken, code: await totp(mfaSecret) });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.token).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
  });

  it("a consumed challenge cannot be replayed, even with a fresh valid code", async () => {
    const mfaToken = await loginChallenge();
    const first = await post("/auth/mfa/verify-login", { mfaToken, code: await totp(mfaSecret) });
    expect(first.status).toBe(200);

    const replay = await post("/auth/mfa/verify-login", { mfaToken, code: await totp(mfaSecret) });
    expect(replay.status).toBe(401);

    const [attempt] = await db
      .select()
      .from(loginAttemptsTable)
      .where(and(eq(loginAttemptsTable.userId, userId), eq(loginAttemptsTable.reason, "mfa_challenge_replayed")))
      .orderBy(desc(loginAttemptsTable.id))
      .limit(1);
    expect(attempt).toBeDefined();
  });

  it("an expired challenge is rejected", async () => {
    const expired = jwt.sign({ uid: userId, jti: "expired-jti", typ: "mfa" }, SECRET, {
      expiresIn: "-10s",
      issuer: ISSUER,
    });
    const res = await post("/auth/mfa/verify-login", { mfaToken: expired, code: await totp(mfaSecret) });
    expect(res.status).toBe(401);
  });

  it("a forged challenge with an unknown jti is rejected even with a valid code", async () => {
    const forged = jwt.sign({ uid: userId, jti: `forged-${Date.now()}`, typ: "mfa" }, SECRET, {
      expiresIn: "5m",
      issuer: ISSUER,
    });
    const res = await post("/auth/mfa/verify-login", { mfaToken: forged, code: await totp(mfaSecret) });
    expect(res.status).toBe(401);
  });

  it("a legacy-format challenge without a jti is rejected", async () => {
    const legacy = jwt.sign({ uid: userId, typ: "mfa" }, SECRET, { expiresIn: "5m", issuer: ISSUER });
    const res = await post("/auth/mfa/verify-login", { mfaToken: legacy, code: await totp(mfaSecret) });
    expect(res.status).toBe(401);
  });

  it("backup codes work exactly once", async () => {
    const code = backupCodes.pop()!;
    const t1 = await loginChallenge();
    const ok = await post("/auth/mfa/verify-login", { mfaToken: t1, code });
    expect(ok.status).toBe(200);

    const t2 = await loginChallenge();
    const reuse = await post("/auth/mfa/verify-login", { mfaToken: t2, code });
    expect(reuse.status).toBe(401);
  });
});

describe("company-required MFA blocks unenrolled users", () => {
  it("returns mfaEnrollmentRequired with no operational token", async () => {
    const email2 = `mfa-policy-${Date.now()}@example.test`;
    const reg = await post("/auth/register", {
      email: email2,
      password: PASSWORD,
      name: "MFA Policy",
      companyName: `MFA Policy Co ${Date.now()}`,
    });
    expect(reg.status).toBeLessThan(300);
    const token = (await reg.json()).token as string;

    const pol = await fetch(`${BASE}/security/policy`, {
      method: "PATCH",
      headers: headers(token),
      body: JSON.stringify({ mfaRequired: true }),
    });
    expect(pol.status).toBe(200);

    const res = await post("/auth/login", { email: email2, password: PASSWORD });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mfaRequired).toBe(true);
    expect(body.mfaEnrollmentRequired).toBe(true);
    expect(body.token).toBeUndefined();
    expect(body.refreshToken).toBeUndefined();

    // The enrollment-required challenge cannot be verified into a session either
    // (the account has no TOTP secret yet).
    const verify = await post("/auth/mfa/verify-login", { mfaToken: body.mfaToken, code: "123456" });
    expect(verify.status).toBe(401);
  });
});

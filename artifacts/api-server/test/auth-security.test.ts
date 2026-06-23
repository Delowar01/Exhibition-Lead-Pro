import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, like } from "drizzle-orm";
import {
  db,
  usersTable,
  companiesTable,
  sessionsTable,
  mfaBackupCodesTable,
  trustedDevicesTable,
  loginAttemptsTable,
} from "@workspace/db";
import { generate as otpGenerate } from "otplib";

const BASE = "http://localhost:80/api";

const TECHCORP = { email: "admin@techcorp.com", password: "Admin123!" };
const INNOVATECH = { email: "admin@innovatech.es", password: "Admin123!" };

const LOCKOUT_EMAIL = `lockout-${Date.now()}@example.invalid`;

async function rawLogin(creds: { email: string; password: string }, extra: Record<string, unknown> = {}) {
  return fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...creds, ...extra }),
  });
}

async function loginJson(creds: { email: string; password: string }, extra: Record<string, unknown> = {}) {
  const res = await rawLogin(creds, extra);
  if (!res.ok) throw new Error(`login failed for ${creds.email}: ${res.status}`);
  return res.json();
}

function authHeaders(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

async function totp(secret: string): Promise<string> {
  return otpGenerate({ secret, strategy: "totp" });
}

beforeAll(async () => {
  let health: Response;
  try {
    health = await fetch(`${BASE}/healthz`);
  } catch (err) {
    throw new Error(`API not reachable at ${BASE} — is the api-server workflow running? (${String(err)})`);
  }
  if (!health.ok) throw new Error(`API health check failed: ${health.status}`);
});

describe("rotating refresh tokens + server-side sessions", () => {
  it("login issues an access token plus a refresh token", async () => {
    const body = await loginJson(TECHCORP);
    expect(typeof body.token).toBe("string");
    expect(typeof body.refreshToken).toBe("string");
    expect(body.user?.email).toBe(TECHCORP.email);
    // Access token carries a session id (3-part JWT).
    expect(body.token.split(".").length).toBe(3);
  });

  it("refresh rotates the refresh token and rejects reuse of the old one", async () => {
    const { refreshToken: rt1 } = await loginJson(TECHCORP);

    const first = await fetch(`${BASE}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: rt1 }),
    });
    expect(first.status).toBe(200);
    const rotated = await first.json();
    expect(typeof rotated.token).toBe("string");
    expect(typeof rotated.refreshToken).toBe("string");
    expect(rotated.refreshToken).not.toBe(rt1);

    // Reusing the now-rotated old token must be rejected (replay detection).
    const reuse = await fetch(`${BASE}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: rt1 }),
    });
    expect(reuse.status).toBe(401);

    // Replay detection revokes the whole family, so the newest token also dies.
    const familyRevoked = await fetch(`${BASE}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: rotated.refreshToken }),
    });
    expect(familyRevoked.status).toBe(401);
  });

  it("lists sessions and terminating others immediately invalidates that device", async () => {
    const a = await loginJson(TECHCORP);
    const b = await loginJson(TECHCORP);

    // Device A sees at least its own + device B's session, exactly one current.
    const listRes = await fetch(`${BASE}/auth/sessions`, { headers: authHeaders(a.token) });
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(Array.isArray(list.sessions)).toBe(true);
    expect(list.sessions.length).toBeGreaterThanOrEqual(2);
    expect(list.sessions.filter((s: { current: boolean }) => s.current).length).toBe(1);

    // Device B's token works before termination.
    const beforeMe = await fetch(`${BASE}/auth/me`, { headers: authHeaders(b.token) });
    expect(beforeMe.status).toBe(200);

    // Terminate all other sessions from device A.
    const termRes = await fetch(`${BASE}/auth/sessions`, {
      method: "DELETE",
      headers: authHeaders(a.token),
    });
    expect(termRes.status).toBe(200);
    const term = await termRes.json();
    expect(term.terminated).toBeGreaterThanOrEqual(1);

    // Device B is now invalid even though its JWT has not expired.
    const afterMe = await fetch(`${BASE}/auth/me`, { headers: authHeaders(b.token) });
    expect(afterMe.status).toBe(401);

    // Device A still works and can terminate a specific session id.
    const aStillOk = await fetch(`${BASE}/auth/me`, { headers: authHeaders(a.token) });
    expect(aStillOk.status).toBe(200);
  });
});

describe("brute-force lockout", () => {
  it("locks further attempts after repeated failures for the same email", async () => {
    let sawLock = false;
    for (let i = 0; i < 7; i++) {
      const res = await rawLogin({ email: LOCKOUT_EMAIL, password: "wrong-password" });
      if (res.status === 429) {
        sawLock = true;
        break;
      }
      expect(res.status).toBe(401);
    }
    expect(sawLock).toBe(true);
  });
});

describe("MFA enrollment, challenge, and recovery", () => {
  let token = "";

  afterAll(async () => {
    // Guarantee the demo account is restored regardless of test outcome.
    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, INNOVATECH.email)).limit(1);
    if (user) {
      await db
        .update(usersTable)
        .set({ mfaEnabled: false, mfaSecret: null, mfaEnrolledAt: null })
        .where(eq(usersTable.id, user.id));
      await db.delete(mfaBackupCodesTable).where(eq(mfaBackupCodesTable.userId, user.id));
      await db.delete(trustedDevicesTable).where(eq(trustedDevicesTable.userId, user.id));
      await db.delete(sessionsTable).where(eq(sessionsTable.userId, user.id));
    }
    await db.delete(loginAttemptsTable).where(like(loginAttemptsTable.email, "lockout-%@example.invalid"));
  });

  it("enrolls, challenges on next login, and verifies via TOTP and a backup code", async () => {
    const loggedIn = await loginJson(INNOVATECH);
    token = loggedIn.token;

    // Begin enrollment — obtain the shared secret + QR payload.
    const setupRes = await fetch(`${BASE}/auth/mfa/setup`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(setupRes.status).toBe(200);
    const setup = await setupRes.json();
    expect(typeof setup.secret).toBe("string");
    expect(setup.qrDataUrl).toMatch(/^data:image\/png;base64,/);

    // Confirm enrollment with a generated code; receive backup codes.
    const enableRes = await fetch(`${BASE}/auth/mfa/enable`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ code: await totp(setup.secret) }),
    });
    expect(enableRes.status).toBe(200);
    const enabled = await enableRes.json();
    expect(Array.isArray(enabled.backupCodes)).toBe(true);
    expect(enabled.backupCodes.length).toBeGreaterThan(0);
    const backupCodes: string[] = enabled.backupCodes;

    // Status now reports enabled.
    const statusRes = await fetch(`${BASE}/auth/mfa/status`, { headers: authHeaders(token) });
    const status = await statusRes.json();
    expect(status.enabled).toBe(true);

    // A fresh login is now gated behind the second factor.
    const challenge = await loginJson(INNOVATECH);
    expect(challenge.mfaRequired).toBe(true);
    expect(typeof challenge.mfaToken).toBe("string");
    expect(challenge.token).toBeUndefined();

    // Complete the challenge with a TOTP code.
    const verifyRes = await fetch(`${BASE}/auth/mfa/verify-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mfaToken: challenge.mfaToken, code: await totp(setup.secret) }),
    });
    expect(verifyRes.status).toBe(200);
    const verified = await verifyRes.json();
    expect(typeof verified.token).toBe("string");
    expect(verified.user?.email).toBe(INNOVATECH.email);

    // A backup code also satisfies the challenge (single-use recovery path).
    const challenge2 = await loginJson(INNOVATECH);
    const backupRes = await fetch(`${BASE}/auth/mfa/verify-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mfaToken: challenge2.mfaToken, code: backupCodes[0] }),
    });
    expect(backupRes.status).toBe(200);

    // The same backup code cannot be reused.
    const challenge3 = await loginJson(INNOVATECH);
    const reuseBackup = await fetch(`${BASE}/auth/mfa/verify-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mfaToken: challenge3.mfaToken, code: backupCodes[0] }),
    });
    expect(reuseBackup.status).toBe(401);

    // Disable MFA with the account password.
    const disableRes = await fetch(`${BASE}/auth/mfa/disable`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ password: INNOVATECH.password }),
    });
    expect(disableRes.status).toBe(200);

    const finalStatus = await fetch(`${BASE}/auth/mfa/status`, { headers: authHeaders(token) });
    expect((await finalStatus.json()).enabled).toBe(false);
  });
});

describe("company-mandated MFA policy", () => {
  it("blocks operational token issuance when the company requires MFA and the user is not enrolled", async () => {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, INNOVATECH.email)).limit(1);
    expect(user).toBeTruthy();
    expect(user.companyId).toBeTruthy();

    // Ensure a clean baseline: user not enrolled, then flip the company policy on.
    await db
      .update(usersTable)
      .set({ mfaEnabled: false, mfaSecret: null, mfaEnrolledAt: null })
      .where(eq(usersTable.id, user.id));
    await db.update(companiesTable).set({ mfaRequired: true }).where(eq(companiesTable.id, user.companyId!));

    try {
      const res = await rawLogin(INNOVATECH);
      expect(res.status).toBe(200);
      const body = await res.json();
      // Correct password, but no operational session may be issued.
      expect(body.mfaEnrollmentRequired).toBe(true);
      expect(body.token).toBeUndefined();
      expect(body.refreshToken).toBeUndefined();
    } finally {
      await db.update(companiesTable).set({ mfaRequired: false }).where(eq(companiesTable.id, user.companyId!));
    }
  });
});

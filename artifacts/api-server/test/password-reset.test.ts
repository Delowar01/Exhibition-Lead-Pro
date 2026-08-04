import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, isNull, like } from "drizzle-orm";
import { db, usersTable, sessionsTable, verificationTokensTable, auditLogsTable } from "@workspace/db";
import { hashPassword } from "../src/lib/auth.js";
import { sha256, randomToken } from "../src/lib/crypto.js";

// Batch 3 — Password-reset flow, end to end against the live dev server.
// Deterministic strategy: raw tokens are generated inside the test and their
// SHA-256 hashes inserted directly into verification_tokens (only hashes are ever
// stored by the app, so email capture is not needed).

const BASE = "http://localhost:80/api";
const RUN = Date.now();
const EMAIL = `pw-reset-${RUN}@example.invalid`;
const OLD_PASSWORD = "OldPassw0rd!";
const NEW_PASSWORD = "NewPassw0rd!9";
const COMPANY_ID = 2; // seeded TechCorp tenant

let userId = 0;

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function login(email: string, password: string) {
  return post("/auth/login", { email, password });
}

async function insertResetToken(raw: string, expiresAt: Date) {
  await db.insert(verificationTokensTable).values({
    userId,
    type: "password_reset",
    tokenHash: sha256(raw),
    expiresAt,
  });
}

beforeAll(async () => {
  const [u] = await db
    .insert(usersTable)
    .values({
      email: EMAIL,
      passwordHash: hashPassword(OLD_PASSWORD),
      name: "PW Reset Test User",
      role: "employee",
      companyId: COMPANY_ID,
      isActive: true,
      emailVerifiedAt: new Date(),
    })
    .returning();
  userId = u.id;
});

afterAll(async () => {
  if (userId) {
    await db.delete(sessionsTable).where(eq(sessionsTable.userId, userId));
    await db.delete(verificationTokensTable).where(eq(verificationTokensTable.userId, userId));
    await db.delete(auditLogsTable).where(eq(auditLogsTable.userId, userId));
    await db.delete(usersTable).where(eq(usersTable.id, userId));
  }
  await db.delete(usersTable).where(like(usersTable.email, `pw-reset-%@example.invalid`));
});

describe("POST /auth/forgot-password", () => {
  it("returns the same generic 200 for unknown and known emails (no enumeration)", async () => {
    const unknown = await post("/auth/forgot-password", { email: `nobody-${RUN}@example.invalid` });
    const known = await post("/auth/forgot-password", { email: EMAIL });
    expect(unknown.status).toBe(200);
    expect(known.status).toBe(200);
    const a = await unknown.json();
    const b = await known.json();
    expect(a).toEqual(b);
  });

  it("issues a live token for a real account and invalidates prior ones on re-request", async () => {
    const first = await db
      .select()
      .from(verificationTokensTable)
      .where(and(eq(verificationTokensTable.userId, userId), eq(verificationTokensTable.type, "password_reset")));
    expect(first.length).toBeGreaterThanOrEqual(1);

    const res = await post("/auth/forgot-password", { email: EMAIL });
    expect(res.status).toBe(200);

    const rows = await db
      .select()
      .from(verificationTokensTable)
      .where(and(eq(verificationTokensTable.userId, userId), eq(verificationTokensTable.type, "password_reset")));
    const live = rows.filter((r) => r.usedAt === null && r.expiresAt.getTime() > Date.now());
    expect(live.length).toBe(1); // exactly one live token at any time
    // Raw token is never stored — only a 64-char hex hash.
    expect(live[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rate limits repeated requests for the same target email", async () => {
    const target = `pw-reset-ratelimit-${RUN}@example.invalid`;
    let got429 = false;
    for (let i = 0; i < 8 && !got429; i++) {
      const res = await post("/auth/forgot-password", { email: target });
      if (res.status === 429) got429 = true;
      else expect(res.status).toBe(200);
    }
    expect(got429).toBe(true);
  });
});

describe("POST /auth/reset-password", () => {
  it("rejects a garbage token", async () => {
    const res = await post("/auth/reset-password", { token: randomToken(32), newPassword: NEW_PASSWORD });
    expect(res.status).toBe(400);
  });

  it("rejects missing fields", async () => {
    const res = await post("/auth/reset-password", { token: "" });
    expect(res.status).toBe(400);
  });

  it("rejects an expired token", async () => {
    const raw = randomToken(32);
    await insertResetToken(raw, new Date(Date.now() - 60_000));
    const res = await post("/auth/reset-password", { token: raw, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(400);
  });

  it("rejects a weak password without consuming the token", async () => {
    const raw = randomToken(32);
    await insertResetToken(raw, new Date(Date.now() + 30 * 60_000));
    const weak = await post("/auth/reset-password", { token: raw, newPassword: "short" });
    expect(weak.status).toBe(400);
    // Token must still be live after the failed attempt.
    const [row] = await db
      .select()
      .from(verificationTokensTable)
      .where(eq(verificationTokensTable.tokenHash, sha256(raw)));
    expect(row.usedAt).toBeNull();
    // Clean up this extra live token so later tests control their own state.
    await db
      .update(verificationTokensTable)
      .set({ usedAt: new Date() })
      .where(eq(verificationTokensTable.tokenHash, sha256(raw)));
  });

  it("resets the password, revokes sessions, is single-use, and writes an audit entry", async () => {
    // Establish a session with the old password first.
    const before = await login(EMAIL, OLD_PASSWORD);
    expect(before.status).toBe(200);
    const { token: oldAccessToken } = await before.json();

    const raw = randomToken(32);
    await insertResetToken(raw, new Date(Date.now() + 30 * 60_000));

    const res = await post("/auth/reset-password", { token: raw, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);

    // Old password no longer works; new one does.
    expect((await login(EMAIL, OLD_PASSWORD)).status).toBe(401);
    expect((await login(EMAIL, NEW_PASSWORD)).status).toBe(200);

    // The pre-reset session is revoked.
    const me = await fetch(`${BASE}/auth/me`, { headers: { Authorization: `Bearer ${oldAccessToken}` } });
    expect(me.status).toBe(401);

    // Single use: replaying the same token fails.
    const replay = await post("/auth/reset-password", { token: raw, newPassword: "AnotherPassw0rd!7" });
    expect(replay.status).toBe(400);
    // ...and the password was NOT changed by the replay.
    expect((await login(EMAIL, NEW_PASSWORD)).status).toBe(200);

    // Audit entry for the completed reset.
    const audits = await db
      .select()
      .from(auditLogsTable)
      .where(and(eq(auditLogsTable.userId, userId), eq(auditLogsTable.action, "user.password_reset")));
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });
});

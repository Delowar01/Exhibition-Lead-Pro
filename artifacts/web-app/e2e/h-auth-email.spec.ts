import { createHash, randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { ADMIN, API_BASE, RUN_TAG } from "./fixtures/seed-values";

/**
 * Batch H — Email-driven auth flows through the real browser UI:
 * forgot-password, reset-password (valid + invalid link), and invitation
 * accept (valid + invalid link).
 *
 * Deterministic strategy: the app only ever stores SHA-256 hashes of tokens, so
 * the spec generates raw tokens itself and writes their hashes straight into the
 * DB (reset) or overwrites the invitation's tokenHash (invite). No email capture
 * or SMTP dependency.
 */

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const rawToken = () => randomBytes(24).toString("hex");

const RESET_EMAIL = `${RUN_TAG.toLowerCase()}.h-reset@example.test`;
const INVITE_EMAIL = `${RUN_TAG.toLowerCase()}.h-invite@example.test`;
const OLD_PASSWORD = "OldPassw0rd!5";
const NEW_PASSWORD = "NewPassw0rd!5";
const INVITE_PASSWORD = "InvitePassw0rd!5";

let pg: Client;
let adminToken = "";
let resetUserId = 0;
let invitationId = 0;
const resetToken = rawToken();
const inviteToken = rawToken();

async function apiLogin(email: string, password: string) {
  return fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();

  const login = await apiLogin(ADMIN.email, ADMIN.password);
  expect(login.ok).toBeTruthy();
  adminToken = (await login.json()).token;

  // Seed the reset-target user through the real management API (known password).
  const createUser = await fetch(`${API_BASE}/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ email: RESET_EMAIL, password: OLD_PASSWORD, name: `${RUN_TAG} H Reset`, role: "employee" }),
  });
  expect(createUser.status, await createUser.clone().text()).toBeLessThan(300);
  const createdUser = await createUser.json();
  resetUserId = createdUser.user?.id ?? createdUser.id;

  // Seed a live reset token (hash only, like the app does).
  await pg.query(
    `INSERT INTO verification_tokens (user_id, type, token_hash, expires_at) VALUES ($1, 'password_reset', $2, NOW() + INTERVAL '30 minutes')`,
    [resetUserId, sha256(resetToken)],
  );

  // Seed an invitation through the real API, then pin its token to a known raw value.
  const createInv = await fetch(`${API_BASE}/invitations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ email: INVITE_EMAIL, name: null, role: "employee", companyId: null }),
  });
  expect(createInv.status, await createInv.clone().text()).toBe(201);
  invitationId = (await createInv.json()).invitation.id;
  await pg.query(`UPDATE invitations SET token_hash = $1 WHERE id = $2`, [sha256(inviteToken), invitationId]);
});

test.afterAll(async () => {
  try {
    for (const email of [RESET_EMAIL, INVITE_EMAIL]) {
      const res = await pg.query(`SELECT id FROM users WHERE email = $1`, [email]);
      for (const row of res.rows) {
        await pg.query(`DELETE FROM sessions WHERE user_id = $1`, [row.id]);
        await pg.query(`DELETE FROM user_roles WHERE user_id = $1`, [row.id]);
        await pg.query(`DELETE FROM verification_tokens WHERE user_id = $1`, [row.id]);
        await pg.query(`DELETE FROM audit_logs WHERE user_id = $1`, [row.id]);
        await pg.query(`DELETE FROM users WHERE id = $1`, [row.id]);
      }
    }
    if (invitationId) await pg.query(`DELETE FROM invitations WHERE id = $1`, [invitationId]);
  } finally {
    await pg.end();
  }
});

test("forgot-password page always shows the generic confirmation", async ({ page }) => {
  await page.goto("/forgot-password");
  await expect(page.getByRole("heading", { name: "Forgot your password?" })).toBeVisible();
  // NOTE: deliberately NOT the seeded reset user — a real forgot-password request
  // invalidates that user's outstanding tokens (correct app behavior), which would
  // kill the token seeded for the next test.
  await page.getByLabel("Work Email").fill(`nobody.${RUN_TAG.toLowerCase()}@example.test`);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
});

test("reset-password link sets a new password end to end", async ({ page }) => {
  await page.goto(`/reset-password?token=${resetToken}`);
  await expect(page.getByRole("heading", { name: "Set a new password" })).toBeVisible();
  await page.getByLabel("New Password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel("Confirm Password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.getByRole("heading", { name: "Password reset" })).toBeVisible();

  // The credential change is real: old password dead, new one works.
  expect((await apiLogin(RESET_EMAIL, OLD_PASSWORD)).status).toBe(401);
  expect((await apiLogin(RESET_EMAIL, NEW_PASSWORD)).status).toBe(200);
});

test("an invalid reset link is rejected with a clear error", async ({ page }) => {
  await page.goto(`/reset-password?token=${rawToken()}`);
  await page.getByLabel("New Password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel("Confirm Password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.getByText("Could not reset password", { exact: true })).toBeVisible();
});

test("a reset link without a token shows the invalid-link view", async ({ page }) => {
  await page.goto("/reset-password");
  await expect(page.getByRole("heading", { name: "Invalid link" })).toBeVisible();
});

test("invitation accept creates the account through the UI", async ({ page }) => {
  await page.goto(`/accept-invite/${inviteToken}`);
  await expect(page.getByRole("heading", { name: "You're invited" })).toBeVisible();
  await expect(page.getByText(INVITE_EMAIL)).toBeVisible();
  await page.getByLabel("Your Name").fill(`${RUN_TAG} H Invitee`);
  await page.getByLabel("Password", { exact: true }).fill(INVITE_PASSWORD);
  await page.getByLabel("Confirm Password", { exact: true }).fill(INVITE_PASSWORD);
  await page.getByRole("button", { name: "Accept & create account" }).click();
  await expect(page.getByRole("heading", { name: "Welcome aboard!" })).toBeVisible();

  // The invited user can actually sign in.
  expect((await apiLogin(INVITE_EMAIL, INVITE_PASSWORD)).status).toBe(200);
});

test("a used or invalid invitation link shows the unavailable view", async ({ page }) => {
  // Unknown token → unavailable.
  await page.goto(`/accept-invite/${rawToken()}`);
  await expect(page.getByRole("heading", { name: "Invitation unavailable" })).toBeVisible();

  // The just-used token is no longer pending → "no longer active".
  await page.goto(`/accept-invite/${inviteToken}`);
  await expect(page.getByRole("heading", { name: "Invitation no longer active" })).toBeVisible();
});

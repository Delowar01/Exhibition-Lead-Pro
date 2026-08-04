import { createHmac } from "node:crypto";
import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { ADMIN, API_BASE, RUN_TAG } from "./fixtures/seed-values";

/**
 * Batch I — Security closure through the real browser UI:
 * MFA challenge step on login (wrong code, then valid TOTP), and
 * server-side session revocation kicking the browser back to login.
 *
 * Deterministic strategy: the MFA user is enrolled through the real API
 * (setup → enable) using a locally computed TOTP — no authenticator app,
 * no third-party TOTP dependency.
 */

const MFA_EMAIL = `${RUN_TAG.toLowerCase()}.i-mfa@example.test`;
const PLAIN_EMAIL = `${RUN_TAG.toLowerCase()}.i-plain@example.test`;
const PASSWORD = "SecClosure!5x";

// --- Minimal RFC 6238 TOTP (SHA-1, 6 digits, 30s step) ---------------------
function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totp(secret: string, at = Date.now()): string {
  const counter = Math.floor(at / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString();
  return code.padStart(6, "0");
}
// ---------------------------------------------------------------------------

let pg: Client;
let adminToken = "";
let mfaSecret = "";
let backupCodes: string[] = [];

async function api(path: string, body: unknown, token?: string) {
  return fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();

  const login = await api("/auth/login", ADMIN);
  expect(login.ok).toBeTruthy();
  adminToken = (await login.json()).token;

  // Seed both users through the real management API.
  for (const email of [MFA_EMAIL, PLAIN_EMAIL]) {
    const res = await api("/users", { email, password: PASSWORD, name: `${RUN_TAG} I Sec`, role: "employee" }, adminToken);
    expect(res.status, await res.clone().text()).toBeLessThan(300);
  }

  // Enroll the MFA user via the real setup → enable flow.
  const userLogin = await api("/auth/login", { email: MFA_EMAIL, password: PASSWORD });
  expect(userLogin.ok).toBeTruthy();
  const userToken = (await userLogin.json()).token;
  const setup = await api("/auth/mfa/setup", {}, userToken);
  expect(setup.ok).toBeTruthy();
  mfaSecret = (await setup.json()).secret;
  const enable = await api("/auth/mfa/enable", { code: totp(mfaSecret) }, userToken);
  expect(enable.ok, await enable.clone().text()).toBeTruthy();
  backupCodes = (await enable.json()).backupCodes;
});

test.afterAll(async () => {
  try {
    for (const email of [MFA_EMAIL, PLAIN_EMAIL]) {
      const res = await pg.query(`SELECT id FROM users WHERE email = $1`, [email]);
      for (const row of res.rows) {
        await pg.query(`DELETE FROM sessions WHERE user_id = $1`, [row.id]);
        await pg.query(`DELETE FROM user_roles WHERE user_id = $1`, [row.id]);
        await pg.query(`DELETE FROM verification_tokens WHERE user_id = $1`, [row.id]);
        await pg.query(`DELETE FROM mfa_backup_codes WHERE user_id = $1`, [row.id]);
        await pg.query(`DELETE FROM login_attempts WHERE user_id = $1`, [row.id]);
        await pg.query(`DELETE FROM trusted_devices WHERE user_id = $1`, [row.id]);
        await pg.query(`DELETE FROM audit_logs WHERE user_id = $1`, [row.id]);
        await pg.query(`DELETE FROM users WHERE id = $1`, [row.id]);
      }
    }
  } finally {
    await pg.end();
  }
});

test("MFA login: wrong code fails, valid TOTP completes sign-in", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Work Email").fill(MFA_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  // Password alone does NOT sign in — the challenge step appears.
  await expect(page.getByRole("heading", { name: "Two-factor authentication" })).toBeVisible();

  await page.getByLabel("Verification code").fill("000000");
  await page.getByRole("button", { name: "Verify & sign in" }).click();
  await expect(page.getByText("Verification failed", { exact: true })).toBeVisible();

  // The same challenge is still usable after a wrong code.
  await page.getByLabel("Verification code").fill(totp(mfaSecret));
  await page.getByRole("button", { name: "Verify & sign in" }).click();
  await expect(page).toHaveURL(/\/admin/);
});

test("MFA login: a backup code also completes sign-in", async ({ page }) => {
  const code = backupCodes[0];
  expect(code).toBeTruthy();
  await page.goto("/login");
  await page.getByLabel("Work Email").fill(MFA_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Two-factor authentication" })).toBeVisible();

  await page.getByLabel("Verification code").fill(code);
  await page.getByRole("button", { name: "Verify & sign in" }).click();
  await expect(page).toHaveURL(/\/admin/);
});

test("server-side session revocation kicks the browser back to login", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Work Email").fill(PLAIN_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin/);

  // Revoke every session for this user server-side (Security-Center semantics).
  await pg.query(
    `UPDATE sessions SET revoked_at = NOW() WHERE user_id = (SELECT id FROM users WHERE email = $1) AND revoked_at IS NULL`,
    [PLAIN_EMAIL],
  );

  // On the next full load the dead session cannot re-authenticate.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible({ timeout: 15000 });
  await expect(page).toHaveURL(/\/login/);
});

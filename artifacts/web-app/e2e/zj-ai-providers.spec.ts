import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/workspace";
import { API_BASE, RUN_TAG } from "./fixtures/seed-values";

/**
 * ZJ. Platform Owner → Settings → AI Providers.
 *
 * Runs against the local stack, where NO AI provider has a key: nothing in this file can
 * reach Claude or Gemini. Where a provider has to look ready, the policy is given a
 * deterministic test model through the API (offered outside production only). The API is
 * the oracle for what is stored; the browser is checked for what is shown and what is sent.
 *
 *   • both providers are shown with their honest readiness — no key on the server — the
 *     model prices, and what serves requests; the page has no field for a key;
 *   • a harmless change is saved at once and is still there after a reload;
 *   • a change that affects AI availability (primary, a disabled provider, both disabled,
 *     a spending limit) opens a confirmation showing the server's reasons — cancelling
 *     changes nothing, applying takes effect without a deployment;
 *   • a spending limit typed in dollars is stored exactly, and a mistyped one is refused
 *     in the page before anything is sent;
 *   • month-to-date usage and cost are the ledger's own figures;
 *   • a company can be pinned to a provider and unpinned;
 *   • a save never overwrites a change someone else made meanwhile;
 *   • a database without the settings storage is shown read-only;
 *   • the tenant's AI Settings shows the provider the platform chose, without a selector;
 *   • a tenant administrator reaches neither the page nor its API;
 *   • the page fits a tablet, a phone and the dark theme.
 *
 * Set AI_SHOTS_DIR to an existing directory to also save screenshots (off by default).
 * afterAll puts back the policy this file found — or the shipped default, if what it found
 * carried test models (the leftover of an interrupted run).
 */

const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const TENANT_DEMO = { email: "admin@techcorp.com", password: "Admin123!" };
const SHOTS = process.env.AI_SHOTS_DIR;
const LEDGER_TAG = `e2e-zj-${RUN_TAG.toLowerCase()}`;

type Provider = "anthropic" | "gemini";
interface Policy {
  primary: Provider;
  fallbackEnabled: boolean;
  alertThresholdPct: number;
  providers: Record<Provider, { enabled: boolean; model: string; monthlyLimitMicroUsd: number | null }>;
  tenantOverrides: Array<{ companyId: number; provider: Provider; model: string | null }>;
}
type Auth = { token: string; user: { id: number; companyId: number | null; email: string } };

let platform: Auth;
let tenant: Auth;
let pg: Client;
let original: Policy;
let demoCompanyName = "";

test.describe.configure({ mode: "serial" });

async function api(method: string, p: string, body?: unknown, token: string | null = null) {
  const res = await fetch(`${API_BASE}${p}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text };
}
async function login(email: string, password: string): Promise<Auth> {
  const res = await api("POST", "/auth/login", { email, password });
  expect(res.status, res.text).toBe(200);
  return { token: res.json.token, user: res.json.user };
}
async function seedAs(page: Page, auth: Auth, theme: "light" | "dark" = "light") {
  await page.addInitScript(
    ([t, u, cid, userId, th]) => {
      try {
        localStorage.setItem("csp_token", t as string);
        localStorage.setItem("csp_user", u as string);
        if (cid) localStorage.setItem("csp_company_id", cid as string);
        localStorage.setItem("csp_theme", th as string);
        localStorage.setItem(`csp_theme:u${userId}c${cid}`, th as string);
      } catch {
        /* storage unavailable */
      }
    },
    [auth.token, JSON.stringify(auth.user), String(auth.user.companyId ?? ""), String(auth.user.id), theme] as const,
  );
}
function trackConsole(page: Page): string[] {
  const errors: string[] = [];
  const noise = (s: string) => /fonts\.googleapis|fonts\.gstatic|ERR_CERT_AUTHORITY_INVALID|Failed to load resource/.test(s);
  page.on("console", (m) => {
    if (m.type() === "error" && !noise(m.text()) && !noise(m.location()?.url ?? "")) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function status() {
  const res = await api("GET", "/platform/ai/providers", undefined, platform.token);
  expect(res.status, res.text).toBe(200);
  return res.json;
}
function plain(s: any): Policy {
  return {
    primary: s.policy.primary,
    fallbackEnabled: s.policy.fallbackEnabled,
    alertThresholdPct: s.policy.alertThresholdPct,
    providers: { anthropic: { ...s.policy.providers.anthropic }, gemini: { ...s.policy.providers.gemini } },
    tenantOverrides: s.policy.tenantOverrides.map((o: any) => ({ companyId: o.companyId, provider: o.provider, model: o.model })),
  };
}
async function setPolicy(policy: Policy) {
  const current = await status();
  const res = await api("PUT", "/platform/ai/providers", { policy, expectedVersion: current.version, confirm: true }, platform.token);
  expect(res.status, res.text).toBe(200);
  return res.json;
}
/** The policy as shipped: real models, both enabled, Claude primary, fallback on. */
function shipped(over: Partial<Policy> = {}): Policy {
  return {
    primary: "anthropic",
    fallbackEnabled: true,
    alertThresholdPct: 80,
    providers: {
      anthropic: { enabled: true, model: "claude-opus-5-5", monthlyLimitMicroUsd: null },
      gemini: { enabled: true, model: "gemini-2.5-flash", monthlyLimitMicroUsd: null },
    },
    tenantOverrides: [],
    ...over,
  };
}
/** Both providers on a deterministic test model, so each "has credentials" without any key. */
function ready(over: Partial<Policy> = {}): Policy {
  return shipped({
    providers: {
      anthropic: { enabled: true, model: "stub-model", monthlyLimitMicroUsd: null },
      gemini: { enabled: true, model: "stub-model", monthlyLimitMicroUsd: null },
    },
    ...over,
  });
}
/** A US-dollar amount held in millionths, as the page prints it. */
function usd(micro: number): string {
  const whole = Math.floor(micro / 1_000_000);
  const fraction = String(micro % 1_000_000).padStart(6, "0").replace(/0{1,4}$/, "");
  return `$${whole.toLocaleString("en-US")}.${fraction}`;
}
async function open(page: Page) {
  await page.goto("/platform/settings");
  await expect(page.getByTestId("ai-providers-section")).toBeVisible();
  await expect(page.getByTestId("ai-provider-anthropic")).toBeVisible();
}
/** Clicks Save and returns the PUT's response. */
async function save(page: Page) {
  const written = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/platform/ai/providers"));
  await page.getByTestId("ai-save").click();
  return written;
}
async function applyConfirmation(page: Page) {
  const written = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/platform/ai/providers"));
  await page.getByTestId("ai-confirm-apply").click();
  const res = await written;
  expect(res.status()).toBe(200);
  expect(res.request().postDataJSON().confirm).toBe(true);
  await expect(page.getByTestId("ai-confirm-dialog")).toHaveCount(0);
}
/** Viewport-safe Radix select helper (as in the plan-builder specs). */
async function pickOption(page: Page, trigger: string, name: string | RegExp) {
  const t = page.getByTestId(trigger);
  await expect(t).toBeVisible();
  for (let attempt = 1; attempt <= 5; attempt++) {
    await t.evaluate(async (el) => {
      let last = el.getBoundingClientRect().top;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const now = el.getBoundingClientRect().top;
        if (Math.abs(now - last) < 1) break;
        last = now;
      }
      el.scrollIntoView({ block: "center" });
    });
    await t.click();
    const option = page.getByRole("option", { name, exact: typeof name === "string" });
    await expect(option).toBeVisible();
    // A long list opens scrolled: bring the option into the list's visible part first.
    await option.evaluate((el) => el.scrollIntoView({ block: "nearest" }));
    const inViewport = await option.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth;
    });
    if (inViewport) {
      await option.click();
      return;
    }
    await page.keyboard.press("Escape");
    await expect(option).toBeHidden();
    await page.waitForTimeout(300);
  }
  throw new Error(`option ${String(name)} of ${trigger} never came into the viewport`);
}

test.beforeAll(async () => {
  if (SHOTS && !fs.existsSync(SHOTS)) throw new Error(`AI_SHOTS_DIR does not exist: ${SHOTS}`);
  platform = await login(PLATFORM.email, PLATFORM.password);
  tenant = await login(TENANT_DEMO.email, TENANT_DEMO.password);
  pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  const found = plain(await status());
  const leftover = found.providers.anthropic.model.startsWith("stub-") || found.providers.gemini.model.startsWith("stub-") || found.tenantOverrides.some((o) => (o.model ?? "").startsWith("stub-"));
  original = leftover ? shipped() : found;
  const company = await pg.query("select name from companies where id = $1", [tenant.user.companyId]);
  demoCompanyName = company.rows[0].name;
  await pg.query("delete from ai_invocations where request_id like $1", [`${LEDGER_TAG}%`]);
});

test.afterAll(async () => {
  try {
    await pg.query("delete from ai_invocations where request_id like $1", [`${LEDGER_TAG}%`]);
    if (platform && original) {
      const current = await status();
      const res = await api("PUT", "/platform/ai/providers", { policy: original, expectedVersion: current.version, confirm: true }, platform.token);
      if (res.status !== 200) throw new Error(`could not restore the AI provider policy: ${res.status} ${res.text}`);
    }
  } finally {
    await pg.end();
  }
});

test("both providers are shown with their real readiness, model prices and what serves requests — and there is no field for a key", async ({ page }) => {
  await setPolicy(shipped());
  const errors = trackConsole(page);
  await seedAs(page, platform);
  await open(page);

  // No key exists on this server: the page says so, names where a key goes, and offers no way to enter one.
  await expect(page.getByTestId("ai-serving-summary")).toContainText("AI is not available yet");
  await expect(page.getByTestId("ai-serving-summary")).toContainText("Manual, QR and NFC capture keep working");
  for (const [p, envVar, label] of [["anthropic", "ANTHROPIC_API_KEY", "Claude"], ["gemini", "GEMINI_API_KEY", "Gemini"]] as const) {
    const cred = page.getByTestId(`ai-credentials-${p}`);
    await expect(cred).toContainText("No key on the server");
    await expect(cred).toContainText(envVar);
    await expect(cred).toContainText("Keys are never entered here");
    await expect(page.getByTestId(`ai-provider-${p}`)).toContainText(label);
    await expect(page.getByTestId(`ai-enable-${p}`)).toHaveAttribute("data-state", "checked");
  }
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  const keyFields = await page.locator("input, textarea").evaluateAll((els) => els.map((e) => `${e.id} ${e.getAttribute("name") ?? ""} ${e.getAttribute("placeholder") ?? ""}`).filter((s) => /key|secret|token/i.test(s)));
  expect(keyFields).toEqual([]);

  // The owner's stated preference is what is in effect.
  await expect(page.getByTestId("ai-primary-anthropic")).toHaveAttribute("data-state", "checked");
  await expect(page.getByTestId("ai-fallback")).toHaveAttribute("data-state", "checked");
  // Prices are the API's, per million tokens.
  await expect(page.getByTestId("ai-price-anthropic")).toHaveText("$4.00 in · $20.00 out per 1M tokens");
  await expect(page.getByTestId("ai-price-gemini")).toHaveText("$0.30 in · $2.50 out per 1M tokens");
  await expect(page.getByTestId("ai-model-anthropic")).toContainText("claude-opus-5-5");
  await expect(page.getByTestId("ai-model-gemini")).toContainText("gemini-2.5-flash");

  // Nothing to save yet.
  await expect(page.getByTestId("ai-dirty-state")).toHaveText("All changes are saved.");
  await expect(page.getByTestId("ai-save")).toBeDisabled();
  await expect(page.getByTestId("ai-discard")).toBeDisabled();
  expect(errors, errors.join("\n")).toEqual([]);
});

test("the Claude models offered are the documented ones, each with its price", async ({ page }) => {
  await seedAs(page, platform);
  await open(page);
  await pickOption(page, "ai-model-anthropic", "claude-haiku-5-5");
  await expect(page.getByTestId("ai-price-anthropic")).toHaveText("$0.10 in · $0.50 out per 1M tokens; $0.50 in · $2.50 out when a request's input exceeds 100,000 tokens");
  await pickOption(page, "ai-model-anthropic", "claude-sonnet-5-5");
  await expect(page.getByTestId("ai-price-anthropic")).toHaveText("$2.00 in · $10.00 out per 1M tokens");
  // A model is a cost choice, not an availability change: it is saved without a confirmation.
  const res = await save(page);
  expect(res.status()).toBe(200);
  expect((await status()).policy.providers.anthropic.model).toBe("claude-sonnet-5-5");
  await expect(page.getByTestId("ai-dirty-state")).toHaveText("All changes are saved.");
});

test("a harmless change is saved at once and is still there after a reload", async ({ page }) => {
  await setPolicy(shipped());
  await seedAs(page, platform);
  await open(page);
  const before = await status();

  await page.getByTestId("ai-alert-threshold").fill("65");
  await expect(page.getByTestId("ai-dirty-state")).toHaveText("You have unsaved changes.");
  const res = await save(page);
  expect(res.status()).toBe(200);
  const sent = res.request().postDataJSON();
  expect(sent.expectedVersion).toBe(before.version);
  expect(sent.confirm).toBeUndefined();
  // The whole policy is sent, and nothing else.
  expect(Object.keys(sent).sort()).toEqual(["expectedVersion", "policy"]);
  expect(Object.keys(sent.policy).sort()).toEqual(["alertThresholdPct", "fallbackEnabled", "primary", "providers", "tenantOverrides"]);

  const after = await status();
  expect(after.policy.alertThresholdPct).toBe(65);
  expect(after.version).toBe(before.version + 1);
  await expect(page.getByTestId("ai-dirty-state")).toHaveText("All changes are saved.");
  await expect(page.getByTestId("ai-policy-meta")).toContainText("Last changed");

  await page.reload();
  await expect(page.getByTestId("ai-alert-threshold")).toHaveValue("65");
  // Discard puts an unsaved edit back.
  await page.getByTestId("ai-alert-threshold").fill("12");
  await page.getByTestId("ai-discard").click();
  await expect(page.getByTestId("ai-alert-threshold")).toHaveValue("65");
  expect((await status()).policy.alertThresholdPct).toBe(65);
});

test("switching the primary is confirmed with the server's reasons; cancelling changes nothing; applying takes effect at once", async ({ page }) => {
  await setPolicy(ready());
  await seedAs(page, platform);
  await open(page);
  // Both providers can serve: Claude does, Gemini is the fallback.
  await expect(page.getByTestId("ai-serving-summary")).toContainText("Claude serves AI requests");
  await expect(page.getByTestId("ai-role-anthropic")).toHaveText("Serving requests");
  await expect(page.getByTestId("ai-role-gemini")).toHaveText("Fallback");
  const before = await status();

  await page.getByTestId("ai-primary-gemini").click();
  const held = await save(page);
  expect(held.status()).toBe(409);
  const dialog = page.getByTestId("ai-confirm-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Confirm this change");
  await expect(page.getByTestId("ai-confirm-warnings")).toContainText("New requests of every tenant without an override will go to Gemini.");
  if (SHOTS) await dialog.screenshot({ path: path.join(SHOTS, "confirm-primary-switch.png") });

  await page.getByTestId("ai-confirm-cancel").click();
  await expect(dialog).toHaveCount(0);
  expect((await status()).version).toBe(before.version); // nothing was changed
  await expect(page.getByTestId("ai-dirty-state")).toHaveText("You have unsaved changes.");

  await save(page);
  await applyConfirmation(page);
  const after = await status();
  expect(after.policy.primary).toBe("gemini");
  expect(after.effective).toMatchObject({ provider: "gemini", fallbackProvider: "anthropic" });
  await expect(page.getByTestId("ai-serving-summary")).toContainText("Gemini serves AI requests");
  await expect(page.getByTestId("ai-role-gemini")).toHaveText("Serving requests");
  await expect(page.getByTestId("ai-role-anthropic")).toHaveText("Fallback");
});

test("disabling a provider and turning automatic fallback off are confirmed; turning both providers off is announced as turning AI off", async ({ page }) => {
  await setPolicy(ready());
  await seedAs(page, platform);
  await open(page);

  // Gemini off: Claude alone serves, with nothing to fall back to.
  await page.getByTestId("ai-enable-gemini").click();
  expect((await save(page)).status()).toBe(409);
  const warnings = page.getByTestId("ai-confirm-warnings");
  await expect(warnings).toContainText("Gemini will be disabled");
  await expect(warnings).toContainText("Only Claude will be able to serve requests");
  await applyConfirmation(page);
  let s = await status();
  expect(s.policy.providers.gemini.enabled).toBe(false);
  expect(s.effective).toMatchObject({ provider: "anthropic", fallbackProvider: null });
  await expect(page.getByTestId("ai-role-gemini")).toHaveText("Disabled");
  await expect(page.getByTestId("ai-serving-summary")).toContainText("No fallback is in place");

  // Claude off as well: nothing could serve. The dialog says so plainly; it is NOT applied here.
  await page.getByTestId("ai-enable-anthropic").click();
  expect((await save(page)).status()).toBe(409);
  const dialog = page.getByTestId("ai-confirm-dialog");
  await expect(dialog).toContainText("Turn AI off for every company?");
  await expect(page.getByTestId("ai-confirm-warnings")).toContainText("every AI feature stops for every tenant");
  await expect(page.getByTestId("ai-confirm-warnings")).toContainText("Manual, QR and NFC capture keep working");
  if (SHOTS) await dialog.screenshot({ path: path.join(SHOTS, "confirm-ai-off.png") });
  await page.getByTestId("ai-confirm-cancel").click();
  await page.getByTestId("ai-discard").click();
  s = await status();
  expect(s.policy.providers.anthropic.enabled).toBe(true);
  await expect(page.getByTestId("ai-enable-anthropic")).toHaveAttribute("data-state", "checked");

  // Fallback off, on a policy where both serve.
  await setPolicy(ready());
  await page.reload();
  await expect(page.getByTestId("ai-role-gemini")).toHaveText("Fallback");
  await page.getByTestId("ai-fallback").click();
  expect((await save(page)).status()).toBe(409);
  await expect(page.getByTestId("ai-confirm-warnings")).toContainText("Automatic fallback will be off");
  await applyConfirmation(page);
  s = await status();
  expect(s.policy.fallbackEnabled).toBe(false);
  expect(s.effective.fallbackProvider).toBeNull();
  await expect(page.getByTestId("ai-role-gemini")).toHaveText("Standby");
});

test("a spending limit typed in dollars is stored exactly; a mistyped one is refused before anything is sent; usage is the ledger's own", async ({ page }) => {
  await setPolicy(ready());
  // Synthetic ledger rows (no company, no content): two Claude calls, one of them served as the fallback, and one failed Gemini call.
  const row = (suffix: string, provider: string, statusText: string, input: number, output: number, cost: number) =>
    pg.query(
      "insert into ai_invocations (feature, provider, model, status, request_id, input_tokens, output_tokens, total_tokens, estimated_cost_micro_usd) values ('card_extraction', $1, 'stub-model', $2, $3, $4, $5, $6, $7)",
      [provider, statusText, `${LEDGER_TAG}-${suffix}`, input, output, input + output, cost],
    );
  const baseline = await status();
  const claudeBefore = baseline.providers.find((p: any) => p.provider === "anthropic").month;
  await row("a", "anthropic", "success", 1200, 300, 12_340_000);
  await row("b-fb1", "anthropic", "success", 800, 200, 7_660_000);
  await row("c", "gemini", "error", 0, 0, 0);
  const claudeCost = claudeBefore.costMicroUsd + 20_000_000;

  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "PUT" && r.url().includes("/platform/ai/providers")) requests.push(r.url());
  });
  await seedAs(page, platform);
  await open(page);
  await expect(page.getByTestId("ai-cost-anthropic")).toHaveText(usd(claudeCost));
  await expect(page.getByTestId("ai-calls-anthropic")).toHaveText(String(claudeBefore.providerCalls + 2));
  await expect(page.getByTestId("ai-as-fallback-anthropic")).toHaveText(String(claudeBefore.servedAsFallback + 1));

  // Mistyped: refused in the page, nothing is sent.
  const limit = page.getByTestId("ai-limit-anthropic");
  await limit.fill("12,50");
  await page.getByTestId("ai-save").click();
  await expect(page.getByTestId("ai-limit-error-anthropic")).toContainText("Enter an amount in US dollars");
  await limit.fill("0.0000001");
  await page.getByTestId("ai-save").click();
  await expect(page.getByTestId("ai-limit-error-anthropic")).toContainText("at most six decimals");
  expect(requests).toEqual([]);

  // A limit above what has been spent: confirmed, then stored to the micro-dollar.
  const dollars = (claudeCost + 230_500_000) / 1_000_000; // e.g. 250.5 on a clean ledger
  await limit.fill(String(dollars));
  await expect(page.getByTestId("ai-limit-error-anthropic")).toHaveCount(0);
  const held = await save(page);
  expect(held.status()).toBe(409);
  expect(held.request().postDataJSON().policy.providers.anthropic.monthlyLimitMicroUsd).toBe(claudeCost + 230_500_000);
  await expect(page.getByTestId("ai-confirm-warnings")).toContainText("Claude gets a monthly spending limit");
  await expect(page.getByTestId("ai-confirm-warnings")).toContainText("are not moved to the other provider");
  await applyConfirmation(page);
  const s = await status();
  expect(s.policy.providers.anthropic.monthlyLimitMicroUsd).toBe(claudeCost + 230_500_000);
  await expect(page.getByTestId("ai-limit-status-anthropic")).toContainText(`${usd(claudeCost)} of ${usd(claudeCost + 230_500_000)}`);
  await expect(page.getByTestId("ai-limit-anthropic")).toHaveValue(String(dollars));
  if (SHOTS) await page.getByTestId("ai-provider-anthropic").screenshot({ path: path.join(SHOTS, "provider-card-usage-limit.png") });

  // A limit below what has already been spent is announced as an immediate stop.
  await limit.fill("0.01");
  expect((await save(page)).status()).toBe(409);
  await expect(page.getByTestId("ai-confirm-warnings")).toContainText("will be refused immediately");
  await page.getByTestId("ai-confirm-cancel").click();
  await page.getByTestId("ai-discard").click();
  // Removing the limit only widens what may be spent: no confirmation.
  await limit.fill("");
  expect((await save(page)).status()).toBe(200);
  expect((await status()).policy.providers.anthropic.monthlyLimitMicroUsd).toBeNull();
  await expect(page.getByTestId("ai-limit-status-anthropic")).toHaveCount(0);
});

test("a company can be pinned to a provider and unpinned", async ({ page }) => {
  await setPolicy(ready());
  await seedAs(page, platform);
  await open(page);
  await expect(page.getByTestId("ai-overrides-empty")).toBeVisible();

  await page.locator("#ai-override-search").fill(demoCompanyName);
  await pickOption(page, "ai-override-company", demoCompanyName);
  await pickOption(page, "ai-override-provider", "Gemini");
  // Changing the search after choosing does not lose the choice: "Pin company" still pins it.
  await page.locator("#ai-override-search").fill("a company name that matches nothing");
  await expect(page.getByTestId("ai-override-company")).toContainText(demoCompanyName);
  await page.getByTestId("ai-override-add").click();
  const pinnedRow = page.getByTestId(`ai-override-${tenant.user.companyId}`);
  await expect(pinnedRow).toContainText(demoCompanyName);
  await expect(pinnedRow).toContainText("Gemini");
  await expect(pinnedRow).toContainText("Provider's selected model");
  // Pinning does not reduce availability: saved without a confirmation.
  expect((await save(page)).status()).toBe(200);
  expect((await status()).policy.tenantOverrides).toEqual([{ companyId: tenant.user.companyId, companyName: demoCompanyName, provider: "gemini", model: null }]);
  // The pinned company is served by Gemini; the tenant sees that in its own settings.
  const settings = await api("GET", "/ai/settings", undefined, tenant.token);
  expect(settings.json.provider).toBe("gemini");

  await page.reload();
  await expect(page.getByTestId(`ai-override-${tenant.user.companyId}`)).toBeVisible();
  await page.getByRole("button", { name: `Remove the override for ${demoCompanyName}` }).click();
  expect((await save(page)).status()).toBe(200);
  expect((await status()).policy.tenantOverrides).toEqual([]);
  await expect(page.getByTestId("ai-overrides-empty")).toBeVisible();
});

test("a save never overwrites a change someone else made meanwhile", async ({ page }) => {
  await setPolicy(ready());
  await seedAs(page, platform);
  await open(page);
  await page.getByTestId("ai-alert-threshold").fill("70");

  // Another platform owner changes the policy while this form has unsaved edits.
  const other = await setPolicy(ready({ alertThresholdPct: 55 }));
  const refused = await save(page);
  expect(refused.status()).toBe(409);
  expect((await refused.json()).code).toBe("AI_POLICY_VERSION_CONFLICT");
  expect((await status()).policy.alertThresholdPct).toBe(55); // their change stands
  expect((await status()).version).toBe(other.version);

  await expect(page.getByTestId("ai-stale")).toBeVisible();
  await expect(page.getByTestId("ai-save")).toBeDisabled();
  await expect(page.getByTestId("ai-alert-threshold")).toHaveValue("70"); // the unsaved edit is not thrown away silently
  await page.getByRole("button", { name: "Load the current settings" }).click();
  await expect(page.getByTestId("ai-stale")).toHaveCount(0);
  await expect(page.getByTestId("ai-alert-threshold")).toHaveValue("55");
  // The form now stands on the current version and saves normally.
  await page.getByTestId("ai-alert-threshold").fill("72");
  expect((await save(page)).status()).toBe(200);
  expect((await status()).policy.alertThresholdPct).toBe(72);
});

test("a database without the settings storage is shown read-only, with the defaults in effect", async ({ page }) => {
  await setPolicy(shipped());
  const real = await status();
  await page.route("**/api/platform/ai/providers", async (route) => {
    if (route.request().method() !== "GET") return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "AI provider settings cannot be saved yet", code: "AI_POLICY_STORAGE_UNAVAILABLE" }) });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...real, version: 0, persisted: false, storage: "unavailable", updatedAt: null, updatedByName: null }) });
  });
  await seedAs(page, platform);
  await open(page);
  await expect(page.getByTestId("ai-storage-unavailable")).toContainText("These settings cannot be changed yet");
  await expect(page.getByTestId("ai-policy-meta")).toContainText("the default settings are in effect");
  await expect(page.getByTestId("ai-dirty-state")).toHaveText("Read-only");
  for (const id of ["ai-enable-anthropic", "ai-enable-gemini", "ai-fallback", "ai-primary-gemini", "ai-limit-anthropic", "ai-alert-threshold", "ai-model-anthropic", "ai-override-add", "ai-save"]) {
    await expect(page.getByTestId(id), id).toBeDisabled();
  }
  await page.unroute("**/api/platform/ai/providers");
});

test("a refresh that fails keeps the form and what was typed, and says the figures may be out of date", async ({ page }) => {
  await setPolicy(shipped());
  await seedAs(page, platform);
  await open(page);
  await page.getByTestId("ai-alert-threshold").fill("44");
  await page.route("**/api/platform/ai/providers", (route) => (route.request().method() === "GET" ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Internal server error" }) }) : route.continue()));
  await page.getByTestId("ai-refresh").click();
  await expect(page.getByTestId("ai-refresh-failed")).toBeVisible();
  // The page is still the form — not an error screen — and the unsaved edit is intact.
  await expect(page.getByTestId("ai-provider-anthropic")).toBeVisible();
  await expect(page.getByTestId("ai-alert-threshold")).toHaveValue("44");
  await expect(page.getByTestId("ai-dirty-state")).toHaveText("You have unsaved changes.");
  await page.unroute("**/api/platform/ai/providers");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("ai-refresh-failed")).toHaveCount(0);
  await expect(page.getByTestId("ai-alert-threshold")).toHaveValue("44");
  // Each switch has its own name for assistive technology.
  await expect(page.getByRole("switch", { name: "Claude enabled" })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Gemini enabled" })).toBeVisible();
});

test("the tenant's AI Settings shows the provider the platform chose — to read, not to choose", async ({ page }) => {
  await setPolicy(ready());
  await seedAs(page, tenant);
  await page.goto("/admin/ai");
  const shown = page.getByTestId("ai-provider-readonly");
  await expect(shown).toBeVisible();
  await expect(page.getByTestId("ai-provider-name")).toHaveText("Claude (Anthropic)");
  await expect(page.getByTestId("ai-provider-model")).toHaveText("stub-model");
  await expect(shown).toContainText("chosen by the platform");
  await expect(shown.locator("select, input, [role=combobox]")).toHaveCount(0);

  // The platform switches the primary: the tenant's page follows, with no action by the tenant.
  await setPolicy(ready({ primary: "gemini" }));
  await page.reload();
  await expect(page.getByTestId("ai-provider-name")).toHaveText("Gemini (Google)");
});

test("the AI provider settings are the platform owner's", async ({ page }) => {
  const before = await status();
  for (const [method, body] of [["GET", undefined], ["PUT", { policy: ready({ primary: "gemini" }), expectedVersion: before.version, confirm: true }]] as const) {
    expect((await api(method, "/platform/ai/providers", body, tenant.token)).status, `tenant ${method}`).toBe(403);
    expect((await api(method, "/platform/ai/providers", body)).status, `anonymous ${method}`).toBe(401);
  }
  expect((await status()).version).toBe(before.version);

  await seedAs(page, tenant);
  await page.goto("/platform/settings");
  await expect(page).not.toHaveURL(/\/platform\/settings/);
  await expect(page.getByTestId("ai-providers-section")).toHaveCount(0);
});

for (const view of [
  { name: "desktop-1440", width: 1440, height: 900, theme: "light" },
  { name: "tablet-820", width: 820, height: 1180, theme: "light" },
  { name: "mobile-390", width: 390, height: 844, theme: "light" },
  { name: "desktop-1440-dark", width: 1440, height: 900, theme: "dark" },
  { name: "mobile-390-dark", width: 390, height: 844, theme: "dark" },
] as const) {
  test(`the AI provider settings fit ${view.name}`, async ({ page }) => {
    // A state with something in every part of the page: Claude serving with a limit in
    // use, Gemini as the fallback, and one pinned company.
    await pg.query("delete from ai_invocations where request_id like $1", [`${LEDGER_TAG}%`]);
    await pg.query(
      "insert into ai_invocations (feature, provider, model, status, request_id, input_tokens, output_tokens, total_tokens, estimated_cost_micro_usd) values ('card_extraction', 'anthropic', 'stub-model', 'success', $1, 184000, 52000, 236000, 41250000), ('email_composer', 'gemini', 'stub-model', 'success', $2, 96000, 31000, 127000, 3180000)",
      [`${LEDGER_TAG}-v1`, `${LEDGER_TAG}-v2-fb1`],
    );
    const spent = (await status()).providers.find((p: any) => p.provider === "anthropic").month.costMicroUsd as number;
    await setPolicy(
      ready({
        providers: { anthropic: { enabled: true, model: "stub-model", monthlyLimitMicroUsd: Math.ceil(spent / 0.55 / 1_000_000) * 1_000_000 }, gemini: { enabled: true, model: "stub-model", monthlyLimitMicroUsd: null } },
        tenantOverrides: [{ companyId: tenant.user.companyId!, provider: "gemini", model: null }],
      }),
    );

    const errors = trackConsole(page);
    await page.setViewportSize({ width: view.width, height: view.height });
    await seedAs(page, platform, view.theme);
    await open(page);
    await expect(page.locator("html")).toHaveClass(view.theme === "dark" ? /dark/ : /^(?!.*\bdark\b)/);
    await expect(page.getByTestId("ai-serving-summary")).toContainText("Claude serves AI requests");
    await expect(page.getByTestId("ai-limit-status-anthropic")).toBeVisible();
    await expect(page.getByTestId(`ai-override-${tenant.user.companyId}`)).toBeVisible();

    // Nothing runs past the edge of the page, and every control sits inside its card.
    const overflow = await page.evaluate(() => {
      const main = document.querySelector("main");
      return { document: document.documentElement.scrollWidth - document.documentElement.clientWidth, main: main ? main.scrollWidth - main.clientWidth : 0 };
    });
    expect(overflow, JSON.stringify(overflow)).toEqual({ document: 0, main: 0 });
    for (const p of ["anthropic", "gemini"] as const) {
      const outside = await page.getByTestId(`ai-provider-${p}`).evaluate((card) => {
        const box = card.getBoundingClientRect();
        return Array.from(card.querySelectorAll("input, button, [role=combobox], [role=switch], dd, dt, p, span"))
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 0 && (r.left < box.left - 1 || r.right > box.right + 1)).length;
      });
      expect(outside, `${p} card content outside its card`).toBe(0);
    }
    // The save bar stays reachable and its buttons are on screen.
    const saveBox = await page.getByTestId("ai-save").boundingBox();
    expect(saveBox).not.toBeNull();
    expect(saveBox!.x).toBeGreaterThanOrEqual(0);
    expect(saveBox!.x + saveBox!.width).toBeLessThanOrEqual(view.width + 1);

    if (SHOTS) {
      const height = await page.evaluate(() => document.querySelector("main")?.scrollHeight ?? document.body.scrollHeight);
      await page.setViewportSize({ width: view.width, height: Math.min(Math.max(height + 140, view.height), 7800) });
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SHOTS, `ai-providers-${view.name}.png`) });
      await page.setViewportSize({ width: view.width, height: view.height });
    }
    expect(errors, errors.join("\n")).toEqual([]);
  });
}

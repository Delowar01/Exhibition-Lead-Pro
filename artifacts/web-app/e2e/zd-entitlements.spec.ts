import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/workspace";
import { API_BASE, RUN_TAG } from "./fixtures/seed-values";

/**
 * ZD. Batch 41 — PB-3 feature entitlements through the browser.
 *
 * Runs against the local stack with the API as the oracle. Proves:
 *   • the platform owner sees the enforcement mode of every version (legacy /
 *     grandfathered vs enforced), the recorded-vs-effective feature matrix, the
 *     AI allowances and the trial policy of a published version, can configure
 *     enforcement / allowances / a read-only grace on a draft (validated with the
 *     publication warnings) and previews what a tenant would get vs what it keeps;
 *   • a tenant admin on an ENFORCED version never sees the Documents entry, gets
 *     the "not included" state on the documents route and has no Schedules tab;
 *   • a tenant admin on a legacy (version 1) plan keeps every entry (grandfathered).
 */

const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PASSWORD = "PlanQa123!";
const SUFFIX = Date.now().toString(36);
const SLUG = `zd-${SUFFIX}`;
const PLAN_NAME = `Enforced ${SUFFIX}`;
const ENFORCED_CO = `${RUN_TAG} Enforced Co`;
const LEGACY_CO = `${RUN_TAG} Legacy Co`;
const ENFORCED_ADMIN = `${RUN_TAG.toLowerCase()}.enforced-admin@example.test`;
const LEGACY_ADMIN = `${RUN_TAG.toLowerCase()}.legacy-admin@example.test`;
const FEATURES = ["ai.assistant", "ai.command_center", "workflow.intelligence", "executive.intelligence", "exports.scheduled", "nfc.capture", "documents", "api.access"];

type Auth = { token: string; user: { id: number; companyId: number | null; email: string; role?: string; entitlements?: unknown } };

let platform: Auth;
let enforcedAdmin: Auth;
let legacyAdmin: Auth;
let enforcedCompanyId = 0;
let legacyCompanyId = 0;
let v1Id = 0;

test.describe.configure({ mode: "serial" });

async function api(method: string, path: string, body?: unknown, token: string | null = null) {
  const res = await fetch(`${API_BASE}${path}`, {
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

async function seedAs(page: Page, auth: Auth) {
  await page.addInitScript(
    ([t, u, cid, userId]) => {
      try {
        localStorage.setItem("csp_token", t as string);
        localStorage.setItem("csp_user", u as string);
        if (cid) localStorage.setItem("csp_company_id", cid as string);
        localStorage.setItem("csp_theme", "light");
        localStorage.setItem(`csp_theme:u${userId}c${cid}`, "light");
      } catch {
        /* storage unavailable */
      }
    },
    [auth.token, JSON.stringify(auth.user), String(auth.user.companyId ?? ""), String(auth.user.id)] as const,
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

/** Same viewport-safe Radix select helper as zc-plan-versions. */
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
    const option = page.getByRole("option", { name });
    await expect(option).toBeVisible();
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
const versions = async () => (await api("GET", `/platform/plans/${SLUG}/versions`, undefined, platform.token)).json;

test.beforeAll(async () => {
  platform = await login(PLATFORM.email, PLATFORM.password);
  // An ENFORCED plan (documents + scheduled exports off), published through the API.
  const features = Object.fromEntries(FEATURES.map((k) => [k, k !== "documents" && k !== "exports.scheduled"]));
  const created = await api("POST", "/platform/plans", { id: SLUG, name: PLAN_NAME, limits: {}, features, featureEnforcement: "enforced" }, platform.token);
  expect(created.status, created.text).toBe(201);
  v1Id = created.json.draft.id;
  const published = await api("POST", `/platform/plans/${SLUG}/versions/${v1Id}/publish`, undefined, platform.token);
  expect(published.status, published.text).toBe(200);
  for (const [name, plan] of [
    [ENFORCED_CO, SLUG],
    [LEGACY_CO, "free"],
  ] as const) {
    const company = await api("POST", "/companies", { name, plan, industry: "QA" }, platform.token);
    expect(company.status, company.text).toBe(201);
    if (plan === SLUG) enforcedCompanyId = company.json.id;
    else legacyCompanyId = company.json.id;
  }
  for (const [email, cid] of [
    [ENFORCED_ADMIN, enforcedCompanyId],
    [LEGACY_ADMIN, legacyCompanyId],
  ] as const) {
    const user = await api("POST", "/users", { email, name: "Entitlement Admin", role: "primary_admin", companyId: cid, password: PASSWORD }, platform.token);
    expect(user.status, user.text).toBe(201);
  }
  enforcedAdmin = await login(ENFORCED_ADMIN, PASSWORD);
  legacyAdmin = await login(LEGACY_ADMIN, PASSWORD);
});

test.afterAll(async () => {
  if (!platform) return;
  for (const cid of [enforcedCompanyId, legacyCompanyId]) if (cid) await api("DELETE", `/companies/${cid}`, undefined, platform.token);
  await api("POST", `/platform/plans/${SLUG}/archive`, undefined, platform.token);
});

test("platform owner: enforcement + grandfathered status, matrix, allowances, trial policy, draft configuration with validation, effective-entitlement preview", async ({ page }) => {
  const errors = trackConsole(page);
  await seedAs(page, platform);
  await page.goto("/platform/plans");
  await expect(page.getByTestId("platform-plans")).toBeVisible();

  // 1. A fixed plan's version 1 is legacy / grandfathered.
  await page.getByTestId("plan-details-free").click();
  await expect(page.getByTestId("plan-detail-title")).toBeVisible();
  await expect(page.getByTestId("version-enforcement")).toContainText("Legacy");
  await expect(page.getByTestId("snapshot-enforcement")).toContainText("grandfathered");
  await expect(page.getByTestId("snapshot-feature-documents")).toHaveAttribute("data-allowed", "true");
  await expect(page.getByTestId("snapshot-feature-documents")).toContainText("grandfathered");
  await expect(page.getByTestId("snapshot-allowance-tokens")).toContainText("None");
  await expect(page.getByTestId("snapshot-trial-outcome")).toContainText("Blocked immediately");

  // 2. The enforced plan: the version table and the snapshot show the enforced mode and the denied features.
  await page.getByTestId(`plan-details-${SLUG}`).click();
  await expect(page.getByTestId("plan-detail-title")).toHaveText(PLAN_NAME);
  await expect(page.getByTestId(`version-enforcement-${v1Id}`)).toContainText("Enforced");
  await expect(page.getByTestId("snapshot-enforcement")).toContainText("Enforced");
  await expect(page.getByTestId("snapshot-feature-documents")).toHaveAttribute("data-allowed", "false");
  await expect(page.getByTestId("snapshot-feature-documents")).toContainText("denied");
  await expect(page.getByTestId("snapshot-feature-ai.assistant")).toHaveAttribute("data-allowed", "true");

  // 3. A new draft: switch to legacy (note explains grandfathering), back to enforced, set allowances + read-only grace, save, validate.
  await page.getByTestId("version-new-draft").click();
  await expect(page.getByTestId("version-editor")).toBeVisible();
  await expect(page.getByTestId("version-title")).toContainText("v2");
  await pickOption(page, "version-enforcement-select", /^Legacy/);
  await expect(page.getByTestId("version-enforcement-note")).toContainText("grandfathered");
  await pickOption(page, "version-enforcement-select", /^Enforced/);
  await expect(page.getByTestId("version-enforcement-note")).toContainText("FEATURE_NOT_ENTITLED");
  await page.getByTestId("version-allowance-tokens").fill("5000");
  await page.getByTestId("version-allowance-cost").fill("2.5");
  await pickOption(page, "version-trial-outcome", /^Read-only grace/);
  await page.getByTestId("version-trial-grace").fill("5");
  await page.getByTestId("version-save").click();
  await expect.poll(async () => (await versions()).versions.find((v: any) => v.version === 2)?.allowances?.aiTokensPerMonth, { timeout: 10_000 }).toBe(5000);
  const v2 = (await versions()).versions.find((v: any) => v.version === 2);
  expect(v2).toMatchObject({ state: "draft", featureEnforcement: "enforced", allowances: { aiTokensPerMonth: 5000, aiCostMicroUsdPerMonth: 2_500_000 } });
  expect(v2.trialPolicy).toMatchObject({ endOutcome: "read_only", readOnlyGraceDays: 5 });
  await page.getByTestId("version-validate").click();
  const validation = page.getByTestId("version-validation");
  await expect(validation).toBeVisible();
  await expect(validation).toHaveAttribute("data-publishable", "true");
  await expect(page.getByTestId("version-validation-warnings")).toContainText("DENIED");
  await expect(page.getByTestId("version-validation-warnings")).toContainText("read-only");
  // The grace without a read-only outcome is refused at publication validation: set 0 and validate again.
  await page.getByTestId("version-trial-grace").fill("0");
  await page.getByTestId("version-save").click();
  await expect.poll(async () => (await versions()).versions.find((v: any) => v.version === 2)?.trialPolicy.readOnlyGraceDays, { timeout: 10_000 }).toBe(0);
  await page.getByTestId("version-validate").click();
  await expect(page.getByTestId("version-validation")).toHaveAttribute("data-publishable", "false");
  await expect(page.getByTestId("version-validation-errors")).toContainText("grace");
  // Remove the draft so the plan keeps exactly its published v1.
  await page.getByTestId("version-delete-open").click();
  await expect(page.getByTestId("delete-dialog")).toBeVisible();
  await page.getByTestId("delete-confirm").click();
  await expect(page.getByTestId("delete-dialog")).toBeHidden();
  await expect.poll(async () => (await versions()).versions.length, { timeout: 10_000 }).toBe(1);

  // 4. Effective-entitlement preview for the enforced tenant: enforcement, features, trial policy and allowance precedence.
  await pickOption(page, "preview-plan", PLAN_NAME);
  await page.getByTestId("preview-search").fill(ENFORCED_CO);
  await page.getByTestId(`preview-pick-${enforcedCompanyId}`).click();
  await expect(page.getByTestId("preview-entitlements")).toBeVisible();
  await expect(page.getByTestId("preview-enforcement-preview")).toContainText("Enforced");
  await expect(page.getByTestId("preview-enforcement-current")).toContainText("Enforced");
  await expect(page.getByTestId("preview-feature-documents")).toHaveAttribute("data-preview-allowed", "false");
  await expect(page.getByTestId("preview-feature-documents")).toHaveAttribute("data-current-allowed", "false");
  await expect(page.getByTestId("preview-feature-ai.assistant")).toHaveAttribute("data-preview-allowed", "true");
  await expect(page.getByTestId("preview-trial-current")).toContainText("Blocked");
  await expect(page.getByTestId("preview-allowance-tokens")).toContainText("none");
  // The legacy tenant on the same preview plan: it currently keeps everything (grandfathered) and would be denied documents.
  await page.getByTestId("preview-search").fill(LEGACY_CO);
  await page.getByTestId(`preview-pick-${legacyCompanyId}`).click();
  await expect(page.getByTestId("preview-enforcement-current")).toContainText("Legacy");
  await expect(page.getByTestId("preview-feature-documents")).toHaveAttribute("data-current-allowed", "true");
  await expect(page.getByTestId("preview-feature-documents")).toHaveAttribute("data-preview-allowed", "false");
  await expect(page.getByTestId("preview-features-note")).toBeVisible();
  expect(errors, errors.join("\n")).toEqual([]);
});

test("tenant admin on the enforced version: Documents hidden, documents route shows the not-included state, no Schedules tab; the API agrees", async ({ page }) => {
  const errors = trackConsole(page);
  expect((enforcedAdmin.user.entitlements as any).featureEnforcement).toBe("enforced");
  await seedAs(page, enforcedAdmin);
  await page.goto("/admin/contacts");
  await expect(page).toHaveURL(/\/admin\/contacts/);
  await expect(page.locator('a[href="/admin/contacts"]').first()).toBeVisible();
  await expect(page.locator('a[href="/admin/documents"]')).toHaveCount(0);
  await page.goto("/admin/documents");
  await expect(page.getByTestId("feature-unavailable-documents")).toBeVisible();
  await expect(page.getByTestId("feature-unavailable-documents")).toContainText("not included");
  await page.goto("/admin/reports");
  await expect(page.getByTestId("reports-workspace-tabs")).toBeVisible();
  await expect(page.getByTestId("tab-reports")).toBeVisible();
  await expect(page.getByTestId("tab-schedules")).toHaveCount(0);
  const denied = await api("GET", "/documents", undefined, enforcedAdmin.token);
  expect(denied.status).toBe(403);
  expect(denied.json.code).toBe("FEATURE_NOT_ENTITLED");
  expect(denied.json.context).toEqual({ feature: "documents", planVersionId: v1Id, enforcement: "enforced" });
  expect(errors, errors.join("\n")).toEqual([]);
});

test("tenant admin on a legacy version keeps Documents and Schedules (grandfathered)", async ({ page }) => {
  const errors = trackConsole(page);
  expect((legacyAdmin.user.entitlements as any).featureEnforcement).toBe("legacy");
  await seedAs(page, legacyAdmin);
  await page.goto("/admin/contacts");
  await expect(page.locator('a[href="/admin/documents"]').first()).toBeVisible();
  await page.goto("/admin/reports");
  await expect(page.getByTestId("tab-schedules")).toBeVisible();
  expect((await api("GET", "/documents", undefined, legacyAdmin.token)).status).toBe(200);
  expect(errors, errors.join("\n")).toEqual([]);
});

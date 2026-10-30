import type { Page } from "@playwright/test";
import { test, expect, seedAuth } from "./fixtures/workspace";
import { API_BASE, RUN_TAG } from "./fixtures/seed-values";

/**
 * ZC. Batch 40 — versioned Plan Builder (PB-2) through the platform owner's UI.
 *
 * Runs against the local stack. Proves, end to end in the browser with the API as
 * the oracle: a plan is created as a DRAFT (not assignable); its draft is edited
 * (limits, feature matrix, trial policy), validated and published ATOMICALLY as an
 * immutable version; a tenant assigned to the plan is PINNED to that version; a
 * second version that tightens a limit is published with a confirmation that shows
 * the tenant impact (0 subscribers moved, tightened limits) and the pinned tenant
 * keeps its v1 entitlements (grandfathering) while the plan row mirrors v2; the
 * comparison view and the per-version effective-limit preview reflect both
 * versions; retiring v1 keeps its subscriber; published versions reject edits and
 * deletion (409) and the last published version cannot be retired; duplicating a
 * plan creates a draft copy without prices and deleting the only draft of a
 * never-published plan removes it; a tenant admin never renders the page and every
 * mutation route refuses it (403) without side effects.
 */

const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PASSWORD = "PlanQa123!";
const SUFFIX = Date.now().toString(36);
const SLUG = `zc-${SUFFIX}`;
const DUP = `zc-copy-${SUFFIX}`;
const PLAN_NAME = `Growth ${SUFFIX}`;
const COMPANY_NAME = `${RUN_TAG} Plan Versions Co`;
const ADMIN_EMAIL = `${RUN_TAG.toLowerCase()}.versions-admin@example.test`;
const FIXED = ["free", "starter", "professional", "business", "enterprise"];

type Auth = { token: string; user: { id: number; companyId: number | null; email: string; role?: string } };

let platform: Auth;
let admin: Auth;
let companyId = 0;
let v1Id = 0;
let v2Id = 0;

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

async function seedAs(page: Page, auth: Auth, theme: "light" | "dark" = "light") {
  await page.addInitScript(
    ([t, u, cid, th, userId]) => {
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
    [auth.token, JSON.stringify(auth.user), String(auth.user.companyId ?? ""), theme, String(auth.user.id)] as const,
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

/** Opens a shadcn/Radix select by test id and picks an option by accessible name. The cards around the select load
 *  asynchronously and can shift the trigger to the edge of the viewport while the popper is open, so the trigger is
 *  let settle and centred first, and the option is only clicked once its box lies inside the viewport (otherwise the
 *  popper is closed and the attempt repeated). No assertion of the calling test is affected. */
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
const pageOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const limitsOf = (rows: Array<{ resource: string; limit: number | null; source: string }>) => Object.fromEntries(rows.map((l) => [l.resource, { limit: l.limit, source: l.source }]));
const versions = async () => (await api("GET", `/platform/plans/${SLUG}/versions`, undefined, platform.token)).json;
const subscription = async () => (await api("GET", `/platform/subscriptions/${companyId}`, undefined, platform.token)).json;
const tenantLimits = async () => limitsOf((await api("GET", "/subscriptions/current", undefined, admin.token)).json.limits);

test.beforeAll(async () => {
  platform = await login(PLATFORM.email, PLATFORM.password);
  const company = await api("POST", "/companies", { name: COMPANY_NAME, plan: "free", industry: "QA" }, platform.token);
  expect(company.status, company.text).toBe(201);
  companyId = company.json.id;
  const user = await api("POST", "/users", { email: ADMIN_EMAIL, name: "Versions Admin", role: "primary_admin", companyId, password: PASSWORD }, platform.token);
  expect(user.status, user.text).toBe(201);
  admin = await login(ADMIN_EMAIL, PASSWORD);
});

test.afterAll(async () => {
  // Best-effort cleanup through the API only: the tenant first (frees the plan), then the plan is archived
  // (the API never deletes a published plan; an archived test plan with a unique slug is inert in the local DB).
  if (!platform) return;
  if (companyId) await api("DELETE", `/companies/${companyId}`, undefined, platform.token);
  await api("POST", `/platform/plans/${SLUG}/archive`, undefined, platform.token);
});

test("platform owner: create → edit → validate → publish → pin → publish v2 (grandfathering) → compare → preview → retire → immutability", async ({ page }) => {
  const errors = trackConsole(page);
  await seedAs(page, platform);
  await page.goto("/platform/plans");
  await expect(page.getByTestId("platform-plans")).toBeVisible();

  // The five fixed plans are present and published.
  for (const id of FIXED) {
    await expect(page.getByTestId(`plan-row-${id}`)).toBeVisible();
    await expect(page.getByTestId(`plan-status-${id}`)).toContainText("Published");
  }

  // 1. Create a draft plan from the UI.
  await page.getByTestId("plan-create-open").click();
  await expect(page.getByTestId("plan-create-dialog")).toBeVisible();
  await page.getByTestId("plan-create-id").fill(SLUG);
  await page.getByTestId("plan-create-name").fill(PLAN_NAME);
  await page.getByTestId("plan-create-submit").click();
  await expect(page.getByTestId("plan-create-dialog")).toBeHidden();
  await expect(page.getByTestId(`plan-row-${SLUG}`)).toBeVisible();
  await expect(page.getByTestId(`plan-status-${SLUG}`)).toContainText("Draft");
  await expect(page.getByTestId("plan-detail-title")).toHaveText(PLAN_NAME);
  await expect(page.getByTestId("version-editor")).toBeVisible();
  await expect(page.getByTestId("version-state")).toContainText("Draft");
  const created = (await api("GET", `/platform/plans/${SLUG}`, undefined, platform.token)).json;
  expect(created).toMatchObject({ id: SLUG, status: "draft", isActive: false, seeded: false });
  // A draft plan is not assignable (API) and not offered to tenants.
  const draftAssign = await api("POST", `/platform/subscriptions/${companyId}/plan`, { plan: SLUG }, platform.token);
  expect(draftAssign.status).toBe(400);
  expect(draftAssign.json.code).toBe("INVALID_PLAN");

  // 2. Edit the draft: limits, feature matrix, trial policy; save.
  await page.getByTestId("version-limit-contacts").fill("25");
  await page.getByTestId("version-limit-admins").fill("2");
  await page.getByTestId("version-feature-ai.assistant").click();
  await page.getByTestId("version-trial-days").fill("7");
  await page.getByTestId("version-save").click();
  await expect.poll(async () => (await versions()).versions[0]?.snapshot.limits.contacts, { timeout: 10_000 }).toBe(25);
  const afterSave = await versions();
  expect(afterSave.versions).toHaveLength(1);
  v1Id = afterSave.versions[0].id;
  expect(afterSave.versions[0]).toMatchObject({ version: 1, state: "draft" });
  expect(afterSave.versions[0].snapshot.limits).toMatchObject({ contacts: 25, admins: 2 });
  expect(afterSave.versions[0].snapshot.features["ai.assistant"]).toBe(true);
  expect(afterSave.versions[0].trialPolicy.trialDays).toBe(7);

  // 3. Validate: publishable.
  await page.getByTestId("version-validate").click();
  const validation = page.getByTestId("version-validation");
  await expect(validation).toBeVisible();
  await expect(validation).toHaveAttribute("data-publishable", "true");

  // 4. Publish v1 with the confirmation dialog (impact: nobody moves).
  await page.getByTestId("version-publish-open").click();
  const publishDialog = page.getByTestId("publish-dialog"); // the panel also shows an impact summary, so scope to the dialog
  await expect(publishDialog).toBeVisible();
  await expect(publishDialog.getByTestId("impact-moved")).toHaveText("0");
  await page.getByTestId("publish-confirm").click();
  await expect(publishDialog).toBeHidden();
  await expect(page.getByTestId("version-state")).toContainText("Published");
  await expect(page.getByTestId("version-immutable-notice")).toContainText("immutable");
  await expect(page.getByTestId(`plan-status-${SLUG}`)).toContainText("Published");
  const published = (await api("GET", `/platform/plans/${SLUG}`, undefined, platform.token)).json;
  expect(published).toMatchObject({ status: "published", isActive: true, versioning: "versioned" });
  expect(published.currentVersion.version).toBe(1);
  expect(published.limits.contacts).toBe(25);

  // 5. Assign the tenant: it is pinned to v1 and its enforcement limits follow v1.
  const assign = await api("POST", `/platform/subscriptions/${companyId}/plan`, { plan: SLUG }, platform.token);
  expect(assign.status, assign.text).toBe(200);
  expect(assign.json).toMatchObject({ plan: SLUG, planVersionId: v1Id, planVersion: 1 });
  expect((await tenantLimits()).contacts).toEqual({ limit: 25, source: "plan" });

  // 6. New draft (v2) that TIGHTENS contacts; publishing it never moves the pinned tenant.
  await page.getByTestId("version-new-draft").click();
  await expect(page.getByTestId("version-editor")).toBeVisible();
  await expect(page.getByTestId("version-title")).toContainText("v2");
  await expect(page.getByTestId("version-limit-contacts")).toHaveValue("25"); // pre-filled from v1
  await page.getByTestId("version-limit-contacts").fill("10");
  await page.getByTestId("version-save").click();
  await expect.poll(async () => (await versions()).versions.find((v: any) => v.version === 2)?.snapshot.limits.contacts, { timeout: 10_000 }).toBe(10);
  v2Id = (await versions()).versions.find((v: any) => v.version === 2).id;
  await page.getByTestId("version-publish-open").click();
  await expect(publishDialog).toBeVisible();
  await expect(publishDialog.getByTestId("impact-moved")).toHaveText("0");
  await expect(publishDialog.getByTestId("impact-tightened")).toContainText("contacts");
  await expect(publishDialog.getByTestId("impact-diff")).toContainText("contacts");
  await page.getByTestId("publish-confirm").click();
  await expect(publishDialog).toBeHidden();
  await expect(page.getByTestId("version-state")).toContainText("current");
  await expect(page.getByTestId(`version-state-${v1Id}`)).toHaveText("Published");
  await expect(page.getByTestId(`version-subs-${v1Id}`)).toHaveText("1");
  await expect(page.getByTestId(`version-subs-${v2Id}`)).toHaveText("0");
  // Grandfathering: the tenant stays on v1 with v1's limits; the plan row mirrors v2 for NEW assignments.
  expect(await subscription()).toMatchObject({ plan: SLUG, planVersionId: v1Id, planVersion: 1 });
  expect((await tenantLimits()).contacts).toEqual({ limit: 25, source: "plan" });
  expect((await api("GET", `/platform/plans/${SLUG}`, undefined, platform.token)).json.limits.contacts).toBe(10);

  // 7. Compare v2 with v1.
  await pickOption(page, "compare-select", /^v1 /);
  const cmpRow = page.getByTestId("compare-row-limits-contacts");
  await expect(cmpRow).toBeVisible();
  await expect(cmpRow).toHaveAttribute("data-changed", "true");
  await expect(cmpRow).toContainText("10");
  await expect(cmpRow).toContainText("25");
  await expect(page.getByTestId("compare-row-limits-admins")).toHaveAttribute("data-changed", "false");

  // 8. Per-version effective-limit preview for the pinned tenant: v2 → 10, v1 → 25; nothing changes.
  await pickOption(page, "preview-plan", PLAN_NAME);
  await page.getByTestId("preview-search").fill(COMPANY_NAME);
  await page.getByTestId(`preview-pick-${companyId}`).click();
  await expect(page.getByTestId("preview-effective-contacts")).toHaveText("10");
  await expect(page.getByTestId("preview-version-label")).toContainText("v2");
  await pickOption(page, "preview-version", /^v1 /);
  await expect(page.getByTestId("preview-effective-contacts")).toHaveText("25");
  await expect(page.getByTestId("preview-version-label")).toContainText("v1");
  expect(await subscription()).toMatchObject({ planVersionId: v1Id });

  // 9. Retire v1: its subscriber is kept and stays pinned; v1 becomes Retired.
  await page.getByTestId(`version-open-${v1Id}`).click();
  await expect(page.getByTestId("version-title")).toContainText("v1");
  await page.getByTestId("version-retire-open").click();
  await expect(page.getByTestId("retire-dialog")).toBeVisible();
  await expect(page.getByTestId("retire-kept")).toHaveText("1");
  await page.getByTestId("retire-confirm").click();
  await expect(page.getByTestId("retire-dialog")).toBeHidden();
  await expect(page.getByTestId("version-state")).toContainText("Retired");
  expect(await subscription()).toMatchObject({ planVersionId: v1Id, planVersion: 1 });
  expect((await tenantLimits()).contacts).toEqual({ limit: 25, source: "plan" });

  // 10. Immutability and protection (API): published versions reject edits + deletion; the last published version cannot retire.
  const patch = await api("PATCH", `/platform/plans/${SLUG}/versions/${v2Id}`, { name: "Mutated" }, platform.token);
  expect(patch.status).toBe(409);
  expect(patch.json.code).toBe("VERSION_IMMUTABLE");
  const del = await api("DELETE", `/platform/plans/${SLUG}/versions/${v2Id}`, undefined, platform.token);
  expect(del.status).toBe(409);
  const lastRetire = await api("POST", `/platform/plans/${SLUG}/versions/${v2Id}/retire`, undefined, platform.token);
  expect(lastRetire.status).toBe(409);
  expect(lastRetire.json.code).toBe("LAST_PUBLISHED_VERSION");
  const finalVersions = await versions();
  expect(finalVersions.versions.map((v: any) => [v.version, v.state])).toEqual([[1, "retired"], [2, "published"]]);
  expect(finalVersions.currentVersionId).toBe(v2Id);

  expect(await pageOverflow(page)).toBe(0);
  expect(errors, errors.join("\n")).toEqual([]);
});

test("platform owner: duplicate creates a draft copy without prices; deleting the only draft of a never-published plan removes it", async ({ page }) => {
  const errors = trackConsole(page);
  await seedAs(page, platform);
  await page.goto(`/platform/plans?plan=${SLUG}`);
  await expect(page.getByTestId("plan-detail-title")).toHaveText(PLAN_NAME);

  await page.getByTestId("plan-duplicate-open").click();
  await expect(page.getByTestId("plan-duplicate-dialog")).toBeVisible();
  await page.getByTestId("plan-duplicate-id").fill(DUP);
  await page.getByTestId("plan-duplicate-submit").click();
  await expect(page.getByTestId("plan-duplicate-dialog")).toBeHidden();
  await expect(page.getByTestId(`plan-row-${DUP}`)).toBeVisible();
  await expect(page.getByTestId(`plan-status-${DUP}`)).toContainText("Draft");
  await expect(page.getByTestId("version-editor")).toBeVisible();
  await expect(page.getByTestId("version-limit-contacts")).toHaveValue("10"); // copied from the current version (v2)
  const copy = (await api("GET", `/platform/plans/${DUP}`, undefined, platform.token)).json;
  expect(copy).toMatchObject({ status: "draft", prices: [] });
  expect(copy.limits.contacts).toBe(10);

  // Deleting the copy's only draft removes the never-published plan.
  await page.getByTestId("version-delete-open").click();
  await expect(page.getByTestId("delete-dialog")).toBeVisible();
  await page.getByTestId("delete-confirm").click();
  await expect(page.getByTestId("delete-dialog")).toBeHidden();
  await expect(page.getByTestId(`plan-row-${DUP}`)).toHaveCount(0);
  expect((await api("GET", `/platform/plans/${DUP}`, undefined, platform.token)).status).toBe(404);
  // The source plan is untouched.
  expect((await versions()).versions.map((v: any) => [v.version, v.state])).toEqual([[1, "retired"], [2, "published"]]);

  expect(await pageOverflow(page)).toBe(0);
  expect(errors, errors.join("\n")).toEqual([]);
});

test("tenant isolation: a company admin never renders /platform/plans and every Plan Builder mutation is refused by the API (403) without side effects", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, boolean>;
    w.__platform_seen = false;
    const check = () => {
      if (document.body?.innerText?.includes("Platform Portal")) w.__platform_seen = true;
      if (document.querySelector('[data-testid="platform-plans"]')) w.__platform_seen = true;
    };
    new MutationObserver(check).observe(document.documentElement, { childList: true, subtree: true });
  });
  await seedAuth(page); // TechCorp primary_admin
  await page.goto("/platform/plans");
  await page.waitForURL("**/admin");
  await expect(page.getByTestId("platform-plans")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as Record<string, boolean>).__platform_seen)).toBe(false);

  const forbidden = `zc-forbidden-${SUFFIX}`;
  const attempts: Array<[string, string, unknown?]> = [
    ["POST", "/platform/plans", { id: forbidden, name: "Forbidden" }],
    ["POST", `/platform/plans/${SLUG}/duplicate`, { id: forbidden }],
    ["POST", `/platform/plans/${SLUG}/archive`],
    ["POST", `/platform/plans/${SLUG}/versions`, {}],
    ["PATCH", `/platform/plans/${SLUG}/versions/${v2Id}`, { name: "x" }],
    ["DELETE", `/platform/plans/${SLUG}/versions/${v2Id}`],
    ["POST", `/platform/plans/${SLUG}/versions/${v2Id}/publish`],
    ["POST", `/platform/plans/${SLUG}/versions/${v2Id}/retire`],
    ["GET", `/platform/plans/${SLUG}/versions`],
  ];
  for (const [method, path, body] of attempts) {
    const r = await api(method, path, body, admin.token);
    expect(r.status, `${method} ${path}`).toBe(403);
  }
  expect((await api("POST", "/platform/plans", { id: forbidden, name: "Forbidden" })).status).toBe(401);
  // No side effect: the forbidden plan does not exist and the real plan is unchanged.
  expect((await api("GET", `/platform/plans/${forbidden}`, undefined, platform.token)).status).toBe(404);
  expect((await versions()).versions.map((v: any) => [v.version, v.state])).toEqual([[1, "retired"], [2, "published"]]);
});

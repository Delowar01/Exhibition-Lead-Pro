import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/workspace";
import { API_BASE, RUN_TAG } from "./fixtures/seed-values";

/**
 * ZE. Batch 42 — PB-4 billing, version migration and plan history through the browser.
 *
 * Runs against the local stack (fake billing provider) with the API as the oracle. Proves:
 *   • the platform owner records platform-managed (manual) prices on a draft, registers a
 *     verified provider price BOUND to that draft from Subscriptions, sees scope + verification
 *     state in the mappings, validates and publishes — the published snapshot shows the
 *     monthly / annual summaries and the captured mapping;
 *   • the change-plan dialog previews the target version: a blocked downgrade (usage over the
 *     target limit) disables the confirmation, a tenant override lifts it, a feature-only
 *     downgrade needs the explicit checkbox; the change is applied and audited;
 *   • the migration dialog: dry run with per-tenant reasons (a blocked downgrade is reported,
 *     never migrated; feature confirmation required), confirmation, execution of exactly the
 *     reviewed set and the result summary (the provider-managed exclusion is proven by the API suite);
 *   • the tenant's plan / version history shows the original, the current version and every
 *     change (direct / migration).
 * The UI never bypasses the server: every decision shown is read back from the API.
 */

const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PASSWORD = "PlanQa123!";
const SUFFIX = Date.now().toString(36);
const SLUG = `ze-${SUFFIX}`;
const PLAN_NAME = `Priced ${SUFFIX}`;
const PRICE_ID = `price_fake_eur_${(Date.now() % 900000) + 100000}_month`; // unique amount per run
const TENANT_ADMIN = `${RUN_TAG.toLowerCase()}.ze-admin@example.test`;
const BLOCKED_ADMIN = `${RUN_TAG.toLowerCase()}.ze-blocked-admin@example.test`;
const FEATURES = ["ai.assistant", "ai.command_center", "workflow.intelligence", "executive.intelligence", "exports.scheduled", "nfc.capture", "documents", "api.access"];

type Auth = { token: string; user: { id: number; companyId: number | null; email: string } };

let platform: Auth;
let v1Id = 0;
let v2Id = 0;
let changeCompanyId = 0; // the change-plan tenant (3 contacts)
let migA = 0;
let migB = 0;
let migC = 0; // blocked by the target limit (3 contacts > contacts 2)
let priceRowId = 0;

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

/** Same viewport-safe Radix select helper as zc-plan-versions / zd-entitlements. */
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

const subscription = async (cid: number) => (await api("GET", `/platform/subscriptions/${cid}`, undefined, platform.token)).json;

test.beforeAll(async () => {
  platform = await login(PLATFORM.email, PLATFORM.password);
  // A published plan (v1: legacy, contacts 25) is the base; the browser creates and prices v2.
  const created = await api("POST", "/platform/plans", { id: SLUG, name: PLAN_NAME, limits: { contacts: 25 }, features: {} }, platform.token);
  expect(created.status, created.text).toBe(201);
  v1Id = created.json.draft.id;
  const published = await api("POST", `/platform/plans/${SLUG}/versions/${v1Id}/publish`, undefined, platform.token);
  expect(published.status, published.text).toBe(200);
  // Tenants: the change-plan tenant (on free, 3 contacts) and three migration tenants on v1 (one provider-managed).
  const mk = async (name: string) => {
    const res = await api("POST", "/companies", { name, plan: "free", industry: "QA" }, platform.token);
    expect(res.status, res.text).toBe(201);
    return res.json.id as number;
  };
  changeCompanyId = await mk(`${RUN_TAG} ZE Change Co`);
  migA = await mk(`${RUN_TAG} ZE Mig A`);
  migB = await mk(`${RUN_TAG} ZE Mig B`);
  migC = await mk(`${RUN_TAG} ZE Mig Blocked`);
  const user = await api("POST", "/users", { email: TENANT_ADMIN, name: "ZE Admin", role: "primary_admin", companyId: changeCompanyId, password: PASSWORD }, platform.token);
  expect(user.status, user.text).toBe(201);
  const tenant = await login(TENANT_ADMIN, PASSWORD);
  for (let i = 0; i < 3; i++) {
    const c = await api("POST", "/contacts", { firstName: `Lead${i}`, lastName: "ZE", email: `ze-lead${i}-${SUFFIX}@example.test` }, tenant.token);
    expect(c.status, c.text).toBe(201);
  }
  for (const cid of [migA, migB, migC]) {
    const res = await api("POST", `/platform/subscriptions/${cid}/plan`, { plan: SLUG, planVersionId: v1Id }, platform.token);
    expect(res.status, res.text).toBe(200);
  }
  const blockedUser = await api("POST", "/users", { email: BLOCKED_ADMIN, name: "ZE Blocked Admin", role: "primary_admin", companyId: migC, password: PASSWORD }, platform.token);
  expect(blockedUser.status, blockedUser.text).toBe(201);
  const blocked = await login(BLOCKED_ADMIN, PASSWORD);
  for (let i = 0; i < 3; i++) {
    const c = await api("POST", "/contacts", { firstName: `Blocked${i}`, lastName: "ZE", email: `ze-blocked${i}-${SUFFIX}@example.test` }, blocked.token);
    expect(c.status, c.text).toBe(201);
  }
});

test("platform owner: price a new draft (manual summaries + a bound provider mapping), validate and publish v2 — the snapshot keeps monthly / annual prices and the captured mapping", async ({ page }) => {
  const errors = trackConsole(page);
  await seedAs(page, platform);
  await page.goto(`/platform/plans?plan=${SLUG}`);
  await expect(page.getByTestId("plan-detail-title")).toHaveText(PLAN_NAME);
  await expect(page.getByTestId("version-state")).toContainText("Published");
  await expect(page.getByTestId("snapshot-manual-prices")).toHaveAttribute("data-count", "0");
  await expect(page.getByTestId("price-mappings-empty")).toBeVisible();

  // New draft v2 with an enforced matrix (documents off) and contacts 2 → the downgrade material for the next tests.
  await page.getByTestId("version-new-draft").click();
  await expect(page.getByTestId("version-editor")).toBeVisible();
  await expect(page.getByTestId("version-title")).toContainText("v2");
  await page.getByTestId("version-limit-contacts").fill("2");
  await expect(page.getByTestId("version-feature-documents")).toHaveAttribute("data-state", "checked");
  await page.getByTestId("version-feature-documents").click();
  await expect(page.getByTestId("version-feature-documents")).toHaveAttribute("data-state", "unchecked");
  await pickOption(page, "version-enforcement-select", /^Enforced/);
  // Manual (platform-managed) prices: monthly + annual.
  await expect(page.getByTestId("manual-prices-empty")).toBeVisible();
  await page.getByTestId("manual-price-add").click();
  await page.getByTestId("manual-price-currency-0").fill("eur");
  await page.getByTestId("manual-price-amount-0").fill("19.00");
  await page.getByTestId("manual-price-label-0").fill("Monthly");
  await page.getByTestId("manual-price-add").click();
  await pickOption(page, "manual-price-interval-1", "Year");
  await page.getByTestId("manual-price-currency-1").fill("eur");
  await page.getByTestId("manual-price-amount-1").fill("190.00");
  await page.getByTestId("version-save").click();
  await expect(page.getByTestId("version-save-errors")).toHaveCount(0);
  const versions = (await api("GET", `/platform/plans/${SLUG}/versions`, undefined, platform.token)).json.versions as any[];
  v2Id = versions.find((v) => v.version === 2).id;
  await expect
    .poll(async () => (await api("GET", `/platform/plans/${SLUG}/versions/${v2Id}`, undefined, platform.token)).json.manualPrices?.length ?? 0)
    .toBe(2);
  const saved = (await api("GET", `/platform/plans/${SLUG}/versions/${v2Id}`, undefined, platform.token)).json;
  expect(saved.manualPrices).toEqual([
    { interval: "month", intervalCount: 1, currency: "eur", unitAmountMinor: 1900, label: "Monthly" },
    { interval: "year", intervalCount: 1, currency: "eur", unitAmountMinor: 19000, label: null },
  ]);
  expect(saved.snapshot.limits.contacts).toBe(2);
  expect(saved.snapshot.features.documents).toBe(false);
  expect(saved.featureEnforcement).toBe("enforced");

  // Register a provider price BOUND to draft v2 from Subscriptions.
  await page.goto("/platform/subscriptions");
  await expect(page.getByTestId("prices-card")).toBeVisible();
  await pickOption(page, "price-plan", new RegExp(`^${SLUG}$`));
  await pickOption(page, "price-version", "Bind to draft v2");
  await page.getByTestId("price-id").fill(PRICE_ID);
  await page.getByTestId("price-register").click();
  await expect
    .poll(async () => ((await api("GET", "/platform/billing/prices", undefined, platform.token)).json.prices as any[]).find((p) => p.planId === SLUG)?.id ?? 0)
    .toBeGreaterThan(0);
  const registered = ((await api("GET", "/platform/billing/prices", undefined, platform.token)).json.prices as any[]).find((p) => p.planId === SLUG);
  priceRowId = registered.id;
  expect(registered).toMatchObject({ scope: "version", planVersionId: v2Id, planVersion: 2, planVersionState: "draft", verified: true, modeMatches: true, currency: "eur", interval: "month" });
  await expect(page.getByTestId(`price-row-${priceRowId}`)).toBeVisible();
  await expect(page.getByTestId(`price-scope-${priceRowId}`)).toContainText("v2");
  await expect(page.getByTestId(`price-scope-${priceRowId}`)).toContainText("draft");
  await expect(page.getByTestId(`price-verified-${priceRowId}`)).toContainText("Verified");

  // Back on the plan: the draft shows the bound mapping; validation lists the manual price shadowed by it; publish.
  await page.goto(`/platform/plans?plan=${SLUG}`);
  await page.getByTestId(`version-open-${v2Id}`).click();
  await expect(page.getByTestId("version-title")).toContainText("v2");
  await expect(page.getByTestId("version-editor")).toBeVisible();
  await expect(page.getByTestId("manual-price-amount-0")).toHaveValue("19.00");
  await expect(page.getByTestId("manual-price-amount-1")).toHaveValue("190.00");
  // The draft editor and the (auto-run) validation panel each list the mappings: scope to the editor's list.
  const draftMappings = page.getByTestId("draft-price-mappings");
  const mapping = draftMappings.getByTestId(`mapping-row-${priceRowId}`);
  await expect(mapping).toHaveAttribute("data-scope", "version");
  await expect(mapping).toHaveAttribute("data-verified", "true");
  await expect(draftMappings.getByTestId(`mapping-scope-${priceRowId}`)).toContainText("Bound to this version");
  await page.getByTestId("version-validate").click();
  const validation = page.getByTestId("version-validation");
  await expect(validation).toHaveAttribute("data-publishable", "true");
  await expect(validation).toContainText(/shadowed|provider price for the same period/i);
  await expect(validation.getByTestId("validation-price-mappings")).toBeVisible();
  await page.getByTestId("version-publish-open").click();
  const publishDialog = page.getByTestId("publish-dialog");
  await expect(publishDialog).toBeVisible();
  await expect(publishDialog.getByTestId("impact-moved")).toHaveText("0");
  await page.getByTestId("publish-confirm").click();
  await expect(publishDialog).toBeHidden();
  await expect(page.getByTestId("version-state")).toContainText("Published");
  await expect(page.getByTestId("snapshot-manual-prices")).toHaveAttribute("data-count", "2");
  await expect(page.getByTestId("manual-prices-monthly")).toContainText("19.00");
  await expect(page.getByTestId("manual-prices-annual")).toContainText("190.00");
  await expect(page.getByTestId("snapshot-price-mappings").getByTestId(`mapping-scope-${priceRowId}`)).toContainText("captured at publication");
  const after = (await api("GET", `/platform/plans/${SLUG}/versions/${v2Id}`, undefined, platform.token)).json;
  expect(after.publishedAt).toBeTruthy();
  expect(after.snapshot.prices.map((p: any) => p.id)).toContain(priceRowId);
  // The published pricing is immutable: binding another price to v2 is refused by the server.
  const refused = await api("POST", "/platform/billing/prices", { planId: SLUG, providerPriceId: "price_fake_eur_777700_month", planVersionId: v2Id }, platform.token);
  expect(refused.status).toBe(409);
  expect(refused.json.code).toBe("VERSION_NOT_DRAFT");
  // The pinned v1 subscribers did not move.
  for (const cid of [migA, migB, migC]) expect((await subscription(cid)).planVersionId).toBe(v1Id);
  expect(errors).toEqual([]);
});

test("platform owner: change-plan dialog — blocked downgrade (usage over the target limit), override lifts it, feature-only downgrade needs confirmation; the change is applied and audited", async ({ page }) => {
  const errors = trackConsole(page);
  await seedAs(page, platform);
  await page.goto("/platform/subscriptions");
  await expect(page.getByTestId(`sub-row-${changeCompanyId}`)).toBeVisible();
  await page.getByTestId(`sub-manage-${changeCompanyId}`).click();
  await expect(page.getByTestId("sub-detail")).toBeVisible();
  await page.getByTestId("action-set_plan").click();
  await expect(page.getByTestId("lifecycle-dialog")).toBeVisible();
  await pickOption(page, "plan-select", new RegExp(`^${SLUG}$`));
  // Current published version = v2 (contacts 2, documents off): 3 contacts block the change.
  const preview = page.getByTestId("plan-change-preview");
  await expect(preview).toHaveAttribute("data-eligible", "false");
  await expect(page.getByTestId("preview-target")).toContainText("v2");
  await expect(page.getByTestId("preview-kind")).toContainText("plan change");
  await expect(page.getByTestId("preview-blocking")).toContainText("contacts");
  await expect(page.getByTestId("preview-blocking")).toContainText("3 used, limit 2");
  await expect(page.getByTestId("preview-lost-features")).toContainText("documents");
  await expect(page.getByTestId("lifecycle-confirm")).toBeDisabled();
  // v1 (explicit, published non-current) is eligible: no feature loss, contacts 25.
  await pickOption(page, "plan-version-select", /^v1 ·/);
  await expect(page.getByTestId("preview-target")).toContainText("v1");
  await expect(preview).toHaveAttribute("data-eligible", "true");
  await expect(page.getByTestId("preview-blocking")).toHaveCount(0);
  await expect(page.getByTestId("preview-lost-features")).toHaveCount(0);
  await expect(page.getByTestId("lifecycle-confirm")).toBeEnabled();
  // Back to v2 → blocked again; a tenant override (API) lifts the block, then the feature confirmation gates the button.
  await pickOption(page, "plan-version-select", /^v2 ·/);
  await expect(preview).toHaveAttribute("data-eligible", "false");
  const override = await api("PUT", `/platform/subscriptions/${changeCompanyId}/limits`, { limits: { contacts: 10 } }, platform.token);
  expect(override.status, override.text).toBe(200);
  await pickOption(page, "plan-version-select", /^v1 ·/);
  await pickOption(page, "plan-version-select", /^v2 ·/); // re-evaluates with the override in place
  await expect(preview).toHaveAttribute("data-eligible", "true");
  await expect(page.getByTestId("preview-blocking")).toHaveCount(0);
  await expect(page.getByTestId("preview-limit-contacts")).toContainText("override");
  await expect(page.getByTestId("preview-lost-features")).toContainText("documents");
  await expect(page.getByTestId("lifecycle-confirm")).toBeDisabled();
  await page.getByTestId("plan-change-confirm-features").click();
  await expect(page.getByTestId("lifecycle-confirm")).toBeEnabled();
  await page.getByTestId("plan-change-reason").fill("ZE browser change");
  await page.getByTestId("lifecycle-confirm").click();
  await expect(page.getByTestId("lifecycle-dialog")).toHaveCount(0);
  await expect.poll(async () => (await subscription(changeCompanyId)).planVersionId).toBe(v2Id);
  const sub = await subscription(changeCompanyId);
  expect(sub).toMatchObject({ plan: SLUG, planVersionId: v2Id });
  expect(sub.entitlements?.features?.documents).toBe(false);
  // The tenant lost documents immediately (server decision, not the UI's).
  const tenant = await login(TENANT_ADMIN, PASSWORD);
  const docs = await api("GET", "/documents", undefined, tenant.token);
  expect(docs.status).toBe(403);
  expect(docs.json.code).toBe("FEATURE_NOT_ENTITLED");
  // History inside the detail dialog.
  await expect(page.getByTestId("plan-history-summary")).toContainText(`${SLUG} v2`);
  await page.getByTestId("plan-history-toggle").click();
  const history = (await api("GET", `/platform/subscriptions/${changeCompanyId}/plan-history`, undefined, platform.token)).json;
  expect(history.entries.map((e: any) => e.kind)).toEqual(["created", "direct_change"]);
  expect(history.entries[1]).toMatchObject({ reason: "ZE browser change", confirmFeatureDowngrade: true, lostFeatures: ["documents"], toVersionId: v2Id });
  await expect(page.getByTestId(`plan-history-row-${history.entries[1].auditId}`)).toHaveAttribute("data-kind", "direct_change");
  await expect(page.getByTestId(`plan-history-row-${history.entries[1].auditId}`)).toContainText("ZE browser change");
  expect(errors).toEqual([]);
});

test("platform owner: migrate v1 tenants to v2 — dry run with reasons, confirmation, execution of the reviewed set, result summary and history", async ({ page }) => {
  const errors = trackConsole(page);
  await seedAs(page, platform);
  // One of the v1 tenants holds 3 contacts: v2 (contacts 2) blocks it (U6) — reported, never migrated, nothing deleted.
  await page.goto(`/platform/plans?plan=${SLUG}`);
  await page.getByTestId(`version-open-${v2Id}`).click();
  await expect(page.getByTestId("version-title")).toContainText("v2");
  await page.getByTestId("version-migrate-open").click();
  const dialog = page.getByTestId("migrate-dialog");
  await expect(dialog).toBeVisible();
  await pickOption(page, "migrate-source", /^v1 ·/);
  await page.getByTestId("migrate-reason").fill("ZE migration");
  await expect(page.getByTestId("migrate-execute")).toBeDisabled();
  await page.getByTestId("migrate-dry-run").click();
  await expect(page.getByTestId("migrate-review")).toBeVisible();
  await expect(page.getByTestId(`migrate-row-${migA}`)).toHaveAttribute("data-reason", "FEATURE_DOWNGRADE_CONFIRMATION_REQUIRED");
  await expect(page.getByTestId(`migrate-row-${migB}`)).toHaveAttribute("data-reason", "FEATURE_DOWNGRADE_CONFIRMATION_REQUIRED");
  await expect(page.getByTestId(`migrate-row-${migC}`)).toHaveAttribute("data-reason", "DOWNGRADE_BLOCKED");
  await expect(page.getByTestId(`migrate-row-${migC}`)).toContainText("contacts 3/2");
  await expect(page.getByTestId("migrate-summary")).toContainText("0 eligible");
  await expect(page.getByTestId("migrate-execute")).toBeDisabled();
  // Confirm the feature-only downgrade → the review is invalidated and must be run again.
  await page.getByTestId("migrate-confirm-features").click();
  await expect(page.getByTestId("migrate-review")).toHaveCount(0);
  await page.getByTestId("migrate-dry-run").click();
  await expect(page.getByTestId("migrate-review")).toBeVisible();
  await expect(page.getByTestId(`migrate-row-${migA}`)).toHaveAttribute("data-reason", "ELIGIBLE");
  await expect(page.getByTestId(`migrate-row-${migB}`)).toHaveAttribute("data-reason", "ELIGIBLE");
  await expect(page.getByTestId(`migrate-row-${migC}`)).toHaveAttribute("data-reason", "DOWNGRADE_BLOCKED");
  await expect(page.getByTestId("migrate-summary")).toContainText("2 eligible");
  await expect(page.getByTestId("migrate-digest")).toContainText("review");
  await expect(page.getByTestId("migrate-execute")).toBeEnabled();
  await page.getByTestId("migrate-execute").click();
  await expect(page.getByTestId("migrate-result")).toBeVisible();
  await expect(page.getByTestId("migrate-complete")).toHaveText("complete");
  await expect(page.getByTestId("migrate-summary")).toContainText("2 migrated");
  await expect(page.getByTestId(`migrate-row-${migA}`)).toHaveAttribute("data-outcome", "migrated");
  await expect(page.getByTestId(`migrate-row-${migB}`)).toHaveAttribute("data-outcome", "migrated");
  await expect(page.getByTestId(`migrate-row-${migC}`)).toHaveAttribute("data-outcome", "not_attempted");
  await expect(page.getByTestId("migrate-execute")).toBeDisabled();
  await page.getByTestId("migrate-close").click();
  await expect(dialog).toBeHidden();
  // Oracle: exactly the reviewed set moved; the blocked tenant did not (and kept its contacts).
  for (const cid of [migA, migB]) {
    const sub = await subscription(cid);
    expect(sub.planVersionId).toBe(v2Id);
    const history = (await api("GET", `/platform/subscriptions/${cid}/plan-history`, undefined, platform.token)).json;
    const last = history.entries[history.entries.length - 1];
    expect(last).toMatchObject({ kind: "migration", source: "migration", reason: "ZE migration", fromVersionId: v1Id, toVersionId: v2Id, confirmFeatureDowngrade: true });
    expect(last.migrationId).toBeTruthy();
    expect(last.dryRunDigest).toMatch(/^[a-f0-9]{64}$/);
  }
  expect((await subscription(migC)).planVersionId).toBe(v1Id);
  const blockedTenant = await login(BLOCKED_ADMIN, PASSWORD);
  const blockedContacts = await api("GET", "/contacts", undefined, blockedTenant.token);
  expect(blockedContacts.status, blockedContacts.text).toBe(200);
  await expect(page.getByTestId(`version-subs-${v2Id}`)).toHaveText("3"); // change tenant + A + B
  await expect(page.getByTestId(`version-subs-${v1Id}`)).toHaveText("1"); // the blocked one
  // History in the subscription manager for a migrated tenant.
  await page.goto("/platform/subscriptions");
  await page.getByTestId(`sub-manage-${migA}`).click();
  await expect(page.getByTestId("sub-detail")).toBeVisible();
  await expect(page.getByTestId("plan-history-summary")).toContainText("Original free");
  await expect(page.getByTestId("plan-history-summary")).toContainText(`${SLUG} v2`);
  await page.getByTestId("plan-history-toggle").click();
  const historyA = (await api("GET", `/platform/subscriptions/${migA}/plan-history`, undefined, platform.token)).json;
  expect(historyA.entries.map((e: any) => e.kind)).toEqual(["created", "direct_change", "migration"]);
  const migrationRow = page.getByTestId(`plan-history-row-${historyA.entries[2].auditId}`);
  await expect(migrationRow).toHaveAttribute("data-kind", "migration");
  await expect(migrationRow).toContainText("ZE migration");
  await expect(migrationRow).toContainText("(batch)");
  expect(errors).toEqual([]);
});

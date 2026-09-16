import { Client } from "pg";
import type { Page } from "@playwright/test";
import { test, expect, seedAuth } from "./fixtures/workspace";
import { API_BASE, RUN_TAG } from "./fixtures/seed-values";

/**
 * Z. Batch 21 — Platform Owner admin panel (real Chromium, real login form).
 *
 * The platform owner onboards a tenant from the Companies list, opens the tenant
 * detail page, edits the profile, creates the tenant's primary administrator
 * (who can then sign in), manages the subscription through the shared manager,
 * suspends / reactivates with confirmation, filters the cross-tenant user
 * directory, and finally deletes the disposable tenant behind a type-the-name
 * confirmation. A tenant admin never reaches the panel (role routing + API 403).
 * Only uniquely stamped disposable data is created; everything is removed.
 */
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const COMPANY_NAME = `${RUN_TAG} Admin Panel Co`;
const tag = RUN_TAG.toLowerCase();
const ADMIN_EMAIL = `${tag}.panel-admin@example.test`;

// Deterministic per run: the panel generates a password, the test replaces it with
// this value so a later test can still sign the administrator in.
const ADMIN_PASSWORD = `${RUN_TAG}-Panel-42a!`;

let pg: Client;
let platformToken = "";
let companyId = 0;

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
/** Real platform-owner sign-in through the login form (no localStorage seeding). */
async function signInAsOwner(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Work Email").fill(PLATFORM.email);
  await page.getByLabel("Password", { exact: true }).fill(PLATFORM.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/platform/);
}

test.beforeAll(async () => {
  pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  const login = await api("POST", "/auth/login", PLATFORM);
  expect(login.status, login.text).toBe(200);
  platformToken = login.json.token;
});

/**
 * Playwright restarts the worker after a failure (module state is lost and the old
 * worker's afterAll cleanup runs): re-resolve the disposable tenant by its unique
 * name, recreating it — and its administrator — through the API when needed so
 * every test after the onboarding one can still run on its own.
 */
async function ensureCompany(opts: { withAdmin?: boolean } = { withAdmin: true }) {
  if (!companyId) {
    const found = await api("GET", `/companies?search=${encodeURIComponent(COMPANY_NAME)}`, undefined, platformToken);
    expect(found.status, found.text).toBe(200);
    if (found.json.companies.length === 1) companyId = found.json.companies[0].id;
    else {
      const created = await api("POST", "/companies", { name: COMPANY_NAME, plan: "free", industry: "QA", country: "AE" }, platformToken);
      expect(created.status, created.text).toBe(201);
      companyId = created.json.id;
    }
  }
  if (opts.withAdmin) {
    const users = await api("GET", `/users?companyId=${companyId}&search=${encodeURIComponent(ADMIN_EMAIL)}`, undefined, platformToken);
    expect(users.status, users.text).toBe(200);
    if (users.json.users.length === 0) {
      const admin = await api("POST", "/users", { email: ADMIN_EMAIL, name: "Panel Admin", role: "primary_admin", companyId, password: ADMIN_PASSWORD }, platformToken);
      expect(admin.status, admin.text).toBe(201);
    }
  }
}
const closeManager = (page: Page) => page.getByTestId("sub-detail").getByRole("button", { name: "Close" }).click();

test.afterAll(async () => {
  // The last test deletes the tenant through the panel; this is the safety net.
  const rows = await pg.query("select id from companies where name = $1", [COMPANY_NAME]);
  for (const r of rows.rows) {
    await pg.query("delete from audit_logs where company_id = $1", [r.id]);
    await pg.query("delete from audit_logs where entity_type = 'company' and entity_id = $1", [String(r.id)]);
    await pg.query("delete from users where company_id = $1", [r.id]);
    await pg.query("delete from companies where id = $1", [r.id]);
  }
  if (companyId) {
    await pg.query("delete from audit_logs where company_id = $1", [companyId]);
    await pg.query("delete from audit_logs where entity_type = 'company' and entity_id = $1", [String(companyId)]);
  }
  await pg.query("delete from login_attempts where email like $1", [`${tag}.panel-%@example.test`]);
  await pg.end();
});

test("companies list: real data with search and filters; a new tenant is onboarded from the panel and opens on its detail page", async ({ page }) => {
  await signInAsOwner(page);
  await page.goto("/platform/companies");
  await expect(page.getByTestId("platform-companies")).toBeVisible();
  await expect(page.getByTestId("company-total")).toContainText(/compan/);
  const list = await api("GET", "/companies?limit=1", undefined, platformToken);
  expect(list.status).toBe(200);
  await expect(page.getByTestId("company-total")).toHaveText(`${list.json.total.toLocaleString()} compan${list.json.total === 1 ? "y" : "ies"}`);
  // Search narrows to a seeded tenant.
  await page.getByTestId("company-search").fill("TechCorp");
  await expect(page.getByTestId("company-total")).toContainText(/^[1-9]\d* compan/);
  await expect(page.getByRole("link", { name: /TechCorp/ }).first()).toBeVisible();
  await page.getByTestId("company-search").fill("");
  // Onboarding dialog → created → detail page.
  await page.getByTestId("company-new").click();
  await expect(page.getByTestId("new-company-dialog")).toBeVisible();
  await page.getByTestId("new-company-name").fill(COMPANY_NAME);
  await page.getByTestId("new-company-industry").fill("QA");
  await page.getByTestId("new-company-country").fill("AE");
  await page.getByTestId("new-company-contact").fill("Panel Contact");
  await page.getByTestId("new-company-contact-email").fill(`${tag}.panel-contact@example.test`);
  await page.getByTestId("new-company-submit").click();
  await expect(page).toHaveURL(/\/platform\/companies\/\d+$/);
  companyId = Number(page.url().match(/\/platform\/companies\/(\d+)$/)?.[1]);
  expect(companyId).toBeGreaterThan(0);
  await expect(page.getByTestId("company-detail")).toBeVisible();
  await expect(page.getByRole("heading", { name: COMPANY_NAME })).toBeVisible();
  await expect(page.getByTestId("detail-status")).toHaveText("Trialing");
  await expect(page.getByTestId("detail-access")).toHaveText("Full access");
  await expect(page.getByTestId("detail-plan")).toHaveText("free");
  await expect(page.getByTestId("profile-primaryContactName")).toHaveText("Panel Contact");
  await expect(page.getByTestId("detail-usage")).toBeVisible();
  await expect(page.getByTestId("detail-usage-events")).toBeVisible();
  await expect(page.getByTestId("count-users")).toHaveText("0");
  // The canonical creation is already on the administrative trail.
  await expect(page.getByTestId("detail-audit").getByText("Subscription created")).toBeVisible();
});

test("tenant detail: edit profile, create the primary administrator (shown-once password) — the administrator can sign in", async ({ page }) => {
  await ensureCompany({ withAdmin: false });
  await signInAsOwner(page);
  await page.goto(`/platform/companies/${companyId}`);
  await expect(page.getByTestId("company-detail")).toBeVisible();
  // Edit profile.
  await page.getByTestId("detail-edit").click();
  await expect(page.getByTestId("edit-dialog")).toBeVisible();
  await page.getByTestId("edit-legalName").fill(`${COMPANY_NAME} FZ-LLC`);
  await page.getByTestId("edit-timezone").fill("Asia/Dubai");
  await page.getByTestId("edit-submit").click();
  await expect(page.getByTestId("edit-dialog")).toHaveCount(0);
  await expect(page.getByTestId("profile-legalName")).toHaveText(`${COMPANY_NAME} FZ-LLC`);
  await expect(page.getByTestId("profile-timezone")).toHaveText("Asia/Dubai");
  await expect(page.getByTestId("detail-audit").getByText("Company profile updated")).toBeVisible();
  // Team card: empty → add the first primary admin.
  await expect(page.getByTestId("detail-users").getByText("No accounts yet")).toBeVisible();
  await page.getByTestId("detail-add-admin").click();
  await expect(page.getByTestId("add-admin-dialog")).toBeVisible();
  await page.getByTestId("add-admin-name").fill("Panel Admin");
  await page.getByTestId("add-admin-email").fill(ADMIN_EMAIL);
  await page.getByTestId("add-admin-generate").click();
  const generated = await page.getByTestId("add-admin-password").inputValue();
  expect(generated.length).toBeGreaterThanOrEqual(12);
  await page.getByTestId("add-admin-password").fill(ADMIN_PASSWORD);
  await page.getByTestId("add-admin-submit").click();
  await expect(page.getByTestId("add-admin-created")).toBeVisible();
  await expect(page.getByTestId("add-admin-created-password")).toHaveText(ADMIN_PASSWORD);
  await page.getByTestId("add-admin-done").click();
  const adminRow = page.getByTestId("detail-users").getByRole("row").filter({ hasText: ADMIN_EMAIL });
  await expect(adminRow).toBeVisible();
  await expect(adminRow.getByText("Primary admin", { exact: true })).toBeVisible();
  await expect(adminRow.getByText("Active", { exact: true })).toBeVisible();
  await expect(page.getByTestId("count-users")).toHaveText("1");
  await expect(page.getByTestId("detail-audit").getByText("Administrator account created")).toBeVisible();
  await expect(page.getByTestId("detail-audit").getByText("role: Primary admin (by the platform)")).toBeVisible();
  // The new administrator signs in for real with the shown-once password.
  const adminLogin = await api("POST", "/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  expect(adminLogin.status, adminLogin.text).toBe(200);
  expect(adminLogin.json.user.companyId).toBe(companyId);
  expect(adminLogin.json.user.role).toBe("primary_admin");
  // Correction 1: a platform-owner action on this tenant's account is attributed to THIS tenant's trail.
  const adminId = adminLogin.json.user.id as number;
  expect((await api("POST", `/users/${adminId}/disable`, {}, platformToken)).status).toBe(200);
  expect((await api("POST", `/users/${adminId}/enable`, {}, platformToken)).status).toBe(200);
  await page.reload();
  await expect(page.getByTestId("detail-audit").getByText("Account disabled")).toBeVisible();
  await expect(page.getByTestId("detail-audit").getByText("Account enabled")).toBeVisible();
  await expect(page.getByTestId("detail-audit").getByText(`account #${adminId}`).first()).toBeVisible();
});

test("subscription management from the tenant page: change plan (confirmed) and suspend / reactivate (confirmed) — access follows on the API", async ({ page }) => {
  await ensureCompany();
  await signInAsOwner(page);
  await page.goto(`/platform/companies/${companyId}`);
  await expect(page.getByTestId("company-detail")).toBeVisible();
  await page.getByTestId("detail-manage-subscription").click();
  await expect(page.getByTestId("sub-detail")).toBeVisible();
  await expect(page.getByTestId("detail-actions")).toBeVisible();
  await page.getByTestId("action-set_plan").click();
  await expect(page.getByTestId("lifecycle-dialog")).toBeVisible();
  await page.getByTestId("plan-select").click();
  await page.getByRole("option", { name: "professional" }).click();
  await page.getByTestId("lifecycle-confirm").click();
  await expect(page.getByTestId("lifecycle-dialog")).toHaveCount(0);
  await closeManager(page);
  await expect(page.getByTestId("sub-detail")).toHaveCount(0);
  await expect(page.getByTestId("detail-plan")).toHaveText("professional");
  await expect(page.getByTestId("detail-audit").getByText("Plan changed")).toBeVisible();
  const afterPlan = await api("GET", `/platform/subscriptions/${companyId}`, undefined, platformToken);
  expect(afterPlan.json.plan).toBe("professional");
  // Suspend with confirmation → blocked; the tenant admin is refused.
  await page.getByTestId("detail-toggle-status").click();
  await expect(page.getByTestId("company-confirm-dialog")).toBeVisible();
  await page.getByTestId("company-confirm").click();
  await expect(page.getByTestId("detail-status")).toHaveText("Suspended");
  await expect(page.getByTestId("detail-access")).toHaveText("Blocked");
  const refused = await api("POST", "/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  expect(refused.status).toBe(403);
  await expect(page.getByTestId("detail-audit").getByText("Suspended", { exact: true }).first()).toBeVisible();
  // Reactivate → previous state restored.
  await page.getByTestId("detail-toggle-status").click();
  await expect(page.getByTestId("company-confirm-dialog")).toBeVisible();
  await page.getByTestId("company-confirm").click();
  await expect(page.getByTestId("detail-status")).toHaveText("Trialing");
  await expect(page.getByTestId("detail-access")).toHaveText("Full access");
  const restored = await api("POST", "/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  expect(restored.status, restored.text).toBe(200);
  await expect(page.getByTestId("detail-audit").getByText("Suspension lifted")).toBeVisible();
});

test("companies list actions and users directory: manage from the list, filter users by company, search by e-mail", async ({ page }) => {
  await ensureCompany();
  await signInAsOwner(page);
  await page.goto("/platform/companies");
  await page.getByTestId("company-search").fill(COMPANY_NAME);
  await expect(page.getByTestId(`company-row-${companyId}`)).toBeVisible();
  await expect(page.getByTestId("company-total")).toHaveText("1 company");
  await page.getByTestId(`company-actions-${companyId}`).click();
  await page.getByTestId(`company-manage-${companyId}`).click();
  await expect(page.getByTestId("sub-detail")).toBeVisible();
  await expect(page.getByTestId("sub-detail").getByText(COMPANY_NAME)).toBeVisible();
  await closeManager(page);
  await expect(page.getByTestId("sub-detail")).toHaveCount(0);
  // Status filter reflects the canonical state.
  await page.getByTestId("company-status-filter").click();
  await page.getByRole("option", { name: "Suspended" }).click();
  await expect(page.getByTestId("companies-empty")).toBeVisible();
  await page.getByTestId("company-status-filter").click();
  await page.getByRole("option", { name: "Trial" }).click();
  await expect(page.getByTestId(`company-row-${companyId}`)).toBeVisible();
  // Users directory filtered by company (deep link from the detail page).
  await page.goto(`/platform/users?companyId=${companyId}`);
  await expect(page.getByTestId("platform-users")).toBeVisible();
  await expect(page.getByTestId("users-company-chip")).toContainText(COMPANY_NAME);
  await expect(page.getByTestId("users-total")).toHaveText("Showing 1–1 of 1 user");
  await expect(page.getByText(ADMIN_EMAIL)).toBeVisible();
  await page.getByTestId("users-company-clear").click();
  await expect(page.getByTestId("users-company-chip")).toHaveCount(0);
  await page.getByTestId("users-search").fill(ADMIN_EMAIL);
  await expect(page.getByTestId("users-total")).toHaveText("Showing 1–1 of 1 user");
  await expect(page.getByTestId(`user-company-${(await api("GET", `/users?search=${encodeURIComponent(ADMIN_EMAIL)}`, undefined, platformToken)).json.users[0].id}`)).toHaveText(COMPANY_NAME);
  // Subscriptions deep link opens the manager directly.
  await page.goto(`/platform/subscriptions?company=${companyId}`);
  await expect(page.getByTestId("sub-detail")).toBeVisible();
  await expect(page.getByTestId("sub-detail").getByText(COMPANY_NAME)).toBeVisible();
});

test("a tenant admin never reaches the panel: role routing sends them to their portal and the API answers 403", async ({ page }) => {
  await ensureCompany();
  await seedAuth(page);
  await page.goto(`/platform/companies/${companyId}`);
  await expect(page).not.toHaveURL(/\/platform/);
  await expect(page.getByTestId("company-detail")).toHaveCount(0);
  const techcorp = await api("POST", "/auth/login", { email: "admin@techcorp.com", password: "Admin123!" });
  expect(techcorp.status).toBe(200);
  expect((await api("GET", `/companies/${companyId}`, undefined, techcorp.json.token)).status).toBe(403);
  expect((await api("GET", `/companies/${companyId}/audit`, undefined, techcorp.json.token)).status).toBe(403);
  expect((await api("GET", "/companies", undefined, techcorp.json.token)).status).toBe(403);
});

test("delete company: type-the-name confirmation removes the tenant and returns to the list", async ({ page }) => {
  await ensureCompany();
  await signInAsOwner(page);
  await page.goto(`/platform/companies/${companyId}`);
  await expect(page.getByTestId("company-detail")).toBeVisible();
  await page.getByTestId("detail-delete").click();
  await expect(page.getByTestId("delete-dialog")).toBeVisible();
  await expect(page.getByTestId("delete-confirm")).toBeDisabled();
  await page.getByTestId("delete-confirm-name").fill("wrong name");
  await expect(page.getByTestId("delete-confirm")).toBeDisabled();
  await page.getByTestId("delete-confirm-name").fill(COMPANY_NAME);
  await expect(page.getByTestId("delete-confirm")).toBeEnabled();
  await page.getByTestId("delete-confirm").click();
  await expect(page).toHaveURL(/\/platform\/companies$/);
  await expect(page.getByTestId("platform-companies")).toBeVisible();
  expect((await api("GET", `/companies/${companyId}`, undefined, platformToken)).status).toBe(404);
  expect((await api("POST", "/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })).status).toBe(401);
  await page.goto(`/platform/companies/${companyId}`);
  await expect(page.getByTestId("company-detail-error")).toBeVisible();
  await expect(page.getByText("Company not found")).toBeVisible();
});

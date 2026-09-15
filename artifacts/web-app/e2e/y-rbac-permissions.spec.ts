import { Client } from "pg";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/workspace";
import { API_BASE, RUN_TAG } from "./fixtures/seed-values";

/**
 * Y. Batch 20 — Correction 4: effective RBAC permissions reach the browser.
 *
 * Real login form, real RBAC operations, no seeded csp_user and no mocked auth
 * response. An employee whose subscriptions:view comes ONLY from an assigned role
 * must see the Subscription navigation and page (the API already allowed the read);
 * a manager's gates must agree with the effective grants AND the provider
 * capabilities reported by the API (no functioning Checkout just because `manage`
 * is granted); an employee without grants stays denied in the UI and on the API;
 * after revocation and a fresh login the access disappears again.
 */
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PASSWORD = "RbacUiQa123!";
const tag = RUN_TAG.toLowerCase();
const ADMIN_EMAIL = `${tag}.rbac-admin@example.test`;
const VIEWER_EMAIL = `${tag}.rbac-viewer@example.test`;
const MANAGER_EMAIL = `${tag}.rbac-manager@example.test`;
const NONE_EMAIL = `${tag}.rbac-none@example.test`;
const COMPANY_NAME = `${RUN_TAG} RBAC Co`;

let pg: Client;
let platformToken = "";
let adminToken = "";
let companyId = 0;
let viewerId = 0;
let viewerRoleId = 0;

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
async function login(email: string, password: string) {
  const res = await api("POST", "/auth/login", { email, password });
  expect(res.status, res.text).toBe(200);
  return res.json as { token: string; user: { id: number; permissions: Record<string, string[]> } };
}
/** Real browser sign-in through the login form (no localStorage seeding). */
async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Work Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin/);
}
const subscriptionNav = (page: Page) => page.getByRole("link", { name: "Subscription", exact: true });
const managementControls = (page: Page) => [page.getByTestId("portal-button"), page.getByTestId("checkout-card"), page.getByRole("button", { name: /upgrade|checkout|manage billing/i })];

test.beforeAll(async () => {
  pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  platformToken = (await login(PLATFORM.email, PLATFORM.password)).token;
  const company = await api("POST", "/companies", { name: COMPANY_NAME, plan: "free", industry: "QA" }, platformToken);
  expect(company.status, company.text).toBe(201);
  companyId = company.json.id;
  const admin = await api("POST", "/users", { email: ADMIN_EMAIL, name: "RBAC Admin", role: "primary_admin", companyId, password: PASSWORD }, platformToken);
  expect(admin.status, admin.text).toBe(201);
  adminToken = (await login(ADMIN_EMAIL, PASSWORD)).token;
  const ids: Record<string, number> = {};
  for (const [email, name] of [[VIEWER_EMAIL, "RBAC Viewer"], [MANAGER_EMAIL, "RBAC Manager"], [NONE_EMAIL, "RBAC None"]] as const) {
    const res = await api("POST", "/users", { email, name, role: "employee", companyId, password: PASSWORD }, adminToken);
    expect(res.status, res.text).toBe(201);
    ids[email] = res.json.id;
  }
  viewerId = ids[VIEWER_EMAIL];
  const viewerRole = await api("POST", "/rbac/roles", { name: `${RUN_TAG} billing viewer`, permissions: [{ module: "subscriptions", action: "view" }] }, adminToken);
  expect(viewerRole.status, viewerRole.text).toBe(201);
  viewerRoleId = viewerRole.json.id;
  const managerRole = await api("POST", "/rbac/roles", { name: `${RUN_TAG} billing manager`, permissions: [{ module: "subscriptions", action: "view" }, { module: "subscriptions", action: "manage" }] }, adminToken);
  expect(managerRole.status, managerRole.text).toBe(201);
  expect((await api("PUT", `/users/${viewerId}/roles`, { roleIds: [viewerRoleId] }, adminToken)).status).toBe(200);
  expect((await api("PUT", `/users/${ids[MANAGER_EMAIL]}/roles`, { roleIds: [managerRole.json.id] }, adminToken)).status).toBe(200);
});

test.afterAll(async () => {
  if (companyId) {
    await pg.query("delete from audit_logs where company_id = $1", [companyId]);
    await pg.query("delete from users where company_id = $1", [companyId]); // user_roles + sessions cascade
    await pg.query("delete from companies where id = $1", [companyId]); // roles cascade
  }
  await pg.query("delete from login_attempts where email like $1", [`${tag}.rbac-%@example.test`]);
  await pg.end();
});

test("role-only viewer: real login shows the Subscription navigation and renders the page; reload keeps it; no management controls", async ({ page }) => {
  const apiView = await login(VIEWER_EMAIL, PASSWORD);
  expect((await api("GET", "/subscriptions/current", undefined, apiView.token)).status).toBe(200); // the server already allows it
  await signIn(page, VIEWER_EMAIL);
  await expect(subscriptionNav(page)).toBeVisible();
  await subscriptionNav(page).click();
  await expect(page).toHaveURL(/\/admin\/subscription/);
  await expect(page.getByTestId("subscription-page")).toBeVisible();
  await expect(page.getByText("No access")).toHaveCount(0);
  await expect(page.getByTestId("status-badge")).toBeVisible();
  await expect(page.getByTestId("plan-name")).toHaveText(/free/i);
  await expect(page.getByTestId("usage-card")).toBeVisible();
  await expect(page.getByTestId("usage-row-events")).toBeVisible();
  for (const control of managementControls(page)) await expect(control).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("subscription-page")).toBeVisible();
  await expect(page.getByTestId("usage-row-contacts")).toBeVisible();
  for (const control of managementControls(page)) await expect(control).toHaveCount(0);
});

test("manager: UI gates agree with the effective grants and the provider capabilities the API reports", async ({ page }) => {
  const manager = await login(MANAGER_EMAIL, PASSWORD);
  const current = (await api("GET", "/subscriptions/current", undefined, manager.token)).json;
  expect(current.billing).toBeTruthy();
  await signIn(page, MANAGER_EMAIL);
  await expect(subscriptionNav(page)).toBeVisible();
  await page.goto("/admin/subscription");
  await expect(page.getByTestId("subscription-page")).toBeVisible();
  await expect(page.getByTestId("usage-card")).toBeVisible();
  // Checkout only when the API says it is available — never merely because `manage` is granted.
  if (current.billing.checkoutAvailable) await expect(page.getByTestId("checkout-card")).toBeVisible();
  else await expect(page.getByTestId("checkout-card")).toHaveCount(0);
  if (current.billing.portalAvailable) {
    await expect(page.getByTestId("portal-button")).toBeVisible();
    await expect(page.getByTestId("portal-unavailable")).toHaveCount(0);
  } else {
    await expect(page.getByTestId("portal-button")).toHaveCount(0);
    await expect(page.getByTestId("portal-unavailable")).toBeVisible();
  }
  // The manage grant is real on the server too: the manage-gated endpoint is not a permission denial.
  const portal = await api("POST", "/subscriptions/portal", {}, manager.token);
  expect(portal.status === 403 && /Missing permission/.test(portal.json?.error ?? ""), portal.text).toBe(false);
});

test("employee without grants: navigation and page stay denied; direct API requests stay denied", async ({ page }) => {
  const none = await login(NONE_EMAIL, PASSWORD);
  expect(none.user.permissions).toEqual({});
  expect((await api("GET", "/subscriptions/current", undefined, none.token)).status).toBe(403);
  expect((await api("GET", "/subscriptions/usage", undefined, none.token)).status).toBe(403);
  await signIn(page, NONE_EMAIL);
  await expect(subscriptionNav(page)).toHaveCount(0);
  await page.goto("/admin/subscription");
  await expect(page.getByText("No access")).toBeVisible();
  await expect(page.getByTestId("subscription-page")).toHaveCount(0);
});

test("revocation: after the role is removed, a fresh login no longer presents the access", async ({ page }) => {
  expect((await api("PUT", `/users/${viewerId}/roles`, { roleIds: [] }, adminToken)).status).toBe(200);
  const revoked = await login(VIEWER_EMAIL, PASSWORD);
  expect(revoked.user.permissions.subscriptions ?? []).not.toContain("view");
  expect((await api("GET", "/subscriptions/current", undefined, revoked.token)).status).toBe(403);
  await signIn(page, VIEWER_EMAIL);
  await expect(subscriptionNav(page)).toHaveCount(0);
  await page.goto("/admin/subscription");
  await expect(page.getByText("No access")).toBeVisible();
  await expect(page.getByTestId("subscription-page")).toHaveCount(0);
});

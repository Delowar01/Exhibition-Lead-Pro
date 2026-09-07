import { Client } from "pg";
import type { Page } from "@playwright/test";
import { test, expect, state, seedAuth } from "./fixtures/workspace";
import { API_BASE, RUN_TAG } from "./fixtures/seed-values";

/**
 * V. Batch 17 — Workflow Automation UI (/admin/automations).
 *
 * Drives the production UI against the real API: navigation + permission
 * gating, the catalog-driven builder (trigger → conditions → actions, entity
 * selectors, compatible actions only, ordering), server validation mapped to
 * fields, the full lifecycle (draft → publish → read-only → unpublish →
 * archive / delete) with confirmations, revision-conflict handling that is
 * never silent, unsaved-change protection, a REAL CRM event executing a
 * published automation that then appears completed in Run History with its
 * per-action outcomes, run filters, the untouched AI Workflow Intelligence
 * page, and layout at desktop/tablet/mobile + dark mode. No AI, no email.
 */

const DESKTOP = { width: 1440, height: 900 };
const TABLET = { width: 1024, height: 768 };
const MOBILE = { width: 390, height: 844 };
const PASSWORD = "WfViewer123!";
const VIEWER_EMAIL = `${RUN_TAG.toLowerCase()}.wf-viewer@example.test`;
const NOPERM_EMAIL = `${RUN_TAG.toLowerCase()}.wf-noperm@example.test`;
const NAME = `${RUN_TAG} Qualified lead follow-up`;

type Auth = { token: string; user: { id: number; companyId: number; email: string } };

let pg: Client;
let tagId = 0;
let tagName = "";
let viewer: Auth;
let noperm: Auth;
let defId = 0;
let leadId = 0;
let runId = 0;
let taskId = 0;
const definitionIds: number[] = [];
const cleanupRunIds: number[] = [];

async function api(method: string, path: string, body?: unknown, token: string | null = state.token) {
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

/** Like seedAuth, but for a freshly minted employee (real login token — not a bypass). */
async function seedAs(page: Page, auth: Auth, theme: "light" | "dark" = "light") {
  await page.addInitScript(
    ([t, u, companyId, th]) => {
      try {
        localStorage.setItem("csp_token", t as string);
        localStorage.setItem("csp_user", u as string);
        localStorage.setItem("csp_company_id", companyId as string);
        localStorage.setItem("csp_theme", th as string);
      } catch {
        /* storage unavailable */
      }
    },
    [auth.token, JSON.stringify(auth.user), String(auth.user.companyId), theme] as const,
  );
}

async function pageOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function pickOption(page: Page, triggerTestId: string, optionName: string | RegExp, exact = false) {
  await page.getByTestId(triggerTestId).click();
  await page.getByRole("option", { name: optionName, exact }).click();
}

async function currentRevision(id: number): Promise<number> {
  const res = await api("GET", `/workflows/${id}`);
  expect(res.status).toBe(200);
  return res.json.revision as number;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();

  const tag = await api("POST", "/tags", { name: `${RUN_TAG} automation tag`, color: "#ef4444" });
  expect(tag.status, tag.text).toBeLessThan(300);
  tagId = tag.json.id;
  tagName = tag.json.name;

  // Two employees through the real management API: one with workflows:view only,
  // one with no workflows permission at all (legacy permission column, exactly
  // what the server RBAC matrix and the client gate both read).
  const mint = async (email: string, perms: Record<string, string[]>): Promise<Auth> => {
    const created = await api("POST", "/users", { email, password: PASSWORD, name: `${RUN_TAG} WF employee`, role: "employee" });
    expect(created.status, created.text).toBeLessThan(300);
    await pg.query(`UPDATE users SET permissions = $1::jsonb WHERE email = $2`, [JSON.stringify(perms), email]);
    const login = await api("POST", "/auth/login", { email, password: PASSWORD }, null);
    expect(login.status, login.text).toBe(200);
    return { token: login.json.token, user: login.json.user };
  };
  viewer = await mint(VIEWER_EMAIL, { workflows: ["view"] });
  noperm = await mint(NOPERM_EMAIL, {});
});

test.afterAll(async () => {
  try {
    if (taskId) await api("DELETE", `/tasks/${taskId}`);
    if (leadId) await api("DELETE", `/leads/${leadId}`);
    for (const id of definitionIds) {
      const runs = await api("GET", `/workflows/runs?workflowDefinitionId=${id}&pageSize=100`);
      for (const r of runs.json?.items ?? []) cleanupRunIds.push(r.id);
      const d = await api("GET", `/workflows/${id}`);
      if (d.status !== 200) continue;
      if (d.json.status === "published") await api("POST", `/workflows/${id}/unpublish`, { revision: d.json.revision });
      const d2 = await api("GET", `/workflows/${id}`);
      if (d2.status === 200 && d2.json.status === "draft") await api("DELETE", `/workflows/${id}`, { revision: d2.json.revision });
    }
    if (cleanupRunIds.length) await pg.query(`DELETE FROM workflow_runs WHERE id = ANY($1::int[])`, [cleanupRunIds]);
    if (definitionIds.length) await pg.query(`DELETE FROM workflow_definitions WHERE id = ANY($1::int[])`, [definitionIds]);
    if (tagId) await api("DELETE", `/tags/${tagId}`);
    for (const email of [VIEWER_EMAIL, NOPERM_EMAIL]) {
      const res = await pg.query(`SELECT id FROM users WHERE email = $1`, [email]);
      for (const row of res.rows) {
        await pg.query(`DELETE FROM sessions WHERE user_id = $1`, [row.id]);
        await pg.query(`DELETE FROM user_roles WHERE user_id = $1`, [row.id]);
        await pg.query(`DELETE FROM verification_tokens WHERE user_id = $1`, [row.id]);
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

test("Automations is in the CRM navigation and the workspace has Automations + Run History", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await seedAuth(page);
  await page.goto("/admin/automations");
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByRole("link", { name: "Automations" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Automations" })).toBeVisible();
  await expect(page.getByTestId("tab-automations")).toBeVisible();
  await expect(page.getByTestId("tab-runs")).toBeVisible();
  await expect(page.getByTestId("automation-list")).toBeVisible();
  await expect(page.getByTestId("button-new-automation")).toBeVisible();

  // Filters produce a clear "no match" state and can be cleared.
  await page.getByTestId("automations-search").fill(`${RUN_TAG}-definitely-no-such-automation`);
  await expect(page.getByText("No automations match these filters")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByText("No automations match these filters")).toHaveCount(0);

  // Run History tab is URL-addressable.
  await page.getByTestId("tab-runs").click();
  await expect(page).toHaveURL(/tab=runs/);
  await expect(page.getByTestId("run-history")).toBeVisible();
  await expect(page.getByTestId("runs-filter-status")).toBeVisible();
  await page.getByTestId("tab-automations").click();
  await expect(page.getByTestId("automation-list")).toBeVisible();
});

test("builder: catalog-driven trigger/conditions/actions, entity selectors, validate, create draft, mapped server issues", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await seedAuth(page);
  await page.goto("/admin/automations/new");
  await expect(page.getByTestId("automation-editor")).toBeVisible();
  await expect(page.getByTestId("section-trigger")).toBeVisible();
  await expect(page.getByTestId("section-conditions")).toBeVisible();
  await expect(page.getByTestId("section-actions")).toBeVisible();

  await page.getByTestId("automation-name").fill(NAME);
  await page.getByTestId("automation-description").fill("Create a task for the owner and tag the lead when it becomes Qualified.");

  // Triggers come from GET /workflows/catalog (both entities are offered).
  await page.getByTestId("trigger-type").click();
  await expect(page.getByRole("option", { name: "Lead created" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Contact created" })).toBeVisible();
  await page.getByRole("option", { name: "Lead stage changed" }).click();
  // Stage keys are chosen from the tenant's pipeline stages, not typed as ids.
  await pickOption(page, "field-trigger.config.toStageKey", "Qualified");

  // Conditions: AND rows with field/operator/value editors and remove.
  await page.getByTestId("condition-add").click();
  await pickOption(page, "condition-field-0", "Title", true);
  await pickOption(page, "condition-operator-0", "contains", true);
  await page.getByTestId("condition-value-0").fill(RUN_TAG);
  await page.getByTestId("condition-add").click();
  await expect(page.getByTestId("condition-row-1")).toBeVisible();
  await page.getByTestId("condition-remove-1").click();
  await expect(page.getByTestId("condition-row-1")).toHaveCount(0);

  // Only lead-compatible actions are offered for a lead trigger.
  await page.getByTestId("action-add").click();
  await expect(page.getByRole("option", { name: "Add tag to lead" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Add tag to contact" })).toHaveCount(0);
  await page.getByRole("option", { name: "Create task" }).click();
  await page.getByTestId("field-actions[0].config.title").fill(`${RUN_TAG} call the qualified lead`);
  // Recipient defaults to the record's owner (no raw user id required).
  await expect(page.getByTestId("field-actions[0].config.assignee.kind")).toContainText("owner");

  await pickOption(page, "action-add", "Add tag to lead");
  await pickOption(page, "field-actions[1].config.tagId", tagName);

  // Order is explicit and reorderable with accessible controls.
  await expect(page.getByTestId("action-title-0")).toContainText("Create task");
  await expect(page.getByTestId("action-title-1")).toContainText("Add tag to lead");
  await page.getByTestId("action-move-up-1").click();
  await expect(page.getByTestId("action-title-0")).toContainText("Add tag to lead");
  await page.getByTestId("action-move-down-0").click();
  await expect(page.getByTestId("action-title-0")).toContainText("Create task");

  // Server validation of the unsaved editor state.
  await page.getByTestId("button-validate").click();
  const summary = page.getByTestId("validation-summary");
  await expect(summary).toBeVisible();
  await expect(summary).toHaveAttribute("data-tone", "success");
  await expect(summary).toContainText("can be published");

  // Create → draft, revision 1, unsaved indicator cleared.
  await page.getByTestId("button-save").click();
  await expect(page).toHaveURL(/\/admin\/automations\/\d+$/);
  defId = Number(page.url().split("/").pop());
  definitionIds.push(defId);
  await expect(page.getByTestId("automation-revision")).toHaveText("1");
  await expect(page.getByTestId("automation-editor")).toHaveAttribute("data-status", "draft");
  await expect(page.getByTestId("unsaved-indicator")).toHaveCount(0);
  await expect(page.getByText("Draft created").first()).toBeVisible();

  // A server issue path (actions[0].config.title) lands on the exact field + summary.
  await page.getByTestId("field-actions[0].config.title").fill("");
  await expect(page.getByTestId("unsaved-indicator")).toBeVisible();
  await page.getByTestId("button-save").click();
  await expect(summary).toBeVisible();
  await expect(summary).toHaveAttribute("data-tone", "destructive");
  await expect(summary).toContainText("Action 1 (Create task)");
  await expect(page.getByTestId("field-error-actions[0].config.title")).toBeVisible();
  await expect(page.getByTestId("automation-revision")).toHaveText("1");

  await page.getByTestId("field-actions[0].config.title").fill(`${RUN_TAG} call the qualified lead`);
  await page.getByTestId("button-save").click();
  await expect(page.getByText("Changes saved").first()).toBeVisible();
  await expect(page.getByTestId("automation-revision")).toHaveText("2");
  await expect(page.getByTestId("field-error-actions[0].config.title")).toHaveCount(0);
});

test("lifecycle: publish needs confirmation and makes the automation active + read-only", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await seedAuth(page);
  await page.goto(`/admin/automations/${defId}`);
  await expect(page.getByTestId("automation-revision")).toHaveText("2");
  await expect(page.getByTestId("button-publish")).toBeEnabled();
  await page.getByTestId("button-publish").click();
  const dialog = page.getByTestId("lifecycle-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("future matching CRM event");
  await page.getByTestId("lifecycle-cancel").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("automation-editor")).toHaveAttribute("data-status", "draft");

  await page.getByTestId("button-publish").click();
  await page.getByTestId("confirm-publish").click();
  await expect(page.getByTestId("automation-editor")).toHaveAttribute("data-status", "published");
  await expect(page.getByTestId("readonly-banner")).toHaveAttribute("data-reason", "published");
  await expect(page.getByTestId("automation-name")).toBeDisabled();
  await expect(page.getByTestId("button-save")).toHaveCount(0);
  await expect(page.getByTestId("button-publish")).toHaveCount(0);
  await expect(page.getByTestId("button-unpublish")).toBeVisible();
  await expect(page.getByTestId("action-remove-0")).toHaveCount(0);

  await page.goto("/admin/automations");
  const row = page.getByTestId(`automation-row-${defId}`);
  await expect(row).toBeVisible();
  await expect(row).toContainText("Active");
  await expect(row).toContainText("Lead stage changed");
});

test("a published automation executes from a real CRM event and appears completed in Run History with action outcomes", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await seedAuth(page);

  // Real CRM mutation through the leads API: prospect → qualified matches the trigger + condition.
  const lead = await api("POST", "/leads", { title: `${RUN_TAG} Acme rollout`, stage: "prospect", assignedToId: state.user.id });
  expect(lead.status, lead.text).toBeLessThan(300);
  leadId = lead.json.id;
  const moved = await api("PATCH", `/leads/${leadId}`, { stage: "qualified" });
  expect(moved.status, moved.text).toBe(200);

  await page.goto(`/admin/automations?tab=runs&definition=${defId}`);
  await expect(page.getByTestId("run-history")).toBeVisible();
  const completedRow = page.locator('[data-testid^="run-row-"][data-status="completed"]');
  await expect(completedRow).toHaveCount(1, { timeout: 20_000 });
  await expect(completedRow).toContainText(NAME);
  await expect(completedRow).toContainText("Lead stage changed");
  await expect(completedRow).toContainText(`Lead #${leadId}`);
  await expect(completedRow).toContainText("2/2 done");
  await expect(page.getByTestId("runs-polling")).toContainText("finished");
  runId = Number((await completedRow.getAttribute("data-testid"))!.replace("run-row-", ""));
  cleanupRunIds.push(runId);

  await page.getByTestId(`run-link-${runId}`).click();
  await expect(page).toHaveURL(new RegExp(`/admin/automations/runs/${runId}$`));
  await expect(page.getByTestId("run-detail")).toHaveAttribute("data-status", "completed");
  await expect(page.getByTestId("run-detail-status")).toHaveText("completed");
  await expect(page.getByTestId("run-action-summary")).toContainText("2 completed");
  const action0 = page.getByTestId("run-action-0");
  const action1 = page.getByTestId("run-action-1");
  await expect(action0).toHaveAttribute("data-status", "completed");
  await expect(action0).toContainText("Create task");
  await expect(action0).toContainText("1 attempt");
  await expect(action1).toHaveAttribute("data-status", "completed");
  await expect(action1).toContainText("Add tag to lead");
  await expect(page.getByTestId("run-action-1-result")).toContainText(tagName);
  await expect(page.getByTestId("run-actor")).not.toHaveText("System");
  await expect(page.getByTestId("run-polling")).toContainText("finished");
  // No run-now / replay / retry anywhere.
  await expect(page.getByRole("button", { name: /retry|replay|run now|re-run/i })).toHaveCount(0);

  // Remember the created task for cleanup (sanitized result exposes only ids).
  const detail = await api("GET", `/workflows/runs/${runId}`);
  taskId = detail.json.actions[0].result?.taskId ?? 0;

  // Link to the related lead.
  const entityLink = page.getByTestId("run-entity-link");
  await expect(entityLink).toHaveAttribute("href", new RegExp(`/admin/leads/${leadId}$`));
  await entityLink.click();
  await expect(page).toHaveURL(new RegExp(`/admin/leads/${leadId}`));
});

test("run history filters (status, record type, record id) narrow the B16 history", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await seedAuth(page);
  await page.goto("/admin/automations?tab=runs");
  await expect(page.getByTestId(`run-row-${runId}`)).toBeVisible();

  await pickOption(page, "runs-filter-status", "Failed", true);
  await expect(page.getByText("No runs match these filters")).toBeVisible();
  await page.getByTestId("runs-clear-filters").click();
  await expect(page.getByTestId(`run-row-${runId}`)).toBeVisible();

  await page.getByTestId("runs-filter-entity-id").fill(String(leadId));
  await expect(page.getByTestId(`run-row-${runId}`)).toBeVisible();
  await page.getByTestId("runs-filter-entity-id").fill("987654321");
  await expect(page.getByText("No runs match these filters")).toBeVisible();
  await page.getByTestId("runs-filter-entity-id").fill("");

  await pickOption(page, "runs-filter-entity-type", "Contacts", true);
  await expect(page.getByText("No runs match these filters")).toBeVisible();
  await pickOption(page, "runs-filter-entity-type", "Leads", true);
  await expect(page.getByTestId(`run-row-${runId}`)).toBeVisible();
  await pickOption(page, "runs-filter-trigger", "Lead created");
  await expect(page.getByText("No runs match these filters")).toBeVisible();
});

test("unpublish returns to an editable draft; a stale revision never overwrites silently", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await seedAuth(page);
  await page.goto(`/admin/automations/${defId}`);
  await page.getByTestId("button-unpublish").click();
  await expect(page.getByTestId("lifecycle-dialog")).toContainText("editable draft");
  await page.getByTestId("confirm-unpublish").click();
  await expect(page.getByTestId("automation-editor")).toHaveAttribute("data-status", "draft");
  await expect(page.getByTestId("readonly-banner")).toHaveCount(0);
  await expect(page.getByTestId("automation-name")).toBeEnabled();

  // Someone else edits the definition while this page holds the old revision.
  const before = await currentRevision(defId);
  await page.getByTestId("automation-name").fill(`${NAME} (mine)`);
  const elsewhere = await api("PATCH", `/workflows/${defId}`, { revision: before, description: "changed elsewhere" });
  expect(elsewhere.status, elsewhere.text).toBe(200);

  await page.getByTestId("button-save").click();
  const conflict = page.getByTestId("conflict-dialog");
  await expect(conflict).toBeVisible();
  await expect(conflict).toContainText(`revision ${elsewhere.json.revision}`);
  await page.getByTestId("conflict-keep").click();
  await expect(conflict).toHaveCount(0);
  await expect(page.getByTestId("automation-name")).toHaveValue(`${NAME} (mine)`);
  expect((await api("GET", `/workflows/${defId}`)).json.name).toBe(NAME);

  // Reload latest discards the local edit and shows the other user's change.
  await page.getByTestId("button-save").click();
  await expect(conflict).toBeVisible();
  await page.getByTestId("conflict-reload").click();
  await expect(page.getByTestId("automation-name")).toHaveValue(NAME);
  await expect(page.getByTestId("automation-description")).toHaveValue("changed elsewhere");
  await expect(page.getByTestId("automation-revision")).toHaveText(String(elsewhere.json.revision));
  await expect(page.getByTestId("validation-summary")).toContainText("Reloaded revision");

  // Overwrite is an explicit choice and saves on top of the newest revision.
  const again = await api("PATCH", `/workflows/${defId}`, { revision: elsewhere.json.revision, description: "changed elsewhere again" });
  expect(again.status).toBe(200);
  await page.getByTestId("automation-name").fill(`${NAME} (overwritten)`);
  await page.getByTestId("button-save").click();
  await expect(conflict).toBeVisible();
  await page.getByTestId("conflict-overwrite").click();
  await expect(page.getByText("Changes saved").first()).toBeVisible();
  await expect(page.getByTestId("automation-revision")).toHaveText(String(again.json.revision + 1));
  expect((await api("GET", `/workflows/${defId}`)).json.name).toBe(`${NAME} (overwritten)`);
});

test("unsaved changes are protected on in-app navigation", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await seedAuth(page);
  await page.goto(`/admin/automations/${defId}`);
  await page.getByTestId("automation-name").fill(`${NAME} (unsaved)`);
  await expect(page.getByTestId("unsaved-indicator")).toBeVisible();

  await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Automations" }).click();
  await expect(page.getByTestId("unsaved-dialog")).toBeVisible();
  await page.getByTestId("unsaved-stay").click();
  await expect(page).toHaveURL(new RegExp(`/admin/automations/${defId}$`));
  await expect(page.getByTestId("automation-name")).toHaveValue(`${NAME} (unsaved)`);

  await page.getByTestId("button-back").click();
  await expect(page.getByTestId("unsaved-dialog")).toBeVisible();
  await page.getByTestId("unsaved-discard").click();
  await expect(page).toHaveURL(/\/admin\/automations$/);
  expect((await api("GET", `/workflows/${defId}`)).json.name).toBe(`${NAME} (overwritten)`);
});

test("browser Back on a dirty editor opens the dialog; Stay keeps everything; Discard completes Back exactly once", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await seedAuth(page);
  await page.goto("/admin/automations");
  await page.getByTestId(`automation-link-${defId}`).click();
  await expect(page).toHaveURL(new RegExp(`/admin/automations/${defId}$`));
  await expect(page.getByTestId("automation-editor")).toHaveAttribute("data-dirty", "false");
  const editorUrl = page.url();
  const lengthBefore = await page.evaluate(() => history.length);

  await page.getByTestId("automation-name").click();
  await page.getByTestId("automation-name").fill(`${NAME} (history)`);
  await expect(page.getByTestId("unsaved-indicator")).toBeVisible();

  // Back → dialog; editor, URL and form untouched while it is open.
  await page.goBack({ waitUntil: "commit" });
  await expect(page.getByTestId("unsaved-dialog")).toBeVisible();
  expect(page.url()).toBe(editorUrl);
  await expect(page.getByTestId("automation-editor")).toHaveAttribute("data-dirty", "true");
  await expect(page.getByTestId("automation-name")).toHaveValue(`${NAME} (history)`);
  expect(await page.evaluate(() => history.length)).toBe(lengthBefore);

  // Stay → the traversal is cancelled cleanly, nothing else changes.
  await page.getByTestId("unsaved-stay").click();
  await expect(page.getByTestId("unsaved-dialog")).toHaveCount(0);
  expect(page.url()).toBe(editorUrl);
  await expect(page.getByTestId("automation-name")).toHaveValue(`${NAME} (history)`);
  await expect(page.getByTestId("unsaved-indicator")).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(lengthBefore);
  // Only one dialog per traversal: none re-opens on its own.
  await page.waitForTimeout(300);
  await expect(page.getByTestId("unsaved-dialog")).toHaveCount(0);

  // Back again → Discard → the original Back completes exactly once.
  await page.goBack({ waitUntil: "commit" });
  await expect(page.getByTestId("unsaved-dialog")).toBeVisible();
  await page.getByTestId("unsaved-discard").click();
  await expect(page).toHaveURL(/\/admin\/automations$/);
  await expect(page.getByTestId("automation-list")).toBeVisible();
  await expect(page.getByTestId("unsaved-dialog")).toHaveCount(0);
  expect(await page.evaluate(() => history.length)).toBe(lengthBefore);
  expect((await api("GET", `/workflows/${defId}`)).json.name).toBe(`${NAME} (overwritten)`);

  // No phantom entries: Forward lands on the (clean, reloaded) editor without a dialog.
  await page.goForward({ waitUntil: "commit" });
  await expect(page).toHaveURL(new RegExp(`/admin/automations/${defId}$`));
  await expect(page.getByTestId("automation-name")).toHaveValue(`${NAME} (overwritten)`);
  await expect(page.getByTestId("automation-editor")).toHaveAttribute("data-dirty", "false");
  await expect(page.getByTestId("unsaved-dialog")).toHaveCount(0);
});

test("browser Forward on a dirty editor is guarded the same way; a clean editor traverses freely", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await seedAuth(page);
  await page.goto("/admin/automations");
  await page.getByTestId(`automation-link-${defId}`).click();
  await expect(page).toHaveURL(new RegExp(`/admin/automations/${defId}$`));
  await page.getByTestId("button-view-runs").click();
  await expect(page).toHaveURL(/tab=runs/);
  const lengthBefore = await page.evaluate(() => history.length);

  // Clean editor: Back and Forward navigate normally, no dialog.
  await page.goBack({ waitUntil: "commit" });
  await expect(page).toHaveURL(new RegExp(`/admin/automations/${defId}$`));
  await expect(page.getByTestId("automation-editor")).toBeVisible();
  await expect(page.getByTestId("unsaved-dialog")).toHaveCount(0);
  await page.goForward({ waitUntil: "commit" });
  await expect(page).toHaveURL(/tab=runs/);
  await expect(page.getByTestId("run-history")).toBeVisible();
  await page.goBack({ waitUntil: "commit" });
  await expect(page).toHaveURL(new RegExp(`/admin/automations/${defId}$`));
  await expect(page.getByTestId("unsaved-dialog")).toHaveCount(0);
  const editorUrl = page.url();

  // Dirty editor with a forward entry: Forward → dialog → Stay.
  await page.getByTestId("automation-name").click();
  await page.getByTestId("automation-name").fill(`${NAME} (forward)`);
  await expect(page.getByTestId("unsaved-indicator")).toBeVisible();
  await page.goForward({ waitUntil: "commit" });
  await expect(page.getByTestId("unsaved-dialog")).toBeVisible();
  expect(page.url()).toBe(editorUrl);
  await expect(page.getByTestId("automation-name")).toHaveValue(`${NAME} (forward)`);
  await page.getByTestId("unsaved-stay").click();
  await expect(page.getByTestId("unsaved-dialog")).toHaveCount(0);
  expect(page.url()).toBe(editorUrl);
  await expect(page.getByTestId("automation-name")).toHaveValue(`${NAME} (forward)`);
  expect(await page.evaluate(() => history.length)).toBe(lengthBefore);

  // Forward → Discard completes the Forward exactly once.
  await page.goForward({ waitUntil: "commit" });
  await expect(page.getByTestId("unsaved-dialog")).toBeVisible();
  await page.getByTestId("unsaved-discard").click();
  await expect(page).toHaveURL(/tab=runs/);
  await expect(page.getByTestId("run-history")).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(lengthBefore);
  expect((await api("GET", `/workflows/${defId}`)).json.name).toBe(`${NAME} (overwritten)`);

  // The runs entry is the last one; Back returns to a clean editor with no dialog.
  await page.goBack({ waitUntil: "commit" });
  await expect(page).toHaveURL(new RegExp(`/admin/automations/${defId}$`));
  await expect(page.getByTestId("automation-editor")).toHaveAttribute("data-dirty", "false");
  await expect(page.getByTestId("unsaved-dialog")).toHaveCount(0);
});

test("link, reload and tab-close guards stay in place alongside the history guard", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await seedAuth(page);
  await page.goto(`/admin/automations/${defId}`);
  await expect(page.getByTestId("automation-editor")).toHaveAttribute("data-dirty", "false");
  const armed = () =>
    page.evaluate(() => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    });
  expect(await armed()).toBe(false);

  await page.getByTestId("automation-name").click();
  await page.getByTestId("automation-name").fill(`${NAME} (guards)`);
  await expect(page.getByTestId("unsaved-indicator")).toBeVisible();
  expect(await armed()).toBe(true);

  // In-app link (sidebar) is still intercepted after a held-back Back.
  await page.goto("/admin/automations");
  await page.getByTestId(`automation-link-${defId}`).click();
  await page.getByTestId("automation-name").click();
  await page.getByTestId("automation-name").fill(`${NAME} (guards)`);
  await page.goBack({ waitUntil: "commit" });
  await expect(page.getByTestId("unsaved-dialog")).toBeVisible();
  await page.getByTestId("unsaved-stay").click();
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Contacts" }).click();
  await expect(page.getByTestId("unsaved-dialog")).toBeVisible();
  expect(page.url()).toContain(`/admin/automations/${defId}`);
  await page.getByTestId("unsaved-stay").click();
  await expect(page.getByTestId("automation-name")).toHaveValue(`${NAME} (guards)`);

  // Real browser beforeunload prompt on close (needs user activation, which the click gave).
  const second = await page.context().newPage();
  await seedAuth(second);
  await second.goto(`/admin/automations/${defId}`);
  await second.getByTestId("automation-name").click();
  await second.getByTestId("automation-name").fill(`${NAME} (close)`);
  await expect(second.getByTestId("unsaved-indicator")).toBeVisible();
  const dialog = second.waitForEvent("dialog");
  await second.close({ runBeforeUnload: true });
  const d = await dialog;
  expect(d.type()).toBe("beforeunload");
  await d.accept();

  // Discarding leaves nothing behind: the definition is untouched.
  await page.getByTestId("button-back").click();
  await page.getByTestId("unsaved-discard").click();
  await expect(page).toHaveURL(/\/admin\/automations$/);
  expect((await api("GET", `/workflows/${defId}`)).json.name).toBe(`${NAME} (overwritten)`);
});

test("list row actions: delete a draft and archive with confirmations; archived is read-only and terminal", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await seedAuth(page);
  const spec = { trigger: { type: "lead.created", config: {} }, conditions: [], actions: [{ type: "lead.add_tag", config: { tagId } }] };
  const toDelete = await api("POST", "/workflows", { name: `${RUN_TAG} delete me`, ...spec });
  const toArchive = await api("POST", "/workflows", { name: `${RUN_TAG} archive me`, ...spec });
  expect(toDelete.status, toDelete.text).toBe(201);
  expect(toArchive.status, toArchive.text).toBe(201);
  definitionIds.push(toDelete.json.id, toArchive.json.id);

  await page.goto("/admin/automations");
  await page.getByTestId(`automation-menu-${toDelete.json.id}`).click();
  await page.getByTestId(`automation-delete-${toDelete.json.id}`).click();
  await expect(page.getByTestId("lifecycle-dialog")).toContainText("Delete this draft?");
  await page.getByTestId("lifecycle-confirm").click();
  await expect(page.getByTestId(`automation-row-${toDelete.json.id}`)).toHaveCount(0);
  expect((await api("GET", `/workflows/${toDelete.json.id}`)).status).toBe(404);

  await page.getByTestId(`automation-menu-${toArchive.json.id}`).click();
  await page.getByTestId(`automation-archive-${toArchive.json.id}`).click();
  await expect(page.getByTestId("lifecycle-dialog")).toContainText("cannot be reactivated");
  await page.getByTestId("lifecycle-confirm").click();
  // Archived rows are hidden by default and shown with the archived filter.
  await expect(page.getByTestId(`automation-row-${toArchive.json.id}`)).toHaveCount(0);
  await page.getByTestId("automations-include-archived").click();
  const archivedRow = page.getByTestId(`automation-row-${toArchive.json.id}`);
  await expect(archivedRow).toBeVisible();
  await expect(archivedRow).toContainText("Archived");
  await page.getByTestId(`automation-menu-${toArchive.json.id}`).click();
  await expect(page.getByTestId(`automation-publish-${toArchive.json.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`automation-delete-${toArchive.json.id}`)).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.goto(`/admin/automations/${toArchive.json.id}`);
  await expect(page.getByTestId("readonly-banner")).toHaveAttribute("data-reason", "archived");
  await expect(page.getByTestId("button-save")).toHaveCount(0);
  await expect(page.getByTestId("button-publish")).toHaveCount(0);
  await expect(page.getByTestId("button-unpublish")).toHaveCount(0);
  await expect(page.getByTestId("button-more")).toHaveCount(0);
  await expect(page.getByTestId("automation-name")).toBeDisabled();

  // Status filter "Archived" also surfaces it.
  await page.goto("/admin/automations");
  await pickOption(page, "automations-status-filter", "Archived", true);
  await expect(page.getByTestId(`automation-row-${toArchive.json.id}`)).toBeVisible();
});

test("view-only employee sees no mutation controls; an employee without the permission is blocked", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await seedAs(page, viewer);
  await page.goto("/admin/automations");
  await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Automations" })).toBeVisible();
  await expect(page.getByTestId("automation-list")).toBeVisible();
  await expect(page.getByTestId(`automation-row-${defId}`)).toBeVisible();
  await expect(page.getByTestId("button-new-automation")).toHaveCount(0);
  await expect(page.locator('[data-testid^="automation-menu-"]')).toHaveCount(0);
  await page.getByTestId("tab-runs").click();
  await expect(page.getByTestId(`run-row-${runId}`)).toBeVisible();

  await page.goto(`/admin/automations/${defId}`);
  await expect(page.getByTestId("readonly-banner")).toHaveAttribute("data-reason", "view-only");
  await expect(page.getByTestId("automation-name")).toBeDisabled();
  await expect(page.getByTestId("button-save")).toHaveCount(0);
  await expect(page.getByTestId("button-publish")).toHaveCount(0);
  await expect(page.getByTestId("button-more")).toHaveCount(0);
  await expect(page.getByTestId("action-add")).toHaveCount(0);

  await page.goto("/admin/automations/new");
  await expect(page.getByTestId("automations-forbidden")).toContainText("View-only access");

  // Server-side: the viewer cannot mutate even with a crafted request.
  const rev = await currentRevision(defId);
  expect((await api("POST", `/workflows/${defId}/publish`, { revision: rev }, viewer.token)).status).toBe(403);

  await page.context().clearCookies();
  await seedAs(page, noperm);
  await page.goto("/admin");
  await expect(page.getByTestId("dashboard-page")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Automations" })).toHaveCount(0);
  await page.goto("/admin/automations");
  await expect(page.getByTestId("automations-forbidden")).toBeVisible();
  await page.goto(`/admin/automations/runs/${runId}`);
  await expect(page.getByTestId("automations-forbidden")).toBeVisible();
  expect((await api("GET", "/workflows", undefined, noperm.token)).status).toBe(403);
});

test("the AI Workflow Intelligence page (/admin/workflow) is unchanged and separate", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await seedAuth(page);
  await page.goto("/admin/workflow");
  await expect(page).toHaveURL(/\/admin\/workflow$/);
  await expect(page.getByRole("link", { name: "Workflow Intelligence" })).toBeVisible();
  await expect(page.getByText("Operational Health")).toBeVisible();
  await expect(page.getByTestId("automation-list")).toHaveCount(0);
  await expect(page.getByTestId("automation-editor")).toHaveCount(0);
});

test("responsive: automations, builder, run history and run detail never overflow at tablet/mobile; dark mode renders", async ({ page }) => {
  const routes = ["/admin/automations", `/admin/automations/${defId}`, "/admin/automations?tab=runs", `/admin/automations/runs/${runId}`];
  const ready = ["automation-list", "automation-editor", "run-history", "run-detail"];
  for (const viewport of [TABLET, MOBILE]) {
    await page.setViewportSize(viewport);
    await seedAuth(page);
    for (let i = 0; i < routes.length; i++) {
      await page.goto(routes[i]);
      await expect(page.getByTestId(ready[i])).toBeVisible();
      expect(await pageOverflow(page), `${routes[i]} @ ${viewport.width}px`).toBeLessThanOrEqual(1);
    }
  }
  await page.setViewportSize(DESKTOP);
  await seedAuth(page, { theme: "dark" });
  await page.goto(`/admin/automations/${defId}`);
  await expect(page.getByTestId("automation-editor")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);
  expect(await pageOverflow(page)).toBeLessThanOrEqual(1);
  await page.goto(`/admin/automations/runs/${runId}`);
  await expect(page.getByTestId("run-detail")).toBeVisible();
  expect(await pageOverflow(page)).toBeLessThanOrEqual(1);
});

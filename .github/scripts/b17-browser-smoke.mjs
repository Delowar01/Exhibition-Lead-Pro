// =============================================================================
// Batch 17 hosted activation — BROWSER smoke (runs on the GitHub runner with a
// real Chromium against the hosted web app; never on the VPS). Drives the
// production Automations UI end to end with the disposable tenant created by
// b17-hosted.sh seed. Prints one PASS/FAIL line per check, saves screenshots,
// exits non-zero on the first failed hard check. Never prints the password or
// the session token.
//
// Env: SMOKE_BASE (origin), SMOKE_EMAIL, SMOKE_PASSWORD_FILE, SMOKE_STAMP,
//      SMOKE_USER_ID, SMOKE_OUT (screenshot dir), SMOKE_PW_MODULE (path to the
//      @playwright/test package entry).
// =============================================================================
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const env = (k, d) => {
  const v = process.env[k] ?? d;
  if (v === undefined || v === "") throw new Error(`missing env ${k}`);
  return v;
};
const BASE = env("SMOKE_BASE").replace(/\/$/, "");
const API = `${BASE}/api`;
const EMAIL = env("SMOKE_EMAIL");
const PASSWORD = fs.readFileSync(env("SMOKE_PASSWORD_FILE"), "utf8").trim();
const STAMP = env("SMOKE_STAMP");
const USER_ID = Number(env("SMOKE_USER_ID"));
const OUT = env("SMOKE_OUT", "b17-smoke-shots");
fs.mkdirSync(OUT, { recursive: true });
const pwMod = await import(pathToFileURL(path.resolve(env("SMOKE_PW_MODULE"))).href);
const chromium = (pwMod.default ?? pwMod).chromium;

const NAME = `B17 smoke ${STAMP}`;
const TAG_NAME = `b17-smoke-${STAMP}`;
const results = [];
let failed = 0;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) {
    failed += 1;
    throw new Error(`check failed: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
let token = "";
async function api(method, p, body) {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text: text.slice(0, 300) };
}
const consoleErrors = [];
let shotN = 0;
async function shot(page, name) {
  shotN += 1;
  const file = path.join(OUT, `${String(shotN).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
async function pick(page, triggerTestId, optionName, exact = false) {
  await page.getByTestId(triggerTestId).click();
  await page.getByRole("option", { name: optionName, exact }).click();
}
const T = 30_000;
async function waitFor(fn, ms = T) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
const waitCount = (locator, n) => waitFor(async () => (await locator.count()) === n);
const waitText = (locator, text) => waitFor(async () => (await locator.innerText()).includes(text));

// ── login through the real API (same origin the browser will use) ──────────
const login = await api("POST", "/auth/login", { email: EMAIL, password: PASSWORD });
check("API login as the disposable primary_admin", login.status === 200 && !!login.json?.token && !login.json?.mfaRequired, `HTTP ${login.status}`);
token = login.json.token;
const user = login.json.user;
check("login user belongs to the disposable tenant", user?.id === USER_ID && user?.role === "primary_admin", `user ${user?.id} role ${user?.role} company ${user?.companyId}`);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: false });
await context.addInitScript(
  ([t, u, cid]) => {
    localStorage.setItem("csp_token", t);
    localStorage.setItem("csp_user", u);
    localStorage.setItem("csp_company_id", cid);
    localStorage.setItem("csp_theme", "light");
  },
  [token, JSON.stringify(user), String(user.companyId)],
);
const page = await context.newPage();
page.on("console", (m) => { if (m.type() === "error" && !/fonts\.g/.test(m.location()?.url ?? "")) consoleErrors.push(`${m.text().slice(0, 200)} @ ${m.location()?.url ?? ""}`); });
page.on("pageerror", (e) => consoleErrors.push(`pageerror ${String(e).slice(0, 200)}`));

let defId = 0, archiveId = 0, leadId = 0, runId = 0, tagId = 0;
try {
  // 1. /admin/automations loads
  await page.goto(`${BASE}/admin/automations`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("automation-list").waitFor({ timeout: T });
  check("1. /admin/automations loads (list + tabs + nav item)", (await waitCount(page.getByTestId("tab-runs"), 1)) && (await waitCount(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Automations" }), 1)));
  check("1b. fresh tenant shows the empty state", await waitCount(page.getByText("No automations yet"), 1));
  check("1c. no page-level horizontal overflow on the list", (await overflow(page)) <= 1, `${await overflow(page)}px`);
  await shot(page, "list-empty");

  // 3. AI Workflow Intelligence page untouched
  await page.goto(`${BASE}/admin/workflow`, { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: "Workflow Intelligence" }).waitFor({ timeout: T });
  await page.getByText("Operational Health").waitFor({ timeout: T });
  check("3. /admin/workflow (AI Workflow Intelligence) renders separately", page.url().endsWith("/admin/workflow") && (await page.getByTestId("automation-list").count()) === 0 && (await page.getByTestId("automation-editor").count()) === 0);
  await shot(page, "ai-workflow-page");

  // 4. builder → draft
  const tag = await api("POST", "/tags", { name: TAG_NAME, color: "#ef4444" });
  check("isolated tag created via API", tag.status < 300, `HTTP ${tag.status}`);
  tagId = tag.json.id;
  await page.goto(`${BASE}/admin/automations/new`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("automation-name").waitFor({ timeout: T });
  await page.getByTestId("automation-name").fill(NAME);
  await page.getByTestId("automation-description").fill("Hosted B17 smoke: task for the owner + tag when a smoke lead is created.");
  await pick(page, "trigger-type", "Lead created");
  await page.getByTestId("condition-add").click();
  await pick(page, "condition-field-0", "Title", true);
  await pick(page, "condition-operator-0", "contains", true);
  await page.getByTestId("condition-value-0").fill(STAMP);
  await page.getByTestId("action-add").click();
  check("4a. only lead-compatible actions are offered", (await page.getByRole("option", { name: "Add tag to lead" }).count()) === 1 && (await page.getByRole("option", { name: "Add tag to contact" }).count()) === 0);
  await page.getByRole("option", { name: "Create task" }).click();
  await page.getByTestId("field-actions[0].config.title").fill(`B17 smoke task ${STAMP}`);
  await pick(page, "action-add", "Add tag to lead");
  await pick(page, "field-actions[1].config.tagId", TAG_NAME);
  check("4b. actions keep their order (task, tag)", (await waitText(page.getByTestId("action-title-0"), "Create task")) && (await waitText(page.getByTestId("action-title-1"), "Add tag to lead")));
  await page.getByTestId("button-validate").click();
  await page.getByTestId("validation-summary").waitFor({ timeout: T });
  check("5a. server validation: valid and publishable", (await page.getByTestId("validation-summary").getAttribute("data-tone")) === "success");
  await shot(page, "builder-validated");
  await page.getByTestId("button-save").click();
  await page.waitForURL(/\/admin\/automations\/\d+$/, { timeout: T });
  defId = Number(page.url().split("/").pop());
  await page.getByTestId("automation-revision").waitFor({ timeout: T });
  check("4c. draft created and saved", (await page.getByTestId("automation-revision").innerText()) === "1" && (await page.getByTestId("automation-editor").getAttribute("data-status")) === "draft", `definition ${defId}`);
  check("4d. no overflow on the editor", (await overflow(page)) <= 1);
  await shot(page, "editor-draft");

  // 5. publish
  await page.getByTestId("button-publish").click();
  await page.getByTestId("lifecycle-dialog").waitFor({ timeout: T });
  await page.getByTestId("confirm-publish").click();
  await page.locator('[data-testid="automation-editor"][data-status="published"]').waitFor({ timeout: T });
  check("5b. published → Active, read-only", (await page.getByTestId("readonly-banner").getAttribute("data-reason")) === "published" && (await page.getByTestId("automation-name").isDisabled()) && (await page.getByTestId("button-save").count()) === 0);
  await shot(page, "editor-published");

  // 5. trigger with a real CRM event
  const lead = await api("POST", "/leads", { title: `B17 smoke lead ${STAMP}`, value: 1, assignedToId: USER_ID });
  check("real CRM event: POST /leads", lead.status < 300, `HTTP ${lead.status}`);
  leadId = lead.json.id;
  await page.goto(`${BASE}/admin/automations?tab=runs&definition=${defId}`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("run-history").waitFor({ timeout: T });
  const completedRow = page.locator('[data-testid^="run-row-"][data-status="completed"]');
  await completedRow.first().waitFor({ timeout: T });
  const rowText = await completedRow.first().innerText();
  runId = Number((await completedRow.first().getAttribute("data-testid")).replace("run-row-", ""));
  check("5c. run appears completed in Run History", (await completedRow.count()) === 1 && rowText.includes(NAME) && rowText.includes("Lead created") && rowText.includes(`Lead #${leadId}`) && rowText.includes("2/2 done"), `run ${runId}`);
  check("5d. polling stopped (all runs finished)", await waitText(page.getByTestId("runs-polling"), "finished"));
  await shot(page, "run-history");
  await page.getByTestId(`run-link-${runId}`).click();
  await page.waitForURL(new RegExp(`/admin/automations/runs/${runId}$`), { timeout: T });
  await page.locator('[data-testid="run-detail"][data-status="completed"]').waitFor({ timeout: T });
  const a0 = page.getByTestId("run-action-0"), a1 = page.getByTestId("run-action-1");
  check("5e. run detail: ordered action outcomes completed", (await a0.getAttribute("data-status")) === "completed" && (await waitText(a0, "Create task")) && (await a1.getAttribute("data-status")) === "completed" && (await waitText(a1, "Add tag to lead")) && (await waitText(page.getByTestId("run-action-1-result"), TAG_NAME)));
  check("5f. run detail links the related lead; no retry/replay controls", ((await page.getByTestId("run-entity-link").getAttribute("href")) ?? "").endsWith(`/admin/leads/${leadId}`) && (await page.getByRole("button", { name: /retry|replay|run now|re-run/i }).count()) === 0);
  check("5g. no overflow on the run detail", (await overflow(page)) <= 1);
  await shot(page, "run-detail");

  // 6. unpublish → editable draft
  await page.goto(`${BASE}/admin/automations/${defId}`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("button-unpublish").waitFor({ timeout: T });
  await page.getByTestId("button-unpublish").click();
  await page.getByTestId("confirm-unpublish").click();
  await page.locator('[data-testid="automation-editor"][data-status="draft"]').waitFor({ timeout: T });
  check("6a. unpublish → editable draft", (await waitCount(page.getByTestId("readonly-banner"), 0)) && (await page.getByTestId("automation-name").isEnabled()));

  // 7–11. browser history guard
  await page.goto(`${BASE}/admin/automations`, { waitUntil: "domcontentloaded" });
  await page.getByTestId(`automation-link-${defId}`).waitFor({ timeout: T });
  await page.getByTestId(`automation-link-${defId}`).click();
  await page.waitForURL(new RegExp(`/admin/automations/${defId}$`), { timeout: T });
  await page.getByTestId("automation-revision").waitFor({ timeout: T });
  const editorUrl = page.url();
  const armed = () => page.evaluate(() => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
  check("12a. reload guard is NOT armed while clean", (await armed()) === false);
  const len0 = await page.evaluate(() => history.length);
  await page.getByTestId("automation-name").click();
  await page.getByTestId("automation-name").fill(`${NAME} (history)`);
  await page.getByTestId("unsaved-indicator").waitFor({ timeout: T });
  await page.goBack({ waitUntil: "commit" });
  await page.getByTestId("unsaved-dialog").waitFor({ timeout: T });
  check("7. dirty editor → browser Back → dialog", true);
  await shot(page, "back-dialog");
  check("8a. while the dialog is open: URL, form, dirty state, history length unchanged", page.url() === editorUrl && (await page.getByTestId("automation-name").inputValue()) === `${NAME} (history)` && (await page.getByTestId("automation-editor").getAttribute("data-dirty")) === "true" && (await page.evaluate(() => history.length)) === len0);
  await page.getByTestId("unsaved-stay").click();
  await page.waitForTimeout(400);
  check("8b. Stay → dialog closed, nothing changed, no repeated dialog", (await page.getByTestId("unsaved-dialog").count()) === 0 && page.url() === editorUrl && (await page.getByTestId("automation-name").inputValue()) === `${NAME} (history)` && (await page.getByTestId("automation-editor").getAttribute("data-dirty")) === "true" && (await page.evaluate(() => history.length)) === len0);
  await page.goBack({ waitUntil: "commit" });
  await page.getByTestId("unsaved-dialog").waitFor({ timeout: T });
  await page.getByTestId("unsaved-discard").click();
  await page.waitForURL(/\/admin\/automations$/, { timeout: T });
  await page.getByTestId("automation-list").waitFor({ timeout: T });
  const nameAfter = (await api("GET", `/workflows/${defId}`)).json?.name;
  check("9. Back → Discard → landed on the list exactly once", (await page.evaluate(() => history.length)) === len0 && (await page.getByTestId("unsaved-dialog").count()) === 0 && nameAfter === NAME, `history.length ${len0}`);
  await page.goForward({ waitUntil: "commit" });
  await page.waitForURL(new RegExp(`/admin/automations/${defId}$`), { timeout: T });
  await page.getByTestId("automation-revision").waitFor({ timeout: T });
  check("10. Forward returns to a clean editor: no dialog, no phantom entry", (await page.getByTestId("unsaved-dialog").count()) === 0 && (await page.getByTestId("automation-editor").getAttribute("data-dirty")) === "false" && (await page.getByTestId("automation-name").inputValue()) === NAME && (await page.evaluate(() => history.length)) === len0);
  await page.goBack({ waitUntil: "commit" });
  await page.waitForURL(/\/admin\/automations$/, { timeout: T });
  const cleanBack = (await page.getByTestId("unsaved-dialog").count()) === 0;
  await page.goForward({ waitUntil: "commit" });
  await page.waitForURL(new RegExp(`/admin/automations/${defId}$`), { timeout: T });
  await page.getByTestId("automation-revision").waitFor({ timeout: T });
  check("11. clean Back/Forward navigate without a dialog", cleanBack && (await page.getByTestId("unsaved-dialog").count()) === 0);

  // 12. sidebar link, editor Cancel, reload, tab close
  await page.getByTestId("automation-name").click();
  await page.getByTestId("automation-name").fill(`${NAME} (guards)`);
  await page.getByTestId("unsaved-indicator").waitFor({ timeout: T });
  check("12b. reload/close guard armed while dirty", (await armed()) === true);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Contacts" }).click();
  await page.getByTestId("unsaved-dialog").waitFor({ timeout: T });
  await page.getByTestId("unsaved-stay").click();
  check("12c. sidebar link intercepted; Stay keeps the editor", (await waitCount(page.getByTestId("unsaved-dialog"), 0)) && page.url() === editorUrl && (await page.getByTestId("automation-name").inputValue()) === `${NAME} (guards)`);
  await page.getByTestId("button-back").click();
  await page.getByTestId("unsaved-dialog").waitFor({ timeout: T });
  await page.getByTestId("unsaved-stay").click();
  check("12d. editor Cancel/Back button intercepted; Stay keeps the editor", (await waitCount(page.getByTestId("unsaved-dialog"), 0)) && page.url() === editorUrl);
  const second = await context.newPage();
  await second.goto(`${BASE}/admin/automations/${defId}`, { waitUntil: "domcontentloaded" });
  await second.getByTestId("automation-name").waitFor({ timeout: T });
  await second.getByTestId("automation-name").click();
  await second.getByTestId("automation-name").fill(`${NAME} (close)`);
  await second.getByTestId("unsaved-indicator").waitFor({ timeout: T });
  const dialogP = second.waitForEvent("dialog", { timeout: T });
  await second.close({ runBeforeUnload: true });
  const d = await dialogP;
  check("12e. tab close shows the browser beforeunload prompt", d.type() === "beforeunload");
  await d.accept();
  await page.getByTestId("button-back").click();
  await page.getByTestId("unsaved-dialog").waitFor({ timeout: T });
  await page.getByTestId("unsaved-discard").click();
  await page.waitForURL(/\/admin\/automations$/, { timeout: T });
  check("12f. Discard from the Cancel button leaves the definition untouched", (await api("GET", `/workflows/${defId}`)).json?.name === NAME);

  // 6. archive (second draft) and delete draft through the list
  const second2 = await api("POST", "/workflows", { name: `B17 smoke archive ${STAMP}`, trigger: { type: "lead.created", config: {} }, conditions: [], actions: [{ type: "lead.add_tag", config: { tagId } }] });
  check("second draft created via API for the archive path", second2.status === 201, `HTTP ${second2.status}`);
  archiveId = second2.json.id;
  await page.goto(`${BASE}/admin/automations`, { waitUntil: "domcontentloaded" });
  await page.getByTestId(`automation-menu-${archiveId}`).waitFor({ timeout: T });
  await page.getByTestId(`automation-menu-${archiveId}`).click();
  await page.getByTestId(`automation-archive-${archiveId}`).click();
  await page.getByTestId("lifecycle-dialog").waitFor({ timeout: T });
  await page.getByTestId("lifecycle-confirm").click();
  await page.getByTestId(`automation-row-${archiveId}`).waitFor({ state: "detached", timeout: T });
  await page.getByTestId("automations-include-archived").click();
  await page.getByTestId(`automation-row-${archiveId}`).waitFor({ timeout: T });
  check("6b. archive with confirmation → Archived, hidden unless 'Show archived'", await waitText(page.getByTestId(`automation-row-${archiveId}`), "Archived"));
  await page.getByTestId(`automation-menu-${defId}`).click();
  await page.getByTestId(`automation-delete-${defId}`).click();
  await page.getByTestId("lifecycle-dialog").waitFor({ timeout: T });
  await page.getByTestId("lifecycle-confirm").click();
  await page.getByTestId(`automation-row-${defId}`).waitFor({ state: "detached", timeout: T });
  check("6c. draft deleted with confirmation", (await api("GET", `/workflows/${defId}`)).status === 404);
  await shot(page, "list-final");
  check("console: no unexpected browser errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
} catch (e) {
  try { await page.screenshot({ path: path.join(OUT, "99-failure.png"), fullPage: false }); console.log("failure screenshot saved; url:", page.url()); } catch { /* page gone */ }
  throw e;
} finally {
  await browser.close().catch(() => {});
  const logout = await api("POST", "/auth/logout", {}).catch(() => ({ status: "n/a" }));
  token = "";
  log(`logout -> ${logout.status}`);
  console.log(`\nSMOKE SUMMARY: ${results.filter((r) => r.ok).length} passed, ${failed} failed; definition=${defId} archive=${archiveId} lead=${leadId} run=${runId} tag=${tagId}; screenshots in ${OUT}`);
}
process.exit(failed === 0 ? 0 : 1);

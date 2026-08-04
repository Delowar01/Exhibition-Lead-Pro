import { test, expect, state, seedAuth, urlFor, waitForWorkspace } from "./fixtures/workspace";
import { API_BASE } from "./fixtures/seed-values";

/**
 * J. AI Copilot UX (Batch 5) — Copy / Regenerate / Save-as-Note actions, error
 * + retry states, duplicate-save idempotency, and the no-auto-send guarantee.
 *
 * Determinism: the tenant's AI settings are disabled for the whole file, so
 * every LLM path fails deterministically (no live Gemini) while the
 * deterministic follow-up plan keeps working. Original settings are restored
 * in afterAll.
 */

async function api(pathname: string, method = "GET", body?: unknown) {
  const res = await fetch(`${API_BASE}${pathname}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${state.token}`,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${pathname} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

let originalAiEnabled: boolean | null = null;

test.beforeAll(async () => {
  const settings = await api("/ai/settings");
  originalAiEnabled = settings?.enabled ?? true;
  await api("/ai/settings", "PATCH", { enabled: false });
});

test.afterAll(async () => {
  if (originalAiEnabled !== null) {
    await api("/ai/settings", "PATCH", { enabled: originalAiEnabled });
  }
});

const contactId = state.contact.id;
const NOTE_SUBJECT = "AI draft — Follow-up plan";

async function openCopilot(page: import("@playwright/test").Page) {
  await seedAuth(page);
  await page.goto(urlFor(contactId, "ai"));
  await waitForWorkspace(page);
  const panel = page.locator("#workspace-panel-ai");
  await expect(panel.getByText("AI Sales Copilot")).toBeVisible();
  return panel;
}

async function generateType(panel: ReturnType<import("@playwright/test").Page["locator"]>, page: import("@playwright/test").Page, label: string) {
  await panel.getByTestId("select-copilot-type").click();
  await page.getByRole("option", { name: label }).click();
  await panel.getByTestId("button-copilot-generate").click();
}

test("deterministic follow-up generates with AI disabled; Copy and Save as Note work", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const panel = await openCopilot(page);

  await generateType(panel, page, "Follow-up plan");
  await expect(page.getByText("Draft generated successfully").first()).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByText("Rule-based").first()).toBeVisible();

  // Copy → success toast (execCommand fallback keeps this deterministic).
  await panel.getByTestId("button-copy-followup").click();
  await expect(page.getByText("Copied to clipboard").first()).toBeVisible();

  // Save as Note → toast + a real timeline row via the API.
  await panel.getByTestId("button-save-note-followup").click();
  await expect(page.getByText("Saved to timeline").first()).toBeVisible({ timeout: 15_000 });

  const timeline = await api(`/contacts/${contactId}/timeline`);
  const entries = JSON.stringify(timeline);
  expect(entries).toContain(NOTE_SUBJECT);
});

test("saving the same draft as a note twice does not create a duplicate", async ({ page }) => {
  const panel = await openCopilot(page);
  await expect(panel.getByTestId("button-save-note-followup")).toBeVisible();
  await panel.getByTestId("button-save-note-followup").click();
  await expect(page.getByText("Saved to timeline").first()).toBeVisible({ timeout: 15_000 });

  const timeline = await api(`/contacts/${contactId}/timeline`);
  const raw = JSON.stringify(timeline);
  const count = raw.split(NOTE_SUBJECT).length - 1;
  expect(count).toBe(1);
});

test("regenerating the deterministic draft shows the regenerated toast", async ({ page }) => {
  const panel = await openCopilot(page);
  await panel.getByTestId("button-regenerate-followup").click();
  await expect(page.getByText("Draft regenerated").first()).toBeVisible({ timeout: 20_000 });
});

test("email draft soft-fails with AI disabled; Try again is offered and stays graceful", async ({ page }) => {
  const panel = await openCopilot(page);

  await generateType(panel, page, "Email draft");
  await expect(page.getByText("Draft unavailable").first()).toBeVisible({ timeout: 20_000 });

  const unavailable = panel.getByTestId("copilot-draft-unavailable");
  await expect(unavailable).toBeVisible();

  // Copy and Save as Note must be disabled for an unavailable draft.
  await expect(panel.getByTestId("button-copy-email")).toBeDisabled();
  await expect(panel.getByTestId("button-save-note-email")).toBeDisabled();

  // Retry (still failing) keeps the graceful placeholder — no crash, new toast.
  await panel.getByTestId("button-retry-generation").first().click();
  await expect(page.getByText("Draft unavailable").nth(1)).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByTestId("copilot-draft-unavailable")).toBeVisible();
});

test("panel load failure shows an inline error with a working Retry", async ({ page }) => {
  await seedAuth(page);
  // Abort only the copilot panel GET so the rest of the workspace loads.
  await page.route("**/ai/copilot/**/panel", (route) => route.abort());
  await page.goto(urlFor(contactId, "ai"));
  await waitForWorkspace(page);

  const panel = page.locator("#workspace-panel-ai");
  await expect(panel.getByTestId("copilot-panel-error")).toBeVisible({ timeout: 20_000 });

  await page.unroute("**/ai/copilot/**/panel");
  await panel.getByTestId("button-retry-panel").click();
  await expect(panel.getByTestId("copilot-panel-error")).toHaveCount(0, { timeout: 20_000 });
  await expect(panel.getByTestId("button-copy-followup")).toBeVisible({ timeout: 20_000 });
});

test("generate + copy + save never auto-send a communication", async ({ page }) => {
  const before = await api(`/contacts/${contactId}/communications`);
  const beforeCount = before?.total ?? before?.communications?.length ?? 0;

  const panel = await openCopilot(page);
  await panel.getByTestId("button-regenerate-followup").click();
  await expect(page.getByText("Draft regenerated").first()).toBeVisible({ timeout: 20_000 });
  await panel.getByTestId("button-copy-followup").click();
  await expect(page.getByText("Copied to clipboard").first()).toBeVisible();

  const after = await api(`/contacts/${contactId}/communications`);
  const afterCount = after?.total ?? after?.communications?.length ?? 0;
  expect(afterCount).toBe(beforeCount);
});

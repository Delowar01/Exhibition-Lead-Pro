import { test, expect, state, seedAuth } from "./fixtures/workspace";

/**
 * S. Batch 11 — Lead Conversion & Opportunity Closure UX. The Lead IS the
 * opportunity: Mark as Won / Mark as Lost / Reopen are confirm-gated on Lead
 * Detail, the pipeline workspace's stage control confirms closures too, a
 * cancelled confirmation performs no mutation, an optional close note lands in
 * the activity architecture, closed leads stay viewable, and a contact can get
 * a new opportunity after a won/lost one. Also: the sidebar now says
 * "Performance Analytics". Fixtures are created via the live API as the seeded
 * TechCorp admin and cleaned up afterwards.
 */

const API = "http://localhost:80/api";
const AUTH = { Authorization: `Bearer ${state.token}`, "Content-Type": "application/json" };

let contactId = 0;
let leadId = 0; // walked through won → reopen → lost in order
const cleanupLeadIds: number[] = [];

test.beforeAll(async ({ request }) => {
  const contact = await request.post(`${API}/contacts`, {
    headers: AUTH,
    data: { fullName: `B11 Closure QA ${Date.now()}`, contactCompany: "Closure Corp" },
  });
  expect(contact.ok()).toBe(true);
  contactId = (await contact.json()).id;

  const lead = await request.post(`${API}/leads`, {
    headers: AUTH,
    data: { contactId, stage: "prospect", value: 4200, currency: "USD" },
  });
  expect(lead.status()).toBe(201);
  leadId = (await lead.json()).id;
  cleanupLeadIds.push(leadId);
});

test.afterAll(async ({ request }) => {
  for (const id of cleanupLeadIds) {
    await request.delete(`${API}/leads/${id}`, { headers: AUTH }).catch(() => undefined);
  }
  if (contactId) await request.delete(`${API}/contacts/${contactId}`, { headers: AUTH }).catch(() => undefined);
});

async function leadStage(request: import("@playwright/test").APIRequestContext): Promise<string> {
  const res = await request.get(`${API}/leads/${leadId}`, { headers: AUTH });
  return (await res.json()).stage;
}

test("cancel on the Won confirmation performs no mutation", async ({ page, request }) => {
  await seedAuth(page);
  await page.goto(`/admin/leads/${leadId}`);
  await expect(page.getByTestId("lead-mark-won")).toBeVisible();
  await expect(page.getByTestId("lead-mark-lost")).toBeVisible();

  await page.getByTestId("lead-mark-won").click();
  await expect(page.getByTestId("lead-close-dialog")).toBeVisible();
  await expect(page.getByText(/recorded as Closed Won/)).toBeVisible();

  await page.getByTestId("lead-close-cancel").click();
  await expect(page.getByTestId("lead-close-dialog")).toHaveCount(0);
  expect(await leadStage(request)).toBe("prospect"); // untouched
});

test("Mark as Won: confirmation + optional note closes the opportunity and refreshes", async ({ page, request }) => {
  await seedAuth(page);
  await page.goto(`/admin/leads/${leadId}`);

  await page.getByTestId("lead-mark-won").click();
  await page.getByTestId("lead-close-note").fill("Signed the annual contract.");
  await page.getByTestId("lead-close-confirm").click();

  await expect(page.getByText("Opportunity marked as Won").first()).toBeVisible();
  // UI refreshed into the closed state: close actions gone, Reopen offered.
  await expect(page.getByTestId("lead-reopen")).toBeVisible();
  await expect(page.getByTestId("lead-mark-won")).toHaveCount(0);

  expect(await leadStage(request)).toBe("won");
  const acts = await request.get(`${API}/leads/${leadId}/activities`, { headers: AUTH }).then((r) => r.json());
  const list = acts.activities ?? acts;
  expect(list.some((a: any) => a.type === "won")).toBe(true);
  expect(list.some((a: any) => a.type === "note" && a.body === "Signed the annual contract.")).toBe(true);
});

test("closed lead remains fully viewable", async ({ page }) => {
  await seedAuth(page);
  await page.goto(`/admin/leads/${leadId}`);
  await expect(page.getByText("Pipeline Status")).toBeVisible();
  await expect(page.getByText("Deal Details")).toBeVisible();
  await expect(page.getByTestId("lead-reopen")).toBeVisible();
});

test("Reopen: confirmation restores the opportunity to an open stage", async ({ page, request }) => {
  await seedAuth(page);
  await page.goto(`/admin/leads/${leadId}`);

  await page.getByTestId("lead-reopen").click();
  await expect(page.getByTestId("lead-close-dialog")).toBeVisible();
  await expect(page.getByText(/counts toward the open pipeline again/)).toBeVisible();
  await page.getByTestId("lead-close-confirm").click();

  await expect(page.getByText("Opportunity reopened").first()).toBeVisible();
  await expect(page.getByTestId("lead-mark-won")).toBeVisible();
  expect(await leadStage(request)).toBe("prospect");
});

test("Mark as Lost closes it; the contact can then get a NEW opportunity", async ({ page, request }) => {
  await seedAuth(page);
  await page.goto(`/admin/leads/${leadId}`);

  await page.getByTestId("lead-mark-lost").click();
  await expect(page.getByText(/recorded as Closed Lost/)).toBeVisible();
  await page.getByTestId("lead-close-confirm").click();
  await expect(page.getByText("Opportunity marked as Lost").first()).toBeVisible();
  expect(await leadStage(request)).toBe("lost");

  // Batch 11 rule: a closed (lost) opportunity no longer blocks a new one.
  const again = await request.post(`${API}/leads`, {
    headers: AUTH,
    data: { contactId, stage: "prospect", value: 100, currency: "USD" },
  });
  expect(again.status()).toBe(201);
  cleanupLeadIds.push((await again.json()).id);
});

test("pipeline workspace stage control confirms a closure", async ({ page, request }) => {
  const openLeadId = cleanupLeadIds[cleanupLeadIds.length - 1];
  await seedAuth(page);
  await page.goto("/admin/leads");

  const badge = page.getByTestId(`badge-stage-${openLeadId}`).first();
  await badge.scrollIntoViewIfNeeded();
  await badge.click();
  await page.getByTestId(`stage-option-${openLeadId}-won`).click();

  await expect(page.getByTestId(`stage-confirm-${openLeadId}`)).toBeVisible();
  await page.getByTestId(`stage-confirm-ok-${openLeadId}`).click();

  await expect
    .poll(async () => (await request.get(`${API}/leads/${openLeadId}`, { headers: AUTH }).then((r) => r.json())).stage)
    .toBe("won");
});

test("sidebar links to Performance Analytics (route unchanged)", async ({ page }) => {
  await seedAuth(page);
  await page.goto("/admin");
  const navLink = page.getByRole("link", { name: "Performance Analytics" }).first();
  await expect(navLink).toBeVisible();
  await expect(page.getByRole("link", { name: "Executive Dashboard" })).toHaveCount(0);
  await navLink.click();
  await expect(page).toHaveURL(/\/admin\/analytics$/);
  await expect(page.getByRole("heading", { name: "Performance Analytics" })).toBeVisible();
});

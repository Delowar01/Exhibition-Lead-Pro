import { test, expect, state, seedAuth, urlFor, waitForWorkspace, markNoReload, markerStillSet } from "./fixtures/workspace";

/**
 * T. Batch 12 — CRM lifecycle in the Contact Workspace. The Overview's
 * "Next follow-up" panel always shows the NEAREST upcoming pending follow-up,
 * creating a follow-up or task from the workspace dialogs refreshes the
 * workspace without a reload, completing a follow-up from the Timeline
 * promotes the next pending one on the contact mirror, and task/follow-up
 * lifecycle events surface in the contact Timeline (System entries).
 * Fixtures are created via the live API and cleaned up afterwards.
 */

const API = "http://localhost:80/api";
const AUTH = { Authorization: `Bearer ${state.token}`, "Content-Type": "application/json" };

let contactId = 0;
const runTag = `B12 UX ${Date.now()}`;

test.beforeAll(async ({ request }) => {
  const contact = await request.post(`${API}/contacts`, {
    headers: AUTH,
    data: { fullName: runTag, contactCompany: "Lifecycle Corp" },
  });
  expect(contact.ok()).toBe(true);
  contactId = (await contact.json()).id;

  for (const scheduledDate of ["2026-09-20", "2026-09-12"]) {
    const res = await request.post(`${API}/follow-ups`, {
      headers: AUTH,
      data: { contactId, scheduledDate, notes: `${runTag} ${scheduledDate}` },
    });
    expect(res.status()).toBe(201);
  }
});

test.afterAll(async ({ request }) => {
  if (!contactId) return;
  const fus = await request.get(`${API}/follow-ups?contactId=${contactId}`, { headers: AUTH });
  for (const f of (await fus.json()).followUps ?? []) {
    await request.delete(`${API}/follow-ups/${f.id}`, { headers: AUTH }).catch(() => undefined);
  }
  const tasks = await request.get(`${API}/tasks?scope=all&contactId=${contactId}`, { headers: AUTH });
  for (const t of (await tasks.json()).tasks ?? []) {
    await request.delete(`${API}/tasks/${t.id}`, { headers: AUTH }).catch(() => undefined);
  }
  await request.delete(`${API}/contacts/${contactId}`, { headers: AUTH }).catch(() => undefined);
});

async function mirror(request: import("@playwright/test").APIRequestContext) {
  const res = await request.get(`${API}/contacts/${contactId}`, { headers: AUTH });
  const body = await res.json();
  return { date: body.followUpDate ?? null, time: body.followUpTime ?? null };
}

test("Overview shows the nearest pending follow-up, and scheduling an earlier one updates it without a reload", async ({ page, request }) => {
  await seedAuth(page);
  await page.goto(urlFor(contactId, "overview"));
  await waitForWorkspace(page);
  await markNoReload(page);

  // Nearest of Sep 20 / Sep 12 is Sep 12 — never the furthest.
  await expect(page.getByTestId("primary-followup")).toContainText("Sep 12, 2026");

  // Schedule an even earlier follow-up through the workspace dialog.
  await page.getByTestId("button-overview-schedule").click();
  await page.getByTestId("input-followup-date").fill("2026-09-05");
  await page.getByTestId("input-followup-notes").fill(`${runTag} earliest`);
  await page.getByTestId("button-save-followup").click();

  // The panel refreshes in place (no browser reload) to the new nearest date…
  await expect(page.getByTestId("primary-followup")).toContainText("Sep 5, 2026");
  expect(await markerStillSet(page)).toBe(true);

  // …and the server-side contact mirror agrees.
  expect((await mirror(request)).date).toBe("2026-09-05");
});

test("follow-up lifecycle events appear in the contact Timeline as System entries", async ({ page }) => {
  await seedAuth(page);
  await page.goto(urlFor(contactId, "timeline"));
  await waitForWorkspace(page);

  await page.getByTestId("chip-timeline-system").click();
  const events = page.locator('[data-testid^="timeline-event-"]');
  await expect(events.filter({ hasText: "Follow-up scheduled for 2026-09-05" }).first()).toBeVisible();
});

test("completing the nearest follow-up from the Timeline promotes the next pending one", async ({ page, request }) => {
  // Resolve the id of the Sep 5 pending follow-up for a precise selection.
  const list = await request.get(`${API}/follow-ups?contactId=${contactId}`, { headers: AUTH });
  const sep5 = ((await list.json()).followUps as Array<{ id: number; scheduledDate: string | null; status: string }>).find(
    (f) => f.status === "pending" && f.scheduledDate === "2026-09-05",
  );
  expect(sep5).toBeTruthy();

  await seedAuth(page);
  await page.goto(urlFor(contactId, "timeline"));
  await waitForWorkspace(page);
  await markNoReload(page);

  await page.getByTestId("chip-timeline-follow_up").click();
  await page.getByTestId(`timeline-event-followup-${sep5!.id}`).click();
  const preview = page.getByRole("complementary", { name: "Event preview" });
  await preview.getByTestId("button-timeline-complete").click();

  // The completion lands in the Timeline (System entry) without a reload…
  await page.getByTestId("chip-timeline-system").click();
  const events = page.locator('[data-testid^="timeline-event-"]');
  await expect(events.filter({ hasText: "Follow-up completed" }).first()).toBeVisible();
  expect(await markerStillSet(page)).toBe(true);

  // …and the contact mirror moves to the next pending follow-up (Sep 12).
  await expect.poll(async () => (await mirror(request)).date).toBe("2026-09-12");
});

test("creating a task from the workspace surfaces it in Overview and the Timeline", async ({ page }) => {
  await seedAuth(page);
  await page.goto(urlFor(contactId, "overview"));
  await waitForWorkspace(page);
  await markNoReload(page);

  await page.getByTestId("button-overview-create-task").click();
  await page.getByTestId("input-task-title").fill(`${runTag} prep dossier`);
  await page.getByTestId("input-task-due").fill("2026-09-10");
  await page.getByTestId("button-save-task").click();

  // Overview's task list refreshes in place with the new task.
  await expect(page.locator('[data-testid^="overview-task-"]').filter({ hasText: `${runTag} prep dossier` }).first()).toBeVisible();
  expect(await markerStillSet(page)).toBe(true);

  // The creation event is on the contact Timeline.
  await page.goto(urlFor(contactId, "timeline"));
  await waitForWorkspace(page);
  await page.getByTestId("chip-timeline-system").click();
  const events = page.locator('[data-testid^="timeline-event-"]');
  await expect(events.filter({ hasText: `Task created: ${runTag} prep dossier` }).first()).toBeVisible();
});

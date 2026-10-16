import { test, expect, state, seedAuth } from "./fixtures/workspace";

/**
 * ZZ. MOBILE-R2 — later event assignment on the admin web: the directory multi-select with the
 * bulk "Assign to Event" bar, and the single-contact "Assign to Event" / "Change Event" control
 * of the contact workspace (No Event → Event, Event A → Event B, Event → No Event). Fixtures are
 * created through the live API as the seeded admin and removed afterwards.
 */

const API = "http://localhost:80/api";
const AUTH = { Authorization: `Bearer ${state.token}`, "Content-Type": "application/json" };
const runTag = `R2E2E${Date.now().toString(36)}`;

let leapId = 0;
let gitexId = 0;
const contactIds: number[] = [];

test.beforeAll(async ({ request }) => {
  for (const [name, setter] of [[`LEAP ${runTag}`, (id: number) => (leapId = id)], [`GITEX ${runTag}`, (id: number) => (gitexId = id)]] as const) {
    const res = await request.post(`${API}/events`, { headers: AUTH, data: { name, status: "active" } });
    expect(res.status(), `create event ${name}`).toBe(201);
    setter((await res.json()).id);
  }
  for (const n of ["One", "Two", "Three"]) {
    const res = await request.post(`${API}/contacts`, { headers: AUTH, data: { firstName: runTag, lastName: n, contactCompany: "Event Assign Co" } });
    expect(res.status(), `create contact ${n}`).toBe(201);
    contactIds.push((await res.json()).id);
  }
});

test.afterAll(async ({ request }) => {
  for (const id of contactIds) await request.delete(`${API}/contacts/${id}`, { headers: AUTH }).catch(() => undefined);
  for (const id of [leapId, gitexId]) if (id) await request.delete(`${API}/events/${id}`, { headers: AUTH }).catch(() => undefined);
});

async function contactEvent(request: Parameters<Parameters<typeof test>[2]>[0]["request"], id: number) {
  const res = await request.get(`${API}/contacts/${id}`, { headers: AUTH });
  expect(res.ok()).toBe(true);
  const body = await res.json();
  return { eventId: body.eventId ?? null, eventName: body.eventName ?? null };
}

test("directory: select several contacts and assign them to an event in one bounded bulk operation (No Event → Event)", async ({ page, request }) => {
  await seedAuth(page);
  await page.goto("/admin/contacts");
  await page.getByTestId("input-contact-search").fill(runTag);
  for (const id of contactIds) await expect(page.getByTestId(`checkbox-contact-${id}`)).toBeVisible();
  await page.getByTestId("checkbox-select-all-contacts").click();
  await expect(page.getByTestId("contacts-bulk-bar")).toContainText(`${contactIds.length} selected`);
  await page.getByTestId("button-bulk-assign-event").click();
  const dialog = page.getByTestId("dialog-assign-event");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("select-assign-event").click();
  await page.getByRole("option", { name: new RegExp(`^LEAP ${runTag}`) }).click();
  await dialog.getByTestId("button-assign-event-confirm").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("contacts-bulk-bar")).toBeHidden();
  for (const id of contactIds) expect(await contactEvent(request, id)).toEqual({ eventId: leapId, eventName: `LEAP ${runTag}` });
});

test("contact workspace: Change Event moves a single contact A → B, then Event → No Event; the hero reflects each state", async ({ page, request }) => {
  const id = contactIds[0];
  await seedAuth(page);
  await page.goto(`/admin/contacts/${id}`);
  await expect(page.getByTestId("text-hero-event")).toContainText(`LEAP ${runTag}`);
  await expect(page.getByTestId("button-hero-assign-event")).toHaveText("Change Event");
  await page.getByTestId("button-hero-assign-event").click();
  let dialog = page.getByTestId("dialog-assign-event");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("select-assign-event").click();
  await page.getByRole("option", { name: new RegExp(`^GITEX ${runTag}`) }).click();
  await dialog.getByTestId("button-assign-event-confirm").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("text-hero-event")).toContainText(`GITEX ${runTag}`);
  expect(await contactEvent(request, id)).toEqual({ eventId: gitexId, eventName: `GITEX ${runTag}` });

  await page.getByTestId("button-hero-assign-event").click();
  dialog = page.getByTestId("dialog-assign-event");
  await dialog.getByTestId("select-assign-event").click();
  await page.getByRole("option", { name: "No Event" }).click();
  await expect(dialog.getByTestId("button-assign-event-confirm")).toHaveText("Remove event");
  await dialog.getByTestId("button-assign-event-confirm").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("text-hero-event")).toContainText("No Event");
  await expect(page.getByTestId("button-hero-assign-event")).toHaveText("Assign to Event");
  expect(await contactEvent(request, id)).toEqual({ eventId: null, eventName: null });
});

test("audit: every move left one contacts.event_assign entry with a readable summary", async ({ request }) => {
  const res = await request.get(`${API}/security/audit?pageSize=100`, { headers: AUTH });
  expect(res.ok()).toBe(true);
  const body = await res.json();
  const rows: Array<{ action: string; entityId?: string | null; metadata?: Record<string, unknown> | null }> = body.entries ?? body.logs ?? body.items ?? body.data ?? [];
  const mine = rows.filter((r) => r.action === "contacts.event_assign" && contactIds.map(String).includes(String(r.entityId)));
  expect(mine.length).toBeGreaterThanOrEqual(contactIds.length + 2);
  const summaries = mine.map((r) => String(r.metadata?.summary ?? ""));
  expect(summaries).toContain(`No Event → LEAP ${runTag}`);
  expect(summaries).toContain(`LEAP ${runTag} → GITEX ${runTag}`);
  expect(summaries).toContain(`GITEX ${runTag} → No Event`);
});

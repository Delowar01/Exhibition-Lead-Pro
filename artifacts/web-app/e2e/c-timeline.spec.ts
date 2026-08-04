import {
  test,
  expect,
  state,
  seedAuth,
  urlFor,
  waitForWorkspace,
} from "./fixtures/workspace";

/**
 * C. Timeline consolidation — with seeded data, one entry of each kind is
 * visible (call/email/whatsapp/meeting/task/follow-up/capture), search filters
 * entries, filter chips filter with live counts matching the seeded data,
 * selecting an event updates the detail preview, and inline task/follow-up
 * action buttons are present.
 */

async function openTimeline(page: import("@playwright/test").Page) {
  await seedAuth(page);
  await page.goto(urlFor(state.contact.id, "timeline"));
  await waitForWorkspace(page);
  // Wait for the timeline feed to have rendered at least one event.
  await expect(page.locator('[data-testid^="timeline-event-"]').first()).toBeVisible({
    timeout: 20000,
  });
}

function chipCount(page: import("@playwright/test").Page, key: string) {
  return page.getByTestId(`chip-timeline-${key}`);
}

test("timeline shows a consolidated entry for every seeded kind", async ({ page }) => {
  await openTimeline(page);

  // The chip labels carry the live count "(N)". Each seeded kind should be ≥1.
  for (const key of ["call", "email", "whatsapp", "meeting", "task", "follow_up", "capture"]) {
    const chip = chipCount(page, key);
    await expect(chip).toBeVisible();
    const text = (await chip.innerText()).replace(/\s+/g, " ");
    const m = text.match(/\((\d+)\)/);
    const n = m ? Number(m[1]) : 0;
    expect(n, `expected ≥1 ${key} events, chip said "${text}"`).toBeGreaterThanOrEqual(1);
  }

  // Filter to each kind and prove real filtering: the seeded entry unique to
  // that kind is visible, an entry of a DIFFERENT kind is not, and the number
  // of rendered events matches the chip's live count.
  const uniqueText: Record<string, string> = {
    call: `${state.runTag} inbound discovery call`,
    email: `${state.runTag} intro email`,
    whatsapp: `${state.runTag} whatsapp ping`,
    meeting: `${state.runTag} kickoff meeting`,
    task: `${state.runTag} prepare proposal task`,
    follow_up: `${state.runTag} follow up on pricing`,
    capture: state.capture.notes,
  };
  const kinds = Object.keys(uniqueText);
  const events = page.locator('[data-testid^="timeline-event-"]');
  for (const key of kinds) {
    await chipCount(page, key).click();
    await expect(
      events.filter({ hasText: uniqueText[key] }).first(),
      `seeded ${key} entry not visible after filtering to ${key}`,
    ).toBeVisible();
    const otherKey = kinds[(kinds.indexOf(key) + 1) % kinds.length];
    await expect(
      events.filter({ hasText: uniqueText[otherKey] }),
      `${otherKey} entry leaked into the ${key} filter`,
    ).toHaveCount(0);
    const chipText = (await chipCount(page, key).innerText()).replace(/\s+/g, " ");
    const expectedCount = Number(chipText.match(/\((\d+)\)/)?.[1] ?? "NaN");
    await expect(events, `event count mismatch for ${key} filter`).toHaveCount(expectedCount);
  }
});

test("chip live counts match the seeded data exactly", async ({ page }) => {
  await openTimeline(page);
  const expected = state.contact.counts;
  const read = async (key: string) => {
    const text = (await chipCount(page, key).innerText()).replace(/\s+/g, " ");
    return Number(text.match(/\((\d+)\)/)?.[1] ?? "NaN");
  };
  expect(await read("call")).toBe(expected.call);
  expect(await read("email")).toBe(expected.email);
  expect(await read("whatsapp")).toBe(expected.whatsapp);
  expect(await read("meeting")).toBe(expected.meeting);
  expect(await read("task")).toBe(expected.task);
  expect(await read("follow_up")).toBe(expected.follow_up);
  expect(await read("capture")).toBe(expected.capture);

  // "All" equals the sum of the per-kind chips (the timeline also surfaces the
  // capture rows a second time as "system" entries — kind "interaction" — so we
  // reconcile against the actual per-kind counts, including system).
  const system = await read("system");
  const note = await read("note");
  const all = await read("all");
  const sum =
    expected.call +
    expected.email +
    expected.whatsapp +
    expected.meeting +
    expected.task +
    expected.follow_up +
    expected.capture +
    system +
    note;
  expect(all).toBe(sum);
});

test("Notes and System filter chips exist (documented data limitation)", async ({ page }) => {
  // There is no contact-note API and no contact-timeline system-event generator,
  // so we assert the filter chips exist rather than fabricating entries.
  await openTimeline(page);
  await expect(chipCount(page, "note")).toBeVisible();
  await expect(chipCount(page, "system")).toBeVisible();
});

test("search filters the timeline entries", async ({ page }) => {
  await openTimeline(page);
  const events = page.locator('[data-testid^="timeline-event-"]');

  const before = await events.count();
  expect(before).toBeGreaterThan(1);

  // Search for the unique call subject → should narrow the feed.
  await page.getByTestId("input-timeline-search").fill(state.contact.searchTerms.call);
  await expect(events.first()).toBeVisible();
  const afterCall = await events.count();
  expect(afterCall).toBeGreaterThanOrEqual(1);
  expect(afterCall).toBeLessThan(before);
  await expect(events.first()).toContainText(state.runTag);

  // A search that matches nothing → empty state.
  await page.getByTestId("input-timeline-search").fill("zzz-no-such-event-zzz");
  await expect(page.getByText(/no timeline events found/i)).toBeVisible();

  // Clear returns the full feed.
  await page.getByTestId("input-timeline-search").fill("");
  await expect(events.first()).toBeVisible();
  expect(await events.count()).toBe(before);
});

test("selecting an event opens/updates the detail preview", async ({ page }) => {
  await openTimeline(page);
  const preview = page.getByRole("complementary", { name: "Event preview" });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText(/select an event/i);

  // Select the seeded task (has inline actions).
  await page.getByTestId("input-timeline-search").fill(state.contact.searchTerms.task);
  const taskEvent = page.locator('[data-testid^="timeline-event-task-"]').first();
  await expect(taskEvent).toBeVisible();
  await taskEvent.click();

  // Preview updates to the task title and exposes inline task actions.
  await expect(preview).toContainText(state.runTag);
  await expect(preview.getByTestId("button-timeline-complete")).toBeVisible();
  await expect(preview.getByTestId("button-timeline-delete")).toBeVisible();

  // Now select the follow-up and confirm the preview swaps content.
  await page.getByTestId("input-timeline-search").fill("");
  await page.getByTestId("chip-timeline-follow_up").click();
  const followUp = page.locator('[data-testid^="timeline-event-followup-"]').first();
  await expect(followUp).toBeVisible();
  await followUp.click();
  await expect(preview.getByTestId("button-timeline-complete")).toBeVisible();
  await expect(preview.getByTestId("button-timeline-delete")).toBeVisible();
});

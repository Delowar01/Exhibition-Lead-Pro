import {
  test,
  expect,
  state,
  seedAuth,
  urlFor,
  waitForWorkspace,
} from "./fixtures/workspace";

/**
 * D. Capture fidelity regression (DOM assertions, not screenshots) — open the
 * deterministically seeded QR capture and assert its source label, capturing
 * user, event handling, GPS coordinates, notes, image element, and the OCR
 * fields extracted from the seeded extractedData.
 */

test("seeded QR capture detail renders every field faithfully", async ({ page }) => {
  await seedAuth(page);
  await page.goto(urlFor(state.contact.id, "timeline"));
  await waitForWorkspace(page);

  // Isolate captures and open the specific seeded QR scan row.
  await page.getByTestId("chip-timeline-capture").click();
  const captureEvent = page.getByTestId(`timeline-event-capture-${state.seededScanId}`);
  await expect(captureEvent).toBeVisible({ timeout: 20000 });
  await captureEvent.click();

  const preview = page.getByRole("complementary", { name: "Event preview" });
  await expect(preview).toBeVisible();

  const cap = state.capture;

  // Capture source label (qr → "QR Code").
  await expect(preview.getByText("QR Code")).toBeVisible();

  // Detail labels are <dt> terms; match them exactly to avoid colliding with
  // the value text below each label.
  const dt = (label: string) =>
    preview.locator("dt", { hasText: new RegExp(`^${label}$`, "i") });

  // Capturing user (the seeded scan's userId resolves to the logged-in user).
  await expect(dt("Captured By")).toBeVisible();
  await expect(preview.getByText(state.user.name ?? "Sarah Mitchell")).toBeVisible();

  // Event: none seeded → the "Event" label must be absent (absence handled).
  await expect(dt("Event")).toHaveCount(0);

  // GPS coordinates (rendered to 5 decimals).
  const lat = cap.latitude.toFixed(5);
  const lon = cap.longitude.toFixed(5);
  await expect(dt("Location")).toBeVisible();
  await expect(preview.getByText(`${lat}, ${lon}`)).toBeVisible();

  // Notes.
  await expect(dt("Notes")).toBeVisible();
  await expect(preview.getByText(cap.notes)).toBeVisible();

  // AI summary (heading + the seeded summary text).
  await expect(preview.getByText("AI Summary", { exact: true })).toBeVisible();
  await expect(preview.getByText(cap.aiSummary)).toBeVisible();

  // Image element present with a resolved src (the API rewrites imageUrl to
  // /api/scans/:id/image once an image is stored).
  const img = preview.getByRole("img", { name: /captured business card/i });
  await expect(img).toBeVisible();
  const src = await img.getAttribute("src");
  expect(src, "capture image should have a src").toBeTruthy();
  expect(src).toContain(`/api/scans/${state.seededScanId}/image`);

  // Extracted OCR fields from the deterministic extractedData.
  await expect(preview.getByText("Extracted Data")).toBeVisible();
  const ocr = cap.extractedData;
  const ocrList = preview.locator("dl").last();
  for (const value of [
    ocr.firstName,
    ocr.lastName,
    ocr.jobTitle,
    ocr.company,
    ocr.email,
    ocr.mobile,
  ]) {
    await expect(ocrList.getByText(value, { exact: false }).first()).toBeVisible();
  }
});

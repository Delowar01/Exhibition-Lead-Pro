import { test, expect, type Page, type Response } from "@playwright/test";
import { ADMIN } from "./fixtures/seed-values";

/**
 * W. M5 — client entitlement refresh.
 *
 * The signed-in user (and with it the plan entitlements) is no longer frozen
 * at sign-in: the web app re-reads GET /auth/me on session restore, when the
 * tab comes back to the front, after a token refresh and when the API answers
 * 403 FEATURE_NOT_ENTITLED. Proven here against the local stack:
 *   • a resume picks up a plan change — the Documents entry disappears and the
 *     documents route shows its "not included" state — WITHOUT a sign-out;
 *   • a reload (session restore, never throttled) picks up the way back, from
 *     the copy the refresh persisted in localStorage;
 *   • a failing /auth/me (500) changes nothing and never signs the user out;
 *   • a 403 FEATURE_NOT_ENTITLED from a module triggers the same re-read;
 *   • so does a renewed session (401 → POST /auth/refresh → retry).
 *
 * Auth is a REAL UI login (as n-newtab-auth) — no addInitScript seeding, which
 * would rewrite csp_user on every reload and hide what the refresh persisted.
 * /auth/me is answered with the server's REAL payload; only the Documents
 * entitlement is rewritten (the server itself is never reconfigured).
 */

type MeMode = "real" | "documents-denied" | "error";

const isAuthMe = (response: Response) => new URL(response.url()).pathname === "/api/auth/me";

async function signIn(page: Page) {
  await page.goto("/login");
  await page.locator("#email").fill(ADMIN.email);
  await page.locator("#password").fill(ADMIN.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL("**/admin");
}

/** GET /auth/me: the real answer, the real answer with Documents switched off on an enforced version, or a 500. */
async function mockAuthMe(page: Page, mode: () => MeMode) {
  await page.route("**/api/auth/me", async (route) => {
    const current = mode();
    try {
      if (current === "error") {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Internal Server Error" }) });
        return;
      }
      if (current === "real") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      if (!response.ok()) {
        await route.fulfill({ response });
        return;
      }
      const me = await response.json();
      me.entitlements = {
        planVersionId: null,
        trialPolicy: { endOutcome: "blocked", readOnlyGraceDays: 0, graceEndsAt: null },
        ...(me.entitlements ?? {}),
        featureEnforcement: "enforced",
        features: { ...(me.entitlements?.features ?? {}), documents: false },
      };
      await route.fulfill({ response, json: me });
    } catch {
      // The page navigated away while this request was in flight — nothing left to answer.
      await route.abort().catch(() => undefined);
    }
  });
}

/** What the browser fires when a background tab comes back to the front. */
async function resume(page: Page) {
  await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
}

/** The stored session reduced to what the assertions need — the token itself never leaves the page. */
async function storedSession(page: Page) {
  return page.evaluate(() => {
    const user = JSON.parse(localStorage.getItem("csp_user") ?? "null");
    return {
      signedIn: !!localStorage.getItem("csp_token") && !!user,
      enforcement: (user?.entitlements?.featureEnforcement ?? null) as string | null,
      documentsAllowed: user?.entitlements?.features?.documents !== false,
    };
  });
}

test("resume re-reads /auth/me: Documents disappears without a sign-out, returns on session restore, and a failing /auth/me changes nothing", async ({ page }) => {
  // Only the fallback of step 1 can come near the default budget (see there).
  test.setTimeout(120_000);
  let mode: MeMode = "real";
  await mockAuthMe(page, () => mode);
  const documentsLink = page.locator('a[href="/admin/documents"]');
  const contactsLink = page.locator('a[href="/admin/contacts"]').first();

  await signIn(page);

  // Session restore: a full load with the stored session re-reads the user once.
  const restored = page.waitForResponse(isAuthMe);
  await page.goto("/admin/contacts");
  expect((await restored).status()).toBe(200);
  await expect(contactsLink).toBeVisible();
  await expect(documentsLink.first()).toBeVisible();
  expect(await storedSession(page)).toMatchObject({ signedIn: true, documentsAllowed: true });

  // 1. The plan version stops including Documents; the tab comes back to the front.
  //    The first resume after a load is never throttled, so this passes on the first
  //    attempt. Should the browser itself have fired a focus event since the load, the
  //    30 s throttle window is waited out by re-dispatching — not by sleeping.
  mode = "documents-denied";
  await expect(async () => {
    await resume(page);
    await expect(documentsLink).toHaveCount(0, { timeout: 1_500 });
  }).toPass({ timeout: 45_000 });
  await expect(page).toHaveURL(/\/admin\/contacts/);
  await expect(contactsLink).toBeVisible();
  expect(await storedSession(page)).toEqual({ signedIn: true, enforcement: "enforced", documentsAllowed: false });

  // The documents route explains itself instead of surfacing request errors.
  const reread = page.waitForResponse(isAuthMe);
  await page.goto("/admin/documents");
  await reread;
  await expect(page.getByTestId("feature-unavailable-documents")).toBeVisible();
  await expect(page.getByTestId("feature-unavailable-documents")).toContainText("not included");
  await expect(documentsLink).toHaveCount(0);

  // 2. The plan includes Documents again. A reload boots from the persisted (denied)
  //    copy and the session-restore refresh — never throttled — brings the module back.
  mode = "real";
  await page.reload();
  await expect(documentsLink.first()).toBeVisible();
  await expect(page.getByTestId("feature-unavailable-documents")).toHaveCount(0);
  await expect(page).toHaveURL(/\/admin\/documents/);
  expect(await storedSession(page)).toMatchObject({ signedIn: true, documentsAllowed: true });

  // 3. /auth/me fails: nothing changes, nobody is signed out, the portal keeps working.
  mode = "error";
  const failed = page.waitForResponse((response) => isAuthMe(response) && response.status() === 500);
  await page.reload();
  await failed;
  await expect(documentsLink.first()).toBeVisible();
  await contactsLink.click();
  await expect(page).toHaveURL(/\/admin\/contacts/);
  await expect(documentsLink.first()).toBeVisible();
  expect(await storedSession(page)).toMatchObject({ signedIn: true, documentsAllowed: true });
});

test("a 403 FEATURE_NOT_ENTITLED from the API re-reads /auth/me: the refused module shows its not-included state, still signed in", async ({ page }) => {
  let mode: MeMode = "real";
  await mockAuthMe(page, () => mode);
  const documentsLink = page.locator('a[href="/admin/documents"]');

  await signIn(page);
  await expect(documentsLink.first()).toBeVisible();

  // The plan version stops including Documents: the API refuses the module and
  // /auth/me says so too. No reload and no resume here — only the refusal itself
  // can tell the client that its cached entitlements are stale.
  mode = "documents-denied";
  await page.route(/\/api\/documents(\/|\?|$)/, (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: "Documents is not included in your plan", code: "FEATURE_NOT_ENTITLED", context: { feature: "documents" } }),
    }),
  );
  await documentsLink.first().click();
  await expect(page).toHaveURL(/\/admin\/documents/);
  await expect(page.getByTestId("feature-unavailable-documents")).toBeVisible();
  await expect(documentsLink).toHaveCount(0);
  await expect(page.locator('a[href="/admin/contacts"]').first()).toBeVisible();
  expect(await storedSession(page)).toEqual({ signedIn: true, enforcement: "enforced", documentsAllowed: false });
});

test("a renewed session (401 → token refresh) re-reads /auth/me: the plan change is picked up, the session continues", async ({ page }) => {
  let mode: MeMode = "real";
  await mockAuthMe(page, () => mode);
  const documentsLink = page.locator('a[href="/admin/documents"]');

  await signIn(page);
  await expect(documentsLink.first()).toBeVisible();

  // The access token of THIS test's own session stops being accepted (as an
  // expired one would); its refresh token is still good. The next API call gets
  // a 401, the client rotates the tokens, retries — and re-reads the user.
  mode = "documents-denied";
  const STALE = "expired.access.token";
  // Armed first: a background poll may hit the 401 before the click below does.
  const renewed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/auth/refresh" && response.status() === 200);
  await page.evaluate((stale) => localStorage.setItem("csp_token", stale), STALE);
  await page.locator('a[href="/admin/contacts"]').first().click();
  await renewed;
  await expect(documentsLink).toHaveCount(0);
  await expect(page).toHaveURL(/\/admin\/contacts/);
  await expect(page.locator('a[href="/admin/contacts"]').first()).toBeVisible();
  expect(await storedSession(page)).toEqual({ signedIn: true, enforcement: "enforced", documentsAllowed: false });
  expect(await page.evaluate((stale) => localStorage.getItem("csp_token") !== stale, STALE)).toBe(true);
});

import fs from "node:fs";
import { test as base, expect, type Page } from "@playwright/test";
import { STATE_FILE, type SeedState } from "./seed-values";

function loadState(): SeedState {
  if (!fs.existsSync(STATE_FILE)) {
    throw new Error("Seed state not found — global-setup must run first.");
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as SeedState;
}

export const state: SeedState = loadState();

/**
 * Seeds localStorage the way the web app's boot reads it (csp_token / csp_user /
 * csp_refresh_token / csp_company_id) BEFORE any navigation, plus an optional
 * theme. This reuses the real login token — it is not a login bypass. Also sets
 * a window marker used to prove SPA navigations do not perform a full reload.
 */
export async function seedAuth(page: Page, opts: { theme?: "light" | "dark" | "system" } = {}) {
  const { token, refreshToken, user } = state;
  const theme = opts.theme ?? "light";
  await page.addInitScript(
    ([t, r, u, companyId, th]) => {
      try {
        localStorage.setItem("csp_token", t as string);
        localStorage.setItem("csp_user", u as string);
        if (r) localStorage.setItem("csp_refresh_token", r as string);
        if (companyId) localStorage.setItem("csp_company_id", companyId as string);
        localStorage.setItem("csp_theme", th as string);
      } catch {
        /* storage unavailable */
      }
    },
    [token, refreshToken ?? "", JSON.stringify(user), String(user.companyId ?? ""), theme] as const,
  );
}

/** Stamp a marker on window; if a real reload happens the marker is cleared. */
export async function markNoReload(page: Page, marker = "__e2e_no_reload__") {
  await page.evaluate((m) => {
    (window as unknown as Record<string, unknown>)[m] = true;
  }, marker);
}

export async function markerStillSet(page: Page, marker = "__e2e_no_reload__") {
  return page.evaluate((m) => (window as unknown as Record<string, unknown>)[m] === true, marker);
}

export const WORKSPACES = ["overview", "timeline", "documents", "ai"] as const;
export type Workspace = (typeof WORKSPACES)[number];

export function urlFor(contactId: number, ws: Workspace): string {
  return ws === "overview"
    ? `/admin/contacts/${contactId}`
    : `/admin/contacts/${contactId}/${ws}`;
}

/** Wait for the contact hero + tablist to be present (workspace mounted). */
export async function waitForWorkspace(page: Page) {
  await expect(page.getByTestId("contact-hero")).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Workspace tabs" })).toBeVisible();
}

export const test = base;
export { expect };

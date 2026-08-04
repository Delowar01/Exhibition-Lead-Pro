import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * On this NixOS environment the Playwright-downloaded Chromium cannot resolve
 * its shared libraries. A Nix-patched Playwright Chromium build is available in
 * the Nix store; we point Playwright at the newest one via `executablePath`.
 * Override with PW_CHROMIUM_PATH if needed.
 */
function resolveChromium(): string | undefined {
  if (process.env.PW_CHROMIUM_PATH && fs.existsSync(process.env.PW_CHROMIUM_PATH)) {
    return process.env.PW_CHROMIUM_PATH;
  }
  try {
    const storeDir = "/nix/store";
    const candidates = fs
      .readdirSync(storeDir)
      .filter((d) => d.endsWith("-playwright-browsers-chromium"))
      .map((d) => path.join(storeDir, d));
    let best: { build: number; bin: string } | null = null;
    for (const dir of candidates) {
      let subs: string[] = [];
      try {
        subs = fs.readdirSync(dir).filter((s) => s.startsWith("chromium-"));
      } catch {
        continue;
      }
      for (const sub of subs) {
        const bin = path.join(dir, sub, "chrome-linux", "chrome");
        if (!fs.existsSync(bin)) continue;
        const build = parseInt(sub.replace("chromium-", ""), 10) || 0;
        if (!best || build > best.build) best = { build, bin };
      }
    }
    return best?.bin;
  } catch {
    return undefined;
  }
}

const chromiumPath = resolveChromium();

/**
 * Playwright configuration scoped to the Contact Workspace automated QA suite
 * (Batch 1). Chromium-only, run against the already-running gateway proxy at
 * http://localhost:80/. The web-app dev server (with HMR) is expected to be up;
 * this config does NOT start or restart it.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:80",
    trace: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: chromiumPath ? { executablePath: chromiumPath } : {},
      },
    },
  ],
});

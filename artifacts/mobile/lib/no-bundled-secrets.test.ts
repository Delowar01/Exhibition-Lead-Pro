import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// MOBILE-R1 — the AI provider credential MUST stay server-side. Nothing that is
// compiled into the client bundle or the build profiles may name or carry it:
// no Gemini key, no AI_INTEGRATIONS_* proxy credential, no EXPO_PUBLIC_* variable
// that would expose one. The only public build-time variables are the server
// origin / domain and the EAS project id.
const ROOT = join(__dirname, "..");
const SCAN_DIRS = ["app", "components", "constants", "contexts", "hooks", "lib"];
const SCAN_FILES = ["app.json", "eas.json", "package.json"];
const SOURCE = /\.(ts|tsx|js|jsx|json)$/;
const FORBIDDEN: { name: string; re: RegExp }[] = [
  { name: "a Gemini key name", re: /GEMINI_API_KEY/ },
  { name: "a Gemini proxy credential name", re: /AI_INTEGRATIONS_GEMINI/ },
  { name: "a Google API key literal", re: /AIza[0-9A-Za-z_-]{30,}/ },
  { name: "a public env variable carrying a key or secret", re: /EXPO_PUBLIC_[A-Z0-9_]*(KEY|SECRET|TOKEN|GEMINI)/ },
];

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE.test(entry)) out.push(full);
  }
}

describe("no AI credential is bundled into the mobile client", () => {
  it("no source, locale, config or build-profile file names or carries a Gemini / AI proxy credential", () => {
    const files: string[] = [];
    for (const d of SCAN_DIRS) walk(join(ROOT, d), files);
    for (const f of SCAN_FILES) files.push(join(ROOT, f));
    expect(files.length).toBeGreaterThan(50);
    const hits: string[] = [];
    for (const f of files) {
      // This test names the forbidden patterns itself; it is excluded from its own scan.
      if (f.endsWith("no-bundled-secrets.test.ts")) continue;
      const text = readFileSync(f, "utf8");
      for (const { name, re } of FORBIDDEN) if (re.test(text)) hits.push(`${relative(ROOT, f)}: ${name}`);
    }
    expect(hits).toEqual([]);
  });

  it("the build profiles expose only the server origin (no credential, no AI variable)", () => {
    const eas = JSON.parse(readFileSync(join(ROOT, "eas.json"), "utf8")) as { build?: Record<string, { env?: Record<string, string> }> };
    for (const [profile, cfg] of Object.entries(eas.build ?? {})) {
      for (const name of Object.keys(cfg.env ?? {})) {
        expect(name, `${profile}.env.${name}`).toMatch(/^EXPO_PUBLIC_(API_URL|DOMAIN|EAS_PROJECT_ID)$/);
      }
    }
  });
});

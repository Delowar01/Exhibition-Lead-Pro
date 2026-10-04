// B25 Correction 8: the mobile release bundle must not carry account
// identifiers, a demo password or quick-demo login UI. Unreachable `__DEV__`
// UI is not enough — Hermes keeps module-level strings — so the values must be
// absent from mobile source entirely. The forbidden values are assembled from
// fragments so this guard never reintroduces the literals it forbids.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const MOBILE_ROOT = fileURLToPath(String(new URL("..", import.meta.url)));
const LOGIN_SCREEN = join(MOBILE_ROOT, "app", "login.tsx");
const LOCALES = ["en", "ar"].map((l) => join(MOBILE_ROOT, "lib", "i18n", "locales", `${l}.json`));

const FORBIDDEN: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "removed TechCorp account email", pattern: new RegExp(["admin", "techcorp\\.com"].join("@"), "i") },
  { name: "removed Nexus account email", pattern: new RegExp(["admin", "nexussys\\.io"].join("@"), "i") },
  { name: "removed demo password", pattern: new RegExp(["Admin", "123!"].join("")) },
  { name: "quick-demo UI text", pattern: new RegExp(["quick", "demo", "access"].join("\\s+"), "i") },
  { name: "quick-demo translation key", pattern: new RegExp(["demo", "Access"].join(""), "i") },
  { name: "demo account list", pattern: new RegExp(["DEMO", "ACCOUNTS"].join("_")) },
];

// Generated, vendored and native-build output is not mobile source.
const SKIP_DIRS = new Set(["node_modules", ".expo", "dist", "android", "ios", "assets"]);
const TEXT_EXT = /\.(tsx?|jsx?|json|md|html|toml)$/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) out.push(...sourceFiles(full));
    } else if (TEXT_EXT.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("mobile source carries no demo identifiers or quick-demo login", () => {
  const files = sourceFiles(MOBILE_ROOT);

  it("scans the login screen and both locales", () => {
    expect(files).toContain(LOGIN_SCREEN);
    for (const locale of LOCALES) expect(files).toContain(locale);
  });

  for (const { name, pattern } of FORBIDDEN) {
    it(`no file contains the ${name}`, () => {
      const hits = files.filter((f) => pattern.test(readFileSync(f, "utf8"))).map((f) => relative(MOBILE_ROOT, f));
      expect(hits).toEqual([]);
    });
  }

  it("no locale defines a demo key in the login namespace, and en/ar login keys match", () => {
    const loginKeys = LOCALES.map((f) => Object.keys((JSON.parse(readFileSync(f, "utf8")) as { login: Record<string, string> }).login).sort());
    for (const keys of loginKeys) expect(keys.filter((k) => /demo/i.test(k))).toEqual([]);
    expect(loginKeys[0]).toEqual(loginKeys[1]);
  });
});

describe("release login fields start empty", () => {
  const src = readFileSync(LOGIN_SCREEN, "utf8");

  it("initialises email and password state to an empty string", () => {
    expect(src).toMatch(/const \[email, setEmail\] = useState\(""\);/);
    expect(src).toMatch(/const \[password, setPassword\] = useState\(""\);/);
  });

  it("has no build-flag-dependent credential path", () => {
    expect(src).not.toMatch(/__DEV__/);
  });

  it("never sets or submits a hardcoded email or password", () => {
    expect(src).not.toMatch(/set(Email|Password)\(\s*["'`]/);
    expect(src).not.toMatch(/handleLogin\(\s*["'`]/);
    expect(src).not.toMatch(/handleLogin\([^)]*,\s*["'`]/);
  });

  it("keeps the normal email/password sign-in form", () => {
    expect(src).toMatch(/value=\{email\}\s+onChangeText=\{setEmail\}/);
    expect(src).toMatch(/value=\{password\}\s+onChangeText=\{setPassword\}/);
    expect(src).toMatch(/secureTextEntry=\{!showPassword\}/);
    expect(src).toMatch(/onPress=\{\(\) => handleLogin\(email, password\)\}/);
    expect(src).toMatch(/t\("auth\.signIn"\)/);
  });
});

// Phase 2 Batch 1 — who mirrors the layout for Arabic: the app (from the language
// chosen in the app), never the phone's system language on top of it.
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { claimLayoutDirection } from "./layout-direction";

const MOBILE_ROOT = fileURLToPath(String(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);

describe("native mirroring is switched off at run time", () => {
  it("tells React Native not to mirror for a right-to-left SYSTEM language, and never forces it", () => {
    const calls: string[] = [];
    const manager = { isRTL: false, allowRTL: (v: boolean) => calls.push(`allowRTL(${v})`), forceRTL: (v: boolean) => calls.push(`forceRTL(${v})`) };
    expect(claimLayoutDirection(manager)).toEqual({ nativeMirroringActive: false });
    expect(calls).toEqual(["allowRTL(false)", "forceRTL(false)"]);
  });

  it("reports when native mirroring is still active in this run (a build without the manifest setting on an Arabic phone)", () => {
    const manager = { isRTL: true, allowRTL: () => {}, forceRTL: () => {} };
    expect(claimLayoutDirection(manager)).toEqual({ nativeMirroringActive: true });
  });

  it("is harmless where there is no native manager (web) or it throws", () => {
    expect(claimLayoutDirection(null)).toEqual({ nativeMirroringActive: false });
    expect(claimLayoutDirection(undefined)).toEqual({ nativeMirroringActive: false });
    const throwing = { isRTL: false, allowRTL: () => { throw new Error("unsupported"); }, forceRTL: () => {} };
    expect(claimLayoutDirection(throwing)).toEqual({ nativeMirroringActive: false });
  });

  it("the app calls it once at start-up, before anything is rendered", () => {
    const layout = readFileSync(join(MOBILE_ROOT, "app", "_layout.tsx"), "utf8");
    expect(layout).toMatch(/claimLayoutDirection\(I18nManager\)/);
    expect(layout.indexOf("claimLayoutDirection(I18nManager)")).toBeLessThan(layout.indexOf("function RootLayoutNav"));
  });
});

describe("native mirroring is switched off at build time", () => {
  it("the config plugin sets android:supportsRtl=\"false\" on the application and changes nothing else", () => {
    const { setNativeLtr } = require("../plugins/withNativeLtr.js") as { setNativeLtr: (m: unknown) => unknown };
    const manifest = {
      manifest: {
        $: { "xmlns:android": "http://schemas.android.com/apk/res/android" },
        "uses-permission": [{ $: { "android:name": "android.permission.CAMERA" } }],
        application: [
          {
            $: { "android:name": ".MainApplication", "android:supportsRtl": "true", "android:allowBackup": "false" },
            activity: [{ $: { "android:name": ".MainActivity" } }],
          },
        ],
      },
    };
    const out = setNativeLtr(structuredClone(manifest)) as typeof manifest;
    expect(out.manifest.application[0]!.$["android:supportsRtl"]).toBe("false");
    out.manifest.application[0]!.$["android:supportsRtl"] = "true";
    expect(out).toEqual(manifest);
  });

  it("is registered in app.json, so the next native build carries it", () => {
    const app = JSON.parse(readFileSync(join(MOBILE_ROOT, "app.json"), "utf8")) as { expo: { plugins: unknown[] } };
    expect(app.expo.plugins).toContain("./plugins/withNativeLtr");
  });
});

describe("the app's own mirroring is the only one in the source", () => {
  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (!["node_modules", ".expo", "dist", "testing"].includes(entry)) out.push(...sources(full));
      } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  }
  const FILES = ["app", "components", "contexts", "hooks", "lib"].flatMap((d) => sources(join(MOBILE_ROOT, d)));

  it("nothing switches native mirroring ON, and only the start-up code touches the native manager", () => {
    const users: string[] = [];
    for (const f of FILES) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/forceRTL\(\s*true\s*\)|allowRTL\(\s*true\s*\)/);
      if (/\bI18nManager\b/.test(src)) users.push(f.slice(MOBILE_ROOT.length).split("\\").join("/"));
    }
    expect(users.sort()).toEqual(["app/_layout.tsx"]);
  });

  it("layout direction comes from the language chosen in the app (hooks/useLocale.ts), not from the system", () => {
    const hook = readFileSync(join(MOBILE_ROOT, "hooks", "useLocale.ts"), "utf8");
    expect(hook).toMatch(/isRTLLanguage\(lang\)/);
    expect(hook).not.toMatch(/I18nManager/);
  });
});

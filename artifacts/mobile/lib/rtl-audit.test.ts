// Phase 2 Batch 1 — Arabic layout guard for the screens this batch audited:
// forms, camera screens, scan review, contact pages, sync and sign-in. It is a
// STATIC check (the mobile suite has no device renderer): it pins the mechanics
// that make those screens mirror, so a later edit cannot quietly drop them.
// It does not replace looking at the screens on a phone in Arabic.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MOBILE_ROOT = fileURLToPath(String(new URL("..", import.meta.url)));
const read = (rel: string) => readFileSync(join(MOBILE_ROOT, rel), "utf8");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(MOBILE_ROOT, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(MOBILE_ROOT, rel)).isDirectory()) out.push(...sources(rel));
    else if (/\.tsx$/.test(entry)) out.push(rel);
  }
  return out;
}
// components/icons.tsx is the icon component itself (it documents and implements the mirroring).
const SCREENS = [...sources("app"), ...sources("components")].filter((f) => f !== "components/icons.tsx");

/** Screens of the audited scope: every one must take its direction from the app language. */
const AUDITED = [
  "app/login.tsx",
  "app/forgot-password.tsx",
  "app/capture-camera.tsx",
  "app/capture-qr.tsx",
  "app/capture-nfc.tsx",
  "app/capture-manual.tsx",
  "app/batch-review.tsx",
  "app/scan-review.tsx",
  "app/sync.tsx",
  "app/contact/[id].tsx",
  "components/ContactForm.tsx",
  "components/ui.tsx",
];

describe("audited screens mirror from the language chosen in the app", () => {
  for (const file of AUDITED) {
    it(`${file} reads the direction from useLocale and applies it to rows`, () => {
      const src = read(file);
      expect(src).toMatch(/useLocale\(\)/);
      expect(src).toMatch(/\bisRTL\b/);
      expect(src).toMatch(/isRTL \? \(?"row-reverse"|rowDir\b|rowDirection/);
    });
  }

  it("the shared primitives every screen uses are direction-aware", () => {
    const ui = read("components/ui.tsx");
    // buttons (icon + label), badge (dot + label), list row (icon, text, chevron), input (label, text, error)
    expect(ui.match(/flexDirection: isRTL \? "row-reverse" : "row"/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(ui).toMatch(/<Feather name="chevron-right" directional/);
    expect(ui.match(/\btextAlign\b/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
  });

  it("the contact page mirrors its detail rows, sections, status options, assignment and manage rows", () => {
    const src = read("app/contact/[id].tsx");
    for (const style of ["leadRow", "recommendRow", "statusGrid", "scheduleChips", "detailRow"]) {
      expect(src, style).toMatch(new RegExp(`styles\\.${style}, \\{[^}]*flexDirection: (rowDir|isRTL)`));
    }
    for (const style of ["statusOption", "assignRow", "scheduleChip", "manageRow"]) {
      expect(src, style).toMatch(new RegExp(`styles\\.${style},\\s*\\{[^}]*flexDirection: (rowDir|isRTL)`));
    }
    expect(src.match(/color: colors\.[a-zA-Z]+, textAlign \}/g)?.length ?? 0).toBeGreaterThanOrEqual(10);
    expect(src).not.toMatch(/"Downloading…"/); // was a hard-coded English label
  });

  it("the camera keeps long messages on screen and translates its mode label", () => {
    const src = read("app/capture-camera.tsx");
    expect(src).toMatch(/rapidBannerText: \{[^}]*flexShrink: 1/);
    expect(src).toMatch(/feedbackContainer: \{[^}]*paddingHorizontal: 16/s);
    expect(src).not.toMatch(/\{mode\.toUpperCase\(\)\}/); // the raw internal mode name used to be shown
    expect(src).toMatch(/capture\.modeRapid/);
  });
});

describe("directional icons", () => {
  const DIRECTIONAL = /<Feather\s+name="(arrow-left|arrow-right|chevron-left|chevron-right)"([^>]*)>/g;

  it("the icon component mirrors a `directional` glyph in a right-to-left language, and only then", () => {
    const icons = read("components/icons.tsx");
    expect(icons).toMatch(/directional\?: boolean/);
    expect(icons).toMatch(/isRTLLanguage\(i18n\.language\) \? \[style, MIRRORED\] : style/);
    expect(icons).toMatch(/MIRRORED: ViewStyle = \{ transform: \[\{ scaleX: -1 \}\] \}/);
  });

  it("every back arrow and chevron with a fixed name is mirrored one way or another", () => {
    const unhandled: string[] = [];
    for (const file of SCREENS) {
      const src = read(file);
      for (const m of src.matchAll(DIRECTIONAL)) {
        const attrs = m[2] ?? "";
        const handled = /\bdirectional\b/.test(attrs) || /scaleX: -1/.test(attrs) || /style=\{mirror\}/.test(attrs);
        if (!handled) unhandled.push(`${file}: ${m[1]}`);
      }
    }
    // The date picker's previous / next month arrows are the one deliberate
    // exception: its month row is not mirrored, so the arrows keep their side.
    expect(unhandled.filter((u) => !u.startsWith("components/DateTimeField.tsx")).sort()).toEqual([]);
  });

  it("a glyph that is already swapped by hand is not ALSO marked directional (that would turn it back)", () => {
    for (const file of SCREENS) {
      const src = read(file);
      expect(src, file).not.toMatch(/<Feather\s+name=\{isRTL \?[^}]*\}[^>]*\bdirectional\b/);
      expect(src, file).not.toMatch(/\bdirectional\b[^>]*scaleX: -1/);
    }
  });
});

describe("what this batch did NOT cover (reported, not hidden)", () => {
  it("lists the screens that still lay out rows left-to-right only", () => {
    const remaining = SCREENS.filter((file) => {
      const src = read(file);
      const rows = (src.match(/flexDirection: "row"/g) ?? []).length;
      const aware = /\bisRTL\b|rowDirection|\brow\(|\bmirror\b|rowDir\b/.test(src);
      return rows > 0 && !aware;
    }).sort();
    // Kept as an explicit list so that fixing one of these (or adding a new
    // unmirrored screen) is a visible change. None is in the audited scope above.
    expect(remaining).toEqual([
      "app/contact/edit/[id].tsx",
      "app/dev-perf.tsx",
      "app/event-picker.tsx",
      "app/event/[id]/index.tsx",
      "app/event/[id]/member/[userId].tsx",
      "app/events.tsx",
      "app/pipeline/form.tsx",
      "components/AiInsightsSection.tsx",
      "components/AppLockOverlay.tsx",
      "components/CopilotSection.tsx",
      "components/DateTimeField.tsx",
      "components/ErrorFallback.tsx",
      "components/PinPad.tsx",
      "components/WorkflowSection.tsx",
    ]);
  });
});

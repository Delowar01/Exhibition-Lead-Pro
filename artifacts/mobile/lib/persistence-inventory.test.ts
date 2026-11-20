// B25 Stage 1 — mobile persistence inventory guard.
// Every place the app persists state on the device was reviewed for
// cross-account exposure (settings 9306a164, offline queue 11f14e13, own-card
// cache in this change). This guard keeps that review honest: a NEW storage
// key, a new module that talks to AsyncStorage / the secure store directly, or
// a new module that writes files must be added to the reviewed tables below
// (with its classification) before the suite passes again. It is an inventory,
// not a ban: AsyncStorage stays available — the reviewer just has to see it.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MOBILE_ROOT = fileURLToPath(String(new URL("..", import.meta.url)));
const SOURCE_DIRS = ["app", "components", "contexts", "hooks", "lib"];
const SKIP_DIRS = new Set(["node_modules", ".expo", "dist", "android", "ios", "assets", "i18n"]);

type Classification = "DEVICE-WIDE SAFE" | "ACCOUNT-SCOPED" | "AUTH/SECURITY" | "AUTH/SECURITY — NON-SECRET ACCOUNT HINT";

/** Reviewed storage keys: value → classification and the module that owns it. */
const REVIEWED_KEYS: Record<string, { kind: Classification; owner: string; note: string }> = {
  csp_settings: { kind: "ACCOUNT-SCOPED", owner: "contexts/SettingsContext.tsx", note: "device prefs + tenant event state bound to scopeOwner (9306a164)" },
  csp_offline_manual: { kind: "DEVICE-WIDE SAFE", owner: "contexts/OfflineContext.tsx", note: "work-offline toggle, no tenant data" },
  csp_offline_queue: { kind: "ACCOUNT-SCOPED", owner: "lib/offline-queue.ts", note: "queue of versions before Phase 2 Batch 1 (images inline): read once and taken over into csp_offline_queue_v2, removed only after that index is stored, left untouched when unreadable" },
  csp_offline_queue_v2: { kind: "ACCOUNT-SCOPED", owner: "lib/offline-queue.ts", note: "queue index: every item stamped with its owner, legacy quarantined (11f14e13); a scan holds only the NAME of its image file (per-account directory, lib/scan-files.ts)" },
  csp_offline_queue_migrated: { kind: "DEVICE-WIDE SAFE", owner: "lib/offline-queue.ts", note: "flag: the older queue was taken over (no tenant data)" },
  csp_offline_done: { kind: "DEVICE-WIDE SAFE", owner: "lib/offline-queue.ts", note: "ids (timestamp-random, no tenant data) of items already uploaded or removed, so a left-over image file is cleaned up and never restored as new work" },
  csp_offline_queue_damaged: { kind: "ACCOUNT-SCOPED", owner: "lib/offline-queue.ts", note: "copy of an index value that was not a queue, set aside before a fresh index replaces it; never read back, never shown" },
  csp_refresh: { kind: "AUTH/SECURITY", owner: "lib/auth-storage.ts", note: "refresh token of the current session (secure store); replaced at every renewal, deleted on logout and when the session ends; only ever used together with csp_token" },
  csp_own_card: { kind: "ACCOUNT-SCOPED", owner: "lib/card-storage.ts", note: "single { owner, card } slot; legacy raw card removed, never attributed" },
  csp_token: { kind: "AUTH/SECURITY", owner: "lib/auth-storage.ts", note: "current session token (secure store); replaced on login, deleted on logout" },
  csp_user: { kind: "AUTH/SECURITY", owner: "lib/auth-storage.ts", note: "current session user (secure store); replaced on login and — for the same session only, never with the token — by the M5 entitlement refresh; deleted on logout" },
  csp_remember_email: { kind: "AUTH/SECURITY", owner: "app/login.tsx", note: "remembered login e-mail (opt-in Remember me, secure store)" },
  csp_biometric_vault: { kind: "AUTH/SECURITY", owner: "lib/biometric.ts", note: "biometric quick sign-in: session of the account that enabled it (secure store, read only after the biometric prompt); cleared when a different account signs in" },
  csp_biometric_account: { kind: "AUTH/SECURITY — NON-SECRET ACCOUNT HINT", owner: "lib/biometric.ts", note: "destination of the biometric action: stable <userId>@<companyId> + masked e-mail only, written/cleared with the vault; no token" },
  csp_app_lock_pin: { kind: "AUTH/SECURITY", owner: "lib/biometric.ts", note: "app-lock PIN (secure store), unlocks the current session only" },
  csp_app_lock_pin_state: { kind: "AUTH/SECURITY", owner: "lib/biometric.ts", note: "app-lock attempt counter / lockout (secure store)" },
};

/** Modules allowed to call the key-value stores directly (everything else goes through them). */
const REVIEWED_STORE_CALLERS = new Set([
  "lib/secure-prefs.ts", // SecureStore with an AsyncStorage fallback on web
  "lib/auth-storage.ts", // session + one-time migration of the pre-secure-store copies
  "lib/biometric.ts",
  "lib/card-storage.ts",
  "lib/offline-queue.ts",
  "contexts/OfflineContext.tsx",
  "contexts/SettingsContext.tsx",
  "app/login.tsx",
]);

/** Modules that write files: all into the OS-managed app cache directory, fresh per request, never reused across accounts. */
// (lib/documents.ts and lib/export-share.ts download through lib/private-files.ts and are not writers themselves.)
// Phase 2 Batch 1 — lib/scan-file-driver.ts is the one writer OUTSIDE the cache: offline scan images in the app's
// private document directory, one sub-directory per account (`<userId>_<companyId>`, derived only from a tenant owner
// key), read back only for the item's owner, deleted only after a confirmed upload or the user's own removal.
const REVIEWED_FILE_WRITERS = new Set([
  "lib/scan-file-driver.ts",
  "lib/private-files.ts",
  "lib/vcard.ts",
  "components/CommunicationHub.tsx",
  "app/contact/[id].tsx",
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) out.push(...sourceFiles(full));
    } else if (/\.(tsx?|jsx?)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = SOURCE_DIRS.flatMap((d) => sourceFiles(join(MOBILE_ROOT, d)));
const read = (f: string) => readFileSync(f, "utf8");
const rel = (f: string) => relative(MOBILE_ROOT, f).split("\\").join("/");

describe("mobile persistence inventory", () => {
  it("scans the mobile source tree", () => {
    expect(FILES.length).toBeGreaterThan(20);
  });

  it("every csp_ storage key in the source is reviewed and classified", () => {
    const found = new Map<string, Set<string>>();
    for (const f of FILES) {
      for (const m of read(f).matchAll(/["'`](csp_[a-z0-9_]+)["'`]/g)) {
        const key = m[1]!;
        if (!found.has(key)) found.set(key, new Set());
        found.get(key)!.add(rel(f));
      }
    }
    const unreviewed = [...found.keys()].filter((k) => !(k in REVIEWED_KEYS));
    expect(unreviewed, `new storage key(s) need a review entry: ${unreviewed.join(", ")}`).toEqual([]);
    for (const [key, entry] of Object.entries(REVIEWED_KEYS)) {
      expect(found.get(key), `reviewed key ${key} no longer appears in the source — remove its entry`).toBeDefined();
      expect(found.get(key)!.has(entry.owner), `${key} is defined outside its reviewed owner module ${entry.owner}`).toBe(true);
    }
  });

  it("only reviewed modules talk to AsyncStorage / the secure store directly", () => {
    const callers = new Set<string>();
    for (const f of FILES) {
      const src = read(f);
      if (/\bAsyncStorage\.(getItem|setItem|removeItem|multiGet|multiSet|multiRemove|getAllKeys|clear)\b/.test(src)) callers.add(rel(f));
      if (/\bSecureStore\.(getItemAsync|setItemAsync|deleteItemAsync)\b/.test(src)) callers.add(rel(f));
      if (/\b(getSecureItem|setSecureItem|deleteSecureItem)\(/.test(src) && !/export (async )?function (getSecureItem|setSecureItem|deleteSecureItem)/.test(src)) callers.add(rel(f));
    }
    const unreviewed = [...callers].filter((c) => !REVIEWED_STORE_CALLERS.has(c));
    expect(unreviewed, `new persistence caller(s) need review: ${unreviewed.join(", ")}`).toEqual([]);
    for (const c of REVIEWED_STORE_CALLERS) expect(callers.has(c), `${c} no longer persists anything — remove it from the reviewed list`).toBe(true);
  });

  it("only reviewed modules write files to the device", () => {
    const writers = new Set<string>();
    for (const f of FILES) {
      if (/\bFileSystem\.(writeAsStringAsync|downloadAsync|copyAsync|moveAsync|makeDirectoryAsync)\b/.test(read(f))) writers.add(rel(f));
    }
    const unreviewed = [...writers].filter((w) => !REVIEWED_FILE_WRITERS.has(w));
    expect(unreviewed, `new file writer(s) need review: ${unreviewed.join(", ")}`).toEqual([]);
    for (const w of REVIEWED_FILE_WRITERS) expect(writers.has(w), `${w} no longer writes files — remove it from the reviewed list`).toBe(true);
  });

  it("account-scoped stores carry an owner (the shared <userId>@<companyId> key) in their persisted shape", () => {
    // The three tenant-data stores persist an explicit owner; the pure models are the single source of truth.
    expect(read(join(MOBILE_ROOT, "lib", "settings-model.ts"))).toMatch(/scopeOwner/);
    expect(read(join(MOBILE_ROOT, "lib", "offline-queue-model.ts"))).toMatch(/owner: string \| null/);
    expect(read(join(MOBILE_ROOT, "lib", "card-cache-model.ts"))).toMatch(/owner: string;/);
    // offline scan images live in a directory derived from that same owner key, never from anything else
    expect(read(join(MOBILE_ROOT, "lib", "scan-files.ts"))).toMatch(/ownerDirName\(owner\)/);
    expect(read(join(MOBILE_ROOT, "lib", "scan-file-driver.ts"))).toMatch(/FileSystem\.documentDirectory/);
    // and all derive it from the one helper
    for (const m of ["lib/offline-queue-model.ts", "lib/biometric-account-model.ts", "contexts/AuthContext.tsx"]) {
      expect(read(join(MOBILE_ROOT, m))).toMatch(/accountOwnerKey/);
    }
  });

  it("the biometric account hint persists no secret: exactly { owner, emailHint }, written and cleared with the vault", () => {
    const model = read(join(MOBILE_ROOT, "lib", "biometric-account-model.ts"));
    expect(model).toMatch(/JSON\.stringify\(\{ owner: hint\.owner, emailHint: hint\.emailHint \}\)/);
    const storage = read(join(MOBILE_ROOT, "lib", "biometric.ts"));
    expect(storage).toMatch(/const ACCOUNT_KEY = "csp_biometric_account"/);
    // the only writer of the hint record serialises the model's two-field hint
    const hintWrites = storage.match(/setSecureItem\(ACCOUNT_KEY, ([^)]*)\)/g) ?? [];
    expect(hintWrites.length).toBeGreaterThan(0);
    for (const w of hintWrites) expect(w).toMatch(/serializeBiometricAccountHint\(/);
    // clearing the vault always clears the hint with it
    expect(storage).toMatch(/deleteSecureItem\(VAULT_KEY\);\s*await deleteSecureItem\(ACCOUNT_KEY\)/);
  });
});
